/**
 * CUA World: the screen and the mouse, as tools.
 *
 * Six tools — look, list windows, click, type, key, focus — each one a short PowerShell call
 * (src/engine.ts). The person is asked before the first call of a turn (or of a grant window),
 * through the system's own Yes/No box; a refusal is a failed tool with no side effect, and the
 * refusal stands for the rest of the turn so a retry does not nag.
 *
 * The same tools are served over a loopback HTTP bridge (src/bridge.ts) when `worlds.cua-bridge.bridge`
 * is on, which is how a program other than Coo (AstrBot, a script) uses them. The bridge goes
 * through the very same `call()`, so the approval above applies to it as well.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { CUA_CONFIG_GROUP, CUA_DEFAULTS, CUA_ID, CUA_STATE_DIR, type AskLevel, type CuaConfigSection } from './config.ts';
import { askDesktop, CuaFailure, runCua, type ScreenInfo, type ShotResult, type WindowEntry } from './engine.ts';
import { Bridge, type BridgeOutcome } from './bridge.ts';
import { fileURLToPath } from 'node:url';
import type { OutputTap } from 'cortico/core/types.ts';

/** What `OutputTap.onEvent` receives; the type itself is not exported by the framework. */
type StreamEvent = Parameters<OutputTap['onEvent']>[0];

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** How long the person gets before a question counts as a refusal. */
export const ASK_TIMEOUT_MS = 60_000;

const ASK_TEXT: Record<AskLevel, string> = {
  'ask-each-command': '每次调用前都会在桌面上问使用者。',
  'ask-each-turn': '每一轮第一次调用前会问使用者；这一轮同意过就不再问。',
  'ask-once': '第一次调用时问使用者，同意后在任何一段时间内不再问。',
  'never-ask': '不事先问使用者。',
};

const DISPLAY_PARAM = '显示器序号，1 是左起第一块；不确定就用 1。';

export const CUA_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'cua_screenshot',
    tags: ['read'],
    description:
      '看一眼使用者此刻的电脑屏幕：截一块显示器，画出鼠标指针的位置，并返回屏幕尺寸、指针坐标和前台窗口标题。' +
      '之后的点击坐标都用这张截图的像素。读屏幕可能需要使用者在桌面的确认框里点一下同意；被拒绝就不要反复重试，等使用者开口。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { display: { type: 'integer', minimum: 1, description: DISPLAY_PARAM } },
    },
  },
  {
    name: 'cua_windows',
    tags: ['read'],
    description: '列出使用者屏幕上可见的顶层窗口：标题、进程 pid、所在位置与大小、是否最小化、哪个在前台。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cua_click',
    tags: ['act'],
    description: '把鼠标移到截图的 (x, y) 并点击。坐标是最近一次截图的像素，必须以那次截图为准；点之前先截一张，确认坐标落在真的控件上。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        display: { type: 'integer', minimum: 1, description: '截图时用的显示器序号；省略时用最近一次截图。' },
        x: { type: 'integer', minimum: 0, description: '横坐标（最近一次 cua_screenshot 的像素）' },
        y: { type: 'integer', minimum: 0, description: '纵坐标（最近一次 cua_screenshot 的像素）' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, description: '1 单击、2 双击、3 三击' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'cua_type',
    tags: ['act'],
    description: '在当前输入焦点输入文字（中文也行，与输入法状态无关；换行按一次回车）。输入前先点一下要输入的框。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', description: '要输入的文字' } },
      required: ['text'],
    },
  },
  {
    name: 'cua_key',
    tags: ['act'],
    description: '按一个键或组合键。组合键用 + 连，先后按用空格分开，例如 "ctrl+s"、"alt+f4"、"ctrl+a delete"。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { keys: { type: 'string', description: '键名组合' } },
      required: ['keys'],
    },
  },
  {
    name: 'cua_focus',
    tags: ['act'],
    description: '把某个窗口切到前台（最小化的先还原）。window 用窗口列表给的 handle，或标题的一部分。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { window: { type: 'string', description: '窗口 handle（0x...）或标题片段' } },
      required: ['window'],
    },
  },
];

export const DELEGATE_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'cua_delegate',
    tags: ['act'],
    description:
      '把一件需要看屏幕、操作电脑的任务交给 Coo 的模型在本机做。提交后立刻返回 job id，用 cua_job 查结果；不要重复提交同一个任务。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: '要完成的事，写清楚目标和完成标准。' },
        allow_act: { type: 'boolean', description: '是否允许点击、输入、按键；默认 false，只查看。' },
        deadline_ms: { type: 'integer', minimum: 10000, maximum: 300000, description: '最多做多久，默认 120000。' },
      },
      required: ['task'],
    },
  },
  {
    name: 'cua_job',
    tags: ['read'],
    description: '查 cua_delegate 提交的任务：running / done / timeout / failed，以及结果文本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: { type: 'string', description: 'cua_delegate 返回的 job id。' } },
      required: ['job_id'],
    },
  },
];

/** What the loopback bridge offers; cua_delegate/cua_job are not part of Coo's own tool table. */
export const BRIDGE_TOOL_SPECS: ToolSpec[] = [...CUA_TOOL_SPECS, ...DELEGATE_TOOL_SPECS];

