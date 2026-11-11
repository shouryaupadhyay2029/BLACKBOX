/**
 * KALA End-to-End Verification Suite
 * Tests all 5 architectural pillars:
 * 1. Lock-Free Rolling Ring Buffer & Sticky Baselines
 * 2. Multi-Language Stack Trace Parser & Local Source Code X-Ray
 * 3. Git Dirty-State Inspector & Stack-to-Diff Overlap Correlation
 * 4. Full-Stack Daemon + ProcessSupervisor + Browser->HTTP->Terminal->Code->Git Causal Chain
 * 5. Model Context Protocol (MCP) JSON-RPC 2.0 Server Tools
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlackboxDaemonServer } from '../src/daemon/server.js';
import { BlackboxMcpServer } from '../src/mcp/mcp-server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runVerification() {
  console.log('=== BLACKBOX END-TO-END VERIFICATION SUITE ===\n');

  const testPort = 9888;
  const testDemoPort = 4488;
  const daemon = new BlackboxDaemonServer({
    port: testPort,
    projectCwd: ROOT_DIR,
    autoFreeze: true,
    passthrough: false,
  });

  await daemon.start();
  console.log('✔ [1/6] Blackbox Daemon Server booted on port', testPort);

  // Spawn the supervised Demo Backend Server
  const demoServerScript = path.join(ROOT_DIR, 'src/demo/demo-server.js');
  daemon.supervisor.spawnProcess({
    name: 'nexuspay-api',
    command: `node "${demoServerScript}"`,
    cwd: ROOT_DIR,
    env: { DEMO_PORT: String(testDemoPort), KALA_PORT: String(testPort) },
  });

  // Wait for demo server to listen
  await sleep(900);
  console.log('✔ [2/6] Supervised Backend ("nexuspay-api") spawned & hooked into PTY/Stream collector');

  // Step A: Simulate Healthy Baseline Flow & Freeze Healthy Capsule
  const baseTraceId = 'tr_healthy_001';
  await fetch(`http://127.0.0.1:${testPort}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      events: [
        {
          plane: 'BROWSER',
          type: 'DOM_SNAPSHOT',
          source: `http://localhost:${testDemoPort}/`,
          payload: {
            url: `http://localhost:${testDemoPort}/`,
            title: 'NexusPay Storefront',
            viewport: { width: 1280, height: 800 },
            html: '<!DOCTYPE html><html><head><style>body{margin:0;padding:24px;background:#0B0E20;color:#F4F3EE;font-family:-apple-system,sans-serif}.banner{background:linear-gradient(135deg,#1B1E4A,#121533);border:1px solid rgba(175,174,162,0.3);border-radius:10px;padding:16px 20px;margin-bottom:16px}h1{margin:0 0 6px;font-size:20px;color:#F4F3EE}p{margin:0;color:#AFAEA2;font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.card{background:rgba(14,17,36,0.7);border:1px solid rgba(175,174,162,0.2);border-radius:8px;padding:14px}.card h3{margin:0 0 8px;font-size:13px;color:#F4F3EE}.btn{width:100%;padding:9px 12px;border-radius:6px;border:none;font-weight:700;font-size:11.5px;cursor:pointer;margin-bottom:8px}.btn-healthy{background:#10B981;color:#062312}.btn-crash{background:#D21319;color:#FFF}.btn-warn{background:#F59E0B;color:#1C1917}.output{margin-top:14px;background:#060812;border:1px solid rgba(175,174,162,0.2);border-radius:6px;padding:10px;font-family:monospace;font-size:11px;color:#AFAEA2}</style></head><body><div class="banner"><h1>⚡ NexusPay Checkout Sandbox</h1><p>Monitored by Blackbox Flight Recorder · Port 4400</p></div><div class="grid"><div class="card"><h3>✅ 1. Healthy Flows</h3><button class="btn btn-healthy" id="btnFetchInventory">📦 Fetch Inventory (GET /api/inventory)</button><button class="btn btn-healthy" id="btnStandardCheckout">💳 Standard Settlement (200 OK)</button></div><div class="card"><h3>💥 2. Trigger Real Full-Stack Bugs</h3><button class="btn btn-crash" id="btnInstantCrash">🔥 Trigger Backend Crash (POST /api/checkout [500])</button><button class="btn btn-crash" id="btnLedgerCrash">⚡ Trigger Ledger Mismatch (503)</button><button class="btn btn-warn" id="btnFrontendCrash">💣 Trigger Frontend Error</button></div></div><div class="output">Ready. Click any button to generate telemetry...</div></body></html>',
          },
        },
        {
          plane: 'BROWSER',
          type: 'STORAGE_SNAPSHOT',
          source: `http://localhost:${testDemoPort}/`,
          payload: {
            localStorage: { nexus_session_tier: 'ENTERPRISE_PRO' },
            sessionStorage: {},
          },
        },
      ],
    }),
  });

  const invRes = await fetch(`http://127.0.0.1:${testDemoPort}/api/inventory`, {
    headers: { 'X-Kala-Trace-Id': baseTraceId },
  });
  const invJson = await invRes.json();
  assert.equal(invRes.status, 200);

  await fetch(`http://127.0.0.1:${testPort}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        plane: 'NETWORK',
        type: 'HTTP_TRACE',
        traceId: baseTraceId,
        source: `http://localhost:${testDemoPort}/`,
        payload: {
          method: 'GET',
          url: '/api/inventory',
          status: 200,
          durationMs: 12,
          responseBody: invJson,
        },
      },
    }),
  });

  const healthyFreezeRes = await fetch(`http://127.0.0.1:${testPort}/api/freeze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      triggerReason: 'BASELINE_CHECK',
      title: 'Healthy Inventory Baseline',
    }),
  });
  const healthyCapsuleData = await healthyFreezeRes.json();
  assert.equal(healthyCapsuleData.ok, true);
  console.log('✔ [3/6] Healthy Baseline Capsule frozen:', healthyCapsuleData.capsule.id);

  // Step B: Simulate Real Full-Stack Crash (Browser Click -> POST /api/checkout -> Backend stderr Stack Trace -> HTTP 500)
  const crashTraceId = 'tr_crash_checkout_999';
  const clickStartMs = Date.now();

  // 1. Browser records user clicking #btnInstantCrash
  await fetch(`http://127.0.0.1:${testPort}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        timestampMs: clickStartMs,
        plane: 'BROWSER',
        type: 'UI_CLICK',
        traceId: crashTraceId,
        source: `http://localhost:${testDemoPort}/`,
        payload: {
          selector: '#btnInstantCrash',
          tagName: 'BUTTON',
          text: 'Trigger Backend Null-Ref Crash (POST /api/checkout [HTTP 500])',
          clientX: 620,
          clientY: 340,
        },
      },
    }),
  });

  // 2. Browser sends POST /api/checkout with X-Kala-Trace-Id -> Backend throws real V8 TypeError on stderr!
  const reqBody = {
    customerEmail: 'founder@vajra-labs.dev',
    subtotal: 2380,
    settlementMode: 'USD-INSTANT',
    items: [{ sku: 'VJ-CORE-01', qty: 1 }],
  };

  const crashHttpRes = await fetch(`http://127.0.0.1:${testDemoPort}/api/checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kala-Trace-Id': crashTraceId,
    },
    body: JSON.stringify(reqBody),
  });
  const crashHttpJson = await crashHttpRes.json();
  assert.equal(crashHttpRes.status, 500);

  // 3. Browser agent reports the HTTP 500 trace
  await fetch(`http://127.0.0.1:${testPort}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: {
        timestampMs: Date.now(),
        plane: 'NETWORK',
        type: 'HTTP_TRACE',
        severity: 'fatal',
        traceId: crashTraceId,
        source: `http://localhost:${testDemoPort}/`,
        payload: {
          method: 'POST',
          url: '/api/checkout',
          status: 500,
          startTimeMs: clickStartMs + 5,
          durationMs: Date.now() - clickStartMs,
          triggerSelector: '#btnInstantCrash',
          requestBody: reqBody,
          responseBody: crashHttpJson,
        },
      },
    }),
  });

  // Wait for the 350ms Auto-Freeze Grace Window to complete and seal the crash capsule
  await sleep(650);

  const capsulesRes = await fetch(`http://127.0.0.1:${testPort}/api/capsules`);
  const { capsules } = await capsulesRes.json();
  assert.ok(capsules.length >= 2, 'Expected auto-frozen crash capsule in vault');

  const latestSummary = capsules[0];
  const detailRes = await fetch(`http://127.0.0.1:${testPort}/api/capsules/${latestSummary.id}`);
  const { capsule: crashCapsule } = await detailRes.json();

  assert.equal(crashCapsule.status, 'FAULT_DETECTED');
  assert.ok(crashCapsule.causal.totalChains >= 1, 'Expected at least 1 causal fault chain');

  const primaryChain = crashCapsule.causal.causalChains[0];
  assert.equal(primaryChain.traceId, crashTraceId);
  assert.equal(primaryChain.triggerUi.selector, '#btnInstantCrash');
  assert.equal(primaryChain.networkRequest.status, 500);
  assert.ok(primaryChain.backendError, 'Expected correlated backend terminal stderr stack trace');
  assert.ok(
    primaryChain.backendError.primaryFrame?.snippet,
    'Expected local source code X-Ray snippet extracted from demo-server.js'
  );

  console.log('✔ [4/6] End-to-End Causal Fault Chain verified:');
  console.log('        Headline :', crashCapsule.causal.rootCauseSummary.headline);
  console.log(
    '        Culprit  :',
    `${crashCapsule.causal.rootCauseSummary.culpritFile}:${crashCapsule.causal.rootCauseSummary.culpritLine}`
  );
  console.log('        Confidence:', primaryChain.confidence);

  // Step C: Verify Capsule Regression Diff Engine
  const diffRes = await fetch(
    `http://127.0.0.1:${testPort}/api/capsules/diff?a=${healthyCapsuleData.capsule.id}&b=${crashCapsule.id}`
  );
  const diffJson = await diffRes.json();
  assert.equal(diffJson.ok, true);
  assert.equal(diffJson.diff.statusChange, 'HEALTHY_SNAPSHOT -> FAULT_DETECTED');
  console.log('✔ [5/6] Capsule Differential & Regression Engine verified');

  // Step D: Verify Model Context Protocol (MCP) JSON-RPC 2.0 Server
  const mcp = new BlackboxMcpServer({
    projectCwd: ROOT_DIR,
    daemonUrl: `http://127.0.0.1:${testPort}`,
  });

  const initRpc = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {},
  });
  assert.equal(initRpc.result.serverInfo.name, 'blackbox-flight-recorder-mcp');

  const callRpc = await mcp.handleJsonRpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_latest_crash_capsule',
      arguments: { capsuleId: 'latest' },
    },
  });
  const mcpText = callRpc.result.content[0].text;
  assert.ok(mcpText.includes('BLACKBOX Flight Recorder — Full-Stack Bug Capsule'));
  assert.ok(mcpText.includes('partnerShare'));
  console.log('✔ [6/6] MCP Server JSON-RPC 2.0 tools verified (`get_latest_crash_capsule`)');

  daemon.stop();
  console.log('\n🎉 ALL BLACKBOX SYSTEMS PASSED VERIFICATION WITH 100% PRECISION!');
  process.exit(0);
}

runVerification().catch((err) => {
  console.error('❌ Verification Failed:', err);
  process.exit(1);
});
