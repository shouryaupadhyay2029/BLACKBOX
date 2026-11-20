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

  // Capture original fetch immediately before any telemetry fallback can reference it
  const origFetch = window.fetch.bind(window);

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

      // Inject <base> so relative CSS, fonts, and images resolve cleanly inside Studio's sandboxed iframe
      const head = clone.querySelector('head');
      if (head && !head.querySelector('base')) {
        const baseEl = document.createElement('base');
        baseEl.setAttribute('href', window.location.origin + '/');
        head.insertBefore(baseEl, head.firstChild);
      }

      // Compact inline dev-server <style> tags (strip comments & extra whitespace) so <head> never starves <body>
      clone.querySelectorAll('style').forEach((styleEl) => {
        if (styleEl.textContent) {
          styleEl.textContent = styleEl.textContent
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        }
      });

      // Snapshot <canvas> elements as PNG <img> nodes so Canvas/Radar/Chart apps replay visually
      const origCanvases = document.querySelectorAll('canvas');
      const cloneCanvases = clone.querySelectorAll('canvas');
      origCanvases.forEach((origC, idx) => {
        const cloneC = cloneCanvases[idx];
        if (!cloneC) return;
        try {
          if (origC.width > 0 && origC.height > 0) {
            const dataUrl = origC.toDataURL('image/png');
            if (dataUrl && dataUrl.length < 220000) {
              const img = document.createElement('img');
              img.setAttribute('src', dataUrl);
              if (cloneC.getAttribute('class')) img.setAttribute('class', cloneC.getAttribute('class'));
              if (cloneC.getAttribute('style')) img.setAttribute('style', cloneC.getAttribute('style'));
              img.style.width = origC.clientWidth ? `${origC.clientWidth}px` : `${origC.width}px`;
              img.style.height = origC.clientHeight ? `${origC.clientHeight}px` : `${origC.height}px`;
              cloneC.replaceWith(img);
            }
          }
        } catch {
          // ignore tainted cross-origin canvases
        }
      });

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

      // Budget <head> and <body> separately so <body> is NEVER chopped off by large dev CSS
      const headHtml = (clone.querySelector('head')?.outerHTML || '<head></head>').slice(0, 260000);
      const bodyHtml = (clone.querySelector('body')?.outerHTML || '<body></body>').slice(0, 260000);
      return `<!DOCTYPE html>\n<html>${headHtml}${bodyHtml}</html>`;
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
      if (
        e.target &&
        e.target.closest &&
        (e.target.closest('#__blackbox_hud_host__') || e.target.closest('#__kala_hud_host__'))
      ) {
        return;
      }
      const target = e.target;
      const traceId = genTraceId();
      const clickable = target && target.closest ? target.closest('button, a, [role="button"], input, select') || target : target;
      const selector = getSelector(clickable);
      const rawText = (
        (clickable &&
          (clickable.getAttribute?.('aria-label') ||
            clickable.getAttribute?.('title') ||
            clickable.innerText ||
            clickable.value)) ||
        ''
      )
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 60);
      const text = rawText;

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

  // Form Submissions & SPA Navigation Tracking
  window.addEventListener(
    'submit',
    (e) => {
      const form = e.target;
      const traceId = genTraceId();
      const selector = getSelector(form);
      lastActionTrace = {
        traceId,
        timestampMs: Date.now(),
        selector,
        text: `Submit ${selector}`,
      };
      sendEvent({
        plane: 'BROWSER',
        type: 'UI_SUBMIT',
        severity: 'info',
        traceId,
        payload: {
          selector,
          tagName: 'FORM',
          text: `Submit ${selector}`,
        },
      });
    },
    true
  );

  let lastTrackedUrl = window.location.href;
  function emitRouteChange(kind) {
    const nextUrl = window.location.href;
    if (nextUrl === lastTrackedUrl) return;
    const prevUrl = lastTrackedUrl;
    lastTrackedUrl = nextUrl;
    sendEvent({
      plane: 'BROWSER',
      type: 'UI_NAVIGATE',
      severity: 'info',
      traceId: lastActionTrace?.traceId || null,
      payload: {
        kind,
        from: prevUrl,
        to: nextUrl,
      },
    });
    setTimeout(() => captureDomSnapshot('POST_NAVIGATE'), 120);
  }

  window.addEventListener('hashchange', () => emitRouteChange('hashchange'));
  window.addEventListener('popstate', () => emitRouteChange('popstate'));
  try {
    const origPushState = history.pushState.bind(history);
    history.pushState = function (...pushArgs) {
      const res = origPushState(...pushArgs);
      emitRouteChange('pushState');
      return res;
    };
  } catch {
    // ignore
  }

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
  function sanitizeHeaderMap(headersObj) {
    const out = {};
    try {
      headersObj.forEach((v, k) => {
        out[k] = /authorization|cookie|secret|token|api-key/i.test(k) ? '***REDACTED***' : v;
      });
    } catch {
      // ignore
    }
    return out;
  }

  window.fetch = async function blackboxInterceptedFetch(input, init = {}) {
    const urlStr = typeof input === 'string' ? input : input?.url || String(input);

    // Do not intercept Blackbox's own telemetry calls or dev-server HMR / restart pings
    const rawAccept =
      (init.headers && (init.headers.Accept || init.headers.accept)) ||
      (init.headers instanceof Headers && init.headers.get('accept')) ||
      '';
    if (
      urlStr.includes(':9876') ||
      urlStr.includes('/__blackbox__') ||
      urlStr.includes('/__kala__') ||
      urlStr.includes('/__vite_ping') ||
      urlStr.includes('/@vite/') ||
      urlStr.includes('/@react-refresh') ||
      urlStr.includes('/_next/webpack-hmr') ||
      urlStr.includes('/sockjs-node') ||
      urlStr.includes('.hot-update.') ||
      String(rawAccept).includes('text/x-vite-ping')
    ) {
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
              requestHeaders: sanitizeHeaderMap(headers),
              responseHeaders: sanitizeHeaderMap(response.headers),
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

        if (
          message.includes('[BLACKBOX]') ||
          message.includes('[KALA]') ||
          /^\[vite\]\s+(connecting|connected|server connection lost|hot updated)/i.test(message.trim())
        ) {
          return;
        }

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

  // --- 6. Shadow-DOM Minimal Frosted-Glass Floating HUD Dock ---
  let hudStatsEl = null;
  let hudErrEl = null;
  let hudDotEl = null;
  let hudPillEl = null;
  let hudFreezeBtn = null;
  let hudToastEl = null;
  let hudToastTimer = null;

  function mountHudPill() {
    if (!document.body || document.getElementById('__blackbox_hud_host__') || document.getElementById('__kala_hud_host__')) return;
    const host = document.createElement('div');
    host.id = '__blackbox_hud_host__';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        *, *::before, *::after {
          box-sizing: border-box;
        }
        .bb-dock {
          position: fixed;
          bottom: 18px;
          right: 18px;
          z-index: 2147483647;
          height: 38px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 0 6px 0 12px;
          border-radius: 999px;
          background: rgba(10, 11, 15, 0.86);
          -webkit-backdrop-filter: blur(22px) saturate(180%);
          backdrop-filter: blur(22px) saturate(180%);
          border: 1px solid rgba(255, 255, 255, 0.11);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.10),
            0 18px 40px -10px rgba(0, 0, 0, 0.65),
            0 2px 10px rgba(0, 0, 0, 0.35);
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          color: #F4F4F5;
          user-select: none;
          transition: border-color 0.25s ease, box-shadow 0.25s ease, padding 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .bb-dock:hover {
          border-color: rgba(255, 255, 255, 0.18);
        }
        .bb-dock.has-error {
          border-color: rgba(244, 63, 94, 0.42);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.09),
            0 0 24px -4px rgba(244, 63, 94, 0.28),
            0 18px 40px -10px rgba(0, 0, 0, 0.7);
        }
        .bb-identity {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          cursor: default;
        }
        .bb-dot-wrap {
          position: relative;
          width: 8px;
          height: 8px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .bb-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #34D399;
          box-shadow: 0 0 0 2px rgba(52, 211, 153, 0.18);
          transition: background 0.25s ease, box-shadow 0.25s ease;
        }
        .bb-dot::after {
          content: "";
          position: absolute;
          inset: -2px;
          border-radius: 50%;
          border: 1px solid #34D399;
          opacity: 0;
          animation: bbPing 2.6s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
        .bb-dot.offline {
          background: #FBBF24;
          box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.18);
        }
        .bb-dot.offline::after {
          border-color: #FBBF24;
          animation: none;
        }
        .bb-dot.error {
          background: #FB7185;
          box-shadow: 0 0 0 2px rgba(244, 63, 94, 0.25);
        }
        .bb-dot.error::after {
          border-color: #F43F5E;
          animation-duration: 1.5s;
        }
        @keyframes bbPing {
          0% { transform: scale(0.8); opacity: 0.7; }
          80%, 100% { transform: scale(2.1); opacity: 0; }
        }
        .bb-brand {
          font-size: 10.5px;
          font-weight: 650;
          letter-spacing: 0.14em;
          color: #F4F4F5;
          line-height: 1;
        }
        .bb-sep {
          width: 1px;
          height: 14px;
          background: rgba(255, 255, 255, 0.10);
          flex-shrink: 0;
        }
        .bb-metrics {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-variant-numeric: tabular-nums;
          font-size: 10.5px;
          color: #A1A1AA;
        }
        .bb-err-chip {
          display: none;
          align-items: center;
          gap: 4px;
          padding: 2px 7px;
          border-radius: 999px;
          background: rgba(244, 63, 94, 0.15);
          border: 1px solid rgba(244, 63, 94, 0.32);
          color: #FDA4AF;
          font-size: 10px;
          font-weight: 600;
          line-height: 1.2;
        }
        .bb-err-chip.visible {
          display: inline-flex;
        }
        .bb-freeze-btn {
          height: 26px;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 0 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.13);
          color: #FAFAFA;
          font-family: inherit;
          font-size: 11px;
          font-weight: 550;
          letter-spacing: 0.01em;
          cursor: pointer;
          transition: background 0.16s ease, border-color 0.16s ease, transform 0.12s ease, color 0.16s ease;
        }
        .bb-freeze-btn:hover {
          background: rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.24);
        }
        .bb-freeze-btn:active {
          transform: scale(0.97);
        }
        .bb-freeze-btn.saved {
          background: rgba(16, 185, 129, 0.18);
          border-color: rgba(52, 211, 153, 0.4);
          color: #6EE7B7;
        }
        .bb-kbd {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 9px;
          color: rgba(255, 255, 255, 0.42);
          padding: 1px 4px;
          border-radius: 4px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .bb-studio-link {
          height: 26px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 0 8px;
          border-radius: 999px;
          color: #A1A1AA;
          text-decoration: none;
          font-size: 11px;
          font-weight: 500;
          transition: color 0.16s ease, background 0.16s ease;
        }
        .bb-studio-link:hover {
          color: #FAFAFA;
          background: rgba(255, 255, 255, 0.07);
        }
        .bb-min-btn {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          border: 1px solid transparent;
          background: transparent;
          color: #71717A;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          padding: 0;
          transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
        }
        .bb-min-btn:hover {
          color: #F4F4F5;
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.10);
        }
        .bb-dock.minimized {
          padding: 0 6px 0 11px;
          gap: 6px;
          cursor: pointer;
        }
        .bb-dock.minimized .bb-brand,
        .bb-dock.minimized .bb-sep,
        .bb-dock.minimized .bb-count-text,
        .bb-dock.minimized .bb-freeze-btn,
        .bb-dock.minimized .bb-studio-link {
          display: none;
        }
        .bb-toast {
          position: fixed;
          bottom: 66px;
          right: 18px;
          z-index: 2147483647;
          display: none;
          align-items: center;
          gap: 10px;
          padding: 9px 12px 9px 13px;
          border-radius: 12px;
          background: rgba(10, 11, 15, 0.92);
          -webkit-backdrop-filter: blur(22px) saturate(180%);
          backdrop-filter: blur(22px) saturate(180%);
          border: 1px solid rgba(52, 211, 153, 0.3);
          box-shadow:
            inset 0 1px 0 rgba(255, 255, 255, 0.08),
            0 18px 36px -8px rgba(0, 0, 0, 0.65);
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          font-size: 11.5px;
          color: #E4E4E7;
          animation: bbToastIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
        }
        .bb-toast.visible {
          display: inline-flex;
        }
        @keyframes bbToastIn {
          from { opacity: 0; transform: translateY(6px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .bb-toast-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #34D399;
          flex-shrink: 0;
        }
        .bb-toast-cta {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 4px 9px;
          border-radius: 999px;
          background: rgba(52, 211, 153, 0.14);
          border: 1px solid rgba(52, 211, 153, 0.32);
          color: #6EE7B7;
          text-decoration: none;
          font-size: 11px;
          font-weight: 600;
          transition: background 0.15s ease;
        }
        .bb-toast-cta:hover {
          background: rgba(52, 211, 153, 0.24);
        }
      </style>
      <div class="bb-toast" id="blackboxToast"></div>
      <div class="bb-dock" id="blackboxPill">
        <span class="bb-identity" title="Blackbox 60s Rolling Flight Recorder">
          <span class="bb-dot-wrap"><span class="bb-dot" id="blackboxDot"></span></span>
          <span class="bb-brand">BLACKBOX</span>
        </span>
        <span class="bb-sep"></span>
        <span class="bb-metrics">
          <span class="bb-count-text" id="blackboxStats">0 evts</span>
          <span class="bb-err-chip" id="blackboxErrChip"></span>
        </span>
        <span class="bb-sep"></span>
        <button class="bb-freeze-btn" id="blackboxFreezeBtn" title="Freeze last 60s capsule (Alt+Shift+B)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"></circle>
            <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
          </svg>
          <span id="blackboxFreezeLabel">Freeze</span>
          <span class="bb-kbd">⌥⇧B</span>
        </button>
        <a class="bb-studio-link" href="${BLACKBOX_HTTP}" target="_blank" title="Open Blackbox Studio">
          <span>Studio</span>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 17L17 7"></path>
            <path d="M7 7h10v10"></path>
          </svg>
        </a>
        <button class="bb-min-btn" id="blackboxMinBtn" title="Minimize dock" aria-label="Minimize Blackbox dock">
          <svg id="blackboxMinIcon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14"></path>
          </svg>
        </button>
      </div>
    `;

    document.body.appendChild(host);
    hudStatsEl = shadow.getElementById('blackboxStats');
    hudErrEl = shadow.getElementById('blackboxErrChip');
    hudDotEl = shadow.getElementById('blackboxDot');
    hudPillEl = shadow.getElementById('blackboxPill');
    hudToastEl = shadow.getElementById('blackboxToast');
    hudFreezeBtn = shadow.getElementById('blackboxFreezeBtn');
    const freezeLabel = shadow.getElementById('blackboxFreezeLabel');
    const minBtn = shadow.getElementById('blackboxMinBtn');
    const minIcon = shadow.getElementById('blackboxMinIcon');

    hudFreezeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerFreezeNow('HUD_BUTTON_CLICK');
      hudFreezeBtn.classList.add('saved');
      if (freezeLabel) freezeLabel.textContent = 'Saved';
      setTimeout(() => {
        hudFreezeBtn?.classList.remove('saved');
        if (freezeLabel) freezeLabel.textContent = 'Freeze';
      }, 1500);
    });

    const toggleMinimize = (e) => {
      if (e) e.stopPropagation();
      const collapsed = hudPillEl.classList.toggle('minimized');
      minBtn.title = collapsed ? 'Expand Blackbox dock' : 'Minimize dock';
      if (minIcon) {
        minIcon.innerHTML = collapsed
          ? '<path d="M12 5v14"></path><path d="M5 12h14"></path>'
          : '<path d="M5 12h14"></path>';
      }
    };

    minBtn.addEventListener('click', toggleMinimize);
    hudPillEl.addEventListener('click', () => {
      if (hudPillEl.classList.contains('minimized')) {
        toggleMinimize();
      }
    });
    updateHudStatus();
  }

  function updateHudStatus() {
    if (!hudStatsEl || !hudDotEl) return;
    hudStatsEl.textContent = `${eventCount} evts`;
    if (hudErrEl) {
      if (errorCount > 0) {
        hudErrEl.textContent = `${errorCount} ${errorCount === 1 ? 'fault' : 'faults'}`;
        hudErrEl.classList.add('visible');
      } else {
        hudErrEl.classList.remove('visible');
      }
    }
    hudDotEl.className =
      'bb-dot' + (!wsConnected ? ' offline' : errorCount > 0 ? ' error' : '');
    if (hudPillEl) {
      hudPillEl.classList.toggle('has-error', errorCount > 0);
    }
  }

  function showHudToast(text, url) {
    if (!hudToastEl) return;
    if (hudToastTimer) clearTimeout(hudToastTimer);
    const shortText = String(text || 'Capsule Frozen').replace(/cap_\d{4}-\d{2}-\d{2}T[\d-]+Z_/, 'cap_');
    hudToastEl.innerHTML = `
      <span class="bb-toast-dot"></span>
      <span>${shortText}</span>
      ${url ? `<a class="bb-toast-cta" href="${url}" target="_blank">Open Studio →</a>` : ''}
    `;
    hudToastEl.classList.add('visible');
    hudToastTimer = setTimeout(() => {
      if (hudToastEl) hudToastEl.classList.remove('visible');
      hudToastTimer = null;
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
