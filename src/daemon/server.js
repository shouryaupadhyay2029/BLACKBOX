/**
 * BLACKBOX Daemon — Main Flight Recorder Engine & WebSocket/HTTP Bridge
 * Coordinates the 60s Rolling Ring Buffer, Process Supervisor, Capsule Vault,
 * Auto-Freeze Grace Window Engine, Browser Telemetry Ingestion, and Blackbox Studio UI.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { BlackboxRingBuffer } from '../core/ring-buffer.js';
import { CapsuleVault } from '../core/capsule-vault.js';
import { captureGitState } from '../core/git-inspector.js';
import { resolveLocalFile, extractSourceSnippet } from '../core/stack-parser.js';
import { resolveBrowserStackWithSourceMaps } from '../core/sourcemap-resolver.js';
import { ProcessSupervisor } from './process-supervisor.js';

function freePortIfOccupied(port) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const lines = out.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && (parts[3] === 'LISTENING' || parts[3] === 'ESTABLISHED')) {
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0' && pid !== String(process.pid)) {
            try {
              execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  } else {
    try {
      execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' });
    } catch {
      // ignore
    }
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STUDIO_DIR = path.resolve(__dirname, '../studio');
const SDK_FILE = path.resolve(__dirname, '../sdk/browser-agent.js');

export class BlackboxDaemonServer {
  /**
   * @param {object} options
   * @param {number} [options.port=9876] Port for Blackbox Daemon & Studio UI
   * @param {number} [options.windowMs=60000] Rolling buffer retention window (ms)
   * @param {string} [options.projectCwd] Target repository directory
   * @param {boolean} [options.autoFreeze=true] Auto-freeze capsule on unhandled crash/5xx
   * @param {boolean} [options.passthrough=true] Pass child process stdout/stderr to terminal
   */
  constructor(options = {}) {
    this.port = options.port || 9876;
    this.windowMs = options.windowMs || 60_000;
    this.projectCwd = options.projectCwd || process.cwd();
    this.autoFreeze = options.autoFreeze ?? true;

    this.ringBuffer = new BlackboxRingBuffer({ windowMs: this.windowMs });
    this.vault = new CapsuleVault({ projectCwd: this.projectCwd });

    this.supervisor = new ProcessSupervisor({
      ringBuffer: this.ringBuffer,
      cwd: this.projectCwd,
      passthrough: options.passthrough ?? true,
      onCrashDetected: (info) => {
        if (this.autoFreeze) {
          this.scheduleAutoFreeze(info.reason, `Auto-frozen on ${info.reason} in ${info.source}`);
        }
      },
    });

    this.httpServer = null;
    this.wss = null;
    this.studioClients = new Set();
    this.agentClients = new Set();

    // Auto-freeze grace window, source-map resolution & cooldown state
    this.pendingFreezeTimer = null;
    this.lastAutoFreezeMs = 0;
    this.autoFreezeCooldownMs = 3500;
    this._pendingSourceMapTasks = new Set();
  }

  /**
   * Waits briefly (max 350ms) for any in-flight dev-server Source Map lookups to finish
   * before freezing a capsule so browser TSX/JSX stack lines map 1:1 to disk.
   */
  async _waitForSourceMaps(timeoutMs = 350) {
    if (this._pendingSourceMapTasks.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this._pendingSourceMapTasks]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  /**
   * Schedules an automatic capsule freeze after a 350ms grace window so trailing
   * stack trace lines, source-map resolutions, response bodies, and UI error states
   * are all captured together.
   */
  scheduleAutoFreeze(triggerReason, defaultTitle = '') {
    const now = Date.now();
    if (now - this.lastAutoFreezeMs < this.autoFreezeCooldownMs) {
      return; // Within cooldown of a just-captured crash capsule
    }
    if (this.pendingFreezeTimer) {
      return; // Already waiting in the 350ms grace window
    }

    this.pendingFreezeTimer = setTimeout(async () => {
      this.pendingFreezeTimer = null;
      this.lastAutoFreezeMs = Date.now();
      await this._waitForSourceMaps(350);
      this.freezeNow({
        triggerReason,
        title: defaultTitle,
      });
    }, 350);
  }

  /**
   * Immediately freezes the rolling buffer into a permanent Time-Travel Bug Capsule.
   */
  freezeNow({ triggerReason = 'MANUAL_FREEZE', title = '', notes = '', durationMs } = {}) {
    const slice = this.ringBuffer.freezeSlice({ durationMs });
    const capsule = this.vault.createCapsule({
      slice,
      triggerReason,
      title,
      notes,
    });

    this._broadcastToStudio({
      type: 'CAPSULE_FROZEN',
      capsule: this._toSummary(capsule),
    });

    return capsule;
  }

  /**
   * Starts the HTTP + WebSocket Flight Recorder Daemon.
   */
  async start() {
    this.httpServer = http.createServer((req, res) => this._handleHttpRequest(req, res));

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => this._handleWsConnection(ws, req));

    // Forward live ring buffer events to connected Studio UIs
    this.ringBuffer.subscribe((event) => {
      this._broadcastToStudio({
        type: 'LIVE_EVENT',
        event,
      });
    });

    return new Promise((resolve, reject) => {
      freePortIfOccupied(this.port);
      this.httpServer.on('error', reject);
      this.httpServer.listen(this.port, '127.0.0.1', () => {
        resolve(this.port);
      });
    });
  }

  _handleWsConnection(ws, req) {
    const url = new URL(req.url || '/ws', `http://127.0.0.1:${this.port}`);
    const role = url.searchParams.get('role') || 'agent';

    if (role === 'studio') {
      this.studioClients.add(ws);
      ws.send(
        JSON.stringify({
          type: 'INIT_STATE',
          stats: this.ringBuffer.getStats(),
          processes: this.supervisor.listProcesses(),
          capsules: this.vault.listCapsules().slice(0, 25),
        })
      );
    } else {
      this.agentClients.add(ws);
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        this._handleIncomingAgentMessage(msg, ws);
      } catch {
        // Ignore malformed frame
      }
    });

    ws.on('close', () => {
      this.studioClients.delete(ws);
      this.agentClients.delete(ws);
    });
  }

  _handleIncomingAgentMessage(msg, ws) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.action === 'INGEST_EVENT' && msg.event) {
      this._ingestTelemetryEvent(msg.event);
    } else if (msg.action === 'INGEST_BATCH' && Array.isArray(msg.events)) {
      for (const ev of msg.events) {
        this._ingestTelemetryEvent(ev);
      }
    } else if (msg.action === 'FREEZE_CAPSULE') {
      this._waitForSourceMaps(250).then(() => {
        const capsule = this.freezeNow({
          triggerReason: msg.triggerReason || 'BROWSER_HOTKEY_FREEZE',
          title: msg.title || '',
          notes: msg.notes || '',
        });
        if (ws && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              type: 'CAPSULE_CREATED',
              capsuleId: capsule.id,
              title: capsule.title,
              studioUrl: `http://localhost:${this.port}/?capsule=${capsule.id}`,
            })
          );
        }
      });
    }
  }

  _ingestTelemetryEvent(rawEvent) {
    // Prevents KALA Studio's own UI clicks/network from polluting target app buffer
    const srcUrl = String(rawEvent.source || rawEvent.payload?.url || '');
    if (
      srcUrl.includes(`:${this.port}`) &&
      !rawEvent.allowStudioSelfCapture
    ) {
      return null;
    }

    const evt = this.ringBuffer.push(rawEvent);

    // Enrich localhost browser stack traces with exact original TypeScript/TSX line numbers via live Vite/Next Source Maps
    if (
      evt.plane === 'BROWSER' &&
      (evt.type === 'UNCAUGHT_ERROR' ||
        evt.type === 'UNHANDLED_REJECTION' ||
        (evt.type === 'CONSOLE' && evt.severity === 'error'))
    ) {
      const rawStack = evt.payload?.stack || (evt.type === 'CONSOLE' ? evt.payload?.message : '') || '';
      if (/https?:\/\/(localhost|127\.0\.0\.1)/i.test(rawStack)) {
        const smTask = resolveBrowserStackWithSourceMaps(rawStack)
          .then((mapped) => {
            if (mapped && mapped !== rawStack) {
              if (evt.payload?.stack) {
                evt.payload.rawCompiledStack = evt.payload.stack;
                evt.payload.stack = mapped;
              } else if (evt.type === 'CONSOLE') {
                evt.payload.stack = mapped;
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            this._pendingSourceMapTasks.delete(smTask);
          });
        this._pendingSourceMapTasks.add(smTask);
      }
    }

    // Check if auto-freeze should fire on unhandled browser errors, React console stack errors, or 5xx network traces
    if (this.autoFreeze) {
      const consoleMsg = String(evt.payload?.message || '');
      const isBrowserConsoleCrash =
        evt.plane === 'BROWSER' &&
        evt.type === 'CONSOLE' &&
        evt.severity === 'error' &&
        /(TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|The above error occurred in)/i.test(consoleMsg) &&
        /\bat\s+/.test(consoleMsg);

      if (
        evt.plane === 'BROWSER' &&
        (evt.type === 'UNCAUGHT_ERROR' || evt.type === 'UNHANDLED_REJECTION' || isBrowserConsoleCrash)
      ) {
        this.scheduleAutoFreeze(
          evt.type,
          `Browser ${evt.type}: ${(evt.payload?.message || 'Exception').split('\n')[0].slice(0, 70)}`
        );
      } else if (
        evt.plane === 'NETWORK' &&
        evt.type === 'HTTP_TRACE' &&
        (evt.payload?.status || 0) >= 500
      ) {
        this.scheduleAutoFreeze(
          `HTTP_${evt.payload.status}`,
          `HTTP ${evt.payload.status} on ${evt.payload.method || 'GET'} ${evt.payload.url || ''}`
        );
      }
    }

    return evt;
  }

  async _handleHttpRequest(req, res) {
    // Universal CORS so any localhost port or browser extension can talk to Blackbox
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Blackbox-Trace-Id, X-Blackbox-Trigger-Action, X-Kala-Trace-Id, X-Kala-Trigger-Action'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. Serve Browser Agent SDK
      if (pathname === '/sdk/browser-agent.js') {
        const code = fs.readFileSync(SDK_FILE, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(code);
        return;
      }

      // 2. REST API Endpoints
      if (pathname === '/api/status' && req.method === 'GET') {
        const git = captureGitState(this.projectCwd);
        const procs = this.supervisor.listProcesses();
        return this._sendJson(res, 200, {
          ok: true,
          daemonPort: this.port,
          projectCwd: this.projectCwd,
          projectName: path.basename(this.projectCwd) || 'localhost',
          demoRunning: procs.some((p) => p.name === 'nexuspay-api' && p.status === 'running'),
          autoFreeze: this.autoFreeze,
          connectedBrowserAgents: this.agentClients.size,
          connectedStudios: this.studioClients.size,
          buffer: this.ringBuffer.getStats(),
          processes: procs,
          git: {
            isGitRepo: git.isGitRepo,
            branch: git.branch,
            headCommit: git.headCommit,
            isDirty: git.isDirty,
            modifiedCount: git.modifiedFiles.length,
          },
          totalCapsules: this.vault.listCapsules().length,
        });
      }

      if (pathname === '/api/buffer' && req.method === 'GET') {
        const durationMs = Number(parsedUrl.searchParams.get('durationMs')) || this.windowMs;
        const slice = this.ringBuffer.freezeSlice({ durationMs });
        return this._sendJson(res, 200, slice);
      }

      if (pathname === '/api/buffer/clear' && req.method === 'POST') {
        this.ringBuffer.clear();
        this._broadcastToStudio({ type: 'BUFFER_CLEARED' });
        return this._sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/ingest' && req.method === 'POST') {
        const body = await this._readJsonBody(req);
        if (Array.isArray(body.events)) {
          for (const e of body.events) this._ingestTelemetryEvent(e);
        } else if (body.event) {
          this._ingestTelemetryEvent(body.event);
        } else {
          this._ingestTelemetryEvent(body);
        }
        return this._sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/freeze' && req.method === 'POST') {
        const body = await this._readJsonBody(req);
        await this._waitForSourceMaps(250);
        const capsule = this.freezeNow({
          triggerReason: body.triggerReason || 'MANUAL_FREEZE',
          title: body.title || '',
          notes: body.notes || '',
          durationMs: body.durationMs,
        });
        return this._sendJson(res, 200, {
          ok: true,
          capsule,
          studioUrl: `http://localhost:${this.port}/?capsule=${capsule.id}`,
        });
      }

      if (pathname === '/api/capsules' && req.method === 'GET') {
        return this._sendJson(res, 200, {
          ok: true,
          capsules: this.vault.listCapsules(),
        });
      }

      if (pathname === '/api/capsules' && req.method === 'DELETE') {
        const deletedCount = this.vault.clearAllCapsules();
        return this._sendJson(res, 200, { ok: true, deletedCount });
      }

      if (pathname === '/api/capsules/diff' && req.method === 'GET') {
        const idA = parsedUrl.searchParams.get('a');
        const idB = parsedUrl.searchParams.get('b');
        const diff = this.vault.diffCapsules(idA, idB);
        return this._sendJson(res, 200, { ok: true, diff });
      }

      if (pathname === '/api/capsules/import' && req.method === 'POST') {
        const body = await this._readJsonBody(req);
        const imported = this.vault.importCapsule(body.capsule || body);
        return this._sendJson(res, 200, { ok: true, capsule: imported });
      }

      if (pathname.startsWith('/api/capsules/') && req.method === 'PATCH') {
        const id = decodeURIComponent(pathname.replace('/api/capsules/', ''));
        const body = await this._readJsonBody(req);
        const updated = this.vault.updateCapsule(id, {
          title: body.title,
          notes: body.notes,
        });
        if (!updated) {
          return this._sendJson(res, 404, { ok: false, error: `Capsule "${id}" not found` });
        }
        return this._sendJson(res, 200, { ok: true, capsule: updated });
      }

      if (pathname.startsWith('/api/capsules/') && req.method === 'DELETE') {
        const id = decodeURIComponent(pathname.replace('/api/capsules/', ''));
        const ok = this.vault.deleteCapsule(id);
        return this._sendJson(res, 200, { ok, id });
      }

      if (pathname.startsWith('/api/capsules/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.replace('/api/capsules/', ''));
        const capsule = this.vault.getCapsule(id);
        if (!capsule) {
          return this._sendJson(res, 404, { ok: false, error: `Capsule "${id}" not found` });
        }
        return this._sendJson(res, 200, { ok: true, capsule });
      }

      if (pathname === '/api/source' && req.method === 'GET') {
        const rawFile = parsedUrl.searchParams.get('file');
        const line = parseInt(parsedUrl.searchParams.get('line') || '1', 10);
        const radius = parseInt(parsedUrl.searchParams.get('radius') || '8', 10);

        if (!rawFile) {
          return this._sendJson(res, 400, { ok: false, error: 'Missing "file" query parameter' });
        }

        const resolved = resolveLocalFile(rawFile, this.projectCwd);
        if (!resolved) {
          return this._sendJson(res, 404, { ok: false, error: `File not found: ${rawFile}` });
        }

        const snippet = extractSourceSnippet(resolved, line, radius);
        return this._sendJson(res, 200, { ok: true, snippet, resolvedPath: resolved });
      }

      if (pathname === '/api/git' && req.method === 'GET') {
        const git = captureGitState(this.projectCwd);
        return this._sendJson(res, 200, { ok: true, git });
      }

      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await this._readJsonBody(req);
        if (typeof body.autoFreeze === 'boolean') {
          this.autoFreeze = body.autoFreeze;
        }
        return this._sendJson(res, 200, { ok: true, autoFreeze: this.autoFreeze });
      }

      // 3. Static Files for KALA Blackbox Studio UI
      let staticFile = pathname === '/' ? 'index.html' : pathname.slice(1);
      const safePath = path.normalize(path.join(STUDIO_DIR, staticFile));
      if (safePath.startsWith(STUDIO_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        const mimeMap = {
          '.html': 'text/html; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.webp': 'image/webp',
        };
        res.writeHead(200, {
          'Content-Type': mimeMap[ext] || 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(fs.readFileSync(safePath));
        return;
      }

      this._sendJson(res, 404, { ok: false, error: 'Not Found' });
    } catch (err) {
      this._sendJson(res, 500, { ok: false, error: err.message });
    }
  }

  _broadcastToStudio(payload) {
    if (this.studioClients.size === 0) return;
    const serialized = JSON.stringify(payload);
    for (const client of this.studioClients) {
      if (client.readyState === 1) {
        try {
          client.send(serialized);
        } catch {
          // ignore
        }
      }
    }
  }

  _toSummary(capsule) {
    return {
      id: capsule.id,
      createdAt: capsule.createdAt,
      createdAtMs: capsule.createdAtMs,
      triggerReason: capsule.triggerReason,
      title: capsule.title,
      status: capsule.status,
      totalEvents: capsule.window.totalEvents,
      durationMs: capsule.window.durationMs,
      planeCounts: capsule.window.planeCounts,
      totalChains: capsule.causal.totalChains,
      culpritFile: capsule.causal.rootCauseSummary?.culpritFile || null,
      culpritLine: capsule.causal.rootCauseSummary?.culpritLine || null,
      gitBranch: capsule.git?.branch || null,
      gitDirty: Boolean(capsule.git?.isDirty),
    };
  }

  _sendJson(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  _readJsonBody(req, maxBytes = 25 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total <= maxBytes) {
          chunks.push(c);
        }
      });
      req.on('end', () => {
        if (total > maxBytes) {
          return reject(new Error('Request payload exceeds 25MB limit'));
        }
        try {
          const str = Buffer.concat(chunks).toString('utf8');
          resolve(str ? JSON.parse(str) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }

  stop() {
    if (this.pendingFreezeTimer) clearTimeout(this.pendingFreezeTimer);
    this.supervisor.stopAll();
    if (this.wss) this.wss.close();
    if (this.httpServer) this.httpServer.close();
  }
}

// Backward-compatibility alias
export const KalaDaemonServer = BlackboxDaemonServer;
