/**
 * CUA World: the screen and the mouse, as tools.
 *
 * Six tools — look, list windows, click, type, key, focus — each one a short PowerShell call
 * (src/engine.ts). The person is asked before the first call of a turn (or of a grant window),
 * through the system's own Yes/No box; a refusal is a failed tool with no side effect, and the
 * refusal stands for the rest of the turn so a retry does not nag.
 *
 * The same tools are served over a loopback HTTP bridge (src/bridge.ts) when `worlds.cua.bridge`
 * is on, which is how a program other than Coo (AstrBot, a script) uses them. The bridge goes
 * through the very same `call()`, so the approval above applies to it as well.
 */
import { join } from 'node:path';
import type { ToolCallContext, ToolDef, ToolOutcome, ToolSpec, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { CUA_CONFIG_GROUP, CUA_DEFAULTS, CUA_ID, type AskLevel, type CuaConfigSection } from './config.ts';
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
    description: '把鼠标移到截图的 (x, y) 并点击。点之前先 cua_screenshot 看一眼，确认坐标落在真的控件上。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', minimum: 0, description: '横坐标（截图像素）' },
        y: { type: 'integer', minimum: 0, description: '纵坐标（截图像素）' },
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
    description: '把某个窗口切到前台（最小化的先还原）。window 用 cua_windows 给的 handle，或标题的一部分。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { window: { type: 'string', description: '窗口 handle（0x...）或标题片段' } },
      required: ['window'],
    },
  },
];

/** The chat tool's static shape; the instance rewrites the description with the configured names. */
export const CHAT_TOOL_SPEC: ToolSpec = {
  name: 'send_msg_to_astrbot',
  tags: ['speak'],
  description:
    '给另一个 bot 发一条消息。它不在本机、用不了这台电脑的鼠标键盘，但能查资料、跑工具、回答问题。' +
    '发完不会立刻拿到回复；它回的话会以【…】开头出现在你的对话里。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', description: '要发过去的话，一两句，把需要它做的事说清楚。' } },
    required: ['message'],
  },
};

export interface CuaWorldOptions {
  /** `worlds.cua` live reference: hot keys are read at use. */
  cfg: CuaConfigSection;
  /** Name the approval box is signed with. */
  botName?: string;
  /** This World's own data directory (the deployment's, not the checkout's). */
  dataDir: string;
  /** Test seams. */
  call?: typeof runCua;
  ask?: typeof askDesktop;
}

export class CuaWorld implements World {
  readonly id = CUA_ID;
  private host: WorldHost | null = null;
  private bridge: Bridge | null = null;
  /** A yes for the current turn only. */
  private turnGranted = false;
  /** Until when an `ask-once` yes holds. */
  private grantedUntil = 0;
  /** In-flight question, so parallel calls in one round raise one box. */
  private pendingAsk: Promise<'yes' | 'no' | 'timeout'> | null = null;
  /** A refusal inside a bot turn sticks until that turn ends; a bridge call gets a fresh question. */
  private refusedThisTurn = false;
  /** Text the bot is currently writing, so a message from the other bot can be answered in place. */
  private tapText = '';
  /** Whether deltas were seen this turn; a finished item must not add the same text again. */
  private tapDelta = false;
  /** Callers waiting for the bot to finish its current turn (the bridge's `waitMs`). */
  private readonly replyWaiters: Array<(text: string) => void> = [];
  /** What the bot said to the other side while it was not listening: AstrBot drains this. */
  private readonly outbox: Array<{ ts: string; text: string }> = [];

  constructor(private readonly opts: CuaWorldOptions) {}

  onTurnEnded(): void {
    this.turnGranted = false;
    this.pendingAsk = null;
    this.refusedThisTurn = false;
    // The bot just finished speaking: hand the text to whoever is waiting (the bridge's waitMs).
    const text = this.tapText.trim();
    this.tapText = '';
    this.tapDelta = false;
    if (this.replyWaiters.length) for (const resolve of this.replyWaiters.splice(0)) resolve(text);
  }

  onHandoffEnded(): void {
    this.turnGranted = false;
    this.pendingAsk = null;
    this.refusedThisTurn = false;
  }

  private get cfg(): CuaConfigSection {
    return this.opts.cfg;
  }

