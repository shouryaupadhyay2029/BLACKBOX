/**
 * KALA Universal Browser Agent & Causal Interceptor
 * Runs inside any localhost target application (via Chrome Extension MV3,
 * Wiretap Proxy auto-injection, or direct script tag).
 *
 * Captures:
 * 1. DOM Visual Snapshots & Form/Input states (for Time-Travel DOM Replay)
 * 2. User Clicks, Cursor Coordinates, Keystrokes & Form Submissions
 * 3. Fetch & XHR Network Calls with automatic `X-Kala-Trace-Id` header injection
 * 4. Console logs/warnings/errors + Uncaught Exceptions & Unhandled Rejections
 * 5. LocalStorage & SessionStorage state
 * 6. Shadow-DOM HUD Pill + `Alt+Shift+B` Instant Capsule Freeze hotkey
 */

(function initKalaBrowserAgent() {
  if (window.__KALA_AGENT_ACTIVE__) return;
  window.__KALA_AGENT_ACTIVE__ = true;

  // Determine KALA Daemon endpoint
  const scriptEl = document.currentScript;
  const endpointAttr = scriptEl && scriptEl.getAttribute('data-kala-endpoint');
  const KALA_HTTP = endpointAttr || window.__KALA_ENDPOINT__ || 'http://localhost:9876';
  const KALA_WS = KALA_HTTP.replace(/^http/, 'ws') + '/ws?role=agent';

  let ws = null;
  let wsConnected = false;
  let eventCount = 0;
  let errorCount = 0;
  let lastActionTrace = null; // { traceId, timestampMs, selector, text }
  const outboundQueue = [];

  function genTraceId() {
    return (
      'tr_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function getActiveTraceId() {
    if (
      lastActionTrace &&
      Date.now() - lastActionTrace.timestampMs < 2200
    ) {
      return lastActionTrace.traceId;
    }
    return genTraceId();
  }

  // --- 1. WebSocket + HTTP Fallback Transport ---
  function connectWebSocket() {
    try {
      ws = new WebSocket(KALA_WS);
      ws.onopen = () => {
        wsConnected = true;
        updateHudStatus();
        while (outboundQueue.length > 0) {
          const item = outboundQueue.shift();
          ws.send(JSON.stringify(item));
        }
        // Send initial baseline snapshots on connect
        captureStorageSnapshot();
        captureDomSnapshot('INITIAL_LOAD');
      };

      ws.onmessage = (evt) => {
        try {
          const data = JSON.parse(evt.data);
          if (data.type === 'CAPSULE_CREATED') {
            showHudToast(
              `Capsule Frozen: ${data.capsuleId}`,
              data.studioUrl
            );
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        wsConnected = false;
        updateHudStatus();
        setTimeout(connectWebSocket, 2500);
      };

      ws.onerror = () => {
        wsConnected = false;
        updateHudStatus();
      };
    } catch {
      setTimeout(connectWebSocket, 3000);
    }
  }

  function sendEvent(eventObj) {
    eventCount++;
    if (eventObj.severity === 'error' || eventObj.severity === 'fatal') {
      errorCount++;
    }
    updateHudStatus();

    const envelope = {
      action: 'INGEST_EVENT',
      event: {
        timestampMs: Date.now(),
        source: window.location.origin + window.location.pathname,
        ...eventObj,
      },
    };

    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(envelope));
    } else {
      outboundQueue.push(envelope);
      if (outboundQueue.length > 200) outboundQueue.shift();
      // Fallback HTTP POST for critical events
      if (eventObj.severity === 'error' || eventObj.severity === 'fatal' || eventObj.type === 'HTTP_TRACE') {
        origFetch(`${KALA_HTTP}/api/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: envelope.event }),
          keepalive: true,
        }).catch(() => {});
      }
    }
  }

  function triggerFreezeNow(reason = 'BROWSER_HOTKEY_FREEZE') {
    captureDomSnapshot('PRE_FREEZE');
    captureStorageSnapshot();
    if (wsConnected && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          action: 'FREEZE_CAPSULE',
          triggerReason: reason,
        })
      );
    } else {
      origFetch(`${KALA_HTTP}/api/freeze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerReason: reason }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data && data.capsule) {
            showHudToast(
              `Capsule Frozen: ${data.capsule.id}`,
              data.studioUrl
            );
          }
        })
        .catch(() => {});
    }
  }

  // --- 2. Visual DOM Snapshot & Form State Serializer ---
  function serializeDomWithState() {
    try {
      const clone = document.documentElement.cloneNode(true);
      // Remove KALA HUD host & scripts so replay is safe and clean
      const hudNodes = clone.querySelectorAll('#__kala_hud_host__, script');
      hudNodes.forEach((n) => n.remove());

      // Sync live input, textarea, and select values into the cloned attributes
      const origInputs = document.querySelectorAll('input, textarea, select');
      const cloneInputs = clone.querySelectorAll('input, textarea, select');
      origInputs.forEach((origEl, idx) => {
        const cloneEl = cloneInputs[idx];
        if (!cloneEl) return;
        if (origEl.type === 'password') {
          cloneEl.setAttribute('value', '***');
        } else if (origEl.type === 'checkbox' || origEl.type === 'radio') {
          if (origEl.checked) cloneEl.setAttribute('checked', 'checked');
          else cloneEl.removeAttribute('checked');
        } else if (origEl.tagName === 'TEXTAREA') {
          cloneEl.textContent = origEl.value;
        } else if (origEl.tagName === 'SELECT') {
          Array.from(cloneEl.options || []).forEach((opt, oIdx) => {
            if (origEl.selectedIndex === oIdx) opt.setAttribute('selected', 'selected');
            else opt.removeAttribute('selected');
          });
        } else {
          cloneEl.setAttribute('value', origEl.value || '');
        }
      });

      return '<!DOCTYPE html>\n' + clone.outerHTML.slice(0, 120000);
    } catch {
      return '<html><body>DOM Snapshot unavailable</body></html>';
    }
  }

  let lastDomSnapshotMs = 0;
  function captureDomSnapshot(trigger = 'MUTATION', traceId = null, clickCoords = null) {
    const now = Date.now();
    if (trigger === 'MUTATION' && now - lastDomSnapshotMs < 350) return;
    lastDomSnapshotMs = now;

    sendEvent({
      plane: 'BROWSER',
      type: 'DOM_SNAPSHOT',
      severity: 'info',
      traceId: traceId || (lastActionTrace && lastActionTrace.traceId) || null,
      payload: {
        trigger,
        url: window.location.href,
        title: document.title,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY,
        },
        cursor: clickCoords || null,
        html: serializeDomWithState(),
      },
    });
  }

  function captureStorageSnapshot() {
    try {
      const local = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          const v = localStorage.getItem(k) || '';
          local[k] = /token|secret|key|auth/i.test(k) ? '***REDACTED***' : v.slice(0, 500);
        }
      }
      const session = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) {
          const v = sessionStorage.getItem(k) || '';
          session[k] = /token|secret|key|auth/i.test(k) ? '***REDACTED***' : v.slice(0, 500);
        }
      }
      sendEvent({
        plane: 'BROWSER',
        type: 'STORAGE_SNAPSHOT',
        severity: 'info',
        payload: {
          localStorage: local,
          sessionStorage: session,
        },
      });
    } catch {
      // ignore cross-origin storage errors
    }
  }

  // --- 3. User Interaction Hooks (Clicks, Inputs, Hotkeys) ---
  function getSelector(el) {
    if (!el || el.nodeType !== 1) return 'window';
    if (el.id) return `#${el.id}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-action');
    if (testId) return `${el.tagName.toLowerCase()}[data-testid="${testId}"]`;
    const classes =
      typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    return `${el.tagName.toLowerCase()}${classes}`;
  }

  window.addEventListener(
    'click',
    (e) => {
      if (e.target && e.target.closest && e.target.closest('#__kala_hud_host__')) {
        return;
      }
      const target = e.target;
      const traceId = genTraceId();
      const selector = getSelector(target);
      const text = ((target && (target.innerText || target.value)) || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);

      lastActionTrace = {
        traceId,
        timestampMs: Date.now(),
        selector,
        text,
      };

      const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
      const coords = {
        x: e.clientX,
        y: e.clientY,
        selector,
        text,
      };

      sendEvent({
        plane: 'BROWSER',
        type: 'UI_CLICK',
        severity: 'info',
        traceId,
        payload: {
          selector,
          tagName: target ? target.tagName : 'UNKNOWN',
          text,
          clientX: e.clientX,
          clientY: e.clientY,
          rect: rect
            ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
            : null,
        },
      });

      // Capture DOM snapshot right after click reaction
      setTimeout(() => captureDomSnapshot('POST_CLICK', traceId, coords), 90);
    },
    true
  );

  // Hotkey: Alt + Shift + B to freeze capsule anytime
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        triggerFreezeNow('HOTKEY_ALT_SHIFT_B');
      }
    },
    true
  );

  // --- 4. Fetch & XMLHttpRequest Causal Interceptor ---
  const origFetch = window.fetch.bind(window);
  window.fetch = async function kalaInterceptedFetch(input, init = {}) {
    const urlStr = typeof input === 'string' ? input : input?.url || String(input);

    // Do not intercept KALA's own telemetry calls
    if (urlStr.includes(':9876') || urlStr.includes('/__kala__')) {
      return origFetch(input, init);
    }

    const traceId = getActiveTraceId();
    const startTimeMs = Date.now();
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();

    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
    headers.set('X-Kala-Trace-Id', traceId);
    if (lastActionTrace && Date.now() - lastActionTrace.timestampMs < 2200) {
      headers.set('X-Kala-Trigger-Action', encodeURIComponent(lastActionTrace.selector || 'click'));
    }

    let requestBody = null;
    if (init.body && typeof init.body === 'string') {
      try {
        requestBody = JSON.parse(init.body);
      } catch {
        requestBody = init.body.slice(0, 2000);
      }
    }

    try {
      const response = await origFetch(input, { ...init, headers });
      const durationMs = Date.now() - startTimeMs;
      const status = response.status;

      // Clone response to read body non-destructively
      const clone = response.clone();
      clone
        .text()
        .then((textBody) => {
          let parsedRes = textBody.slice(0, 4096);
          try {
            parsedRes = JSON.parse(textBody);
          } catch {
            // keep text
          }

          sendEvent({
            plane: 'NETWORK',
            type: 'HTTP_TRACE',
            severity: status >= 500 ? 'fatal' : status >= 400 ? 'error' : 'info',
            traceId,
            payload: {
              method,
              url: urlStr,
              status,
              startTimeMs,
              durationMs,
              triggerSelector: lastActionTrace?.selector || null,
              requestBody,
              responseBody: parsedRes,
            },
          });

          // Capture updated DOM state after network response settles
          setTimeout(() => captureDomSnapshot(`POST_HTTP_${status}`, traceId), 80);
        })
        .catch(() => {});

      return response;
    } catch (networkErr) {
      const durationMs = Date.now() - startTimeMs;
      sendEvent({
        plane: 'NETWORK',
        type: 'HTTP_TRACE',
        severity: 'error',
        traceId,
        payload: {
          method,
          url: urlStr,
          status: 0,
          startTimeMs,
          durationMs,
          error: networkErr.message,
          requestBody,
        },
      });
      throw networkErr;
    }
  };

  // --- 5. Console & Uncaught Error Interceptor ---
  ['log', 'warn', 'error'].forEach((level) => {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      orig(...args);
      try {
        const message = args
          .map((a) =>
            a instanceof Error
              ? `${a.message}\n${a.stack || ''}`
              : typeof a === 'object'
              ? JSON.stringify(a)
              : String(a)
          )
          .join(' ')
          .slice(0, 4000);

        if (message.includes('[KALA]')) return;

        sendEvent({
          plane: 'BROWSER',
          type: 'CONSOLE',
          severity: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
          traceId: lastActionTrace?.traceId || null,
          payload: {
            level,
            message,
          },
        });
      } catch {
        // ignore
      }
    };
  });

  window.addEventListener('error', (event) => {
    sendEvent({
      plane: 'BROWSER',
      type: 'UNCAUGHT_ERROR',
      severity: 'fatal',
      traceId: lastActionTrace?.traceId || null,
      payload: {
        message: event.message || 'Uncaught Error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack || `${event.filename}:${event.lineno}:${event.colno}`,
      },
    });
    setTimeout(() => captureDomSnapshot('ON_UNCAUGHT_ERROR'), 50);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    sendEvent({
      plane: 'BROWSER',
      type: 'UNHANDLED_REJECTION',
      severity: 'fatal',
      traceId: lastActionTrace?.traceId || null,
      payload: {
        message: reason?.message || String(reason || 'Unhandled Promise Rejection'),
        stack: reason?.stack || '',
      },
    });
    setTimeout(() => captureDomSnapshot('ON_UNHANDLED_REJECTION'), 50);
  });

  // --- 6. Shadow-DOM Floating Flight Recorder HUD Pill ---
  let hudStatsEl = null;
  let hudDotEl = null;
  let hudToastEl = null;

  function mountHudPill() {
    if (!document.body || document.getElementById('__kala_hud_host__')) return;
    const host = document.createElement('div');
    host.id = '__kala_hud_host__';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .kala-pill {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          gap: 10px;
          background: rgba(11, 15, 25, 0.92);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(99, 102, 241, 0.45);
          border-radius: 999px;
          padding: 7px 14px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
          font-size: 12px;
          color: #e2e8f0;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
          user-select: none;
        }
        .kala-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 10px #10b981;
          animation: pulse 2s infinite;
        }
        .kala-dot.offline {
          background: #f59e0b;
          box-shadow: 0 0 8px #f59e0b;
        }
        .kala-dot.error {
          background: #ef4444;
          box-shadow: 0 0 12px #ef4444;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.88); }
        }
        .kala-brand {
          font-weight: 700;
          letter-spacing: 0.06em;
          color: #a5b4fc;
        }
        .kala-stats {
          color: #94a3b8;
          font-size: 11px;
        }
        .kala-btn {
          background: linear-gradient(135deg, #6366f1, #ec4899);
          border: none;
          color: #ffffff;
          font-weight: 600;
          font-size: 11px;
          padding: 5px 11px;
          border-radius: 999px;
          cursor: pointer;
          transition: transform 0.15s ease, opacity 0.15s ease;
        }
        .kala-btn:hover {
          transform: translateY(-1px);
          opacity: 0.95;
        }
        .kala-link {
          color: #38bdf8;
          text-decoration: none;
          font-size: 11px;
          font-weight: 600;
        }
        .kala-toast {
          position: fixed;
          bottom: 60px;
          right: 16px;
          z-index: 2147483647;
          background: rgba(15, 23, 42, 0.96);
          border: 1px solid #10b981;
          color: #f8fafc;
          padding: 10px 14px;
          border-radius: 10px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 12px;
          display: none;
          box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }
        .kala-toast a {
          color: #34d399;
          font-weight: 700;
          margin-left: 8px;
        }
      </style>
      <div class="kala-toast" id="kalaToast"></div>
      <div class="kala-pill">
        <span class="kala-dot" id="kalaDot"></span>
        <span class="kala-brand">KALA</span>
        <span class="kala-stats" id="kalaStats">60s Ring Buffer</span>
        <button class="kala-btn" id="kalaFreezeBtn" title="Shortcut: Alt+Shift+B">Freeze Capsule</button>
        <a class="kala-link" href="${KALA_HTTP}" target="_blank" title="Open KALA Blackbox Studio">Studio ↗</a>
      </div>
    `;

    document.body.appendChild(host);
    hudStatsEl = shadow.getElementById('kalaStats');
    hudDotEl = shadow.getElementById('kalaDot');
    hudToastEl = shadow.getElementById('kalaToast');
    const freezeBtn = shadow.getElementById('kalaFreezeBtn');
    freezeBtn.addEventListener('click', () => triggerFreezeNow('HUD_BUTTON_CLICK'));
    updateHudStatus();
  }

  function updateHudStatus() {
    if (!hudStatsEl || !hudDotEl) return;
    hudStatsEl.textContent = `${eventCount} evts${errorCount > 0 ? ` · ${errorCount} err` : ''}`;
    hudDotEl.className =
      'kala-dot' + (!wsConnected ? ' offline' : errorCount > 0 ? ' error' : '');
  }

  function showHudToast(text, url) {
    if (!hudToastEl) return;
    hudToastEl.style.display = 'block';
    hudToastEl.innerHTML = `<span>⚡ ${text}</span> ${
      url ? `<a href="${url}" target="_blank">Inspect in Studio →</a>` : ''
    }`;
    setTimeout(() => {
      if (hudToastEl) hudToastEl.style.display = 'none';
    }, 6500);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => {
      mountHudPill();
      connectWebSocket();
    });
  } else {
    mountHudPill();
    connectWebSocket();
  }
})();
