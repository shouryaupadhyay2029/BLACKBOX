#!/usr/bin/env node
/**
 * BLACKBOX CLI — The Localhost Flight Recorder & Causal Time-Travel Capsule System
 *
 * Commands:
 *   blackbox init [--inject]                                    Initialize Blackbox Vault & MCP configs (.cursor/mcp.json) in current project
 *   blackbox doctor                                             Verify Node, Git, Vault permissions, Daemon & MCP readiness
 *   blackbox demo                                               Launch Blackbox Studio + Interactive Full-Stack Target Sandbox
 *   blackbox run "<command>" [--port 9876] [--proxy 4000:3000]  Supervise any dev command with 60s rolling flight recorder
 *   blackbox studio [--port 9876]                               Start Blackbox Studio & Daemon standalone
 *   blackbox freeze [--title "..."]                             Trigger an immediate capsule freeze on the active daemon
 *   blackbox capsules                                           List all saved Bug Capsules in the vault
 *   blackbox inspect [capsuleId|latest]                         Print the full Causal Fault Chain & AI Root-Cause Markdown
 *   blackbox mcp                                                Start the stdio Model Context Protocol (MCP) server
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { BlackboxDaemonServer } from '../src/daemon/server.js';
import { WiretapProxy } from '../src/daemon/wiretap-proxy.js';
import { CapsuleVault } from '../src/core/capsule-vault.js';
import { BlackboxMcpServer } from '../src/mcp/mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  console.log('\x1b[35m║\x1b[0m  \x1b[1m\x1b[36m⚡ BLACKBOX — LOCALHOST FLIGHT RECORDER & CAUSAL TIME-TRAVEL ENGINE\x1b[0m     \x1b[35m║\x1b[0m');
  console.log('\x1b[35m╠══════════════════════════════════════════════════════════════════════════╣\x1b[0m');
  console.log(`\x1b[35m║\x1b[0m  🕰️  Blackbox Studio UI : \x1b[1m\x1b[32mhttp://localhost:${daemonPort}\x1b[0m                         \x1b[35m║\x1b[0m`);
  console.log(`\x1b[35m║\x1b[0m  🔌 Browser Agent SDK  : \x1b[36mhttp://localhost:${daemonPort}/sdk/browser-agent.js\x1b[0m   \x1b[35m║\x1b[0m`);
  for (const line of extraLines) {
    console.log(`\x1b[35m║\x1b[0m  ${line}`);
  }
  console.log('\x1b[35m║\x1b[0m  ❄️  Shortcut           : Press \x1b[1mAlt+Shift+B\x1b[0m in Browser or \x1b[1mCtrl+B\x1b[0m here     \x1b[35m║\x1b[0m');
  console.log('\x1b[35m╚══════════════════════════════════════════════════════════════════════════╝\x1b[0m\n');
}

function attachTerminalHotkey(daemon, onCleanup = null) {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      if (typeof onCleanup === 'function') onCleanup();
      daemon.stop();
    } catch {
      // ignore
    }
  };

  process.once('SIGINT', () => {
    console.log('\n[BLACKBOX] Received SIGINT. Terminating Flight Recorder...');
    cleanup();
    process.exit(0);
  });

  process.once('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  process.once('exit', () => {
    cleanup();
  });

  if (!process.stdin.isTTY) return;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      if (key[0] === 3) {
        console.log('\n[BLACKBOX] Shutting down Flight Recorder Daemon...');
        cleanup();
        process.exit(0);
      }
      if (key[0] === 2) {
        const cap = daemon.freezeNow({ triggerReason: 'CLI_HOTKEY_CTRL_B' });
        console.log(
          `\n\x1b[32m❄️ [BLACKBOX] Frozen Bug Capsule: ${cap.id} -> http://localhost:${daemon.port}/?capsule=${cap.id}\x1b[0m\n`
        );
      }
    });
  } catch {
    // Ignore raw mode errors in non-interactive shells
  }
}

async function main() {
  const port = Number(parseFlag('--port', process.env.BLACKBOX_PORT || process.env.KALA_PORT || 9876));

  if (subcommand === '--version' || subcommand === '-v' || subcommand === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    console.log(`${pkg.name} v${pkg.version}`);
    return;
  }

  if (subcommand === 'init') {
    const cwd = process.cwd();
    console.log(`\n⚡ Initializing BLACKBOX in ${cwd}...\n`);

    // 1. Create .blackbox/capsules directory
    const capsulesDir = path.join(cwd, '.blackbox', 'capsules');
    fs.mkdirSync(capsulesDir, { recursive: true });
    console.log('  \x1b[32m✔\x1b[0m Created archival vault directory: .blackbox/capsules');

    // 2. Ensure .blackbox/ is in .gitignore
    const gitignorePath = path.join(cwd, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf8');
      if (!gitignore.includes('.blackbox')) {
        fs.appendFileSync(gitignorePath, '\n.blackbox/\n', 'utf8');
        console.log('  \x1b[32m✔\x1b[0m Added .blackbox/ to .gitignore');
      } else {
        console.log('  \x1b[32m✔\x1b[0m .blackbox/ already present in .gitignore');
      }
    }

    // 3. Configure .cursor/mcp.json for Cursor / Windsurf
    const cursorDir = path.join(cwd, '.cursor');
    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    fs.mkdirSync(cursorDir, { recursive: true });
    let cursorConfig = { mcpServers: {} };
    if (fs.existsSync(cursorMcpPath)) {
      try {
        cursorConfig = JSON.parse(fs.readFileSync(cursorMcpPath, 'utf8'));
        cursorConfig.mcpServers = cursorConfig.mcpServers || {};
      } catch {
        cursorConfig = { mcpServers: {} };
      }
    }
    cursorConfig.mcpServers.blackbox = {
      command: 'blackbox',
      args: ['mcp'],
    };
    fs.writeFileSync(cursorMcpPath, JSON.stringify(cursorConfig, null, 2) + '\n', 'utf8');
    console.log('  \x1b[32m✔\x1b[0m Configured MCP server in .cursor/mcp.json');

    // 4. Configure .mcp.json for Claude Code / Antigravity / Zed
    const stdMcpPath = path.join(cwd, '.mcp.json');
    let stdConfig = { mcpServers: {} };
    if (fs.existsSync(stdMcpPath)) {
      try {
        stdConfig = JSON.parse(fs.readFileSync(stdMcpPath, 'utf8'));
        stdConfig.mcpServers = stdConfig.mcpServers || {};
      } catch {
        stdConfig = { mcpServers: {} };
      }
    }
    stdConfig.mcpServers.blackbox = {
      command: 'blackbox',
      args: ['mcp'],
    };
    fs.writeFileSync(stdMcpPath, JSON.stringify(stdConfig, null, 2) + '\n', 'utf8');
    console.log('  \x1b[32m✔\x1b[0m Configured MCP server in .mcp.json');

    // 5. Optional HTML SDK injection if --inject passed
    const sdkTag = `<script src="http://localhost:${port}/sdk/browser-agent.js" data-blackbox-endpoint="http://localhost:${port}"></script>`;
    if (args.includes('--inject')) {
      const candidates = [
        path.join(cwd, 'index.html'),
        path.join(cwd, 'public', 'index.html'),
      ];
      let injectedAny = false;
      for (const htmlFile of candidates) {
        if (fs.existsSync(htmlFile)) {
          let content = fs.readFileSync(htmlFile, 'utf8');
          if (!content.includes('browser-agent.js')) {
            if (/<\/head>/i.test(content)) {
              content = content.replace(/<\/head>/i, `  ${sdkTag}\n</head>`);
            } else {
              content = `${sdkTag}\n${content}`;
            }
            fs.writeFileSync(htmlFile, content, 'utf8');
            console.log(`  \x1b[32m✔\x1b[0m Injected Browser Agent SDK into ${path.relative(cwd, htmlFile)}`);
            injectedAny = true;
          } else {
            console.log(`  \x1b[32m✔\x1b[0m Browser Agent SDK already present in ${path.relative(cwd, htmlFile)}`);
            injectedAny = true;
          }
        }
      }
      if (!injectedAny) {
        console.log('  \x1b[33mℹ\x1b[0m No static index.html found (e.g. Next.js / backend-only).');
        console.log('    Use the Wiretap Proxy (`blackbox run "<cmd>" --proxy 4000:3000`) or paste the <script> tag into your root layout.');
      }
    }

    console.log('\n🚀 \x1b[1mBlackbox initialized! Next steps:\x1b[0m');
    console.log(`  1. Add to your frontend HTML <head> (or run 'blackbox init --inject'):\n     \x1b[36m${sdkTag}\x1b[0m`);
    console.log('  2. Supervise your dev server:\n     \x1b[32mblackbox run "npm run dev"\x1b[0m');
    console.log(`  3. Open Blackbox Studio UI:\n     \x1b[32mhttp://localhost:${port}\x1b[0m\n`);
    return;
  }

  if (subcommand === 'doctor') {
    console.log('\n🩺 \x1b[1mBLACKBOX ENVIRONMENT DIAGNOSTICS (DOCTOR)\x1b[0m\n');
    const nodeVer = process.versions.node;
    const major = Number(nodeVer.split('.')[0]);
    console.log(`  ${major >= 18 ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'} Node.js Runtime       : v${nodeVer} (requires >= 18.0.0)`);

    try {
      const gitVer = execSync('git --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      console.log(`  \x1b[32m✔\x1b[0m Git Inspector         : ${gitVer}`);
    } catch {
      console.log('  \x1b[33m!\x1b[0m Git Inspector         : git not found on PATH');
    }

    const vault = new CapsuleVault({ projectCwd: process.cwd() });
    const count = vault.listCapsules().length;
    console.log(`  \x1b[32m✔\x1b[0m Archival Vault        : ${vault.storageDir} (${count} capsules indexed)`);

    const mcp = new BlackboxMcpServer({ projectCwd: process.cwd() });
    const rpcRes = await mcp.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    console.log(`  \x1b[32m✔\x1b[0m MCP Server Engine     : ${rpcRes.result.serverInfo.name} v${rpcRes.result.serverInfo.version} (ready)`);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      const data = await res.json();
      if (data.ok) {
        console.log(`  \x1b[32m✔\x1b[0m Active Daemon (:${port}) : ONLINE (${data.buffer.activeEvents} events in ring buffer · project: ${data.projectName || 'localhost'})`);
      }
    } catch {
      console.log(`  \x1b[36mℹ\x1b[0m Active Daemon (:${port}) : Standby (start with 'blackbox demo' or 'blackbox run "..."')`);
    }
    console.log('\n✅ All Blackbox core systems are healthy and ready.\n');
    return;
  }

  if (subcommand === 'mcp') {
    const mcp = new BlackboxMcpServer({
      projectCwd: process.env.BLACKBOX_PROJECT_CWD || process.env.KALA_PROJECT_CWD || process.cwd(),
      daemonUrl: `http://127.0.0.1:${port}`,
    });
    mcp.startStdio();
    return;
  }

  if (subcommand === 'capsules') {
    const vault = new CapsuleVault({ projectCwd: process.cwd() });
    const onlyFaults = args.includes('--faults');
    const limit = Number(parseFlag('--limit', 25));
    let list = vault.listCapsules();
    if (onlyFaults) {
      list = list.filter((c) => c.status === 'FAULT_DETECTED');
    }
    if (list.length === 0) {
      console.log(onlyFaults ? 'No FAULT_DETECTED capsules found in .blackbox/capsules.' : 'No capsules found in .blackbox/capsules.');
      return;
    }
    const shown = list.slice(0, limit);
    console.log(`\nFound ${list.length} Blackbox Bug Capsule(s)${list.length > shown.length ? ` (showing latest ${shown.length})` : ''}:\n`);
    for (const c of shown) {
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

  if (subcommand === 'diff') {
    const vault = new CapsuleVault({ projectCwd: process.cwd() });
    const list = vault.listCapsules();
    let idA = args[1];
    let idB = args[2];
    if (!idA || !idB) {
      const fault = list.find((c) => c.status === 'FAULT_DETECTED');
      const healthy = list.find((c) => c.status !== 'FAULT_DETECTED');
      if (!idA) idA = healthy?.id || list[list.length - 1]?.id;
      if (!idB) idB = fault?.id || list[0]?.id;
    }
    if (!idA || !idB) {
      console.error('Need at least 2 capsules in .blackbox/capsules (or pass: blackbox diff <idA> <idB>).');
      process.exit(1);
    }
    const diff = vault.diffCapsules(idA, idB);
    console.log('\n⚡ BLACKBOX CAPSULE REGRESSION DIFF\n');
    console.log(`  Baseline A : ${diff.capsuleA.id} — ${diff.capsuleA.title}`);
    console.log(`  Target   B : ${diff.capsuleB.id} — ${diff.capsuleB.title}`);
    console.log(`  Transition : ${diff.statusChange}`);
    console.log(`  Git Commit : ${diff.gitCommitChange}`);
    console.log(`  Routes     : ${diff.totalRoutesAudited} audited, ${diff.routeDiffs.filter((r) => r.regression).length} regression(s)`);
    if (diff.routeDiffs.length > 0) {
      console.log('\n  HTTP Route Deltas:');
      for (const r of diff.routeDiffs) {
        const marker = r.regression ? '\x1b[31m[REGRESSION]\x1b[0m' : '\x1b[33m[SHIFT]\x1b[0m';
        const before = r.before ? `${r.before.lastStatus} (${r.before.avgMs}ms)` : 'N/A';
        const after = r.after ? `${r.after.lastStatus} (${r.after.avgMs}ms)` : 'N/A';
        console.log(`    ${marker} ${r.route}: ${before} -> ${after}`);
      }
    }
    if (diff.newCausalChains.length > 0) {
      console.log('\n  Newly Introduced Causal Fault Chains:');
      for (const ch of diff.newCausalChains) {
        console.log(`    \x1b[31m✖\x1b[0m ${ch.culpritFile}:${ch.culpritLine || '?'} — ${ch.faultSummary}`);
      }
    }
    console.log('');
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
    const title = parseFlag('--title', parseFlag('--reason', ''));
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
    freePortIfOccupied(port);
    freePortIfOccupied(demoPort);

    const daemon = new BlackboxDaemonServer({
      port,
      projectCwd: path.resolve(__dirname, '..'),
    });
    await daemon.start();

    const demoServerScript = path.resolve(__dirname, '../src/demo/demo-server.js');
    daemon.supervisor.spawnProcess({
      name: 'nexuspay-api',
      command: `node "${demoServerScript}"`,
      cwd: path.resolve(__dirname, '..'),
      env: { DEMO_PORT: String(demoPort), BLACKBOX_PORT: String(port), KALA_PORT: String(port) },
    });

    printBanner(port, [
      `🎯 Target Sandbox App : \x1b[1m\x1b[33mhttp://localhost:${demoPort}\x1b[0m                         \x1b[35m║\x1b[0m`,
    ]);
    attachTerminalHotkey(daemon);
    return;
  }

  if (subcommand === 'studio') {
    freePortIfOccupied(port);
    const daemon = new BlackboxDaemonServer({ port, projectCwd: process.cwd() });
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
      console.error('Usage: blackbox run "<command>" [--name api] [--port 9876] [--proxy 4000:3000]');
      process.exit(1);
    }

    const procName = parseFlag('--name', 'dev-server');
    const proxySpec = parseFlag('--proxy', null);

    const daemon = new BlackboxDaemonServer({ port, projectCwd: process.cwd() });
    await daemon.start();

    const extraBanner = [
      `🚀 Supervised Command : \x1b[1m${cmdToRun}\x1b[0m (${procName})`,
    ];

    let activeProxy = null;
    if (proxySpec && proxySpec.includes(':')) {
      const [listenPortStr, targetPortStr] = proxySpec.split(':');
      activeProxy = new WiretapProxy({
        listenPort: Number(listenPortStr),
        targetOrigin: `http://127.0.0.1:${targetPortStr}`,
        port,
        ringBuffer: daemon.ringBuffer,
        onHttp5xx: (info) => daemon.scheduleAutoFreeze(info.reason),
      });
      await activeProxy.start();
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
    attachTerminalHotkey(daemon, () => {
      if (activeProxy) activeProxy.stop();
    });
    return;
  }

  // Help output
  printBanner(port);
  console.log('Usage:');
  console.log('  blackbox init [--inject]                   Initialize Blackbox & MCP configs in current project');
  console.log('  blackbox doctor                            Verify Node, Git, Vault, Daemon & MCP health');
  console.log('  blackbox demo                              Launch Blackbox Studio + Interactive Target Sandbox');
  console.log('  blackbox run "<cmd>" [--proxy 4000:3000]   Supervise any backend/frontend dev command');
  console.log('  blackbox studio [--port 9876]              Run Blackbox Daemon & Studio UI');
  console.log('  blackbox freeze [--title "..."]            Freeze the active 60s rolling ring buffer');
  console.log('  blackbox capsules [--faults]               List all captured Time-Travel Bug Capsules');
  console.log('  blackbox inspect [id|latest|latest_fault]  Print Causal Fault Chain & AI Diagnostic Markdown');
  console.log('  blackbox diff [capA] [capB]                Compare Baseline vs Crash capsule for regressions');
  console.log('  blackbox mcp                               Start stdio Model Context Protocol (MCP) server');
}

main().catch((err) => {
  console.error('[BLACKBOX Fatal Error]:', err);
  process.exit(1);
});
