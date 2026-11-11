#!/usr/bin/env node
/**
 * KALA CLI — The Localhost Flight Recorder & Causal Time-Travel Capsule System
 *
 * Commands:
 *   kala run "<command>" [--port 9876] [--proxy 4000:3000]  Supervise any dev command with 60s rolling flight recorder
 *   kala demo                                               Launch KALA Studio + Interactive Full-Stack Target Sandbox
 *   kala studio [--port 9876]                               Start KALA Blackbox Studio & Daemon standalone
 *   kala freeze [--title "..."]                             Trigger an immediate capsule freeze on the active daemon
 *   kala capsules                                           List all saved Bug Capsules in the vault
 *   kala inspect [capsuleId|latest]                         Print the full Causal Fault Chain & AI Root-Cause Markdown
 *   kala mcp                                                Start the stdio Model Context Protocol (MCP) server
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KalaDaemonServer } from '../src/daemon/server.js';
import { WiretapProxy } from '../src/daemon/wiretap-proxy.js';
import { CapsuleVault } from '../src/core/capsule-vault.js';
import { KalaMcpServer } from '../src/mcp/mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const subcommand = args[0] || 'help';

function parseFlag(flagName, defaultValue = null) {
  const idx = args.indexOf(flagName);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  return defaultValue;
}

function printBanner(daemonPort, extraLines = []) {
  console.log('\x1b[35m╔══════════════════════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m⚡ KALA — LOCALHOST FLIGHT RECORDER & CAUSAL TIME-TRAVEL ENGINE\x1b[0m         \x1b[35m║\x1b[0m');
  console.log('\x1b[35m╠══════════════════════════════════════════════════════════════════════════╣\x1b[0m');
  console.log(`\x1b[35m║\x1b[0m  🕰️  Blackbox Studio UI : \x1b[1m\x1b[32mhttp://localhost:${daemonPort}\x1b[0m                         \x1b[35m║\x1b[0m`);
  console.log(`\x1b[35m║\x1b[0m  🔌 Browser Agent SDK  : \x1b[36mhttp://localhost:${daemonPort}/sdk/browser-agent.js\x1b[0m   \x1b[35m║\x1b[0m`);
  for (const line of extraLines) {
    console.log(`\x1b[35m║\x1b[0m  ${line}`);
  }
  console.log('\x1b[35m║\x1b[0m  ❄️  Shortcut           : Press \x1b[1mAlt+Shift+B\x1b[0m in Browser or \x1b[1mCtrl+B\x1b[0m here     \x1b[35m║\x1b[0m');
  console.log('\x1b[35m╚══════════════════════════════════════════════════════════════════════════╝\x1b[0m\n');
}

function attachTerminalHotkey(daemon) {
  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      // Ctrl+C -> exit cleanly
      if (key[0] === 3) {
        console.log('\n[KALA] Shutting down Flight Recorder Daemon...');
        daemon.stop();
        process.exit(0);
      }
      // Ctrl+B (ASCII 2) -> Freeze Capsule immediately
      if (key[0] === 2) {
        const cap = daemon.freezeNow({ triggerReason: 'CLI_HOTKEY_CTRL_B' });
        console.log(
          `\n\x1b[32m❄️ [KALA] Frozen Bug Capsule: ${cap.id} -> http://localhost:${daemon.port}/?capsule=${cap.id}\x1b[0m\n`
        );
      }
    });
  } catch {
    // Ignore raw mode errors in non-interactive shells
  }
}

async function main() {
  const port = Number(parseFlag('--port', process.env.KALA_PORT || 9876));

  if (subcommand === 'mcp') {
    const mcp = new KalaMcpServer({ projectCwd: process.cwd() });
    mcp.startStdio();
    return;
  }

  if (subcommand === 'capsules') {
    const vault = new CapsuleVault({ projectCwd: process.cwd() });
    const list = vault.listCapsules();
    if (list.length === 0) {
      console.log('No capsules found in .kala/capsules.');
      return;
    }
    console.log(`\nFound ${list.length} KALA Bug Capsule(s):\n`);
    for (const c of list) {
      const tag = c.status === 'FAULT_DETECTED' ? '\x1b[31m[FAULT]\x1b[0m' : '\x1b[32m[OK]\x1b[0m';
      console.log(
        `- ${tag} \x1b[1m${c.id}\x1b[0m (${new Date(c.createdAt).toLocaleTimeString()}) :: ${c.title}`
      );
      if (c.culpritFile) {
        console.log(`    Culprit: ${c.culpritFile}:${c.culpritLine || '?'}`);
      }
    }
    return;
  }

  if (subcommand === 'inspect') {
    const targetId = args[1] || 'latest';
    const vault = new CapsuleVault({ projectCwd: process.cwd() });
    const cap = vault.getCapsule(targetId);
    if (!cap) {
      console.error(`Capsule "${targetId}" not found.`);
      process.exit(1);
    }
    console.log(cap.aiDiagnosticMarkdown || vault.compileAiDiagnosticPrompt(cap));
    return;
  }

  if (subcommand === 'freeze') {
    const title = parseFlag('--title', '');
    const res = await fetch(`http://127.0.0.1:${port}/api/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggerReason: 'CLI_FREEZE_COMMAND', title }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('Freeze failed:', data.error);
      process.exit(1);
    }
    console.log(`❄️ Capsule Frozen: ${data.capsule.id}`);
    console.log(`🔗 Open in Studio: ${data.studioUrl}\n`);
    console.log(data.capsule.aiDiagnosticMarkdown);
    return;
  }

  if (subcommand === 'demo') {
    const demoPort = Number(parseFlag('--demo-port', 4400));
    const daemon = new KalaDaemonServer({
      port,
      projectCwd: path.resolve(__dirname, '..'),
    });
    await daemon.start();

    const demoServerScript = path.resolve(__dirname, '../src/demo/demo-server.js');
    daemon.supervisor.spawnProcess({
      name: 'nexuspay-api',
      command: `node "${demoServerScript}"`,
      cwd: path.resolve(__dirname, '..'),
      env: { DEMO_PORT: String(demoPort), KALA_PORT: String(port) },
    });

    printBanner(port, [
      `🎯 Target Sandbox App : \x1b[1m\x1b[33mhttp://localhost:${demoPort}\x1b[0m                         \x1b[35m║\x1b[0m`,
    ]);
    attachTerminalHotkey(daemon);
    return;
  }

  if (subcommand === 'studio') {
    const daemon = new KalaDaemonServer({ port, projectCwd: process.cwd() });
    await daemon.start();
    printBanner(port);
    attachTerminalHotkey(daemon);
    return;
  }

  if (subcommand === 'run') {
    const cmdToRun = args
      .slice(1)
      .filter((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--port' && arr[i - 1] !== '--name' && arr[i - 1] !== '--proxy')
      .join(' ');

    if (!cmdToRun) {
      console.error('Usage: kala run "<command>" [--name api] [--port 9876] [--proxy 4000:3000]');
      process.exit(1);
    }

    const procName = parseFlag('--name', 'dev-server');
    const proxySpec = parseFlag('--proxy', null);

    const daemon = new KalaDaemonServer({ port, projectCwd: process.cwd() });
    await daemon.start();

    const extraBanner = [
      `🚀 Supervised Command : \x1b[1m${cmdToRun}\x1b[0m (${procName})`,
    ];

    if (proxySpec && proxySpec.includes(':')) {
      const [listenPortStr, targetPortStr] = proxySpec.split(':');
      const proxy = new WiretapProxy({
        listenPort: Number(listenPortStr),
        targetOrigin: `http://127.0.0.1:${targetPortStr}`,
        kalaPort: port,
        ringBuffer: daemon.ringBuffer,
        onHttp5xx: (info) => daemon.scheduleAutoFreeze(info.reason),
      });
      await proxy.start();
      extraBanner.push(
        `🕵️  Wiretap Proxy      : \x1b[36mhttp://localhost:${listenPortStr} -> 127.0.0.1:${targetPortStr}\x1b[0m`
      );
    }

    printBanner(port, extraBanner);
    daemon.supervisor.spawnProcess({
      name: procName,
      command: cmdToRun,
      cwd: process.cwd(),
    });
    attachTerminalHotkey(daemon);
    return;
  }

  // Help output
  printBanner(port);
  console.log('Usage:');
  console.log('  kala demo                                  Launch KALA Studio + Interactive Target Sandbox');
  console.log('  kala run "<cmd>" [--proxy 4000:3000]       Supervise any backend/frontend dev command');
  console.log('  kala studio [--port 9876]                  Run KALA Daemon & Blackbox Studio UI');
  console.log('  kala freeze [--title "..."]                Freeze the active 60s rolling ring buffer');
  console.log('  kala capsules                              List all captured Time-Travel Bug Capsules');
  console.log('  kala inspect [capsuleId|latest]            Print Causal Fault Chain & AI Diagnostic Markdown');
  console.log('  kala mcp                                   Start stdio Model Context Protocol (MCP) server');
}

main().catch((err) => {
  console.error('[KALA Fatal Error]:', err);
  process.exit(1);
});