  /** Who is who, as this World's prompt and tool texts say it. Nothing outside CUA is renamed. */
  names(): { coo: string; astrbot: string; user: string } {
    const n = this.cfg.names;
    return {
      coo: (n?.coo || this.opts.botName || 'Coo').trim(),
      astrbot: (n?.astrbot || 'AstrBot').trim(),
      user: (n?.user || '使用者').trim(),
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
   * Coo speaking first. The message goes into the outbox, which AstrBot drains with
   * `GET /v1/mailbox` on its next poll — that direction needs no inbound port on this machine,
   * which is what makes it work behind a one-way tunnel.
   */
  async sendToAstrBot(text: string): Promise<string> {
    const body = text.trim();
    if (!body) return '[send_msg_to_astrbot] message 不能为空。';
    this.outbox.push({ ts: new Date().toISOString(), text: body });
    return '已放进 ' + this.names().astrbot + ' 的信箱，它下次来取。';
  }

  private askLevel(): AskLevel {
    return this.cfg.ask || CUA_DEFAULTS.ask;
  }

  private stateFile(): string {
    return join(this.opts.dataDir, CUA_ID, 'bridge.json');
  }

  /** Ask the person, at most once per level; throws a readable refusal when they say no. */
  private async permit(what: string, signal?: AbortSignal, sticky = true): Promise<void> {
    const level = this.askLevel();
    if (level === 'never-ask') return;
    if (level === 'ask-once' && Date.now() < this.grantedUntil) return;
    if (this.turnGranted && level !== 'ask-each-command') return;
    // A no already given in this bot turn: fail without nagging. Bridge calls skip this, because
    // there is no turn to end — the person gets asked again on the next call.
    if (sticky && this.refusedThisTurn) throw new CuaFailure('这一轮已经拒绝过了，这次不做；等使用者换一轮再说。');
    const who = this.opts.botName || 'Coopanion';
    const question = who + ' 想' + what + '\n\n可以吗？（' + ASK_TIMEOUT_MS / 1000 + ' 秒不答按拒绝）';
    const ask = this.opts.ask ?? askDesktop;
    const answer = level === 'ask-each-command'
      ? await ask(question, 'CUA', ASK_TIMEOUT_MS, signal)
      : await (this.pendingAsk ??= ask(question, 'CUA', ASK_TIMEOUT_MS, signal));
    // The box is closed whichever way it went; keeping it around would turn one unanswered
    // question into a permanent refusal for every later call.
    this.pendingAsk = null;
    if (answer !== 'yes') {
      if (sticky) this.refusedThisTurn = true;
      throw new CuaFailure(answer === 'timeout'
        ? '确认框没有回答，' + ASK_TIMEOUT_MS / 1000 + ' 秒后按拒绝处理，这次什么也没做。'
        : '使用者点了「否」，这次什么也没做。不要换个说法重试。');
    }
    this.turnGranted = true;
    if (level === 'ask-once') this.grantedUntil = Date.now() + (this.cfg.grantMinutes || CUA_DEFAULTS.grantMinutes) * 60_000;
  }

  private run<T>(op: Parameters<typeof runCua>[0], args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const call = this.opts.call ?? runCua;
    return call<T>(op, args, { timeoutMs: this.cfg.timeoutMs || CUA_DEFAULTS.timeoutMs, signal, log: this.host?.log });
  }

  /** One tool call, shared by the bot's tool table and the loopback bridge. Throws on refusal. */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal, sticky = true): Promise<ToolOutcome> {
    switch (name) {
      case 'cua_screenshot': {
        await this.permit('看一眼你的屏幕', signal, sticky);
        const display = typeof args.display === 'number' ? args.display : 1;
        const shot = await this.run<ShotResult>('screenshot', {
          display,
          maxWidth: this.cfg.screenshot?.maxWidth ?? CUA_DEFAULTS.screenshot.maxWidth,
          maxHeight: this.cfg.screenshot?.maxHeight ?? CUA_DEFAULTS.screenshot.maxHeight,
          quality: this.cfg.screenshot?.quality ?? CUA_DEFAULTS.screenshot.quality,
        }, signal);
        return {
          text: describeShot(shot),
          blobs: [{ bytes: Buffer.from(shot.base64, 'base64'), mime: shot.mime || 'image/jpeg', name: 'screen.jpg', fallbackText: '屏幕截图 ' + shot.width + '×' + shot.height }],
        };
      }
      case 'cua_windows': {
        await this.permit('看一眼你开了哪些窗口', signal, sticky);
        const list = await this.run<WindowEntry[]>('windows', {}, signal);
        return { text: describeWindows(list) };
      }
      case 'cua_click': {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { text: '[cua_click] 需要 x 与 y。', failed: true };
        await this.permit('把鼠标移到 (' + x + ', ' + y + ') 并点击', signal, sticky);
        await this.run('click', { x, y, button: args.button ?? 'left', clicks: args.clicks ?? 1 }, signal);
        return { text: '已点击 (' + x + ', ' + y + ')。' };
      }
      case 'cua_type': {
        const text = typeof args.text === 'string' ? args.text : '';
        if (!text) return { text: '[cua_type] text 不能为空。', failed: true };
        await this.permit('在当前焦点输入 ' + text.length + ' 个字符', signal, sticky);
        await this.run('type', { text }, signal);
        return { text: '已输入 ' + text.length + ' 个字符。' };
      }
      case 'cua_key': {
        const keys = typeof args.keys === 'string' ? args.keys.trim() : '';
        if (!keys) return { text: '[cua_key] keys 不能为空。', failed: true };
        await this.permit('按 ' + keys, signal, sticky);
        await this.run('key', { keys }, signal);
        return { text: '已按 ' + keys + '。' };
      }
      case 'cua_focus': {
        const window = typeof args.window === 'string' ? args.window : '';
        if (!window) return { text: '[cua_focus] window 不能为空。', failed: true };
        await this.permit('把窗口「' + window + '」切到前台', signal, sticky);
        const out = await this.run<{ ok: boolean; foreground?: string }>('focus', { window }, signal);
        return { text: out.ok ? '已切到前台：' + (out.foreground || window) : '没能把「' + window + '」切到前台。', failed: out.ok ? undefined : true };
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
   * The bot's view of this World. Empty unless `worlds.cua.exposeToBot` is on: by default the
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
        '但它能查资料、跑工具、回答你问它的问题。它回的话会以「【' + astrbot + '】」开头出现在你的对话里。' +
        '发完不会立刻拿到回复；把它当"发信"，不是"对话"。',
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
      astrbot + ' 没有屏幕，也没有鼠标键盘：要看屏幕、动鼠标，只能由你来做。',
      '要主动找 ' + astrbot + '，用 send_msg_to_astrbot：消息会放进它的信箱，它下次来取，不会立刻有回音。' +
        astrbot + ' 的回话会以【' + astrbot + '】开头进来。',
    ].join('\n');
    const cuaParts: string[] = [];
    if (this.cfg.exposeToBot) {
      const level = this.askLevel();
      cuaParts.push(
        '你也能看 ' + user + ' 的屏幕、动鼠标键盘（cua_* 工具）：坐标一律是最近一次 cua_screenshot 的像素，点之前先看一眼。',
        (ASK_TEXT[level] ?? '') + (level === 'never-ask' ? '' : ' 被拒绝就别换写法重试，等 ' + user + ' 开口。'),
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
    const level = this.askLevel();
    return {
      label: 'CUA',
      lamps: [{
        label: en ? 'Bridge' : '桥接',
        state: this.bridge ? 'online' : 'offline',
        hint: this.bridge
          ? (en ? 'listening on 127.0.0.1:' + this.bridge.port : '监听 127.0.0.1:' + this.bridge.port)
          : (en ? 'off (worlds.cua.bridge)' : '关（worlds.cua.bridge）'),
      }, {
        label: en ? 'Waiting for you' : '在等你点头',
        state: this.pendingAsk ? 'online' : 'offline',
        hint: this.pendingAsk ? (en ? 'a question is open' : '桌面上有个确认框在等你') : (en ? 'no question open' : '没有在问的问题'),
      }],
      badges: [
        { label: en ? 'Ask' : '先问你', value: level, tone: level === 'never-ask' ? 'off' : 'on' },
        { label: en ? 'To Coo' : '给 Coo 用', value: this.cfg.exposeToBot ? (en ? 'yes' : '是') : (en ? 'no' : '否'), tone: this.cfg.exposeToBot ? 'on' : 'off' },
        { label: en ? 'Shot' : '截图', value: (this.cfg.screenshot?.maxWidth ?? 1280) + '×' + (this.cfg.screenshot?.maxHeight ?? 800), tone: 'plain' },
        { label: en ? 'Bridge port' : '桥接端口', value: this.bridge ? String(this.bridge.port) : '—', tone: this.bridge ? 'plain' : 'off' },
      ],
      config: [CUA_CONFIG_GROUP],
      promptDocs: [{
        key: 'worlds.cua.envPrompt',
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
    this.turnGranted = false;
    this.grantedUntil = 0;
    this.pendingAsk = null;
    if (!this.cfg.bridge) return;
    const bridge = new Bridge({
      port: () => this.cfg.port ?? CUA_DEFAULTS.port,
      list: () => [CHAT_TOOL_SPEC.name, ...CUA_TOOL_SPECS.map((t) => t.name)],
      call: (name, args) => this.bridgeCall(name, args),
      mailbox: () => this.drainOutbox(),
      identity: () => {
        const { coo, astrbot, user } = this.names();
        return {
          coo,
          astrbot,
          user,

          tools: CUA_TOOL_SPECS.map((t) => t.name),
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
    await this.bridge?.stop();
    this.bridge = null;
    this.host = null;
    this.turnGranted = false;
    this.grantedUntil = 0;
    this.pendingAsk = null;
  }
}

/** 回执形如：屏幕 1（1280×853，物理 2160×1440）；指针在 (100, 200)；前台窗口：… */
export function describeShot(shot: ShotResult): string {
  const screens = shot.screens.length > 1
    ? '；显示器共 ' + shot.screens.length + ' 块：' + shot.screens.map((s: ScreenInfo) => '#' + s.index + ' ' + s.width + '×' + s.height + (s.primary ? '(主)' : '')).join('、')
    : '';
  return '屏幕 ' + shot.display + '（' + shot.width + '×' + shot.height + '，物理 ' + (shot.screens[0]?.width ?? '?') + '×' + (shot.screens[0]?.height ?? '?') + '）' +
    '；指针在 (' + shot.cursor.x + ', ' + shot.cursor.y + ')' +
    '；前台窗口：' + (shot.foreground || '（无）') +
    screens +
    '。之后的坐标都是这张截图的像素。';
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
