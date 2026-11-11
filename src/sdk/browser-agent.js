/**
 * BLACKBOX Universal Browser Agent & Causal Interceptor
 * Runs inside any localhost target application (via Chrome Extension MV3,
 * Wiretap Proxy auto-injection, or direct script tag).
 *
 * Captures:
 * 1. DOM Visual Snapshots & Form/Input states (for Time-Travel DOM Replay)
 * 2. User Clicks, Cursor Coordinates, Keystrokes & Form Submissions
 * 3. Fetch & XHR Network Calls with automatic `X-Blackbox-Trace-Id` header injection
 * 4. Console logs/warnings/errors + Uncaught Exceptions & Unhandled Rejections
 * 5. LocalStorage & SessionStorage state
 * 6. Shadow-DOM HUD Pill + `Alt+Shift+B` Instant Capsule Freeze hotkey
 */

(function initBlackboxBrowserAgent() {
  if (window.__BLACKBOX_AGENT_ACTIVE__ || window.__KALA_AGENT_ACTIVE__) return;
  window.__BLACKBOX_AGENT_ACTIVE__ = true;
  window.__KALA_AGENT_ACTIVE__ = true;

  // Determine Blackbox Daemon endpoint
  const scriptEl = document.currentScript;
  const endpointAttr =
    (scriptEl && (scriptEl.getAttribute('data-blackbox-endpoint') || scriptEl.getAttribute('data-kala-endpoint')));
  const BLACKBOX_HTTP = endpointAttr || window.__BLACKBOX_ENDPOINT__ || window.__KALA_ENDPOINT__ || 'http://localhost:9876';
  const BLACKBOX_WS = BLACKBOX_HTTP.replace(/^http/, 'ws') + '/ws?role=agent';

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
      ws = new WebSocket(BLACKBOX_WS);
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
        origFetch(`${BLACKBOX_HTTP}/api/ingest`, {
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
      origFetch(`${BLACKBOX_HTTP}/api/freeze`, {
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
      // Remove Blackbox HUD host & scripts so replay is safe and clean
      const hudNodes = clone.querySelectorAll('#__blackbox_hud_host__, #__kala_hud_host__, script');
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
  window.fetch = async function blackboxInterceptedFetch(input, init = {}) {
    const urlStr = typeof input === 'string' ? input : input?.url || String(input);

    // Do not intercept Blackbox's own telemetry calls
    if (urlStr.includes(':9876') || urlStr.includes('/__blackbox__') || urlStr.includes('/__kala__')) {
      return origFetch(input, init);
    }

    const traceId = getActiveTraceId();
    const startTimeMs = Date.now();
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();

    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
    headers.set('X-Blackbox-Trace-Id', traceId);
    headers.set('X-Kala-Trace-Id', traceId);
    if (lastActionTrace && Date.now() - lastActionTrace.timestampMs < 2200) {
      headers.set('X-Blackbox-Trigger-Action', encodeURIComponent(lastActionTrace.selector || 'click'));
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
    if (!document.body || document.getElementById('__blackbox_hud_host__') || document.getElementById('__kala_hud_host__')) return;
    const host = document.createElement('div');
    host.id = '__blackbox_hud_host__';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .blackbox-pill {
          position: fixed;
          bottom: 16px;
          right: 16px;
          z-index: 2147483647;
          display: flex;
          align-items: center;
          gap: 10px;
          background: rgba(14, 17, 36, 0.94);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(175, 174, 162, 0.35);
          border-radius: 999px;
          padding: 7px 15px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
          font-size: 12px;
          color: #F4F3EE;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
          user-select: none;
        }
        .blackbox-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 10px #10b981;
          animation: pulse 2s infinite;
        }
        .blackbox-dot.offline {
          background: #f59e0b;
          box-shadow: 0 0 8px #f59e0b;
        }
        .blackbox-dot.error {
          background: #D21319;
          box-shadow: 0 0 12px #D21319;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.55; transform: scale(0.88); }
        }
        .blackbox-brand {
          font-weight: 800;
          letter-spacing: 0.08em;
          color: #F4F3EE;
        }
        .blackbox-stats {
          color: #AFAEA2;
          font-size: 11px;
        }
        .blackbox-btn {
          background: #D21319;
          border: 1px solid #FF262E;
          color: #ffffff;
          font-weight: 700;
          font-size: 11px;
          padding: 5px 12px;
          border-radius: 999px;
          cursor: pointer;
          box-shadow: 0 2px 10px rgba(210, 19, 25, 0.4);
          transition: transform 0.15s ease, opacity 0.15s ease;
        }
        .blackbox-btn:hover {
          transform: translateY(-1px);
          filter: brightness(1.1);
        }
        .blackbox-link {
          color: #AFAEA2;
          text-decoration: none;
          font-size: 11px;
          font-weight: 600;
        }
        .blackbox-link:hover {
          color: #F4F3EE;
          text-decoration: underline;
        }
        .blackbox-toast {
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
        .blackbox-toast a {
          color: #34d399;
          font-weight: 700;
          margin-left: 8px;
        }
      </style>
      <div class="blackbox-toast" id="blackboxToast"></div>
      <div class="blackbox-pill">
        <span class="blackbox-dot" id="blackboxDot"></span>
        <span class="blackbox-brand">BLACKBOX</span>
        <span class="blackbox-stats" id="blackboxStats">60s Ring Buffer</span>
        <button class="blackbox-btn" id="blackboxFreezeBtn" title="Shortcut: Alt+Shift+B">Freeze Capsule</button>
        <a class="blackbox-link" href="${BLACKBOX_HTTP}" target="_blank" title="Open Blackbox Studio">Studio ↗</a>
      </div>
    `;

    document.body.appendChild(host);
    hudStatsEl = shadow.getElementById('blackboxStats');
    hudDotEl = shadow.getElementById('blackboxDot');
    hudToastEl = shadow.getElementById('blackboxToast');
    const freezeBtn = shadow.getElementById('blackboxFreezeBtn');
    freezeBtn.addEventListener('click', () => triggerFreezeNow('HUD_BUTTON_CLICK'));
    updateHudStatus();
  }

  function updateHudStatus() {
    if (!hudStatsEl || !hudDotEl) return;
    hudStatsEl.textContent = `${eventCount} evts${errorCount > 0 ? ` · ${errorCount} err` : ''}`;
    hudDotEl.className =
      'blackbox-dot' + (!wsConnected ? ' offline' : errorCount > 0 ? ' error' : '');
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
