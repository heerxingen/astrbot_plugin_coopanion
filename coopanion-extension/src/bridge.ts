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
 * actually bound (the configured port may be taken). That file is the discovery file: read it, send
 * the token in a header. Nothing is written outside the deployment directory.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export interface BridgeOutcome {
  text: string;
  failed: boolean;
  blobs: Array<{ mime: string; name: string | null; base64: string }>;
}

export interface BridgeOptions {
  /** Configured port; 0 picks a free one. */
  port: () => number;
  /** Names shown by GET /v1/health. */
  list: () => string[];
  /** Runs one tool; throws with a human-readable message when it is refused. */
  call: (name: string, args: Record<string, unknown>) => Promise<BridgeOutcome>;
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
      this.token = randomBytes(32).toString('base64url');
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
    try { rmSync(this.opts.stateFile, { force: true }); } catch { /* nothing to clean */ }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The listener is loopback-only, but a browser on this machine can still reach it; the token
    // and the Host check are what keep a web page from driving the desktop.
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) {
      res.writeHead(421).end();
      return;
    }
    if (!this.authorized(req)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      json(res, 200, { ok: true, world: 'cua', port: this.bound, tools: this.opts.list() });
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_MAX) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
