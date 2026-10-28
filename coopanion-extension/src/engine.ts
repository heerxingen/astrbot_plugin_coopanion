/**
 * The engine: one PowerShell process per call, JSON in / JSON out (scripts/cua.ps1).
 *
 * A child process keeps the World from blocking the Core's event loop, makes a timeout a plain
 * kill, and means a hung screen call cannot wedge the whole app. The price is one process start
 * per call (~150-300 ms on this machine), which is nothing next to a model round.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'cortico/core/types.ts';

export const CUA_SCRIPT = fileURLToPath(new URL('../scripts/cua.ps1', import.meta.url));
export const ASK_SCRIPT = fileURLToPath(new URL('../scripts/ask.ps1', import.meta.url));

export type CuaOp =
  | 'info' | 'idle' | 'screenshot' | 'windows' | 'click' | 'move' | 'drag' | 'scroll' | 'type' | 'key' | 'focus';

export class CuaFailure extends Error {}

export interface RunOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  log?: Logger;
}

/** Everything the engine reports for a display: physical pixels, 1-based index, left to right. */
export interface ScreenInfo {
  index: number;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShotResult {
  ok: true;
  display: number;
  width: number;
  height: number;
  scale: number;
  screens: ScreenInfo[];
  cursor: { x: number; y: number };
  foreground: string;
  mime: string;
  base64: string;
}

export interface WindowEntry {
  handle: string;
  title: string;
  pid: number;
  foreground: boolean;
  minimized: boolean;
  rect: { x: number; y: number; width: number; height: number };
}

export function runCua<T>(op: CuaOp, args: Record<string, unknown>, opts: RunOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CUA_SCRIPT, '-Op', op, '-Json', JSON.stringify(args)],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => reject(new CuaFailure('被中断，这次调用没有执行完。')));
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { out += chunk; });
    child.stderr.on('data', (chunk: string) => { err += chunk; });

    child.on('error', (e) => finish(() => reject(new CuaFailure('起不来 PowerShell：' + e.message))));
    child.on('close', (code) => {
      if (timedOut) {
        finish(() => reject(new CuaFailure('超过 ' + opts.timeoutMs + ' ms 没有返回，进程已终止。')));
        return;
      }
      const text = out.trim();
      if (!text) {
        finish(() => reject(new CuaFailure('引擎没有输出（exit=' + code + '）。' + (err.trim() ? ' ' + err.trim().slice(0, 500) : ''))));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish(() => reject(new CuaFailure('引擎输出不是 JSON：' + text.slice(0, 300))));
        return;
      }
      const result = parsed as { ok?: boolean; error?: string };
      if (result && result.ok === false) {
        finish(() => reject(new CuaFailure(result.error || '引擎报告失败')));
        return;
      }
      finish(() => resolve(parsed as T));
    });
  });
}

/**
 * The approval box, in a child process so a wait does not block the World.
 * Anything but an explicit Yes is a refusal — including the timeout, which kills the dialog.
 */
export function askDesktop(question: string, title: string, timeoutMs: number, signal?: AbortSignal, log?: Logger): Promise<'yes' | 'no' | 'timeout' | 'error'> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ASK_SCRIPT], {
      windowsHide: false,
      env: { ...process.env, CUA_ASK_TEXT: question, CUA_ASK_TITLE: title },
    });
    let settled = false;
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    const done = (answer: 'yes' | 'no' | 'timeout' | 'error'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    const fail = (reason: string): void => {
      log?.warn('CUA approval box did not open', { reason, stderr: stderr.trim().slice(0, 500) });
      done('error');
    };
    const onAbort = (): void => { child.kill(); done('no'); };
    const timer = setTimeout(() => { child.kill(); done('timeout'); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', (e) => fail(e.message));
    child.on('close', (code) => {
      if (code === 0) done('yes');
      else if (code === 2) fail('ask.ps1 exited 2');
      else done('no');
    });
  });
}
