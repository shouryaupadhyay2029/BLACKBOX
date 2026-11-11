/**
 * KALA Demo Target Backend Server (Port 4400)
 * A realistic fintech/e-commerce microservice supervised by KALA's ProcessSupervisor.
 * Emits real stdout/stderr logs and real V8 stack traces so KALA can demonstrate
 * sub-millisecond Browser <-> Network <-> Backend Terminal <-> Source Code <-> Git Diff correlation.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEMO_HTML_PATH = path.join(__dirname, 'demo-app.html');
const PORT = Number(process.env.DEMO_PORT) || 4400;
const KALA_PORT = Number(process.env.KALA_PORT) || 9876;

const inventory = [
  { sku: 'VJ-CORE-01', name: 'Vajra Quantum Processor Node', price: 1490, stock: 8 },
  { sku: 'KL-BOX-99', name: 'Kala Telemetry Hardware Tap', price: 420, stock: 19 },
  { sku: 'NX-MESH-04', name: 'Hyperion Fiber Backplane', price: 890, stock: 3 },
];

/**
 * Intentional realistic backend bug #1:
 * When `couponCode === 'VIP_CRASH'` or `paymentGateway.merchantConfig` is dereferenced
 * without null-check, this function throws a real V8 TypeError with an exact stack trace!
 */
function calculateAndChargeOrder(orderPayload, traceId) {
  console.log(
    `[OrderEngine] [trace:${traceId}] Validating cart for customer="${orderPayload.customerEmail}" items=${orderPayload.items?.length || 0}`
  );

  // Subtle bug: `merchantSplitRule` is undefined when currency === 'USD-INSTANT'
  const gatewayRegistry = {
    'USD-STANDARD': { feeRate: 0.029, merchantSplitRule: { partnerShare: 0.15 } },
    'USD-INSTANT': { feeRate: 0.045, merchantSplitRule: null },
  };

  const mode = orderPayload.settlementMode || 'USD-INSTANT';
  const selectedGateway = gatewayRegistry[mode];

  // CRASH LINE: Dereferencing `.partnerShare` on null `merchantSplitRule`!
  const partnerFee =
    orderPayload.subtotal * selectedGateway.merchantSplitRule.partnerShare;

  return {
    orderId: `ord_${Date.now()}`,
    chargedAmount: orderPayload.subtotal + partnerFee,
  };
}

/**
 * Intentional realistic backend bug #2:
 * Ledger reconciliation invariant failure.
 */
function verifyLedgerSignature(payload, traceId) {
  console.log(`[LedgerService] [trace:${traceId}] Starting cryptographic merkle check...`);
  if (!payload.merkleRoot || payload.merkleRoot === 'STALE_ROOT_0x00') {
    throw new RangeError(
      `LedgerMerkleMismatchError: Expected non-zero merkle root for shard #${payload.shardId || 7}, received "${payload.merkleRoot}"`
    );
  }
  return { verified: true };
}

const server = http.createServer(async (req, res) => {
  const traceId = req.headers['x-kala-trace-id'] || 'no-trace';
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Kala-Trace-Id, X-Kala-Trigger-Action');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve Demo Frontend App
  if (url.pathname === '/' && req.method === 'GET') {
    let html = fs.readFileSync(DEMO_HTML_PATH, 'utf8');
    html = html.replace(/__KALA_PORT__/g, String(KALA_PORT));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Route 1: Healthy Inventory Fetch
  if (url.pathname === '/api/inventory' && req.method === 'GET') {
    console.log(
      `[InventoryAPI] [trace:${traceId}] GET /api/inventory -> Returning ${inventory.length} active SKUs (200 OK)`
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, traceId, items: inventory }));
    return;
  }

  // Route 2: Checkout Endpoint (Triggers real full-stack TypeError crash on USD-INSTANT)
  if (url.pathname === '/api/checkout' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = calculateAndChargeOrder(body, traceId);
      console.log(`[OrderEngine] [trace:${traceId}] Order completed: ${result.orderId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, traceId, result }));
    } catch (err) {
      // Emit full stack trace to stderr so KALA ProcessSupervisor captures & parses it
      console.error(
        `[OrderEngine] [FATAL] [trace:${traceId}] Unhandled checkout exception on POST /api/checkout:\n${err.stack}`
      );
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err.message,
          code: 'CHECKOUT_SETTLEMENT_CRASH',
          traceId,
        })
      );
    }
    return;
  }

  // Route 3: Ledger Sync Endpoint (Triggers RangeError stack trace)
  if (url.pathname === '/api/ledger/sync' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = verifyLedgerSignature(body, traceId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      console.error(
        `[LedgerService] [ERROR] [trace:${traceId}] Ledger sync aborted on POST /api/ledger/sync:\n${err.stack}`
      );
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err.message,
          code: 'LEDGER_MERKLE_MISMATCH',
          traceId,
        })
      );
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[DemoBackend] Target service listening at http://localhost:${PORT}`);
});
