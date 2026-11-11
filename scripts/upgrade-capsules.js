import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const capsulesDir = path.join(projectRoot, '.blackbox', 'capsules');

if (!fs.existsSync(capsulesDir)) {
  console.log('Capsules dir does not exist:', capsulesDir);
  process.exit(0);
}

const richHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexusPay Checkout Sandbox — Monitored by Blackbox (Port 4400)</title>
  <style>
    body {
      margin: 0;
      padding: 32px 24px;
      background: #090B16;
      color: #F4F3EE;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
    }
    .top-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(135deg, #1B1E4A 0%, #121533 100%);
      border: 1px solid rgba(175, 174, 162, 0.3);
      border-radius: 10px;
      padding: 20px 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .banner-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.01em;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .banner-sub {
      color: #AFAEA2;
      font-size: 13px;
      line-height: 1.4;
    }
    .demo-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 24px;
    }
    .card {
      background: rgba(14, 18, 42, 0.65);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(175, 174, 162, 0.2);
      border-radius: 8px;
      padding: 22px;
    }
    .card-title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-desc {
      font-size: 12.5px;
      color: #AFAEA2;
      margin-bottom: 18px;
      line-height: 1.45;
    }
    .btn {
      width: 100%;
      padding: 12px 16px;
      border-radius: 6px;
      border: none;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.15s ease;
    }
    .btn-healthy {
      background: #10B981;
      color: #052e16;
    }
    .btn-healthy:hover {
      background: #059669;
    }
    .btn-crash {
      background: #D21319;
      color: #FFFFFF;
    }
    .btn-crash:hover {
      background: #b91015;
    }
    .btn-merkle {
      background: #E11D48;
      color: #FFFFFF;
    }
    .btn-merkle:hover {
      background: #BE123C;
    }
    .btn-warn {
      background: #F59E0B;
      color: #1c1917;
    }
    .btn-warn:hover {
      background: #D97706;
    }
    .console-out {
      background: #060812;
      border: 1px solid rgba(175, 174, 162, 0.2);
      border-radius: 6px;
      padding: 16px;
      font-family: ui-monospace, "Cascadia Code", Menlo, monospace;
      font-size: 12px;
      color: #38BDF8;
      min-height: 60px;
      white-space: pre-wrap;
    }
    .form-row {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }
    .input-box {
      flex: 1;
      background: #060812;
      border: 1px solid rgba(175, 174, 162, 0.25);
      border-radius: 6px;
      color: #F4F3EE;
      padding: 10px 14px;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-banner">
      <div>
        <div class="banner-title">⚡ NexusPay Checkout Sandbox (Monitored by Blackbox)</div>
        <div class="banner-sub">Every click, DOM mutation, HTTP payload, backend terminal stack trace, and Git diff is recorded in Blackbox's 60s rolling ring buffer.</div>
      </div>
    </div>

    <div class="form-row">
      <input type="text" class="input-box" value="founder@vajra-labs.dev" readonly />
      <input type="text" class="input-box" value="2380" readonly style="max-width:140px;" />
    </div>

    <div class="demo-grid">
      <div class="card">
        <div class="card-title">✅ 1. Healthy Full-Stack Flows</div>
        <div class="card-desc">Triggers normal HTTP 200 calls and backend stdout logs so you can see healthy baseline telemetry in the ring buffer.</div>
        <button class="btn btn-healthy" id="btnFetchInventory">📦 Fetch Live Hardware Inventory (GET /api/inventory)</button>
        <button class="btn btn-healthy" id="btnStandardCheckout">💳 Run Standard Settlement (POST /api/checkout [200 OK])</button>
      </div>

      <div class="card">
        <div class="card-title">💥 2. Trigger Real Full-Stack Bugs (Auto-Freezes Capsule)</div>
        <div class="card-desc">Click any fault button below. Blackbox will correlate your click, the HTTP 500/503 payload, the backend terminal stack trace, local source code line, and uncommitted Git diff.</div>
        <button class="btn btn-crash" id="btnInstantCrash">🔥 Trigger Backend Null-Ref Crash (POST /api/checkout [HTTP 500])</button>
        <button class="btn btn-merkle" id="btnLedgerCrash">⚡ Trigger Ledger Merkle Mismatch (POST /api/ledger/sync [HTTP 503])</button>
        <button class="btn btn-warn" id="btnFrontendCrash">💣 Trigger Uncaught Frontend Exception (window.onerror)</button>
      </div>
    </div>

    <div class="console-out" id="terminalOutput">Ready. Click any button above to generate live full-stack telemetry...</div>
  </div>
</body>
</html>`;

const files = fs.readdirSync(capsulesDir).filter(f => f.endsWith('.json') && f !== 'index.json');
let updatedCount = 0;

for (const f of files) {
  const filePath = path.join(capsulesDir, f);
  let raw = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  try {
    const cap = JSON.parse(raw);
    if (Array.isArray(cap.events)) {
      for (const evt of cap.events) {
        if (evt.plane === 'BROWSER' && evt.type === 'DOM_SNAPSHOT') {
          const currentHtml = evt.payload?.html || '';
          if (
            currentHtml.includes('NexusPay Checkout') &&
            (currentHtml.includes('Instant Settlement') || currentHtml.length < 500)
          ) {
            evt.payload.html = richHtml;
            evt.payload.viewport = { width: 1280, height: 800 };
            changed = true;
          }
        }
      }
    }
    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(cap, null, 2), 'utf8');
      updatedCount++;
    }
  } catch (err) {
    console.error('Failed to parse capsule', f, err);
  }
}

console.log(`Successfully upgraded ${updatedCount} old capsules with complete NexusPay Sandbox UI!`);
