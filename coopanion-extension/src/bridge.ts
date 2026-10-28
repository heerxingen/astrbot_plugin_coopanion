/**
 * The loopback bridge: a small HTTP server on 127.0.0.1 so a program outside Coopanion (AstrBot,
 * a script, another agent) can use the same tools the World gives Coo.
 *
 * Why an HTTP server rather than the WebUI panel route: a World extension has no access to the
 * panel routing of the bundled worlds, and it must not depend on private routes of the app. It may
 * host its own environment — that is the sanctioned shape for a World that needs to talk to
 * something else on this machine (docs/DEVELOPMENT.md, "托管自己的环境").
 *
 * The token is generated once per deployment into <dataDir>/cua/bridge.json, next to the port
 * actually bound (the configured port may be taken), and reused on later starts. That file is the
 * discovery file: read it, send the token in a header. Nothing is written outside the deployment
 * directory.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export interface BridgeOutcome {
  text: string;
  failed: boolean;
  blobs: Array<{ mime: string; name: string | null; base64: string }>;
}

export interface BridgeTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tags?: readonly string[];
}

export interface BridgeOptions {
  /** World id reported by /v1/health. */
  world: string;
  /** Tools a client may call, with the JSON Schema the model needs. */
  tools: () => readonly BridgeTool[];
  /** Configured port; 0 picks a free one. */
  port: () => number;
  /** Names shown by GET /v1/health. */
  list: () => string[];
  /** Runs one tool; throws with a human-readable message when it is refused. */
  call: (name: string, args: Record<string, unknown>) => Promise<BridgeOutcome>;
  /** Who is who, for the other end's prompt. */
  identity: () => Record<string, unknown>;
  /** Delivers a message from the other bot into the bot's session; optionally waits for the reply. */
  chat: (text: string, waitMs: number) => Promise<{ delivered: boolean; reply: string; timedOut: boolean }>;
  /** Messages the bot tried to send while the other side was away; drained by GET /v1/mailbox. */
  mailbox: () => Array<{ ts: string; text: string }>;
  /** Host names answered, lower-case and without the port. Loopback by default; add the public name behind a tunnel. */
  hosts: () => string[];
  /** <dataDir>/cua/bridge.json — written on start, removed on stop. */
  stateFile: string;
  log?: Logger;
}

const PORT_ATTEMPTS = 10;
const BODY_MAX = 512 * 1024;

export class Bridge {
  private server: Server | null = null;
  private token = '';
  private bound = 0;
  private readonly opts: BridgeOptions;

  constructor(opts: BridgeOptions) {
    this.opts = opts;
  }

  get port(): number {
    return this.bound;
  }

  get url(): string | null {
    return this.bound ? 'http://127.0.0.1:' + this.bound : null;
  }

  async start(): Promise<number> {
    const base = this.opts.port();
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const server = createServer((req, res) => { void this.handle(req, res); });
      const port = base === 0 ? 0 : base + i;
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => { server.off('error', () => {}); resolve(true); });
      });
      if (!ok) continue;
      this.server = server;
      this.bound = (server.address() as { port: number }).port;
      // Reuse the deployment's token: an AstrBot configured with base + token must survive a
      // Coopanion restart. Only a missing or corrupt state file mints a new one.
      let previous = '';
      try {
        const saved = JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as { token?: unknown };
        if (typeof saved.token === 'string' && saved.token.length >= 32) previous = saved.token;
      } catch {
        // first start, or the file was removed
      }
      this.token = previous || randomBytes(32).toString('base64url');
      mkdirSync(dirname(this.opts.stateFile), { recursive: true });
      writeFileSync(
        this.opts.stateFile,
        JSON.stringify({ port: this.bound, token: this.token, tools: this.opts.list() }, null, 2) + '\n',
        { mode: 0o600 },
      );
      this.opts.log?.info('CUA 桥接已监听 http://127.0.0.1:' + this.bound + '，令牌见 ' + this.opts.stateFile);
      return this.bound;
    }
    throw new Error('CUA 桥接起不来：端口 ' + base + '–' + (base + PORT_ATTEMPTS - 1) + ' 都被占用。');
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.bound = 0;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Leave bridge.json in place: the token is the deployment's, not this run's.
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The listener is loopback-only, but a browser on this machine can still reach it; the token
    // and the Host check are what keep a web page from driving the desktop.
    const host = hostName(req.headers.host);
    if (!host || !this.opts.hosts().includes(host)) {
      res.writeHead(421).end();
      return;
    }
    if (!this.authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      json(res, 200, { ok: true, protocol: 1, world: this.opts.world, port: this.bound, tools: this.opts.list() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      json(res, 200, { ok: true, protocol: 1, tools: this.opts.tools() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/identity') {
      json(res, 200, { ok: true, ...this.opts.identity() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/v1/mailbox') {
      json(res, 200, { ok: true, messages: this.opts.mailbox() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat') {
      let body: { text?: unknown; waitMs?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { text?: unknown; waitMs?: unknown };
      } catch {
        json(res, 400, { ok: false, error: 'body is not JSON' });
        return;
      }
      const text = typeof body.text === 'string' ? body.text : '';
      const rawWait = typeof body.waitMs === 'number' && Number.isFinite(body.waitMs) ? body.waitMs : 0;
      // An HTTP request may hold the connection for a while, but not forever.
      const waitMs = Math.max(0, Math.min(120_000, Math.round(rawWait)));
      if (!text.trim()) {
        json(res, 400, { ok: false, error: 'text is required' });
        return;
      }
      try {
        const out = await this.opts.chat(text, waitMs);
        json(res, 200, { ok: true, from: 'astrbot', ...out });
      } catch (e) {
        json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/tool') {
      let body: { name?: unknown; args?: unknown };
      try {
        body = JSON.parse(await readBody(req)) as { name?: unknown; args?: unknown };
      } catch {
        json(res, 400, { ok: false, error: 'body is not JSON' });
        return;
      }
      const name = typeof body.name === 'string' ? body.name : '';
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
      if (!name) {
        json(res, 400, { ok: false, error: 'name is required' });
        return;
      }
      try {
        const out = await this.opts.call(name, args);
        json(res, 200, { ok: true, failed: out.failed, text: out.text, blobs: out.blobs });
      } catch (e) {
        // A refusal (the person said no, the call was interrupted) is a normal answer, not a 500.
        json(res, 200, { ok: true, failed: true, text: e instanceof Error ? e.message : String(e), blobs: [] });
      }
      return;
    }
    json(res, 404, { ok: false, error: 'no such route' });
  }

  private authorized(req: IncomingMessage): boolean {
    const head = req.headers.authorization;
    const bearer = typeof head === 'string' && head.toLowerCase().startsWith('bearer ') ? head.slice(7).trim() : '';
    const direct = typeof req.headers['x-cua-token'] === 'string' ? (req.headers['x-cua-token'] as string).trim() : '';
    const given = bearer || direct;
    if (!given || !this.token) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/** `example.com:8080` -> `example.com`; `[::1]:8080` -> `[::1]`. */
function hostName(header: string | undefined): string {
  const raw = (header ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    return end < 0 ? raw : raw.slice(0, end + 1);
  }
  return raw.split(':')[0] ?? '';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  // Decoding with replacement would store mojibake and blame nobody; refuse instead, so a caller
  // that sent GBK (or otherwise not UTF-8) gets told rather than quietly garbling its message.
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) throw new Error('body is not UTF-8');
  return text;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
