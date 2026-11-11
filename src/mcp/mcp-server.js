/**
 * KALA MCP Server — Model Context Protocol (JSON-RPC 2.0 over stdio)
 * Enables AI coding agents (Antigravity, Cursor, Claude Code, Windsurf, Zed)
 * to directly inspect full-stack bug capsules, causal chains, terminal stack traces,
 * local source code X-rays, and uncommitted Git diffs.
 */

import readline from 'node:readline';
import { CapsuleVault } from '../core/capsule-vault.js';

export class KalaMcpServer {
  constructor(options = {}) {
    this.projectCwd = options.projectCwd || process.cwd();
    this.daemonUrl = options.daemonUrl || 'http://127.0.0.1:9876';
    this.vault = new CapsuleVault({ projectCwd: this.projectCwd });
  }

  startStdio() {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    rl.on('line', async (line) => {
      if (!line.trim()) return;
      try {
        const req = JSON.parse(line);
        const res = await this.handleJsonRpc(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch (err) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${err.message}` },
          }) + '\n'
        );
      }
    });
  }

  async handleJsonRpc(req) {
    const { id, method, params } = req;

    // Notifications do not expect a response
    if (id === undefined || id === null) {
      return null;
    }

    try {
      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'kala-flight-recorder-mcp',
              version: '1.0.0',
            },
          },
        };
      }

      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'list_capsules',
                description:
                  'Lists captured KALA Time-Travel Bug Capsules with status, trigger reason, culprit file:line, and timestamps.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    limit: { type: 'number', description: 'Max capsules to return (default 15)' },
                  },
                },
              },
              {
                name: 'get_latest_crash_capsule',
                description:
                  'Returns the full Causal Fault Graph, Browser UI click, failed HTTP payload, Backend Terminal stack trace, Local Source Code X-Ray, and Uncommitted Git Diff for the latest (or specified) Bug Capsule.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    capsuleId: {
                      type: 'string',
                      description: 'Optional capsule ID (defaults to "latest")',
                    },
                  },
                },
              },
              {
                name: 'inspect_capsule_timeline',
                description:
                  'Filters raw microsecond-indexed telemetry events inside a capsule by plane (BROWSER, NETWORK, TERMINAL) or traceId.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    capsuleId: { type: 'string', description: 'Capsule ID or "latest"' },
                    plane: {
                      type: 'string',
                      enum: ['BROWSER', 'NETWORK', 'TERMINAL', 'GIT', 'ALL'],
                    },
                    traceId: { type: 'string', description: 'Optional causal trace ID filter' },
                  },
                },
              },
              {
                name: 'freeze_live_buffer',
                description:
                  'Triggers an immediate live freeze of the running KALA Flight Recorder 60s rolling buffer and returns the analyzed capsule.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    title: { type: 'string', description: 'Optional title for the capsule' },
                  },
                },
              },
              {
                name: 'diff_capsules',
                description:
                  'Compares two capsules (capsuleIdA vs capsuleIdB) to detect HTTP status regressions, latency changes, and Git working-tree diffs.',
                inputSchema: {
                  type: 'object',
                  properties: {
                    capsuleIdA: { type: 'string' },
                    capsuleIdB: { type: 'string' },
                  },
                  required: ['capsuleIdA', 'capsuleIdB'],
                },
              },
            ],
          },
        };
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const args = params?.arguments || {};
        const toolOutput = await this._executeTool(toolName, args);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text:
                  typeof toolOutput === 'string'
                    ? toolOutput
                    : JSON.stringify(toolOutput, null, 2),
              },
            ],
          },
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err.message },
      };
    }
  }

  async _executeTool(name, args) {
    if (name === 'list_capsules') {
      const list = this.vault.listCapsules().slice(0, args.limit || 15);
      return { total: list.length, capsules: list };
    }

    if (name === 'get_latest_crash_capsule') {
      const cap = this.vault.getCapsule(args.capsuleId || 'latest');
      if (!cap) return 'No capsules found in vault.';
      return cap.aiDiagnosticMarkdown || this.vault.compileAiDiagnosticPrompt(cap);
    }

    if (name === 'inspect_capsule_timeline') {
      const cap = this.vault.getCapsule(args.capsuleId || 'latest');
      if (!cap) return 'No capsule found.';
      let events = cap.events || [];
      if (args.plane && args.plane !== 'ALL') {
        events = events.filter((e) => e.plane === args.plane);
      }
      if (args.traceId) {
        events = events.filter((e) => e.traceId === args.traceId);
      }
      // Strip bulky HTML strings so MCP output stays concise
      const concise = events.map((e) => {
        if (e.type === 'DOM_SNAPSHOT' && e.payload?.html) {
          return {
            ...e,
            payload: { ...e.payload, html: `[HTML ${e.payload.html.length} chars]` },
          };
        }
        return e;
      });
      return {
        capsuleId: cap.id,
        matchedEvents: concise.length,
        events: concise.slice(0, 60),
      };
    }

    if (name === 'freeze_live_buffer') {
      const res = await fetch(`${this.daemonUrl}/api/freeze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          triggerReason: 'MCP_AGENT_FREEZE',
          title: args.title || '',
        }),
      });
      const data = await res.json();
      if (!data.ok || !data.capsule) {
        throw new Error(data.error || 'Failed to freeze live buffer');
      }
      return data.capsule.aiDiagnosticMarkdown;
    }

    if (name === 'diff_capsules') {
      return this.vault.diffCapsules(args.capsuleIdA, args.capsuleIdB);
    }

    throw new Error(`Unknown MCP tool: ${name}`);
  }
}