/** The chat tool's static shape; the instance rewrites the description with the configured names. */
export const CHAT_TOOL_SPEC: ToolSpec = {
  name: 'send_msg_to_astrbot',
  tags: ['speak'],
  description:
    '给另一个 bot 发一条消息。它不在本机、用不了这台电脑的鼠标键盘，但能查资料、跑工具、回答问题。' +
    '配置了直连时它回的话会作为下一条消息进来；没有直连时进信箱。发完都不会立刻出现在返回值里。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', description: '要发过去的话，一两句，把需要它做的事说清楚。' } },
    required: ['message'],
  },
};

export interface CuaWorldOptions {
  /** `worlds.cua-bridge` live reference: hot keys are read at use. */
  cfg: CuaConfigSection;
  /** Name the approval box is signed with. */
  botName?: string;
  /** This World's own data directory (the deployment's, not the checkout's). */
  dataDir: string;
  /** The deployment directory, read only to fall back to the name the introduction stored. */
  botDir?: string;
  /** Test seams. */
  call?: typeof runCua;
  ask?: typeof askDesktop;
}

interface ShotFrame {
  /** Screen origin of the display, in physical pixels. */
  x: number;
  y: number;
  /** Screenshot scale: image pixel * (1 / scale) = physical pixel. */
  scale: number;
  /** Size of the image the model saw. */
  width: number;
  height: number;
}

