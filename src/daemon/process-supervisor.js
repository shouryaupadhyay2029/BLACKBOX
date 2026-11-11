/**
 * BLACKBOX Daemon — Multi-Process Stream & PTY Supervisor
 * Spawns and supervises backend/frontend dev commands, passes ANSI output transparently
 * to the developer's terminal, coalesces multi-line stack trace bursts (15ms window),
 * parses stack frames + local source code snippets, and feeds the Blackbox Ring Buffer.
 */

import { spawn } from 'node:child_process';
import { parseStackAndCode, stripAnsi } from '../core/stack-parser.js';
import { nowPreciseMs } from '../core/ring-buffer.js';

const TRACE_TOKEN_REGEX = /(?:X-Blackbox-Trace-Id|X-Kala-Trace-Id|traceId|trace_id|trace:)[=:\s]+([a-zA-Z0-9_-]{6,64})/i;
const CRASH_KEYWORDS_REGEX =
  /(unhandledrejection|uncaught exception|typeerror:|referenceerror:|syntaxerror:|rangeerror:|traceback \(most recent call last\)|panic:|fatal error:|segmentation fault|eaddrinuse|error:)/i;

export class ProcessSupervisor {
  /**
   * @param {object} options
   * @param {import('../core/ring-buffer.js').KalaRingBuffer} options.ringBuffer
   * @param {Function} [options.onCrashDetected] Callback when a fatal backend error is detected
   * @param {string} [options.cwd]
   * @param {boolean} [options.passthrough=true] Whether to echo output to parent stdout/stderr
   */
  constructor(options = {}) {
    this.ringBuffer = options.ringBuffer;
    this.onCrashDetected = options.onCrashDetected || null;
    this.cwd = options.cwd || process.cwd();
    this.passthrough = options.passthrough ?? true;

    /** @type {Map<string, object>} */
    this.processes = new Map();
  }

  /**
   * Spawns a supervised command and hooks its stdout/stderr streams into KALA.
   * @param {object} spec
   * @param {string} spec.name Logical service name (e.g. 'api-server', 'web')
   * @param {string} spec.command Shell command to run
   * @param {string} [spec.cwd] Working directory
   * @param {object} [spec.env] Additional environment variables
   */
  spawnProcess({ name = 'app', command, cwd = this.cwd, env = {} }) {
    const startTimeMs = nowPreciseMs();

    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        BLACKBOX_ACTIVE: '1',
        KALA_ACTIVE: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const procEntry = {
      name,
      command,
      pid: child.pid,
      cwd,
      startTimeMs,
      status: 'running',
      exitCode: null,
      child,
    };

    this.processes.set(name, procEntry);

    this.ringBuffer.push({
      plane: 'TERMINAL',
      type: 'PROCESS_START',
      severity: 'info',
      source: name,
      payload: {
        name,
        command,
        pid: child.pid,
        cwd,
      },
    });

    // Coalesce burst chunks (15ms) so multi-line stack traces stay intact
    this._attachStreamCollector(child.stdout, name, 'TERMINAL_STDOUT', false);
    this._attachStreamCollector(child.stderr, name, 'TERMINAL_STDERR', true);

    child.on('exit', (code, signal) => {
      procEntry.status = 'exited';
      procEntry.exitCode = code;
      const isAbnormal = code !== 0 && code !== null;

      const evt = this.ringBuffer.push({
        plane: 'TERMINAL',
        type: 'PROCESS_EXIT',
        severity: isAbnormal ? 'error' : 'info',
        source: name,
        payload: {
          name,
          pid: child.pid,
          exitCode: code,
          signal,
          text: `[BLACKBOX] Process "${name}" (PID ${child.pid}) exited with code ${code}${
            signal ? ` (signal ${signal})` : ''
          }`,
        },
      });

      if (isAbnormal && this.onCrashDetected) {
        this.onCrashDetected({
          reason: `PROCESS_EXIT_${code}`,
          source: name,
          event: evt,
        });
      }
    });

    return procEntry;
  }

  _attachStreamCollector(stream, procName, eventType, isStderr) {
    let buffer = '';
    let flushTimer = null;
    let firstChunkMs = null;

    const flush = () => {
      flushTimer = null;
      if (!buffer) return;
      const rawText = buffer;
      const ts = firstChunkMs || nowPreciseMs();
      buffer = '';
      firstChunkMs = null;

      const cleanText = stripAnsi(rawText);
      const traceMatch = TRACE_TOKEN_REGEX.exec(cleanText);
      const traceId = traceMatch ? traceMatch[1] : null;

      const stackInfo = parseStackAndCode(cleanText, this.cwd);
      const hasCrashKeyword = CRASH_KEYWORDS_REGEX.test(cleanText);

      let severity = isStderr ? 'warn' : 'info';
      if (stackInfo.hasStack || (isStderr && hasCrashKeyword)) {
        severity = 'error';
      }

      const evt = this.ringBuffer.push({
        timestampMs: ts,
        plane: 'TERMINAL',
        type: eventType,
        severity,
        traceId,
        source: procName,
        payload: {
          processName: procName,
          rawAnsi: rawText.slice(0, 16000),
          text: cleanText.slice(0, 16000),
          stackInfo: stackInfo.hasStack ? stackInfo : undefined,
        },
      });

      if ((stackInfo.hasStack || (isStderr && hasCrashKeyword)) && this.onCrashDetected) {
        this.onCrashDetected({
          reason: stackInfo.hasStack ? 'BACKEND_STACK_TRACE' : 'BACKEND_STDERR_ERROR',
          source: procName,
          event: evt,
        });
      }
    };

    stream.on('data', (chunk) => {
      const str = chunk.toString('utf8');
      if (this.passthrough) {
        if (isStderr) {
          process.stderr.write(str);
        } else {
          process.stdout.write(str);
        }
      }

      if (!firstChunkMs) {
        firstChunkMs = nowPreciseMs();
      }
      buffer += str;

      if (buffer.length > 12000) {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, 18);
      }
    });

    stream.on('end', () => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    });
  }

  /**
   * Lists all supervised processes and their live states.
   */
  listProcesses() {
    return Array.from(this.processes.values()).map(
      ({ child, ...metadata }) => metadata
    );
  }

  /**
   * Gracefully stops all supervised child processes.
   */
  stopAll() {
    for (const entry of this.processes.values()) {
      try {
        if (entry.child && entry.status === 'running') {
          entry.child.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
    }
  }
}