type GrantKind = 'read' | 'act';
type DelegateState = 'running' | 'done' | 'timeout' | 'failed';
interface DelegateJob {
  id: string;
  task: string;
  allowAct: boolean;
  state: DelegateState;
  text: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class CuaWorld implements World {
  readonly id = CUA_ID;
  private host: WorldHost | null = null;
  private bridge: Bridge | null = null;
  /** A yes for the current turn only, separately for read and act. */
  private turnGranted: Record<GrantKind, boolean> = { read: false, act: false };
  /** Until when an `ask-once` yes holds, per kind. */
  private grantedUntil: Record<GrantKind, number> = { read: 0, act: 0 };
  /** In-flight question per kind, so parallel calls in one round raise one box. */
  private pendingAsk: { read?: Promise<'yes' | 'no' | 'timeout' | 'error'>; act?: Promise<'yes' | 'no' | 'timeout' | 'error'> } = {};
  /** A refusal inside a bot turn sticks until that turn ends, per kind. */
  private refusedThisTurn: Record<GrantKind, boolean> = { read: false, act: false };
  /** The one delegated task Coo is working on, and recent finished ones for cua_job. */
  private activeJob: DelegateJob | null = null;
  private readonly jobs = new Map<string, DelegateJob>();
  /** True while the current turn carries a delegated task; that turn answers in text, not by messaging back. */
  private taskTurn = false;
  /** One outbound message per turn. AstrBot's reply arrives as a new event, which starts the next turn. */
  private sentThisTurn = false;
  /** Text the bot is currently writing, so a message from the other bot can be answered in place. */
  private tapText = '';
  /** Whether deltas were seen this turn; a finished item must not add the same text again. */
  private tapDelta = false;
  /** Callers waiting for the bot to finish its current turn (the bridge's `waitMs`). */
  private readonly replyWaiters: Array<(text: string) => void> = [];
  /** What the bot said to the other side while it was not listening: AstrBot drains this. */
  private readonly outbox: Array<{ ts: string; text: string }> = [];
  /** Last screenshot frame per display, so a click stays in the pixels the model saw. */
  private readonly shots = new Map<number, ShotFrame>();
  /** Display of the most recent screenshot. */
  private lastDisplay = 0;
  /** `worlds.desktop-pet.user`, cached against config.json's mtime. */
  private petUserName = '';
  private petUserNameMtime = -1;

  constructor(private readonly opts: CuaWorldOptions) {}

  private resetTurnGrants(): void {
    for (const kind of ['read', 'act'] as const) {
      this.turnGranted[kind] = false;
      this.refusedThisTurn[kind] = false;
      delete this.pendingAsk[kind];
    }
  }

  onTurnEnded(): void {
    this.resetTurnGrants();
    this.taskTurn = false;
    this.sentThisTurn = false;
    // The bot just finished speaking: hand the text to whoever is waiting (the bridge's waitMs).
    const text = this.tapText.trim();
    this.tapText = '';
    this.tapDelta = false;
    if (this.replyWaiters.length) for (const resolve of this.replyWaiters.splice(0)) resolve(text);
    this.completeActiveJob(text);
  }

  onHandoffEnded(): void {
    this.resetTurnGrants();
    this.taskTurn = false;
    this.sentThisTurn = false;
  }

  private get cfg(): CuaConfigSection {
    return this.opts.cfg;
  }

  /**
   * The person's name. `names.user` wins; when it is empty this reads
   * `worlds.desktop-pet.user`, which is where the introduction writes the name. That section
   * belongs to another World, so this is a read-only fallback: no writes, and a missing or
   * half-written config.json just means the default stands.
   */
  private storedUserName(): string {
    if (!this.opts.botDir) return '';
    const file = join(this.opts.botDir, 'config.json');
    try {
      const mtime = statSync(file).mtimeMs;
      if (mtime !== this.petUserNameMtime) {
        const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
        const raw = JSON.parse(text) as {
          worlds?: Record<string, { user?: unknown } | undefined>;
        };
        const name = raw.worlds?.['desktop-pet']?.user;
        this.petUserName = typeof name === 'string' ? name.trim() : '';
        this.petUserNameMtime = mtime;
      }
    } catch {
      return this.petUserName;
    }
    return this.petUserName;
  }

  /** Who is who, as this World's prompt and tool texts say it. Nothing outside CUA is renamed. */
  names(): { coo: string; astrbot: string; user: string } {
    const n = this.cfg.names;
    return {
      coo: (n?.coo || this.opts.botName || 'Coo').trim(),
      astrbot: (n?.astrbot || 'AstrBot').trim(),
      user: (n?.user || '').trim() || this.storedUserName() || '使用者',
    };
  }

  /**
   * The main session's output stream: this is how a message from the other bot can carry the
   * reply back in the same call instead of leaving the caller to poll.
   */
  outputTap(): OutputTap | undefined {
    return {
      onEvent: (event: StreamEvent) => {
        // Two shapes reach here, depending on the provider: streamed deltas, or a finished
        // message item. Take text from whichever arrives, and never twice for the same round.
        if (event.type === 'response.output_text.delta') {
          const delta = (event as unknown as { delta?: unknown }).delta;
          if (typeof delta === 'string') {
            this.tapText += delta;
            this.tapDelta = true;
          }
          return;
        }
        if (event.type === 'response.output_item.done') {
          const item = (event as unknown as { item?: { type?: string; content?: unknown } }).item;
          if (!item || item.type !== 'message' || !Array.isArray(item.content)) return;
          const text = (item.content as Array<{ type?: string; text?: unknown }>)
            .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
            .map((part) => part.text as string)
            .join('');
          // Providers that streamed deltas already gave us this text.
          if (text && !this.tapDelta) this.tapText += text;
        }
      },
      // A turn has several rounds (tool loop); only the turn's end means the bot has finished
      // speaking. Resolving per round would return an empty reply from the first tool round.
      onAbort: () => {
        this.tapText = '';
        this.taskTurn = false;
        this.sentThisTurn = false;
        if (this.activeJob) {
          clearTimeout(this.activeJob.timer);
          this.activeJob.state = 'failed';
          this.activeJob.text = '这一轮被中断，任务没有完成。';
          this.activeJob = null;
        }
        for (const resolve of this.replyWaiters.splice(0)) resolve('');
      },
    };
  }

  /** Waits for the bot to finish a turn; '' when nothing came before the deadline. */
  private waitForReply(ms: number): Promise<string> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (text: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(text);
      };
      const timer = setTimeout(() => finish(''), ms);
      this.replyWaiters.push(finish);
    });
  }

  /** A message from the other bot: it enters Coo's session like any other event. */
  async receiveFromAstrBot(text: string, waitMs: number): Promise<{ delivered: boolean; reply: string; timedOut: boolean }> {
    const host = this.host;
    if (!host) throw new CuaFailure('World 没有挂载，收不到消息。');
    const { astrbot } = this.names();
    const body = text.trim();
    if (!body) throw new CuaFailure('消息是空的。');
    // Start waiting *before* the event goes in: delivering it can start the turn immediately, and
    // a waiter registered afterwards would miss the end of that very turn.
    const pending = waitMs > 0 ? this.waitForReply(waitMs) : null;
    // The sender is spelled out in the body, so the bot never has to guess who is talking.
    await host.pushEvent({
      type: 'cua.message',
      ts: new Date().toISOString(),
      source: this.id,
      text: '【' + astrbot + '】' + body,
      senderKey: 'astrbot',
      meta: { from: 'astrbot' },
    });
    if (!pending) return { delivered: true, reply: '', timedOut: false };
    const reply = await pending;
    return { delivered: true, reply, timedOut: reply === '' };
  }

  /** Drains what the bot said to AstrBot since the last call. */
  drainOutbox(): Array<{ ts: string; text: string }> {
    return this.outbox.splice(0, this.outbox.length);
  }

  /**
   * Coo speaking first. With AstrBot's OpenAPI configured the reply is pushed back into Coo's
   * session as a new event, so it starts the next turn; without it the message goes into the
   * outbox, which AstrBot drains with `GET /v1/mailbox` on its next poll.
   */
  async sendToAstrBot(text: string): Promise<string> {
    const body = text.trim();
    if (!body) return '[send_msg_to_astrbot] message 不能为空。';
    if (this.taskTurn) return '这一轮是 AstrBot 委托的任务，把结果写进回复里，不要用 send_msg_to_astrbot。';
    if (this.sentThisTurn) return '这一轮已经给 AstrBot 发过信了；它的回信会作为新消息进来，下一轮再回。';
    this.sentThisTurn = true;
    const chat = this.cfg.chat;
    if (chat?.astrbotUrl && chat.apiKey) {
      let reply = '';
      try {
        reply = await this.postToAstrBot(body, chat);
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') {
          return '已经送到 ' + this.names().astrbot + '，但没在等待时间内回完；它的回话会作为新消息进来。';
        }
        this.outbox.push({ ts: new Date().toISOString(), text: body });
        return '没能直接联系上 ' + this.names().astrbot + '（' + (e instanceof Error ? e.message : String(e)) + '），已放进信箱，它下次来取。';
      }
      if (!reply) return '已经送到 ' + this.names().astrbot + '，它这一轮没有文字回复。';
      try {
        await this.receiveFromAstrBot(reply, 0);
        return '已经送到 ' + this.names().astrbot + '；它的回信作为新消息进来了，下一轮再回。';
      } catch (e) {
        this.outbox.push({ ts: new Date().toISOString(), text: reply });
        return 'AstrBot 回了，但没能送进你的会话（' + (e instanceof Error ? e.message : String(e)) + '）；已放进信箱。';
      }
    }
    this.outbox.push({ ts: new Date().toISOString(), text: body });
    return '已放进 ' + this.names().astrbot + ' 的信箱，它下次来取。';
  }

  /** One turn on AstrBot's OpenAPI; returns the assistant text the SSE stream carried. */
  private async postToAstrBot(text: string, chat: CuaConfigSection['chat']): Promise<string> {
    const base = chat.astrbotUrl.trim().replace(/\/+$/, '');
    const response = await fetch(base + '/api/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + chat.apiKey.trim() },
      body: JSON.stringify({
        username: (chat.username || 'coo').trim(),
        session_id: (chat.sessionId || 'coo-astrbot').trim(),
        ...((chat.configId || '').trim() ? { config_id: chat.configId.trim() } : {}),
        message: [{ type: 'plain', text }],
        enable_streaming: true,
      }),
      signal: AbortSignal.timeout(Math.max(5000, chat.waitMs || CUA_DEFAULTS.chat.waitMs)),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new CuaFailure('AstrBot OpenAPI 返回 ' + response.status + (detail ? '：' + detail.slice(0, 200) : ''));
    }
    if (!response.body) throw new CuaFailure('AstrBot OpenAPI 没有返回内容。');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let delta = '';
    let single = '';
    let complete = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let event: { type?: unknown; data?: unknown; streaming?: unknown; chain_type?: unknown };
        try {
          event = JSON.parse(raw) as typeof event;
        } catch {
          continue;
        }
        if (event.chain_type === 'tool_call' || event.chain_type === 'tool_call_result') continue;
        if (event.type === 'plain' && typeof event.data === 'string') {
          if (event.streaming === true) delta += event.data;
          else single = event.data;
        } else if (event.type === 'complete' && typeof event.data === 'string') {
          complete = event.data;
        }
      }
    }
    return (complete || single || delta).trim();
  }

  /** The ladder for this kind; the specific setting wins, then the legacy `ask`. */
  private askLevel(kind: GrantKind): AskLevel {
    const specific = kind === 'read' ? this.cfg.askRead : this.cfg.askAct;
    return (specific || this.cfg.ask || CUA_DEFAULTS.ask) as AskLevel;
  }

  /** Refuse act tools while a read-only delegated task is running. */
  private assertActAllowed(): void {
    if (this.activeJob && this.activeJob.state === 'running' && !this.activeJob.allowAct) {
      throw new CuaFailure('这次任务只允许查看，不能操作鼠标键盘。');
    }
  }

  /** Wait for the person to stop using the keyboard and mouse before an act call. */
  private async ensureIdle(signal?: AbortSignal): Promise<void> {
    const idleMs = Math.max(0, this.cfg.actIdleMs ?? CUA_DEFAULTS.actIdleMs);
    const waitMs = Math.max(0, this.cfg.actWaitMs ?? CUA_DEFAULTS.actWaitMs);
    if (idleMs <= 0) return;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const out = await this.run<{ idleMs: number }>('idle', {}, signal);
      if (Number(out?.idleMs) >= idleMs) return;
      if (Date.now() >= deadline) throw new CuaFailure('使用者正在用鼠标键盘，这次操作没有执行；等他停手再试。');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private taskText(task: string, allowAct: boolean): string {
    return '【AstrBot 的任务】' + task +
      '\n\n完成后用一两句话说明结果；不要调用 send_msg_to_astrbot，直接把结果写进这一轮的回复。' +
      (allowAct
        ? '\n这次允许操作鼠标键盘；每次操作仍按使用者的设置询问。'
        : '\n这次只允许查看屏幕和窗口，不要点击、输入、按键或切窗口。');
  }

  /** Hand a task to Coo's own model and return the job the bridge polls with cua_job. */
  private async startJob(task: string, allowAct: boolean, deadlineMs: number): Promise<DelegateJob> {
    if (this.activeJob?.state === 'running') throw new CuaFailure('已经有一个任务在跑，等它结束再提交。');
    const host = this.host;
    if (!host) throw new CuaFailure('World 没有挂载，收不到任务。');
    const id = randomUUID();
    const job: DelegateJob = {
      id, task, allowAct, state: 'running', text: '', startedAt: Date.now(),
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    job.timer = setTimeout(() => {
      if (job.state !== 'running') return;
      job.state = 'timeout';
      job.text = '任务超过 ' + Math.round(deadlineMs / 1000) + ' 秒还没结束，已停止等待。';
      if (this.activeJob === job) this.activeJob = null;
    }, deadlineMs);
    this.activeJob = job;
    this.jobs.set(id, job);
    this.taskTurn = true;
    try {
      await host.pushEvent({
        type: 'cua.task',
        ts: new Date().toISOString(),
        source: this.id,
        text: this.taskText(task, allowAct),
        senderKey: 'astrbot',
        meta: { job: id, allowAct },
      });
    } catch (e) {
      job.state = 'failed';
      job.text = '没能把任务送进 Coo 的会话：' + (e instanceof Error ? e.message : String(e));
      clearTimeout(job.timer);
      this.taskTurn = false;
      if (this.activeJob === job) this.activeJob = null;
      throw new CuaFailure(job.text);
    }
    // Finished jobs only matter until the caller polls once; keep the map bounded.
    if (this.jobs.size > 64) {
      for (const [key, old] of this.jobs) {
        if (this.jobs.size <= 64) break;
        if (old.state !== 'running') this.jobs.delete(key);
      }
    }
    return job;
  }

  /** The turn that carried the task ended: its final text, or the outbox it wrote instead. */
  private completeActiveJob(text: string): void {
    const job = this.activeJob;
    if (!job || job.state !== 'running') return;
    const fromOutbox = this.outbox
      .filter((m) => m.ts >= new Date(job.startedAt).toISOString())
      .map((m) => m.text)
      .join('\n')
      .trim();
    job.state = 'done';
    job.text = (text || fromOutbox || '（Coo 没有给出文字结果）').trim();
    clearTimeout(job.timer);
    this.activeJob = null;
  }

  private stateFile(): string {
    return join(this.opts.dataDir, CUA_STATE_DIR, 'bridge.json');
  }

  /** Ask the person, at most once per level and kind; throws a readable refusal when they say no. */
  private async permit(what: string, kind: GrantKind, signal?: AbortSignal, sticky = true): Promise<void> {
    const level = this.askLevel(kind);
    if (level === 'never-ask') return;
    if (level === 'ask-once' && Date.now() < this.grantedUntil[kind]) return;
    if (this.turnGranted[kind] && level !== 'ask-each-command') return;
    // A no already given in this bot turn: fail without nagging. Bridge calls skip this, because
    // there is no turn to end — the person gets asked again on the next call.
    if (sticky && this.refusedThisTurn[kind]) throw new CuaFailure('这一轮已经拒绝过了，这次不做；等使用者换一轮再说。');
    const who = this.opts.botName || 'Coopanion';
    const question = who + ' 想' + what + '\n\n可以吗？（' + ASK_TIMEOUT_MS / 1000 + ' 秒不答按拒绝）';
    const ask = this.opts.ask ?? askDesktop;
    const answer = level === 'ask-each-command'
      ? await ask(question, 'CUA', ASK_TIMEOUT_MS, signal, this.host?.log)
      : await (this.pendingAsk[kind] ??= ask(question, 'CUA', ASK_TIMEOUT_MS, signal, this.host?.log));
    this.host?.log?.info('CUA approval', { kind, what, answer });
    // The box is closed whichever way it went; keeping it around would turn one unanswered
    // question into a permanent refusal for every later call.
    delete this.pendingAsk[kind];
    if (answer === 'error') {
      if (sticky) this.refusedThisTurn[kind] = true;
      throw new CuaFailure('确认框没能显示，这次什么也没做；请查看 Coopanion 运行日志里的 “CUA approval” 错误。');
    }
    if (answer !== 'yes') {
      if (sticky) this.refusedThisTurn[kind] = true;
      throw new CuaFailure(answer === 'timeout'
        ? '确认框没有回答，' + ASK_TIMEOUT_MS / 1000 + ' 秒后按拒绝处理，这次什么也没做。'
        : '使用者点了「否」，这次什么也没做。不要换个说法重试。');
    }
    this.turnGranted[kind] = true;
    if (level === 'ask-once') this.grantedUntil[kind] = Date.now() + (this.cfg.grantMinutes || CUA_DEFAULTS.grantMinutes) * 60_000;
  }

  private run<T>(op: Parameters<typeof runCua>[0], args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const call = this.opts.call ?? runCua;
    return call<T>(op, args, { timeoutMs: this.cfg.timeoutMs || CUA_DEFAULTS.timeoutMs, signal, log: this.host?.log });
  }

  /** One tool call, shared by the bot's tool table and the loopback bridge. Throws on refusal. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, sticky = true): Promise<ToolOutcome> {
    this.host?.log.info('CUA tool', { tool: name, caller: sticky ? 'bot' : 'bridge' });
    switch (name) {
      case 'cua_screenshot': {
        await this.permit('看一眼你的屏幕', 'read', signal, sticky);
        const display = typeof args.display === 'number' ? args.display : 1;
        const shot = await this.run<ShotResult>('screenshot', {
          display,
          maxWidth: this.cfg.screenshot?.maxWidth ?? CUA_DEFAULTS.screenshot.maxWidth,
          maxHeight: this.cfg.screenshot?.maxHeight ?? CUA_DEFAULTS.screenshot.maxHeight,
          quality: this.cfg.screenshot?.quality ?? CUA_DEFAULTS.screenshot.quality,
        }, signal);
        const screen = shot.screens.find((s) => s.index === shot.display) ?? shot.screens[0];
        const scale = Number(shot.scale) > 0 ? Number(shot.scale) : 1;
        if (screen) {
          this.shots.set(shot.display, { x: screen.x, y: screen.y, scale, width: shot.width, height: shot.height });
          this.lastDisplay = shot.display;
        }
        return {
          text: describeShot(shot),
          blobs: [{ bytes: Buffer.from(shot.base64, 'base64'), mime: shot.mime || 'image/jpeg', name: 'screen.jpg', fallbackText: '屏幕截图 ' + shot.width + '×' + shot.height }],
        };
      }
      case 'cua_windows': {
        await this.permit('看一眼你开了哪些窗口', 'read', signal, sticky);
        const list = await this.run<WindowEntry[]>('windows', {}, signal);
        return { text: describeWindows(list) };
      }
      case 'cua_click': {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: '[cua_click] 需要 x 与 y。', failed: true };
        const asked = Number(args.display);
        const display = Number.isInteger(asked) && asked > 0 ? asked : this.lastDisplay;
        const frame = this.shots.get(display);
        if (!frame) {
          return { text: '[cua_click] 没有可用的截图坐标：先调用 cua_screenshot' + (display ? '（显示器 ' + display + '）' : '') + '，再按那张图的像素点击。', failed: true };
        }
        if (x < 0 || y < 0 || x > frame.width || y > frame.height) {
          return { text: '[cua_click] (' + x + ', ' + y + ') 超出截图 ' + frame.width + '×' + frame.height + ' 的范围。', failed: true };
        }
        const px = Math.round(frame.x + x / frame.scale);
        const py = Math.round(frame.y + y / frame.scale);
        this.assertActAllowed();
        await this.ensureIdle(signal);
        await this.permit('把鼠标移到 (' + px + ', ' + py + ') 并点击', 'act', signal, sticky);
        await this.run('click', { x: px, y: py, button: args.button ?? 'left', clicks: args.clicks ?? 1 }, signal);
        return { text: '已点击截图坐标 (' + x + ', ' + y + ')，物理坐标 (' + px + ', ' + py + ')。' };
      }
      case 'cua_type': {
        const text = typeof args.text === 'string' ? args.text : '';
        if (!text) return { text: '[cua_type] text 不能为空。', failed: true };
        this.assertActAllowed();
        await this.ensureIdle(signal);
        await this.permit('在当前焦点输入 ' + text.length + ' 个字符', 'act', signal, sticky);
        await this.run('type', { text }, signal);
        return { text: '已输入 ' + text.length + ' 个字符。' };
      }
      case 'cua_key': {
        const keys = typeof args.keys === 'string' ? args.keys.trim() : '';
        if (!keys) return { text: '[cua_key] keys 不能为空。', failed: true };
        this.assertActAllowed();
        await this.ensureIdle(signal);
        await this.permit('按 ' + keys, 'act', signal, sticky);
        await this.run('key', { keys }, signal);
        return { text: '已按 ' + keys + '。' };
      }
      case 'cua_focus': {
        const window = typeof args.window === 'string' ? args.window : '';
        if (!window) return { text: '[cua_focus] window 不能为空。', failed: true };
        this.assertActAllowed();
        await this.ensureIdle(signal);
        await this.permit('把窗口「' + window + '」切到前台', 'act', signal, sticky);
        const out = await this.run<{ ok: boolean; foreground?: string }>('focus', { window }, signal);
        return { text: out.ok ? '已切到前台：' + (out.foreground || window) : '没能把「' + window + '」切到前台。', failed: out.ok ? undefined : true };
      }
      case 'cua_delegate': {
        const task = typeof args.task === 'string' ? args.task.trim() : '';
        if (!task) return { text: '[cua_delegate] task 不能为空。', failed: true };
        const allowAct = args.allow_act === true;
        const deadline = Math.min(300_000, Math.max(10_000, Number(args.deadline_ms) || 120_000));
        try {
          const job = await this.startJob(task, allowAct, deadline);
          return { text: '任务已交给 Coo（job ' + job.id + '）。用 cua_job 查结果；不要重复提交同一个任务。' };
        } catch (e) {
          return { text: e instanceof CuaFailure ? e.message : '提交任务失败：' + String(e), failed: true };
        }
      }
      case 'cua_job': {
        const id = typeof args.job_id === 'string' ? args.job_id.trim() : '';
        const job = this.jobs.get(id);
        if (!job) return { text: '[cua_job] 找不到这个 job：' + id, failed: true };
        if (job.state === 'running') {
          return { text: '任务还在跑（已 ' + Math.round((Date.now() - job.startedAt) / 1000) + ' 秒）。' };
        }
        return { text: job.text, failed: job.state === 'failed' || job.state === 'timeout' ? true : undefined };
      }
      case 'send_msg_to_astrbot': {
        const message = typeof args.message === 'string' ? args.message : '';
        return { text: await this.sendToAstrBot(message) };
      }
      default:
        throw new CuaFailure('没有这个工具：' + name);
    }
  }

  /**
   * The bot's view of this World. Empty unless `worlds.cua-bridge.exposeToBot` is on: by default the
   * tools belong to the bridge (AstrBot), and Coo never sees them in its tool table.
   */
  tools(): ToolDef[] {
    const { astrbot } = this.names();
    // Talking to the other bot is always on: it is this World's reason to exist even when the
    // screen tools stay off.
    const chat: ToolDef = {
      ...CHAT_TOOL_SPEC,
      description:
        '给另一个 bot「' + astrbot + '」发一条消息。' + astrbot + ' 不在本机，用不了这台电脑的鼠标和键盘，' +
        '但它能查资料、跑工具、回答你问它的问题。' +
        '它回的话会以「【' + astrbot + '】」开头作为下一条消息进来；发完不会立刻拿到回复。',
      parameters: {
        ...CHAT_TOOL_SPEC.parameters,
        properties: { message: { type: 'string', description: '要发给 ' + astrbot + ' 的话，一两句，把需要它做的事说清楚。' } },
      },
      handler: async (args: Record<string, unknown>) => ({
        text: await this.sendToAstrBot(typeof args.message === 'string' ? args.message : ''),
      }),
    };
    if (!this.cfg.exposeToBot) return [chat];
    return [chat, ...CUA_TOOL_SPECS.map((spec) => ({
      ...spec,
      interruptible: true,
      handler: (args: Record<string, unknown>, ctx: ToolCallContext) => this.call(spec.name, args, ctx.signal),
    }))];
  }

  async bridgeCall(name: string, args: Record<string, unknown>): Promise<BridgeOutcome> {
    // Bridge calls are not part of a bot turn, so a refusal must not stick to the next one.
    const out = await this.call(name, args, undefined, false);
    return {
      text: out.text,
      failed: out.failed === true,
      // BlobInput is either inline bytes or a handle into the host's blob store. The bridge only
      // carries inline bytes, so a handle-only blob is dropped rather than sent as an empty image.
      blobs: (out.blobs ?? []).flatMap((b) => ('bytes' in b ? [{ mime: b.mime, name: b.name ?? null, base64: Buffer.from(b.bytes).toString('base64') }] : [])),
    };
  }

  /**
   * The identity block: who you are, who the person is, who the other bot is, and which messages
   * come from whom. Written for the model, not for the person.
   */
  envPromptVars(): Record<string, string> {
    const { coo, astrbot, user } = this.names();
    const chat = [
      '【' + astrbot + '】开头的消息是 ' + astrbot + ' 发给你的；其它话都是 ' + user + ' 说的，别搞混。',
      '【' + astrbot + ' 的任务】开头的是它委托你做的事：在本机用 cua_* 完成，最后把结果写进回复，\n' +
        '不要用 send_msg_to_astrbot 回信；这次任务只跑一轮。',
      astrbot + ' 没有屏幕，也没有鼠标键盘：要看屏幕、动鼠标，只能由你来做。',
      '要主动找 ' + astrbot + '，用 send_msg_to_astrbot：它的回信会以【' + astrbot + '】开头作为新消息进来。\n' +
        '回信是下一轮；你可以回一次，但不要连续追问，等 ' + user + ' 开口再继续。',
    ].join('\n');
    const cuaParts: string[] = [];
    if (this.cfg.exposeToBot) {
      const readLevel = this.askLevel('read');
      const actLevel = this.askLevel('act');
      cuaParts.push(
        '你也能看 ' + user + ' 的屏幕、动鼠标键盘（cua_* 工具）：坐标一律是最近一次截图的像素，点之前先看一眼。',
        '看屏幕前：' + (ASK_TEXT[readLevel] ?? ''),
        '动鼠标键盘前：' + (ASK_TEXT[actLevel] ?? '') +
          (actLevel === 'never-ask' ? '' : ' 被拒绝就别换写法重试，等 ' + user + ' 开口。'),
        '动键鼠前会先等你停手；使用者一直在用电脑时这次操作会放弃。',
      );
      if (user) cuaParts.push('操作的是 ' + user + ' 自己的电脑，做完要说清楚你动了什么。');
    }
    return {
      'cua.coo': coo,
      'cua.astrbot': astrbot,
      'cua.user': user,
      'cua.chat': chat,
      'cua.cua': cuaParts.join('\n'),
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const en = language === 'en';
    const askRead = this.askLevel('read');
    const askAct = this.askLevel('act');
    const asking = Object.keys(this.pendingAsk).length > 0;
    const job = this.activeJob;
    return {
      label: 'CUA Bridge',
      lamps: [{
        label: en ? 'Bridge' : '桥接',
        state: this.bridge ? 'online' : 'offline',
        hint: this.bridge
          ? (en ? 'listening on 127.0.0.1:' + this.bridge.port : '监听 127.0.0.1:' + this.bridge.port)
          : (en ? 'off (worlds.cua-bridge.bridge)' : '关（worlds.cua-bridge.bridge）'),
      }, {
        label: en ? 'Waiting for you' : '在等你点头',
        state: asking ? 'online' : 'offline',
        hint: asking ? (en ? 'a question is open' : '桌面上有个确认框在等你') : (en ? 'no question open' : '没有在问的问题'),
      }, {
        label: en ? 'Task' : '任务',
        state: job ? 'online' : 'offline',
        hint: job ? (en ? 'a delegated job is running' : '有一个委托任务在跑') : (en ? 'no delegated job' : '没有在跑的任务'),
      }],
      badges: [
        { label: en ? 'Ask read' : '看屏幕', value: askRead, tone: askRead === 'never-ask' ? 'off' : 'on' },
        { label: en ? 'Ask act' : '动键鼠', value: askAct, tone: askAct === 'never-ask' ? 'off' : 'on' },
        { label: en ? 'To Coo' : '给 Coo 用', value: this.cfg.exposeToBot ? (en ? 'yes' : '是') : (en ? 'no' : '否'), tone: this.cfg.exposeToBot ? 'on' : 'off' },
        { label: en ? 'Shot' : '截图', value: (this.cfg.screenshot?.maxWidth ?? 1280) + '×' + (this.cfg.screenshot?.maxHeight ?? 800), tone: 'plain' },
        { label: en ? 'Bridge port' : '桥接端口', value: this.bridge ? String(this.bridge.port) : '—', tone: this.bridge ? 'plain' : 'off' },
      ],
      config: [CUA_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.' + CUA_ID + '.envPrompt',
        title: en ? 'CUA · Environment prompt' : 'CUA · 环境提示词',
        description: en
          ? 'Who is who, and who can reach whom.'
          : '谁是谁、谁能收到谁的消息。改这里就改了 Coo 对身份的理解。',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'cua.coo', description: en ? 'The pet bot’s name.' : '桌宠的名字。' },
          { name: 'cua.astrbot', description: en ? 'The other bot’s name.' : '另一个 bot 的名字。' },
          { name: 'cua.user', description: en ? 'The person at this computer.' : '坐在这台电脑前的人。' },
          { name: 'cua.chat', description: en ? 'Who may message whom, and how.' : '谁能给谁发消息、怎么发。' },
          { name: 'cua.cua', description: en ? 'Screen and mouse rules, when the bot has them.' : '机器人有屏幕权限时的规则。' },
        ],
      }],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.resetTurnGrants();
    this.grantedUntil = { read: 0, act: 0 };
    this.taskTurn = false;
    this.sentThisTurn = false;
    if (!this.cfg.bridge) return;
    const bridge = new Bridge({
      world: this.id,
      tools: () => BRIDGE_TOOL_SPECS,
      port: () => this.cfg.port ?? CUA_DEFAULTS.port,
      list: () => [CHAT_TOOL_SPEC.name, ...BRIDGE_TOOL_SPECS.map((t) => t.name)],
      call: (name, args) => this.bridgeCall(name, args),
      mailbox: () => this.drainOutbox(),
      identity: () => {
        const { coo, astrbot, user } = this.names();
        return {
          coo,
          astrbot,
          user,

          tools: BRIDGE_TOOL_SPECS.map((t) => t.name),
          exposeToBot: !!this.cfg.exposeToBot,
        };
      },
      chat: (text, waitMs) => this.receiveFromAstrBot(text, waitMs),
      hosts: () => (this.cfg.bridgeHosts || CUA_DEFAULTS.bridgeHosts).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
      stateFile: this.stateFile(),
      log: host.log,
    });
    try {
      await bridge.start();
      this.bridge = bridge;
    } catch (e) {
      host.log?.warn('CUA 桥接没起来，只有 Coo 能用这些工具', { reason: String(e) });
    }
  }

  async stop(): Promise<void> {
    if (this.activeJob) {
      clearTimeout(this.activeJob.timer);
      this.activeJob.state = 'failed';
      this.activeJob.text = 'World 已停止，任务中断。';
      this.activeJob = null;
    }
    await this.bridge?.stop();
    this.bridge = null;
    this.host = null;
    this.taskTurn = false;
    this.sentThisTurn = false;
    this.resetTurnGrants();
    this.grantedUntil = { read: 0, act: 0 };
  }
}

/** 回执形如：屏幕 1（1280×853，物理 2160×1440，缩放 0.556）；指针在 (100, 200)；前台窗口：… */
export function describeShot(shot: ShotResult): string {
  const screen = shot.screens.find((s) => s.index === shot.display) ?? shot.screens[0];
  const screens = shot.screens.length > 1
    ? '；显示器共 ' + shot.screens.length + ' 块：' + shot.screens.map((s: ScreenInfo) => '#' + s.index + ' ' + s.width + '×' + s.height + (s.primary ? '(主)' : '')).join('、')
    : '';
  const scale = Number(shot.scale) > 0 ? Number(shot.scale) : 1;
  const shownScale = Math.round(scale * 1000) / 1000;
  return '屏幕 ' + shot.display + '（' + shot.width + '×' + shot.height + '，物理 ' + (screen?.width ?? '?') + '×' + (screen?.height ?? '?') + '，缩放 ' + shownScale + '）' +
    '；指针在 (' + shot.cursor.x + ', ' + shot.cursor.y + ')' +
    '；前台窗口：' + (shot.foreground || '（无）') +
    screens +
    '。坐标帧：显示器 #' + shot.display + ' 原点 (' + (screen?.x ?? 0) + ', ' + (screen?.y ?? 0) + ')，点击坐标用这张图的像素，并带上 display=' + shot.display + '。';
}

/** One line per window, foreground first. */
export function describeWindows(list: WindowEntry[]): string {
  if (!Array.isArray(list) || list.length === 0) return '没有可见窗口。';
  const rows = list
    .slice()
    .sort((a, b) => Number(b.foreground) - Number(a.foreground))
    .map((w) => (w.foreground ? '* ' : '  ') + w.handle + '  ' + w.title + '  [pid ' + w.pid + (w.minimized ? ', 最小化' : '') + ']  ' +
      w.rect.width + '×' + w.rect.height + ' @(' + w.rect.x + ',' + w.rect.y + ')');
  return '可见窗口（* 为前台）：\n' + rows.join('\n');
}
