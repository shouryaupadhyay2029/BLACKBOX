/**
 * KALA Blackbox Studio — Synchronized 4-Pane Time-Travel Scrubber & Flight Deck Engine
 */

let capsulesList = [];
let activeCapsule = null;
let currentRelMs = 0;
let maxDurationMs = 1000;
let lastRenderedDomEventId = null;
let isPlaying = false;
let playTimer = null;
let vaultStatusFilter = 'ALL'; // 'ALL' | 'FAULT' | 'SNAPSHOT'
let lastDaemonStatus = null;
let toastTimer = null;
let liveStreamPaused = false;
let liveSearchQuery = '';

// DOM Elements
const capsuleListEl = document.getElementById('capsuleList');
const capsuleCountBadge = document.getElementById('capsuleCountBadge');
const bufferStatText = document.getElementById('bufferStatText');
const gitStatText = document.getElementById('gitStatText');
const autoFreezeCheck = document.getElementById('autoFreezeCheck');

const capsuleStatusTag = document.getElementById('capsuleStatusTag');
const capsuleHeadline = document.getElementById('capsuleHeadline');
const capsuleMetaText = document.getElementById('capsuleMetaText');
const causalChainFlow = document.getElementById('causalChainFlow');

const domReplayFrame = document.getElementById('domReplayFrame');
const domStageWrapper = document.getElementById('domStageWrapper');
const domStageViewport = document.getElementById('domStageViewport');
const domResPill = document.getElementById('domResPill');
const btnToggleDomFit = document.getElementById('btnToggleDomFit');
const btnExpandDomStage = document.getElementById('btnExpandDomStage');
const domUrlPill = document.getElementById('domUrlPill');
const domClickBadge = document.getElementById('domClickBadge');
const cursorLaser = document.getElementById('cursorLaser');
const cursorLaserLabel = document.getElementById('cursorLaserLabel');
let isDomFitMode = true;
let currentDomViewport = { width: 1280, height: 800 };

function updateDomReplayScaling() {
  if (!domStageWrapper || !domStageViewport) return;
  const vpW = currentDomViewport.width || 1280;
  const vpH = currentDomViewport.height || 800;

  domStageViewport.style.width = `${vpW}px`;
  domStageViewport.style.height = `${vpH}px`;

  const stageW = domStageWrapper.clientWidth || 600;
  const stageH = domStageWrapper.clientHeight || 400;

  let scale = 1;
  if (isDomFitMode) {
    const scaleX = (stageW - 24) / vpW;
    const scaleY = (stageH - 24) / vpH;
    scale = Math.min(scaleX, scaleY);
    scale = Math.max(0.15, Math.min(1.25, scale));
    domStageWrapper.style.overflow = 'hidden';
  } else {
    scale = 1.0;
    domStageWrapper.style.overflow = 'auto';
  }

  domStageViewport.style.transform = `scale(${scale.toFixed(3)})`;
  domStageViewport.style.transformOrigin = 'center center';

  if (domResPill) {
    domResPill.textContent = `${vpW}×${vpH} · ${isDomFitMode ? Math.round(scale * 100) + '%' : '100%'}`;
  }
}
const browserConsoleList = document.getElementById('browserConsoleList');
const browserStoragePre = document.getElementById('browserStoragePre');
const consoleCount = document.getElementById('consoleCount');

const networkWaterfallList = document.getElementById('networkWaterfallList');
const networkPayloadInspector = document.getElementById('networkPayloadInspector');
const netCount = document.getElementById('netCount');

const terminalStreamList = document.getElementById('terminalStreamList');
const sourceXrayContainer = document.getElementById('sourceXrayContainer');
const termCount = document.getElementById('termCount');

const gitInspectorContainer = document.getElementById('gitInspectorContainer');
const aiMarkdownPreview = document.getElementById('aiMarkdownPreview');

const timeScrubber = document.getElementById('timeScrubber');
const scrubberMarkers = document.getElementById('scrubberMarkers');
const scrubberTimeReadout = document.getElementById('scrubberTimeReadout');
const scrubberEventReadout = document.getElementById('scrubberEventReadout');
const playPauseBtn = document.getElementById('playPauseBtn');
const playbackSpeedSelect = document.getElementById('playbackSpeedSelect');
const liveStreamFeed = document.getElementById('liveStreamFeed');

// --- 1. Initialization & WebSocket Live Link ---
async function initStudio() {
  setupTabs();
  setupModeSwitcher();
  setupViewSwitcher();
  setupVaultToggle();
  setupActions();
  setupHexCliSection();

  await fetchDaemonStatus();
  await loadCapsulesList();

  setupKeyboardShortcuts();

  const urlParams = new URLSearchParams(window.location.search);
  const requestedCap = urlParams.get('capsule');
  if (requestedCap) {
    await selectCapsule(requestedCap);
  } else if (capsulesList.length > 0) {
    await selectCapsule(capsulesList[0].id);
  }

  const requestedMode = urlParams.get('mode');
  if (requestedMode && ['inspector', 'live', 'diff', 'cli'].includes(requestedMode)) {
    switchMode(requestedMode);
  }

  connectStudioWebSocket();
  setInterval(fetchDaemonStatus, 4000);
}

function connectStudioWebSocket() {
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${wsProto}//${window.location.host}/ws?role=studio`);

  ws.onmessage = async (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'LIVE_EVENT' && msg.event) {
        appendLiveFeedEvent(msg.event);
      } else if (msg.type === 'BUFFER_CLEARED') {
        clearLiveFeedUi();
      } else if (msg.type === 'CAPSULE_FROZEN' && msg.capsule) {
        showToast(`❄️ New Capsule Frozen: ${msg.capsule.title}`);
        await loadCapsulesList();
        if (!activeCapsule || msg.capsule.status === 'FAULT_DETECTED') {
          await selectCapsule(msg.capsule.id);
        }
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    setTimeout(connectStudioWebSocket, 3000);
  };
}

async function fetchDaemonStatus() {
  const daemonDot = document.getElementById('daemonDot');
  const stampEl = document.getElementById('projectTelemetryStamp');
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.ok) return;
    lastDaemonStatus = data;
    if (daemonDot) {
      daemonDot.className = 'dot live';
    }
    bufferStatText.textContent = `Buffer: ${data.buffer.activeEvents} evts (${data.buffer.memoryMB}MB)`;
    gitStatText.textContent = data.git.isGitRepo
      ? `${data.git.branch}@${data.git.headCommit}${
          data.git.isDirty ? ` (${data.git.modifiedCount} dirty)` : ' (clean)'
        }`
      : 'no-git';
    autoFreezeCheck.checked = Boolean(data.autoFreeze);
    if (stampEl) {
      const agents = data.connectedBrowserAgents || 0;
      const proj = (data.projectName || 'localhost').toUpperCase();
      stampEl.textContent = `✦ PROJECT: ${proj} · DAEMON :${data.daemonPort || 9876} · ${agents} AGENT${agents === 1 ? '' : 'S'}`;
    }
    const rateBadge = document.getElementById('liveStreamRateBadge');
    if (rateBadge && !liveStreamPaused) {
      rateBadge.textContent = `${data.buffer.activeEvents} events buffered (${data.buffer.memoryMB}MB · 60s window)`;
    }
  } catch {
    if (daemonDot) {
      daemonDot.className = 'dot offline';
    }
    bufferStatText.textContent = 'Daemon Disconnected';
    if (stampEl) {
      stampEl.textContent = '✦ DAEMON OFFLINE · RECONNECTING...';
    }
  }
}

async function loadCapsulesList() {
  try {
    const res = await fetch('/api/capsules');
    const data = await res.json();
    capsulesList = data.capsules || [];
    capsuleCountBadge.textContent = String(capsulesList.length);
    renderCapsuleSidebar();
    populateDiffSelectors();
  } catch {
    // ignore
  }
}

function renderCapsuleSidebar() {
  const searchInput = document.getElementById('capsuleSearchInput');
  const query = (searchInput?.value || '').trim().toLowerCase();

  let filtered = capsulesList;
  if (vaultStatusFilter === 'FAULT') {
    filtered = filtered.filter((c) => c.status === 'FAULT_DETECTED');
  } else if (vaultStatusFilter === 'SNAPSHOT') {
    filtered = filtered.filter((c) => c.status !== 'FAULT_DETECTED');
  }

  if (query) {
    filtered = filtered.filter(
      (c) =>
        (c.title && c.title.toLowerCase().includes(query)) ||
        (c.id && c.id.toLowerCase().includes(query)) ||
        (c.culpritFile && c.culpritFile.toLowerCase().includes(query)) ||
        (c.status && c.status.toLowerCase().includes(query))
    );
  }

  if (filtered.length === 0) {
    capsuleListEl.innerHTML =
      query || vaultStatusFilter !== 'ALL'
        ? '<div class="empty-hint">No capsules match your current filter.</div>'
        : '<div class="empty-hint">No capsules frozen yet. Trigger a bug or click "Freeze Capsule Now".</div>';
    return;
  }

  capsuleListEl.innerHTML = filtered
    .map((c) => {
      const isFault = c.status === 'FAULT_DETECTED';
      const isActive = activeCapsule && activeCapsule.id === c.id;
      const timeStr = new Date(c.createdAt).toLocaleTimeString();
      const shortCulprit = c.culpritFile
        ? `${c.culpritFile.split(/[\\/]/).pop()}${c.culpritLine ? ':' + c.culpritLine : ''}`
        : '';
      return `
        <div class="capsule-card ${isActive ? 'active' : ''}" data-cap-id="${escapeHtml(c.id)}">
          <div class="cap-top">
            <span class="cap-badge ${isFault ? 'fault' : 'ok'}">${
        isFault ? '✦ FAULT' : '✦ SNAPSHOT'
      }</span>
            <div class="cap-actions">
              <span class="cap-time">${escapeHtml(timeStr)}</span>
              <button class="cap-del-btn" data-del-id="${escapeHtml(c.id)}" title="Delete Capsule">✕</button>
            </div>
          </div>
          <div class="cap-title">${escapeHtml(c.title)}</div>
          ${shortCulprit ? `<div class="cap-culprit-chip">⌖ ${escapeHtml(shortCulprit)}</div>` : ''}
          <div class="cap-meta">
            <span>${c.totalEvents} evts · ${(c.durationMs / 1000).toFixed(1)}s</span>
            <span>${c.totalChains || 0} chain(s)</span>
          </div>
        </div>
      `;
    })
    .join('');

  capsuleListEl.querySelectorAll('.capsule-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.cap-del-btn')) return;
      const id = card.getAttribute('data-cap-id');
      selectCapsule(id);
    });
  });

  capsuleListEl.querySelectorAll('.cap-del-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-del-id');
      if (!confirm(`Delete capsule ${id}?`)) return;
      try {
        const res = await fetch(`/api/capsules/${encodeURIComponent(id)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          showToast(`🗑 Deleted capsule: ${id}`);
          await loadCapsulesList();
          if (activeCapsule?.id === id) {
            if (capsulesList.length > 0) {
              await selectCapsule(capsulesList[0].id);
            } else {
              activeCapsule = null;
              capsuleHeadline.textContent = 'Select or freeze a capsule to inspect causal time-travel state';
              capsuleStatusTag.textContent = 'STANDBY';
              capsuleStatusTag.className = 'status-tag';
              causalChainFlow.innerHTML = '';
            }
          }
        }
      } catch (err) {
        showToast(`Delete failed: ${err.message}`);
      }
    });
  });
}

// --- 2. Loading & Rendering a Capsule into the 4-Pane Time Machine ---
async function selectCapsule(id) {
  stopPlayback();
  try {
    const res = await fetch(`/api/capsules/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!data.ok || !data.capsule) return;

    activeCapsule = data.capsule;
    lastRenderedDomEventId = null;
    renderCapsuleSidebar();

    maxDurationMs = Math.max(100, Math.ceil(activeCapsule.window?.durationMs || 1000));
    timeScrubber.min = '0';
    timeScrubber.max = String(maxDurationMs);
    currentRelMs = maxDurationMs; // Start at end of capsule (the crash moment)
    timeScrubber.value = String(currentRelMs);

    renderCausalBanner(activeCapsule);
    renderScrubberMarkers(activeCapsule);
    renderSourceXrayPane(activeCapsule);
    renderGitAndAiPane(activeCapsule);
    renderStaticEventLists(activeCapsule);
    syncTimeScrubber(currentRelMs);
  } catch (err) {
    showToast(`Error loading capsule: ${err.message}`);
  }
}

function renderCausalBanner(capsule) {
  const summary = capsule.causal?.rootCauseSummary || {};
  const isFault = summary.status === 'FAULT_DETECTED';

  const capsuleIdBadge = document.getElementById('capsuleIdBadge');
  if (capsuleIdBadge) {
    capsuleIdBadge.textContent = capsule.id ? `DOSSIER · ${capsule.id}` : 'ARCHIVE DOSSIER';
  }

  capsuleStatusTag.textContent = isFault ? '✦ FAULT DETECTED' : '✦ HEALTHY SNAPSHOT';
  capsuleStatusTag.className = `status-tag ${isFault ? 'fault' : ''}`;
  const isCustomTitle =
    capsule.title &&
    !capsule.title.startsWith('Flight Capsule (') &&
    !capsule.title.startsWith('Auto-frozen on ');
  capsuleHeadline.textContent = isCustomTitle ? capsule.title : summary.headline || capsule.title;

  let existingNoteEl = document.getElementById('capsuleNoteBanner');
  if (capsule.notes) {
    if (!existingNoteEl) {
      existingNoteEl = document.createElement('div');
      existingNoteEl.id = 'capsuleNoteBanner';
      existingNoteEl.className = 'capsule-note-banner';
      capsuleHeadline.parentElement?.appendChild(existingNoteEl);
    }
    existingNoteEl.textContent = `✎ Note: ${capsule.notes}`;
    existingNoteEl.style.display = 'block';
  } else if (existingNoteEl) {
    existingNoteEl.style.display = 'none';
  }

  const rawCulprit = summary.culpritFile || '';
  const shortCulprit = rawCulprit.replace(/^.*?[\\/]blackbox[\\/]/i, '').replace(/\\/g, '/');
  const lineSuffix = summary.culpritLine ? `:${summary.culpritLine}` : '';
  const confidence = summary.confidence ? ` · ${summary.confidence.replace(/_/g, ' ')}` : '';

  if (rawCulprit) {
    capsuleMetaText.textContent = `${shortCulprit || rawCulprit}${lineSuffix}${confidence}`;
    capsuleMetaText.title = `Click to inspect ${rawCulprit}:${summary.culpritLine || 1} in Source Code X-Ray`;
    capsuleMetaText.style.cursor = 'pointer';
    capsuleMetaText.onclick = () => inspectSourceFile(rawCulprit, summary.culpritLine || 1);
  } else {
    capsuleMetaText.textContent = `Trigger Reason: ${capsule.triggerReason || 'MANUAL_FREEZE'}`;
    capsuleMetaText.style.cursor = 'default';
    capsuleMetaText.onclick = null;
  }

  const chains = capsule.causal?.causalChains || [];
  if (chains.length === 0) {
    causalChainFlow.innerHTML =
      '<div style="font-size:11px;color:#AFAEA2;font-family:var(--font-mono);padding:8px 0;">No unhandled fault chains in this capsule window. Scrub timeline below to inspect all 4 planes.</div>';
    return;
  }

  const primary = chains[0];
  causalChainFlow.innerHTML = (primary.steps || [])
    .map((step, idx) => {
      const timeBadge =
        step.relTimeMs !== null ? `+${(step.relTimeMs / 1000).toFixed(2)}s` : 'WORKING TREE';
      return `
        ${idx > 0 ? '<span class="chain-arrow">—✦→</span>' : ''}
        <div class="chain-node" data-chain-plane="${escapeHtml(step.plane)}" data-chain-time="${step.relTimeMs ?? ''}" title="Click to jump to ${escapeHtml(step.plane)} at ${escapeHtml(timeBadge)}">
          <div class="chain-node-top">
            <span class="plane-badge plane-${step.plane.toLowerCase()}">${escapeHtml(
        step.plane
      )}</span>
            <span style="color:#94a3b8">${escapeHtml(timeBadge)}</span>
          </div>
          <div class="chain-node-title" title="${escapeHtml(step.title)}">${escapeHtml(
        step.title
      )}</div>
          <div class="chain-node-sub" title="${escapeHtml(step.detail)}">${escapeHtml(
        step.detail
      )}</div>
        </div>
      `;
    })
    .join('');

  causalChainFlow.querySelectorAll('.chain-node').forEach((node) => {
    node.addEventListener('click', () => {
      const plane = node.getAttribute('data-chain-plane');
      const relTime = node.getAttribute('data-chain-time');
      if (relTime && relTime !== '') {
        const timeMs = Number(relTime);
        timeScrubber.value = String(Math.round(timeMs));
        syncTimeScrubber(timeMs);
      }
      if (plane === 'BROWSER') {
        activatePaneTab('p1', 'dom');
        document.getElementById('paneBrowser')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (plane === 'NETWORK') {
        activatePaneTab('p2', 'waterfall');
        document.getElementById('paneNetwork')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (plane === 'TERMINAL') {
        activatePaneTab('p3', 'xray');
        document.getElementById('paneTerminal')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (plane === 'GIT') {
        activatePaneTab('p4', 'git');
        document.getElementById('paneGitAi')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      showToast(`⌖ Focused Plane: ${plane}`);
    });
  });
}

function renderScrubberMarkers(capsule) {
  const markers = capsule.causal?.timelineMarkers || [];
  const dur = Math.max(1, capsule.window?.durationMs || 1000);

  scrubberMarkers.innerHTML = markers
    .map((m) => {
      const pct = Math.min(99.5, Math.max(0.5, (m.relTimeMs / dur) * 100));
      return `<div class="marker-pin ${escapeHtml(m.kind)}" style="left:${pct}%" data-rel-ms="${
        m.relTimeMs
      }" title="[+${(m.relTimeMs / 1000).toFixed(2)}s] ${escapeHtml(m.label)}"></div>`;
    })
    .join('');

  scrubberMarkers.querySelectorAll('.marker-pin').forEach((pin) => {
    pin.addEventListener('click', () => {
      const targetMs = Number(pin.getAttribute('data-rel-ms')) || 0;
      timeScrubber.value = String(Math.round(targetMs));
      syncTimeScrubber(targetMs);
    });
  });
}

function renderStaticEventLists(capsule) {
  const startMs = capsule.window?.startTimeMs || 0;
  const events = capsule.events || [];

  // 1. Browser Console & Exceptions
  const consoleEvents = events.filter(
    (e) =>
      e.plane === 'BROWSER' &&
      (e.type === 'CONSOLE' || e.type === 'UNCAUGHT_ERROR' || e.type === 'UNHANDLED_REJECTION')
  );
  consoleCount.textContent = String(consoleEvents.length);

  browserConsoleList.innerHTML =
    consoleEvents.length === 0
      ? '<div class="empty-hint">No browser console logs or uncaught errors recorded.</div>'
      : consoleEvents
          .map((e) => {
            const relMs = Math.max(0, e.timestampMs - startMs);
            const isErr = e.severity === 'error' || e.severity === 'fatal';
            return `
              <div class="term-row log-row clickable-scrub ${isErr ? 'stderr' : ''}" data-rel-ms="${relMs}" title="Click to jump time-travel scrubber to +${(relMs / 1000).toFixed(3)}s">
                <div class="term-meta">
                  <span>[${escapeHtml(e.type)}]</span>
                  <span>+${(relMs / 1000).toFixed(3)}s</span>
                </div>
                <div>${escapeHtml(e.payload?.message || '')}</div>
              </div>
            `;
          })
          .join('');

  browserConsoleList.querySelectorAll('.clickable-scrub').forEach((row) => {
    row.addEventListener('click', () => {
      stopPlayback();
      const targetMs = Number(row.getAttribute('data-rel-ms')) || 0;
      timeScrubber.value = String(Math.round(targetMs));
      syncTimeScrubber(targetMs);
    });
  });

  // 2. Network Waterfall
  const netEvents = events.filter((e) => e.plane === 'NETWORK' && e.type === 'HTTP_TRACE');
  netCount.textContent = String(netEvents.length);
  const maxNetDur = Math.max(50, ...netEvents.map((n) => Number(n.payload?.durationMs) || 0));

  networkWaterfallList.innerHTML =
    netEvents.length === 0
      ? '<div class="empty-hint">No HTTP/WS network requests captured in this window.</div>'
      : netEvents
          .map((e, idx) => {
            const relMs = Math.max(0, e.timestampMs - startMs);
            const status = e.payload?.status || 0;
            const durMs = e.payload?.durationMs ?? 0;
            const barPct = Math.min(100, Math.max(4, Math.round((durMs / maxNetDur) * 100)));
            const statusClass =
              status >= 500 ? 'status-5xx' : status >= 400 ? 'status-4xx' : 'status-2xx';
            return `
              <div class="net-row ${status >= 400 ? 'error-row' : ''}" data-net-idx="${idx}" data-rel-ms="${relMs}" title="Click to inspect payload & jump scrubber to +${(relMs / 1000).toFixed(2)}s">
                <span class="status-pill ${statusClass}">${status || 'ERR'}</span>
                <strong style="color:#e2e8f0">${escapeHtml(e.payload?.method || 'GET')}</strong>
                <span class="net-url-col">
                  <span class="net-url-text">${escapeHtml(e.payload?.url || '/')}</span>
                  <span class="net-dur-track"><span class="net-dur-fill ${status >= 400 ? 'err' : ''}" style="width:${barPct}%"></span></span>
                </span>
                <span style="color:#94a3b8;text-align:right;">${durMs}ms</span>
                <span style="color:#64748b;text-align:right;">+${(relMs / 1000).toFixed(2)}s</span>
              </div>
            `;
          })
          .join('');

  networkWaterfallList.querySelectorAll('.net-row').forEach((row) => {
    row.addEventListener('click', () => {
      stopPlayback();
      networkWaterfallList.querySelectorAll('.net-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      const relMs = Number(row.getAttribute('data-rel-ms')) || 0;
      timeScrubber.value = String(Math.round(relMs));
      syncTimeScrubber(relMs);
      const idx = Number(row.getAttribute('data-net-idx'));
      const netEvt = netEvents[idx];
      if (netEvt) {
        renderNetworkPayloadDetail(netEvt);
        activatePaneTab('p2', 'payload');
      }
    });
  });

  // Auto-populate payload inspector with first failed request (or first request)
  const defaultNet = netEvents.find((n) => (n.payload?.status || 0) >= 400) || netEvents[0];
  if (defaultNet) {
    renderNetworkPayloadDetail(defaultNet);
  } else {
    networkPayloadInspector.innerHTML =
      '<div class="empty-hint">No HTTP requests captured in this capsule.</div>';
  }

  // 3. Backend Terminal Stream
  const termEvents = events.filter((e) => e.plane === 'TERMINAL');
  termCount.textContent = String(termEvents.length);

  terminalStreamList.innerHTML =
    termEvents.length === 0
      ? '<div class="empty-hint">No backend terminal output captured in this window.</div>'
      : termEvents
          .map((e) => {
            const relMs = Math.max(0, e.timestampMs - startMs);
            const isStderr =
              e.type === 'TERMINAL_STDERR' || e.severity === 'error' || e.severity === 'fatal';
            return `
              <div class="term-row clickable-scrub ${isStderr ? 'stderr' : ''}" data-rel-ms="${relMs}" title="Click to jump time-travel scrubber to +${(relMs / 1000).toFixed(3)}s">
                <div class="term-meta">
                  <span>[${escapeHtml(e.source || 'app')} · ${
              isStderr ? 'stderr' : 'stdout'
            }] ${e.traceId ? `🔗 ${escapeHtml(e.traceId)}` : ''}</span>
                  <span>+${(relMs / 1000).toFixed(3)}s</span>
                </div>
                <div>${escapeHtml((e.payload?.text || '').trim())}</div>
              </div>
            `;
          })
          .join('');

  terminalStreamList.querySelectorAll('.clickable-scrub').forEach((row) => {
    row.addEventListener('click', () => {
      stopPlayback();
      const targetMs = Number(row.getAttribute('data-rel-ms')) || 0;
      timeScrubber.value = String(Math.round(targetMs));
      syncTimeScrubber(targetMs);
    });
  });
}

function buildCurlCommand(netEvt) {
  const p = netEvt.payload || {};
  const method = (p.method || 'GET').toUpperCase();
  let url = p.url || '/';
  if (url.startsWith('/') && netEvt.source && /^https?:\/\//i.test(netEvt.source)) {
    try {
      url = new URL(url, netEvt.source).toString();
    } catch {
      // keep relative
    }
  }
  const parts = [`curl -X ${method} "${url}"`];
  const headers = p.requestHeaders || {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(host|content-length|connection|accept-encoding)$/i.test(k)) continue;
    parts.push(`  -H "${k}: ${String(v).replace(/"/g, '\\"')}"`);
  }
  if (p.requestBody !== null && p.requestBody !== undefined) {
    const bodyStr =
      typeof p.requestBody === 'string' ? p.requestBody : JSON.stringify(p.requestBody);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      parts.push(`  -H "Content-Type: application/json"`);
    }
    parts.push(`  -d '${bodyStr.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n');
}

function renderNetworkPayloadDetail(netEvt) {
  const p = netEvt.payload || {};
  const curlCmd = buildCurlCommand(netEvt);
  const hasReqHeaders = p.requestHeaders && Object.keys(p.requestHeaders).length > 0;
  const hasResHeaders = p.responseHeaders && Object.keys(p.responseHeaders).length > 0;

  networkPayloadInspector.innerHTML = `
    <div class="xray-card">
      <div class="xray-header">
        <span>${escapeHtml(p.method || 'GET')} ${escapeHtml(p.url || '')} → HTTP ${
    p.status || 'ERR'
  } (${p.durationMs || 0}ms)</span>
        <button class="mini-btn" id="btnCopyCurl" style="flex:none;padding:2px 8px;">📋 Copy cURL</button>
      </div>
      <div style="padding:10px;">
        <div style="margin-bottom:6px;color:#94a3b8;">
          <strong>Causal Trace-ID:</strong> <code style="color:#a5b4fc">${escapeHtml(
            netEvt.traceId || 'none'
          )}</code>
          ${
            p.triggerSelector
              ? ` · <strong>Triggered By UI:</strong> <code style="color:#38bdf8">${escapeHtml(
                  p.triggerSelector
                )}</code>`
              : ''
          }
        </div>
        <div style="margin-top:10px;font-weight:700;color:#cbd5e1;">Request Payload:</div>
        <pre class="code-block" style="background:#070a12;border-radius:6px;margin-top:4px;">${escapeHtml(
          formatJsonOrText(p.requestBody)
        )}</pre>
        <div style="margin-top:10px;font-weight:700;color:#cbd5e1;">Response Payload:</div>
        <pre class="code-block" style="background:#070a12;border-radius:6px;margin-top:4px;">${escapeHtml(
          formatJsonOrText(p.responseBody)
        )}</pre>
        ${
          hasReqHeaders || hasResHeaders
            ? `
          <details class="headers-details" style="margin-top:10px;">
            <summary style="cursor:pointer;color:#94a3b8;font-size:11px;font-weight:700;">HTTP Headers (${Object.keys(p.requestHeaders || {}).length} req / ${Object.keys(p.responseHeaders || {}).length} res)</summary>
            ${
              hasReqHeaders
                ? `<div style="margin-top:6px;font-size:10px;color:#64748b;">REQUEST HEADERS</div><pre class="code-block" style="background:#070a12;border-radius:6px;margin-top:2px;">${escapeHtml(JSON.stringify(p.requestHeaders, null, 2))}</pre>`
                : ''
            }
            ${
              hasResHeaders
                ? `<div style="margin-top:6px;font-size:10px;color:#64748b;">RESPONSE HEADERS</div><pre class="code-block" style="background:#070a12;border-radius:6px;margin-top:2px;">${escapeHtml(JSON.stringify(p.responseHeaders, null, 2))}</pre>`
                : ''
            }
          </details>
        `
            : ''
        }
      </div>
    </div>
  `;

  document.getElementById('btnCopyCurl')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(curlCmd);
      showToast('📋 Copied reproducible cURL command to clipboard!');
    } catch {
      showToast('Clipboard copy failed.');
    }
  });
}


async function inspectSourceFile(filePath, line = 1) {
  if (!filePath) return;
  try {
    const res = await fetch(`/api/source?file=${encodeURIComponent(filePath)}&line=${line}&radius=8`);
    const data = await res.json();
    if (!data.ok || !data.snippet) {
      showToast(`Source file not accessible: ${filePath}`);
      return;
    }
    const snippet = data.snippet;
    const codeLines = snippet.lines
      .map(
        (ln) => `
        <div class="xray-line ${ln.isTarget ? 'target-line' : ''}">
          <span class="ln-num">${ln.isTarget ? '▶ ' : ''}${ln.lineNumber}</span>
          <span>${escapeHtml(ln.code)}</span>
        </div>
      `
      )
      .join('');

    sourceXrayContainer.innerHTML = `
      <div class="xray-card">
        <div class="xray-header">
          <span>📄 ${escapeHtml(snippet.fileName)}:${snippet.targetLine}</span>
          <span style="font-size:10px;color:#94a3b8">${escapeHtml(snippet.filePath)}</span>
        </div>
        <div>${codeLines}</div>
      </div>
    `;
    activatePaneTab('p3', 'xray');
    document.getElementById('paneTerminal')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast(`📄 Inspected ${snippet.fileName}:${snippet.targetLine}`);
  } catch (err) {
    showToast(`Source inspect error: ${err.message}`);
  }
}

function renderSourceXrayPane(capsule) {
  const snippets = [];
  const seen = new Set();

  // Gather snippets from causal chains & terminal events
  for (const chain of capsule.causal?.causalChains || []) {
    const frames = [
      ...(chain.backendError?.frames || []),
      ...(chain.browserError?.frames || (chain.browserError?.primaryFrame ? [chain.browserError.primaryFrame] : [])),
    ];
    for (const f of frames) {
      if (f.snippet) {
        const key = `${f.snippet.filePath}:${f.snippet.targetLine}`;
        if (!seen.has(key)) {
          seen.add(key);
          snippets.push({ frame: f, snippet: f.snippet });
        }
      }
    }
  }

  for (const evt of capsule.events || []) {
    if (evt.plane === 'TERMINAL' && evt.payload?.stackInfo?.frames) {
      for (const f of evt.payload.stackInfo.frames) {
        if (f.snippet) {
          const key = `${f.snippet.filePath}:${f.snippet.targetLine}`;
          if (!seen.has(key)) {
            seen.add(key);
            snippets.push({ frame: f, snippet: f.snippet });
          }
        }
      }
    }
  }

  if (snippets.length === 0) {
    sourceXrayContainer.innerHTML =
      '<div class="empty-hint">No local source code stack frames triggered in this capsule.</div>';
  } else {
    sourceXrayContainer.innerHTML = snippets
      .map(({ frame, snippet }) => {
        const codeLines = snippet.lines
          .map(
            (ln) => `
            <div class="xray-line ${ln.isTarget ? 'target-line' : ''}">
              <span class="ln-num">${ln.isTarget ? '▶ ' : ''}${ln.lineNumber}</span>
              <span>${escapeHtml(ln.code)}</span>
            </div>
          `
          )
          .join('');

        return `
          <div class="xray-card">
            <div class="xray-header">
              <span>📄 ${escapeHtml(snippet.fileName)}:${snippet.targetLine} (${escapeHtml(
          frame.functionName || 'anonymous'
        )})</span>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:10px;color:#94a3b8;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(snippet.filePath)}">${escapeHtml(snippet.filePath)}</span>
                <button class="mini-btn btn-copy-loc" data-loc="${escapeHtml(`${snippet.filePath}:${snippet.targetLine}`)}" style="flex:none;padding:2px 7px;" title="Copy exact file:line location">📋 Copy</button>
              </div>
            </div>
            <div>${codeLines}</div>
          </div>
        `;
      })
      .join('');

    sourceXrayContainer.querySelectorAll('.btn-copy-loc').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const loc = btn.getAttribute('data-loc') || '';
        try {
          await navigator.clipboard.writeText(loc);
          showToast(`📋 Copied location: ${loc}`);
        } catch {
          showToast(loc);
        }
      });
    });
  }
}

function renderColorizedDiff(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) {
    return '<div class="empty-hint" style="padding:12px;">No uncommitted diff against HEAD.</div>';
  }
  return rawDiff
    .split(/\r?\n/)
    .map((line) => {
      let cls = 'diff-ctx';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
        cls = 'diff-hdr';
      } else if (line.startsWith('@@')) {
        cls = 'diff-hunk';
      } else if (line.startsWith('+')) {
        cls = 'diff-add';
      } else if (line.startsWith('-')) {
        cls = 'diff-del';
      }
      return `<div class="git-diff-line ${cls}">${escapeHtml(line || ' ')}</div>`;
    })
    .join('');
}

function renderGitAndAiPane(capsule) {
  aiMarkdownPreview.textContent =
    capsule.aiDiagnosticMarkdown || 'No AI diagnostic markdown compiled.';

  const git = capsule.git || {};
  if (!git.isGitRepo) {
    gitInspectorContainer.innerHTML =
      '<div class="empty-hint">Target directory is not a Git repository.</div>';
    return;
  }

  const overlaps =
    capsule.causal?.causalChains?.flatMap((c) => c.gitDiffOverlaps || []) || [];

  const overlapBanner =
    overlaps.length > 0
      ? `
      <div class="xray-card" style="border-color:#ef4444;">
        <div class="xray-header" style="background:rgba(239,68,68,0.2);color:#fca5a5;">
          <span>🎯 HIGH-CONFIDENCE GIT DIFF OVERLAP DETECTED</span>
          <span>${escapeHtml(overlaps[0].confidence)}</span>
        </div>
        <div style="padding:10px;">
          Crash at <strong style="cursor:pointer;text-decoration:underline;" id="btnInspectGitHit">${escapeHtml(overlaps[0].file)}:${
          overlaps[0].crashLine
        }</strong> directly overlaps uncommitted working-tree edit hunk <code>${escapeHtml(
          overlaps[0].hunkRange
        )}</code>!
        </div>
      </div>
    `
      : '';

  const modFiles = (git.modifiedFiles || []).slice(0, 20);
  const modPillsHtml =
    modFiles.length > 0
      ? `<div class="git-mod-pills">${modFiles
          .map((f) => {
            const p = typeof f === 'string' ? f : f.path;
            const st = typeof f === 'string' ? 'M' : f.status || 'M';
            return `<button class="git-mod-pill" data-file="${escapeHtml(p)}" title="Click to open ${escapeHtml(p)} in Source Code X-Ray"><span class="git-st">${escapeHtml(st)}</span> ${escapeHtml(p)}</button>`;
          })
          .join('')}</div>`
      : '';

  gitInspectorContainer.innerHTML = `
    ${overlapBanner}
    <div class="xray-card">
      <div class="xray-header">
        <span>🌿 Branch: ${escapeHtml(git.branch || 'main')} @ ${escapeHtml(
    git.headCommit || ''
  )}</span>
        <span>${
          git.isDirty
            ? `${git.modifiedFiles?.length || 0} Uncommitted File(s)`
            : 'Clean Working Tree'
        }</span>
      </div>
      ${modPillsHtml}
      <div class="colorized-diff-box">${renderColorizedDiff(git.rawDiff)}</div>
    </div>
  `;

  if (overlaps.length > 0) {
    document.getElementById('btnInspectGitHit')?.addEventListener('click', () => {
      inspectSourceFile(overlaps[0].file, overlaps[0].crashLine || 1);
    });
  }

  gitInspectorContainer.querySelectorAll('.git-mod-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const f = btn.getAttribute('data-file');
      if (f) inspectSourceFile(f, 1);
    });
  });
}

// --- 3. Synchronized Time-Travel Scrubber Logic ---
function syncTimeScrubber(relMs) {
  if (!activeCapsule) return;
  currentRelMs = Math.max(0, Math.min(maxDurationMs, Number(relMs)));
  const startMs = activeCapsule.window?.startTimeMs || 0;
  const targetAbsMs = startMs + currentRelMs;

  const events = activeCapsule.events || [];
  let visibleCount = 0;
  let activeDomEvt = null;
  let activeClickEvt = null;
  let activeStorageEvt = null;

  for (const e of events) {
    if (e.timestampMs <= targetAbsMs + 5) {
      visibleCount++;
      if (e.plane === 'BROWSER' && e.type === 'DOM_SNAPSHOT') {
        activeDomEvt = e;
      } else if (e.plane === 'BROWSER' && e.type === 'UI_CLICK') {
        if (Math.abs(targetAbsMs - e.timestampMs) <= 850) {
          activeClickEvt = e;
        }
      } else if (e.plane === 'BROWSER' && e.type === 'STORAGE_SNAPSHOT') {
        activeStorageEvt = e;
      }
    }
  }

  // Fallback to first DOM_SNAPSHOT if scrubbing before initial load
  if (!activeDomEvt) {
    activeDomEvt = events.find((e) => e.plane === 'BROWSER' && e.type === 'DOM_SNAPSHOT') || null;
  }

  // Update Readouts
  scrubberTimeReadout.textContent = `+${(currentRelMs / 1000).toFixed(2)}s / ${(
    maxDurationMs / 1000
  ).toFixed(2)}s`;
  scrubberEventReadout.textContent = `${visibleCount} / ${events.length} events`;

  // 1. Update DOM Replay Viewport
  if (activeDomEvt && activeDomEvt.id !== lastRenderedDomEventId) {
    lastRenderedDomEventId = activeDomEvt.id;
    domUrlPill.textContent = activeDomEvt.payload?.url || 'http://localhost/...';
    
    if (activeDomEvt.payload?.viewport) {
      currentDomViewport = {
        width: activeDomEvt.payload.viewport.width || 1280,
        height: activeDomEvt.payload.viewport.height || 800,
      };
    }

    let rawHtml =
      activeDomEvt.payload?.html ||
      '<html><body style="font-family:sans-serif;padding:30px;color:#AFAEA2;background:#0B0E20;">No DOM Snapshot recorded at this point in flight.</body></html>';
    
    // Inject clean high-contrast dark theme & button fallbacks without destroying existing styling
    const darkThemeInjection = `
      <style id="__blackbox_monitor_theme__">
        * { box-sizing: border-box; }
        html {
          background: #0B0E20 !important;
          color-scheme: dark !important;
        }
        body {
          background: #0B0E20 !important;
          color: #F4F3EE !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
          margin: 0;
          padding: 24px !important;
          min-height: 100vh;
        }
        h1, h2, h3, h4 {
          color: #F4F3EE !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          margin-top: 0;
        }
        h1 {
          font-size: 20px !important;
          border-bottom: 1px solid rgba(175, 174, 162, 0.25);
          padding-bottom: 10px;
        }
        /* Fallback for bare unstyled buttons */
        button:not([class]), button.btn-stub, #btnInstantCrash:not([class*="btn-"]) {
          font-family: monospace !important;
          font-size: 13px !important;
          font-weight: 700 !important;
          padding: 10px 18px !important;
          border-radius: 6px !important;
          border: 1px solid #D21319 !important;
          background: #D21319 !important;
          color: #FFFFFF !important;
          cursor: pointer !important;
          box-shadow: 0 4px 14px rgba(210, 19, 25, 0.4) !important;
          transition: transform 0.15s ease, background 0.15s ease !important;
        }
        button:hover {
          filter: brightness(1.15);
        }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: rgba(11, 14, 32, 0.6); }
        ::-webkit-scrollbar-thumb { background: rgba(175, 174, 162, 0.3); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: #D21319; }
      </style>
    `;

    // Upgrade any unstyled or legacy test HTML to full dark aerospace sandbox
    if (
      rawHtml.includes('Instant Settlement') ||
      (rawHtml.includes('NexusPay') && rawHtml.length < 800)
    ) {
      rawHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NexusPay Checkout Sandbox — Monitored by Blackbox</title>
  ${darkThemeInjection}
  <style>
    .banner {
      background: linear-gradient(135deg, #1B1E4A 0%, #121533 100%);
      border: 1px solid rgba(175, 174, 162, 0.35);
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }
    .banner-title {
      font-size: 18px;
      font-weight: 700;
      color: #F4F3EE;
      margin: 0 0 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .banner-sub {
      font-size: 11px;
      color: #AFAEA2;
      font-family: monospace;
      margin: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 20px;
    }
    .panel {
      background: rgba(14, 17, 36, 0.85);
      border: 1px solid rgba(175, 174, 162, 0.25);
      border-radius: 6px;
      padding: 16px;
    }
    .panel-hdr {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #AFAEA2;
      margin: 0 0 12px;
    }
    .btn {
      width: 100%;
      padding: 10px 14px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 700;
      font-family: monospace;
      cursor: pointer;
      margin-bottom: 10px;
      border: none;
      transition: filter 0.15s ease, transform 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
    .btn-green { background: #10B981; color: #042413; }
    .btn-red { background: #D21319; color: #FFFFFF; box-shadow: 0 0 12px rgba(210, 19, 25, 0.5); }
    .btn-amber { background: #F59E0B; color: #1C1917; }
    .terminal-out {
      background: #04050C;
      border: 1px solid rgba(175, 174, 162, 0.2);
      border-radius: 4px;
      padding: 12px;
      font-family: monospace;
      font-size: 11px;
      color: #AFAEA2;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="banner">
    <div class="banner-title">⚡ NexusPay Checkout Sandbox</div>
    <div class="banner-sub">SUPERVISED BY BLACKBOX FLIGHT RECORDER · PORT 4400 · TARGET NODE</div>
  </div>
  <div class="grid">
    <div class="panel">
      <div class="panel-hdr">✅ Healthy Production Flows</div>
      <button class="btn btn-green" id="btnFetchInventory">📦 GET /api/inventory (200 OK)</button>
      <button class="btn btn-green" id="btnStandardCheckout">💳 Standard Settlement (200 OK)</button>
    </div>
    <div class="panel">
      <div class="panel-hdr" style="color: #D21319;">💥 Trigger Anomaly & Crash</div>
      <button class="btn btn-red" id="btnInstantCrash">🔥 Trigger Null-Ref Crash (POST /api/checkout [500])</button>
      <button class="btn btn-amber" id="btnLedgerCrash">⚡ Trigger Ledger Mismatch (503)</button>
    </div>
  </div>
  <div class="terminal-out">
    [Telemetry Hook Active] Clicked button #btnInstantCrash at +1.24s. Awaiting Blackbox causal correlation...
  </div>
</body>
</html>`;
    } else {
      // Preserve authentic app styling for real applications that have stylesheets;
      // only inject dark fallback for bare unstyled HTML snippets.
      const hasOwnStyles = /<style[\s>]|<link[^>]+rel=["']?stylesheet/i.test(rawHtml);
      let baseTag = '';
      if (!/<base[\s>]/i.test(rawHtml) && activeDomEvt.payload?.url) {
        try {
          const origin = new URL(activeDomEvt.payload.url).origin;
          baseTag = `<base href="${escapeHtml(origin)}/" />`;
        } catch {
          // ignore
        }
      }
      const headInject = `${baseTag}${hasOwnStyles ? '' : darkThemeInjection}`;
      if (headInject) {
        if (/<head[^>]*>/i.test(rawHtml)) {
          rawHtml = rawHtml.replace(/<head[^>]*>/i, (m) => `${m}${headInject}`);
        } else if (rawHtml.includes('</head>')) {
          rawHtml = rawHtml.replace('</head>', `${headInject}</head>`);
        } else if (/<body/i.test(rawHtml)) {
          rawHtml = rawHtml.replace(/<body/i, `<head>${headInject}</head><body`);
        } else {
          rawHtml = `<!DOCTYPE html><html><head>${headInject}</head><body>${rawHtml}</body></html>`;
        }
      }
    }
    domReplayFrame.srcdoc = rawHtml;
    updateDomReplayScaling();
  }

  // 2. Update Click Laser Overlay
  if (activeClickEvt) {
    const vpW = currentDomViewport.width || 1280;
    const vpH = currentDomViewport.height || 800;
    const clickX = activeClickEvt.payload?.clientX ?? 200;
    const clickY = activeClickEvt.payload?.clientY ?? 200;
    const xPct = Math.min(98, Math.max(2, (clickX / vpW) * 100));
    const yPct = Math.min(98, Math.max(2, (clickY / vpH) * 100));
    cursorLaser.style.display = 'block';
    cursorLaser.style.left = `${xPct}%`;
    cursorLaser.style.top = `${yPct}%`;
    cursorLaser.classList.toggle('flip-left', xPct > 65);
    cursorLaserLabel.textContent = `Click: ${
      activeClickEvt.payload?.text || activeClickEvt.payload?.selector || 'Element'
    }`;
    domClickBadge.textContent = `🖱️ Clicked ${activeClickEvt.payload?.selector || ''}`;
  } else {
    cursorLaser.style.display = 'none';
    domClickBadge.textContent = 'Idle at T';
  }

  // 3. Update Storage Snapshot
  if (activeStorageEvt) {
    browserStoragePre.textContent = JSON.stringify(activeStorageEvt.payload || {}, null, 2);
  }

  // 4. Dim future events in Console, Network Waterfall, and Terminal Stream
  document.querySelectorAll('[data-rel-ms]').forEach((row) => {
    if (row.classList.contains('marker-pin')) return;
    const rowMs = Number(row.getAttribute('data-rel-ms')) || 0;
    if (rowMs > currentRelMs + 5) {
      row.classList.add('future-event');
      row.classList.remove('active-at-t');
    } else {
      row.classList.remove('future-event');
      if (Math.abs(rowMs - currentRelMs) < 220) {
        row.classList.add('active-at-t');
      } else {
        row.classList.remove('active-at-t');
      }
    }
  });
}

// --- 4. Playback Controls & Tabs ---
function startPlayback() {
  if (!activeCapsule) return;
  if (currentRelMs >= maxDurationMs) {
    currentRelMs = 0;
  }
  isPlaying = true;
  playPauseBtn.textContent = '⏸ Pause';

  let lastTick = performance.now();
  function tick(now) {
    if (!isPlaying) return;
    const dt = now - lastTick;
    lastTick = now;
    const speed = parseFloat(playbackSpeedSelect.value) || 1;
    currentRelMs += dt * speed;

    if (currentRelMs >= maxDurationMs) {
      currentRelMs = maxDurationMs;
      timeScrubber.value = String(Math.round(currentRelMs));
      syncTimeScrubber(currentRelMs);
      stopPlayback();
      return;
    }

    timeScrubber.value = String(Math.round(currentRelMs));
    syncTimeScrubber(currentRelMs);
    playTimer = requestAnimationFrame(tick);
  }
  playTimer = requestAnimationFrame(tick);
}

function stopPlayback() {
  isPlaying = false;
  playPauseBtn.textContent = '▶ Play';
  if (playTimer) cancelAnimationFrame(playTimer);
}

function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pane = btn.getAttribute('data-pane');
      const tab = btn.getAttribute('data-tab');
      activatePaneTab(pane, tab);
    });
  });
}

function activatePaneTab(pane, tab) {
  document.querySelectorAll(`.tab-btn[data-pane="${pane}"]`).forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tab);
  });
  const parentPane = document.querySelector(`.tab-btn[data-pane="${pane}"]`)?.closest('.pane');
  if (!parentPane) return;
  parentPane.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${pane}-${tab}`);
  });
  if (pane === 'p1' && tab === 'dom') {
    setTimeout(updateDomReplayScaling, 40);
  }
}

function switchMode(mode) {
  const stages = {
    inspector: document.getElementById('inspectorStage'),
    live: document.getElementById('liveStage'),
    diff: document.getElementById('diffStage'),
  };

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-mode') === mode);
  });

  if (mode === 'cli') {
    Object.entries(stages).forEach(([k, el]) => {
      if (el) el.style.display = k === 'inspector' ? 'flex' : 'none';
    });
    const cliSec = document.getElementById('hexCliSection');
    if (cliSec) {
      cliSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }

  Object.entries(stages).forEach(([k, el]) => {
    if (el) el.style.display = k === mode ? 'flex' : 'none';
  });

  if (mode === 'live') {
    loadLiveBufferIfEmpty();
  } else if (mode === 'diff') {
    const container = document.getElementById('diffResultsContainer');
    if (container && (!container.children || container.children.length === 0)) {
      renderDiffInitialBriefing();
    }
  }

  try {
    const url = new URL(window.location.href);
    url.searchParams.set('mode', mode);
    window.history.replaceState({}, '', url.toString());
  } catch {
    // ignore
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupModeSwitcher() {
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      if (mode) switchMode(mode);
    });
  });

  document.querySelectorAll('a[href*="mode="]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      const match = href.match(/mode=([a-z]+)/);
      if (match && match[1]) {
        e.preventDefault();
        switchMode(match[1]);
      }
    });
  });
}

function setupHexCliSection() {
  const tabs = document.querySelectorAll('.hex-tab');
  const codeText = document.getElementById('hexInstallCodeText');
  const copyBtn = document.getElementById('hexCopyBtn');
  const runDemoBtn = document.getElementById('hexRunDemoBtn');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const cmd = tab.getAttribute('data-cmd');
      if (codeText && cmd) {
        codeText.textContent = cmd;
      }
    });
  });

  if (copyBtn && codeText) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeText.textContent.trim());
        showToast('✓ Copied command to clipboard!');
      } catch {
        showToast('Command: ' + codeText.textContent.trim());
      }
    });
  }

  if (runDemoBtn) {
    runDemoBtn.addEventListener('click', () => {
      if (lastDaemonStatus && lastDaemonStatus.demoRunning === false) {
        showToast('ℹ Demo sandbox is not running. Start it with: blackbox demo');
        return;
      }
      window.open('http://localhost:4400/', '_blank');
      showToast('⚡ Opening NexusPay Sandbox at http://localhost:4400/');
    });
  }

  document.querySelectorAll('.btn-copy-snippet').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const raw = btn.getAttribute('data-copy') || '';
      try {
        await navigator.clipboard.writeText(raw);
        const prev = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1600);
        showToast('✓ Copied setup snippet to clipboard!');
      } catch {
        showToast('Snippet: ' + raw);
      }
    });
  });

  document.querySelectorAll('.cli-ref-row').forEach((row) => {
    row.addEventListener('click', async () => {
      const raw = row.getAttribute('data-copy') || '';
      if (!raw) return;
      try {
        await navigator.clipboard.writeText(raw);
        showToast(`✓ Copied: ${raw}`);
      } catch {
        showToast(raw);
      }
    });
  });
}

function setupVaultToggle() {
  const toggleBtn = document.getElementById('toggleVaultBtn');
  const collapseBtn = document.getElementById('collapseSidebarBtn');
  const studioBody = document.getElementById('studioBody');

  const toggle = () => {
    if (!studioBody) return;
    studioBody.classList.toggle('sidebar-collapsed');
    const isCollapsed = studioBody.classList.contains('sidebar-collapsed');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', !isCollapsed);
    }
  };

  if (toggleBtn) toggleBtn.addEventListener('click', toggle);
  if (collapseBtn) collapseBtn.addEventListener('click', toggle);

  const searchInput = document.getElementById('capsuleSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', renderCapsuleSidebar);
  }

  document.querySelectorAll('#vaultFilterPills .vault-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#vaultFilterPills .vault-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      vaultStatusFilter = pill.getAttribute('data-vault-filter') || 'ALL';
      renderCapsuleSidebar();
    });
  });

  document.getElementById('btnEditCapsuleMeta')?.addEventListener('click', async () => {
    if (!activeCapsule) {
      showToast('Select a capsule first.');
      return;
    }
    const newTitle = prompt('Capsule Label / Title:', activeCapsule.title || '');
    if (newTitle === null) return;
    const newNotes = prompt('Engineer Notes (optional — included in AI Prompt & MCP):', activeCapsule.notes || '');
    if (newNotes === null) return;
    try {
      const res = await fetch(`/api/capsules/${encodeURIComponent(activeCapsule.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, notes: newNotes }),
      });
      const data = await res.json();
      if (data.ok && data.capsule) {
        activeCapsule = data.capsule;
        renderCausalBanner(activeCapsule);
        renderGitAndAiPane(activeCapsule);
        await loadCapsulesList();
        showToast('✓ Updated capsule label & notes');
      }
    } catch (err) {
      showToast(`Update failed: ${err.message}`);
    }
  });

  const clearBtn = document.getElementById('clearVaultBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!confirm('Are you sure you want to delete ALL capsules from the vault? This cannot be undone.')) {
        return;
      }
      try {
        const res = await fetch('/api/capsules', { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          showToast(`🗑 Cleared ${data.deletedCount} capsules from vault`);
          activeCapsule = null;
          await loadCapsulesList();
          capsuleHeadline.textContent = 'Select or freeze a capsule to inspect causal time-travel state';
          capsuleStatusTag.textContent = 'STANDBY';
          capsuleStatusTag.className = 'status-tag';
          causalChainFlow.innerHTML = '';
        }
      } catch (err) {
        showToast(`Clear vault failed: ${err.message}`);
      }
    });
  }
}

function setupViewSwitcher() {
  const quadGrid = document.getElementById('quadGrid');
  const viewBtns = document.querySelectorAll('.view-btn');

  viewBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      viewBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      if (quadGrid) {
        quadGrid.className = 'quad-grid';
        if (view === 'flow') {
          quadGrid.classList.add('view-flow');
        } else if (view === 'plane-1') {
          quadGrid.classList.add('view-plane-1');
        } else if (view === 'plane-2') {
          quadGrid.classList.add('view-plane-2');
        } else if (view === 'plane-3') {
          quadGrid.classList.add('view-plane-3');
        } else if (view === 'plane-4') {
          quadGrid.classList.add('view-plane-4');
        }
      }

      if (btnExpandDomStage) {
        if (view === 'plane-1') {
          btnExpandDomStage.textContent = '⛶ Quad';
          btnExpandDomStage.classList.add('active');
        } else {
          btnExpandDomStage.textContent = '⛶ Focus';
          btnExpandDomStage.classList.remove('active');
        }
      }
      setTimeout(updateDomReplayScaling, 50);
    });
  });
}

function setupActions() {
  timeScrubber.addEventListener('input', (e) => {
    stopPlayback();
    syncTimeScrubber(Number(e.target.value));
  });

  playPauseBtn.addEventListener('click', () => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  });

  document.getElementById('stepPrevBtn').addEventListener('click', () => {
    stopPlayback();
    if (!activeCapsule) return;
    const startMs = activeCapsule.window?.startTimeMs || 0;
    const prevEvents = (activeCapsule.events || []).filter(
      (e) => e.timestampMs - startMs < currentRelMs - 5
    );
    const target = prevEvents[prevEvents.length - 1];
    const nextMs = target ? Math.max(0, target.timestampMs - startMs) : 0;
    timeScrubber.value = String(Math.round(nextMs));
    syncTimeScrubber(nextMs);
  });

  document.getElementById('stepNextBtn').addEventListener('click', () => {
    stopPlayback();
    if (!activeCapsule) return;
    const startMs = activeCapsule.window?.startTimeMs || 0;
    const nextEvt = (activeCapsule.events || []).find(
      (e) => e.timestampMs - startMs > currentRelMs + 5
    );
    const nextMs = nextEvt ? nextEvt.timestampMs - startMs : maxDurationMs;
    timeScrubber.value = String(Math.round(nextMs));
    syncTimeScrubber(nextMs);
  });

  document.getElementById('freezeNowBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/freeze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerReason: 'STUDIO_MANUAL_FREEZE' }),
      });
      const data = await res.json();
      if (data.ok && data.capsule) {
        showToast(`❄️ Capsule Frozen: ${data.capsule.id}`);
        await loadCapsulesList();
        await selectCapsule(data.capsule.id);
      }
    } catch (err) {
      showToast(`Freeze failed: ${err.message}`);
    }
  });

  document.getElementById('copyAiPromptBtn').addEventListener('click', async () => {
    if (!activeCapsule || !activeCapsule.aiDiagnosticMarkdown) {
      showToast('Select a capsule first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(activeCapsule.aiDiagnosticMarkdown);
      showToast('🤖 Copied AI Root-Cause Diagnostic Packet to clipboard!');
    } catch {
      showToast('Clipboard copy failed — view it in Pane 4 (AI Root-Cause Markdown).');
    }
  });

  document.getElementById('exportCapsuleBtn').addEventListener('click', () => {
    if (!activeCapsule) {
      showToast('Select a capsule to export.');
      return;
    }
    const blob = new Blob([JSON.stringify(activeCapsule, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeCapsule.id}.blackbox.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`⬇ Exported ${activeCapsule.id}.blackbox.json`);
  });

  document.getElementById('importCapsuleBtn').addEventListener('click', () => {
    document.getElementById('importFileInput').click();
  });

  document.getElementById('importFileInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const res = await fetch('/api/capsules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capsule: parsed }),
      });
      const data = await res.json();
      if (data.ok && data.capsule) {
        showToast(`📂 Imported Capsule: ${data.capsule.id}`);
        await loadCapsulesList();
        await selectCapsule(data.capsule.id);
      }
    } catch (err) {
      showToast(`Import error: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  });

  document.getElementById('refreshCapsulesBtn').addEventListener('click', loadCapsulesList);

  autoFreezeCheck.addEventListener('change', async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoFreeze: autoFreezeCheck.checked }),
    });
    showToast(
      autoFreezeCheck.checked
        ? '⚡ Auto-Freeze ON (crashes & HTTP 5xx will freeze automatically)'
        : '⏸ Auto-Freeze OFF (manual freeze only)'
    );
  });

  document.getElementById('runDiffBtn')?.addEventListener('click', runCapsuleDiff);

  const btnQuickCompare = document.getElementById('btnQuickCompareLatest');
  if (btnQuickCompare) {
    btnQuickCompare.addEventListener('click', quickCompareLatest);
  }

  const btnSwap = document.getElementById('btnSwapDiffPods');
  if (btnSwap) {
    btnSwap.addEventListener('click', () => {
      const selA = document.getElementById('diffSelectA');
      const selB = document.getElementById('diffSelectB');
      if (selA && selB) {
        const valA = selA.value;
        const valB = selB.value;
        selA.value = valB;
        selB.value = valA;
        runCapsuleDiff();
        showToast('⇄ Swapped Baseline and Comparison Capsules');
      }
    });
  }

  // Live Deck plane filtering, search, pause & clear
  document.querySelectorAll('.live-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.live-filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.getAttribute('data-filter');
      filterLiveDeckEvents(filter);
    });
  });

  document.getElementById('liveSearchInput')?.addEventListener('input', (e) => {
    liveSearchQuery = (e.target.value || '').trim().toLowerCase();
    filterLiveDeckEvents(currentLiveFilter);
  });

  document.getElementById('livePauseBtn')?.addEventListener('click', (e) => {
    liveStreamPaused = !liveStreamPaused;
    e.currentTarget.textContent = liveStreamPaused ? '▶ RESUME' : '⏸ PAUSE';
    e.currentTarget.classList.toggle('active', liveStreamPaused);
    showToast(liveStreamPaused ? '⏸ Live Deck stream display paused' : '▶ Live Deck stream resumed');
  });

  document.getElementById('liveClearBtn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/buffer/clear', { method: 'POST' });
      clearLiveFeedUi();
      showToast('🗑 Cleared active 60s rolling ring buffer');
    } catch (err) {
      showToast(`Clear failed: ${err.message}`);
    }
  });

  if (btnToggleDomFit) {
    btnToggleDomFit.addEventListener('click', () => {
      isDomFitMode = !isDomFitMode;
      btnToggleDomFit.textContent = isDomFitMode ? 'Fit' : '100%';
      btnToggleDomFit.classList.toggle('active', !isDomFitMode);
      updateDomReplayScaling();
    });
  }

  if (btnExpandDomStage) {
    btnExpandDomStage.addEventListener('click', () => {
      const quadGrid = document.getElementById('quadGrid');
      const isExpanded = quadGrid?.classList.contains('view-plane-1');
      if (isExpanded) {
        quadGrid.className = 'quad-grid';
        btnExpandDomStage.textContent = '⛶ Focus';
        btnExpandDomStage.classList.remove('active');
      } else {
        quadGrid.className = 'quad-grid view-plane-1';
        btnExpandDomStage.textContent = '⛶ Quad';
        btnExpandDomStage.classList.add('active');
      }
      setTimeout(updateDomReplayScaling, 50);
    });
  }

  window.addEventListener('resize', () => {
    updateDomReplayScaling();
  });

  document.getElementById('btnCopyRawMarkdown')?.addEventListener('click', async () => {
    if (!activeCapsule || !activeCapsule.aiDiagnosticMarkdown) {
      showToast('Select a capsule first.');
      return;
    }
    try {
      await navigator.clipboard.writeText(activeCapsule.aiDiagnosticMarkdown);
      showToast('🤖 Copied AI Prompt Packet to clipboard!');
    } catch {
      showToast('Clipboard copy failed.');
    }
  });

  document.getElementById('liveDeckFreezeBtn')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/freeze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerReason: 'LIVE_DECK_INSTANT_FREEZE' }),
      });
      const data = await res.json();
      if (data.ok && data.capsule) {
        showToast(`❄️ Live Buffer Frozen: ${data.capsule.id}`);
        await loadCapsulesList();
        switchMode('inspector');
        await selectCapsule(data.capsule.id);
      }
    } catch (err) {
      showToast(`Freeze failed: ${err.message}`);
    }
  });
}

// --- 5. Live Flight Deck & Capsule Differ ---

function clearLiveFeedUi() {
  liveStreamCount = 0;
  if (liveStreamFeed) liveStreamFeed.innerHTML = '';
  const rateBadge = document.getElementById('liveStreamRateBadge');
  if (rateBadge) {
    rateBadge.textContent = '0 events buffered (60s window)';
  }
}

async function loadLiveBufferIfEmpty() {
  if (!liveStreamFeed || liveStreamFeed.children.length > 0) return;
  try {
    const res = await fetch('/api/buffer?durationMs=60000');
    const data = await res.json();
    if (data.events && Array.isArray(data.events)) {
      // Iterate oldest-to-newest (tail 80) so prepend() places newest on top
      const recent = data.events.slice(-80);
      for (const e of recent) {
        appendLiveFeedEvent(e, true);
      }
    }
  } catch {
    // ignore
  }
}

function setupKeyboardShortcuts() {
  window.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';

    // Alt+Shift+B -> Instant Freeze Capsule!
    if (e.altKey && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
      e.preventDefault();
      document.getElementById('freezeNowBtn')?.click();
      return;
    }

    if (isInput) return;

    // Space -> Play / Pause playback
    if (e.code === 'Space') {
      e.preventDefault();
      playPauseBtn?.click();
      return;
    }

    // Left Arrow -> Previous Event
    if (e.code === 'ArrowLeft') {
      e.preventDefault();
      document.getElementById('stepPrevBtn')?.click();
      return;
    }

    // Right Arrow -> Next Event
    if (e.code === 'ArrowRight') {
      e.preventDefault();
      document.getElementById('stepNextBtn')?.click();
      return;
    }

    // Escape -> Close Vault Drawer
    if (e.code === 'Escape') {
      const studioBody = document.getElementById('studioBody');
      if (studioBody && !studioBody.classList.contains('sidebar-collapsed')) {
        studioBody.classList.add('sidebar-collapsed');
        document.getElementById('toggleVaultBtn')?.classList.remove('active');
      }
      return;
    }

    // Alt+1..4 -> Switch Modes
    if (e.altKey) {
      if (e.key === '1') switchMode('inspector');
      if (e.key === '2') switchMode('live');
      if (e.key === '3') switchMode('diff');
      if (e.key === '4') switchMode('cli');
    }
  });
}

let liveStreamCount = 0;
let currentLiveFilter = 'ALL';

function filterLiveDeckEvents(planeFilter) {
  currentLiveFilter = planeFilter;
  if (!liveStreamFeed) return;
  const rows = liveStreamFeed.querySelectorAll('.term-row');
  rows.forEach((row) => {
    const rowPlane = row.getAttribute('data-plane');
    const rowText = (row.textContent || '').toLowerCase();
    const planeMatch = planeFilter === 'ALL' || rowPlane === planeFilter;
    const textMatch = !liveSearchQuery || rowText.includes(liveSearchQuery);
    row.style.display = planeMatch && textMatch ? 'flex' : 'none';
  });
}

function appendLiveFeedEvent(evt, forceRender = false) {
  if (!liveStreamFeed) return;
  if (liveStreamPaused && !forceRender) return;
  liveStreamCount++;
  const rateBadge = document.getElementById('liveStreamRateBadge');
  if (rateBadge) {
    rateBadge.textContent = `${liveStreamCount} events buffered (60s window)`;
  }

  const row = document.createElement('div');
  const isErr = evt.severity === 'error' || evt.severity === 'fatal';
  row.className = `term-row live-feed-row ${isErr ? 'stderr' : ''}`;
  row.setAttribute('data-plane', evt.plane);
  row.title = 'Click to expand / collapse full telemetry payload';

  const summary =
    evt.plane === 'NETWORK'
      ? `${evt.payload?.method || 'GET'} ${evt.payload?.url || ''} -> HTTP ${evt.payload?.status ?? 'ERR'} (${evt.payload?.durationMs ?? 0}ms)`
      : evt.plane === 'TERMINAL'
      ? (evt.payload?.text || '').trim().slice(0, 240)
      : evt.type === 'UI_CLICK'
      ? `Clicked ${evt.payload?.selector || ''} ("${evt.payload?.text || ''}")`
      : evt.type === 'UI_NAVIGATE'
      ? `Navigated to ${evt.payload?.to || ''}`
      : evt.payload?.message || evt.type;

  const concisePayload =
    evt.type === 'DOM_SNAPSHOT' && evt.payload?.html
      ? { ...evt.payload, html: `[DOM Snapshot ${evt.payload.html.length} chars]` }
      : evt.payload || {};

  row.innerHTML = `
    <div class="term-meta">
      <span><span class="plane-badge plane-${evt.plane.toLowerCase()}">${escapeHtml(
    evt.plane
  )}</span> ${escapeHtml(evt.type)} ${evt.traceId ? `· <span class="trace-hash">🔗 ${escapeHtml(evt.traceId)}</span>` : ''}</span>
      <span class="feed-time">${new Date(evt.timestampMs).toLocaleTimeString()}</span>
    </div>
    <div class="feed-summary">${escapeHtml(summary)}</div>
    <pre class="live-payload-drawer" style="display:none;">${escapeHtml(JSON.stringify(concisePayload, null, 2).slice(0, 3000))}</pre>
  `;

  row.addEventListener('click', () => {
    const drawer = row.querySelector('.live-payload-drawer');
    if (drawer) {
      drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
    }
  });

  const planeMatch = currentLiveFilter === 'ALL' || evt.plane === currentLiveFilter;
  const textMatch = !liveSearchQuery || (row.textContent || '').toLowerCase().includes(liveSearchQuery);
  if (!planeMatch || !textMatch) {
    row.style.display = 'none';
  }

  liveStreamFeed.prepend(row);
  while (liveStreamFeed.children.length > 120) {
    liveStreamFeed.lastChild.remove();
  }
}

function populateDiffSelectors() {
  const selA = document.getElementById('diffSelectA');
  const selB = document.getElementById('diffSelectB');
  if (!selA || !selB) return;

  if (capsulesList.length === 0) {
    selA.innerHTML = '<option value="">No capsules in vault</option>';
    selB.innerHTML = '<option value="">No capsules in vault</option>';
    renderDiffInitialBriefing();
    return;
  }

  const opts = capsulesList
    .map((c) => {
      const isFault = c.status === 'FAULT_DETECTED' || c.status === 'ANOMALY';
      const icon = isFault ? '▲' : '●';
      const timeStr = new Date(c.createdAt).toLocaleTimeString();
      return `<option value="${escapeHtml(c.id)}">${icon} ${escapeHtml(c.title)} (${timeStr} · ${c.id.slice(0, 8)})</option>`;
    })
    .join('');

  selA.innerHTML = opts;
  selB.innerHTML = opts;

  // By default: Baseline A is oldest or healthy; Comparison B is newest or fault
  if (capsulesList.length > 1) {
    selA.selectedIndex = capsulesList.length - 1; // oldest baseline
    selB.selectedIndex = 0; // newest target
  }

  renderDiffInitialBriefing();
}

function quickCompareLatest() {
  const selA = document.getElementById('diffSelectA');
  const selB = document.getElementById('diffSelectB');
  if (!selA || !selB || capsulesList.length === 0) return;

  // Find latest healthy baseline (HEALTHY_SNAPSHOT or SNAPSHOT)
  const healthyIdx = capsulesList.findIndex(
    (c) => c.status !== 'FAULT_DETECTED' && c.status !== 'ANOMALY'
  );
  if (healthyIdx !== -1) {
    selA.selectedIndex = healthyIdx;
  } else if (capsulesList.length > 1) {
    selA.selectedIndex = capsulesList.length - 1;
  } else {
    selA.selectedIndex = 0;
  }

  // Find latest fault comparison
  const faultIdx = capsulesList.findIndex(
    (c) => c.status === 'FAULT_DETECTED' || c.status === 'ANOMALY'
  );
  if (faultIdx !== -1) {
    selB.selectedIndex = faultIdx;
  } else {
    selB.selectedIndex = 0;
  }

  runCapsuleDiff();
  showToast('⚡ Running differential audit between Baseline and Crash...');
}

function renderDiffInitialBriefing() {
  const container = document.getElementById('diffResultsContainer');
  if (!container) return;

  const count = capsulesList.length;
  container.innerHTML = `
    <div class="diff-briefing-card">
      <div class="briefing-header">
        <div class="briefing-reticle">
          <span class="reticle-pulse"></span>
          <span class="reticle-icon">⌖</span>
        </div>
        <div class="briefing-title-wrap">
          <div class="briefing-badge">BIPARTITE HOROLOGICAL DIFFERENTIAL RADAR · STANDBY</div>
          <h3 class="briefing-headline">Ready for Multi-Plane Differential Audit</h3>
          <p class="briefing-sub">
            Blackbox correlates 60-second in-memory telemetry across two snapshots to isolate HTTP status regressions, latency anomalies, uncaught V8 faults, and working tree drift.
          </p>
        </div>
        <div class="briefing-quick-cta">
          <button class="action-btn btn-freeze" id="btnBriefingRun">
            ⚡ Compare Latest Crash vs Baseline
          </button>
        </div>
      </div>

      <div class="briefing-channels-grid">
        <div class="briefing-channel">
          <div class="chan-num">01</div>
          <div class="chan-meta">
            <span class="chan-pill net">NETWORK</span>
            <span class="chan-title">HTTP Status &amp; 5xx Inversion</span>
          </div>
          <p class="chan-desc">
            Surfaces API endpoints that flipped from 2xx/3xx successes to 4xx/5xx failures, identifying broken controllers and route regressions.
          </p>
          <div class="chan-foot">Detects 200 OK → 500 Faults</div>
        </div>

        <div class="briefing-channel">
          <div class="chan-num">02</div>
          <div class="chan-meta">
            <span class="chan-pill lat">LATENCY</span>
            <span class="chan-title">Latency Drift &amp; Outliers</span>
          </div>
          <p class="chan-desc">
            Measures response time shifts across endpoints with &gt;100ms delta, pinpointing sudden database bottlenecks or blocking loops.
          </p>
          <div class="chan-foot">Precision down to 0.1ms</div>
        </div>

        <div class="briefing-channel">
          <div class="chan-num">03</div>
          <div class="chan-meta">
            <span class="chan-pill fault">V8 EXCEPTION</span>
            <span class="chan-title">Causal Anomaly &amp; Stack Traces</span>
          </div>
          <p class="chan-desc">
            Compares unhandled Node runtime errors, isolating the newly introduced culprit file and line number with confidence score.
          </p>
          <div class="chan-foot">Zero-hallucination line matching</div>
        </div>

        <div class="briefing-channel">
          <div class="chan-num">04</div>
          <div class="chan-meta">
            <span class="chan-pill git">GIT TREE</span>
            <span class="chan-title">Working Tree &amp; Commit Drift</span>
          </div>
          <p class="chan-desc">
            Audits uncommitted source file changes and HEAD commit drift between the two captures, isolating the exact code commits that broke functionality.
          </p>
          <div class="chan-foot">Tracks dirty files & commit hashes</div>
        </div>
      </div>

      <div class="briefing-footer-bar">
        <span>✦ VAULT STATUS: <strong>${count} Flight Capsules Indexed</strong></span>
        <span>ZERO DISK OVERHEAD: IN-MEMORY RING BUFFER COMPILATION</span>
        <span>STANDBY MODE</span>
      </div>
    </div>
  `;

  document.getElementById('btnBriefingRun')?.addEventListener('click', () => {
    quickCompareLatest();
  });
}

async function runCapsuleDiff() {
  const selA = document.getElementById('diffSelectA');
  const selB = document.getElementById('diffSelectB');
  const idA = selA?.value;
  const idB = selB?.value;
  const container = document.getElementById('diffResultsContainer');
  if (!idA || !idB || !container) return;

  container.innerHTML = `
    <div class="diff-loading-card">
      <div class="loading-spinner"></div>
      <div class="loading-title">Synthesizing Multi-Plane Differential...</div>
      <div class="loading-sub">Correlating endpoints, latencies, V8 exceptions, and Git status</div>
    </div>
  `;

  try {
    const res = await fetch(`/api/capsules/diff?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const d = data.diff;
    const hasRegression = d.routeDiffs.some((r) => r.regression) ||
      d.statusChange.includes('FAULT') ||
      (d.newCausalChains && d.newCausalChains.length > 0);

    const regressedRoutesCount = d.routeDiffs.filter((r) => r.regression).length;
    const totalRoutesCount = d.totalRoutesAudited ?? d.routeDiffs.length;

    let maxLatencyDelta = 0;
    d.routeDiffs.forEach((r) => {
      if (r.before && r.after) {
        const delta = Math.abs(r.after.avgMs - r.before.avgMs);
        if (delta > maxLatencyDelta) maxLatencyDelta = delta;
      }
    });

    // 1. Verdict Banner
    const verdictBannerHtml = d.isIdentical
      ? `
      <div class="diff-verdict-banner nominal">
        <div class="verdict-left">
          <div class="verdict-badge-row">
            <span class="verdict-badge" style="border-color:#38bdf8;color:#38bdf8;">● IDENTICAL CAPSULES AUDITED</span>
            <span class="verdict-tag">SELF-COMPARISON</span>
          </div>
          <h3 class="verdict-headline">Same Capsule Selected for Both Pods</h3>
          <p class="verdict-summary">
            Baseline A and Comparison B are the identical snapshot (<strong>${escapeHtml(d.capsuleA.title)}</strong>). Select two distinct snapshots (e.g. Healthy Baseline vs Crash Snapshot) to isolate runtime regressions.
          </p>
        </div>
      </div>
      `
      : hasRegression
      ? `
      <div class="diff-verdict-banner regression">
        <div class="verdict-left">
          <div class="verdict-badge-row">
            <span class="verdict-badge alert">⚠️ CRITICAL REGRESSION DETECTED</span>
            <span class="verdict-tag">FAULT IN SNAPSHOT B</span>
          </div>
          <h3 class="verdict-headline">Endpoint & Causal Regressions Isolated</h3>
          <p class="verdict-summary">
            Snapshot B experienced critical runtime faults not present in Golden Baseline A:
            <strong>Status transition: ${escapeHtml(d.statusChange)}</strong>.
          </p>
          <div class="verdict-pills">
            <span class="v-pill">Baseline A: <strong>${escapeHtml(d.capsuleA.title)}</strong></span>
            <span class="v-arrow">→</span>
            <span class="v-pill fault">Comparison B: <strong>${escapeHtml(d.capsuleB.title)}</strong></span>
          </div>
        </div>
        <div class="verdict-actions">
          <button class="action-btn btn-freeze" id="btnJumpToCrashInCockpit">
            ▶ Inspect Fault in 4-Plane Cockpit
          </button>
        </div>
      </div>
      `
      : `
      <div class="diff-verdict-banner nominal">
        <div class="verdict-left">
          <div class="verdict-badge-row">
            <span class="verdict-badge success">✓ ZERO REGRESSIONS DETECTED</span>
            <span class="verdict-tag">SYSTEM NOMINAL</span>
          </div>
          <h3 class="verdict-headline">Snapshots Functionally Equivalent</h3>
          <p class="verdict-summary">
            No HTTP 5xx errors or significant latency anomalies were detected between Snapshot A and Snapshot B.
          </p>
          <div class="verdict-pills">
            <span class="v-pill">Baseline A: <strong>${escapeHtml(d.capsuleA.title)}</strong></span>
            <span class="v-arrow">⇄</span>
            <span class="v-pill">Comparison B: <strong>${escapeHtml(d.capsuleB.title)}</strong></span>
          </div>
        </div>
      </div>
      `;

    // 2. 4-KPI Summary Cards
    const kpiGridHtml = `
      <div class="diff-kpi-grid">
        <div class="diff-kpi-card ${regressedRoutesCount > 0 ? 'alert' : ''}">
          <div class="kpi-top">
            <span class="kpi-label">ENDPOINT REGRESSIONS</span>
            <span class="kpi-icon">${regressedRoutesCount > 0 ? '⚠️' : '✓'}</span>
          </div>
          <div class="kpi-value ${regressedRoutesCount > 0 ? 'c-red' : 'c-green'}">
            ${regressedRoutesCount > 0 ? `${regressedRoutesCount} Failed` : '0 Failed'}
          </div>
          <div class="kpi-sub">${totalRoutesCount} endpoints audited</div>
        </div>

        <div class="diff-kpi-card ${maxLatencyDelta > 100 ? 'warn' : ''}">
          <div class="kpi-top">
            <span class="kpi-label">MAX LATENCY DELTA</span>
            <span class="kpi-icon">⚡</span>
          </div>
          <div class="kpi-value ${maxLatencyDelta > 100 ? 'c-amber' : 'c-white'}">
            ${maxLatencyDelta > 0 ? `+${maxLatencyDelta}ms` : '0ms'}
          </div>
          <div class="kpi-sub">Round-trip timing variance</div>
        </div>

        <div class="diff-kpi-card ${(d.newCausalChains && d.newCausalChains.length > 0) ? 'alert' : ''}">
          <div class="kpi-top">
            <span class="kpi-label">NEW CAUSAL CHAINS</span>
            <span class="kpi-icon">⌖</span>
          </div>
          <div class="kpi-value ${(d.newCausalChains && d.newCausalChains.length > 0) ? 'c-red' : 'c-green'}">
            ${d.newCausalChains ? d.newCausalChains.length : 0} New
          </div>
          <div class="kpi-sub">V8 unhandled rejections</div>
        </div>

        <div class="diff-kpi-card ${(d.gitModifiedFilesAfter && d.gitModifiedFilesAfter.length > 0) ? 'info' : ''}">
          <div class="kpi-top">
            <span class="kpi-label">WORKING TREE DRIFT</span>
            <span class="kpi-icon">⎇</span>
          </div>
          <div class="kpi-value c-white">
            ${d.gitModifiedFilesAfter ? d.gitModifiedFilesAfter.length : 0} Dirty Files
          </div>
          <div class="kpi-sub">${escapeHtml(d.gitCommitChange)}</div>
        </div>
      </div>
    `;

    // 3. Route Table Rows
    const emptyRouteMsg =
      totalRoutesCount > 0
        ? `All ${totalRoutesCount} audited HTTP route(s) remained stable with zero status inversions or latency regressions.`
        : 'No HTTP traffic routes recorded in selected capsules.';
    const tableRowsHtml = d.routeDiffs.length === 0
      ? `<tr><td colspan="5" class="empty-table-cell">${emptyRouteMsg}</td></tr>`
      : d.routeDiffs.map((r) => {
          const isReg = r.regression;
          const statusBefore = r.before ? `HTTP ${r.before.lastStatus}` : 'Not called';
          const statusAfter = r.after ? `HTTP ${r.after.lastStatus}` : 'Not called';
          const latencyBefore = r.before ? `${r.before.avgMs}ms` : '—';
          const latencyAfter = r.after ? `${r.after.avgMs}ms` : '—';
          const latencyDeltaVal = (r.before && r.after) ? (r.after.avgMs - r.before.avgMs) : 0;
          const latencyDeltaSign = latencyDeltaVal > 0 ? `+${latencyDeltaVal}ms` : `${latencyDeltaVal}ms`;

          return `
            <tr class="${isReg ? 'regressed-row' : ''}">
              <td class="col-route">
                <span class="route-name">${escapeHtml(r.route)}</span>
                ${isReg ? '<span class="reg-tag">FAULT</span>' : ''}
              </td>
              <td class="col-before">
                <span class="status-chip ${r.before && r.before.lastStatus < 400 ? 'status-ok' : 'status-err'}">
                  ${statusBefore}
                </span>
                <span class="time-chip">${latencyBefore}</span>
              </td>
              <td class="col-after">
                <span class="status-chip ${r.after && r.after.lastStatus >= 400 ? 'status-err' : 'status-ok'}">
                  ${statusAfter}
                </span>
                <span class="time-chip">${latencyAfter}</span>
              </td>
              <td class="col-delta ${latencyDeltaVal > 100 ? 'c-red' : ''}">
                ${latencyDeltaSign}
              </td>
              <td class="col-status">
                ${isReg
                  ? '<span class="verdict-pill reg">⚠️ REGRESSION</span>'
                  : '<span class="verdict-pill nom">✓ STABLE</span>'
                }
              </td>
            </tr>
          `;
        }).join('');

    const routeTableHtml = `
      <div class="diff-card">
        <div class="diff-card-header">
          <div class="dch-title">
            <span class="dch-glyph">⇄</span>
            <span>HTTP Endpoint &amp; Latency Shifts</span>
          </div>
          <span class="dch-meta">${d.routeDiffs.length} endpoints analyzed</span>
        </div>
        <div class="diff-table-wrap">
          <table class="diff-table">
            <thead>
              <tr>
                <th>ENDPOINT &amp; METHOD</th>
                <th>BASELINE A</th>
                <th>COMPARISON B</th>
                <th>LATENCY DELTA</th>
                <th>REGRESSION STATUS</th>
              </tr>
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;

    // 4. Causal Chains Card
    let causalHtml = '';
    if (d.newCausalChains && d.newCausalChains.length > 0) {
      const chainsList = d.newCausalChains
        .map((c) => {
          const culpritLabel = `${c.culpritFile || 'runtime'}${c.culpritLine ? ':' + c.culpritLine : ''}`;
          return `
        <div class="causal-diff-chain">
          <div class="chain-header">
            <span class="chain-conf-badge">${escapeHtml(c.confidence || 'CORRELATED')}</span>
            <span class="chain-culprit-pill">CULPRIT: ${escapeHtml(culpritLabel)}</span>
          </div>
          <h4 class="chain-headline">${escapeHtml(c.headline || c.faultSummary || 'Unhandled Crash Exception')}</h4>
          <div class="chain-details">
            <div class="chain-cause"><strong>Trigger:</strong> ${escapeHtml(c.triggerSummary || 'Runtime Event')}</div>
            <div class="chain-fault"><strong>Fault:</strong> ${escapeHtml(c.faultSummary || 'Unhandled Exception')}</div>
          </div>
        </div>
      `;
        })
        .join('');

      causalHtml = `
        <div class="diff-card">
          <div class="diff-card-header">
            <div class="dch-title">
              <span class="dch-glyph c-red">⌖</span>
              <span>Newly Introduced Causal Fault Chains (Snapshot B)</span>
            </div>
            <span class="dch-badge fault">${d.newCausalChains.length} FAULT CHAIN(S)</span>
          </div>
          <div class="diff-card-body">
            ${chainsList}
          </div>
        </div>
      `;
    }

    // 5. Git Modified Files Card
    let gitHtml = '';
    if (d.gitModifiedFilesAfter && d.gitModifiedFilesAfter.length > 0) {
      const filesList = d.gitModifiedFilesAfter
        .map((f) => {
          const filePath = typeof f === 'string' ? f : f.path || 'unknown';
          const status = typeof f === 'string' ? 'M' : f.status || 'M';
          const isNew = typeof f === 'object' && f.isNew;
          return `
        <div class="git-diff-row">
          <span class="git-diff-status">${escapeHtml(status)}${isNew ? ' · NEW' : ''}</span>
          <code class="git-diff-file">${escapeHtml(filePath)}</code>
        </div>
      `;
        })
        .join('');

      gitHtml = `
        <div class="diff-card">
          <div class="diff-card-header">
            <div class="dch-title">
              <span class="dch-glyph">⎇</span>
              <span>Git Working Tree Modifications</span>
            </div>
            <span class="dch-meta">${escapeHtml(d.gitCommitChange)}</span>
          </div>
          <div class="diff-card-body">
            <div class="git-diff-list">
              ${filesList}
            </div>
          </div>
        </div>
      `;
    }

    container.innerHTML = `
      <div class="diff-dossier-wrap">
        ${verdictBannerHtml}
        ${kpiGridHtml}
        ${routeTableHtml}
        ${causalHtml}
        ${gitHtml}
      </div>
    `;

    document.getElementById('btnJumpToCrashInCockpit')?.addEventListener('click', async () => {
      await selectCapsule(d.capsuleB.id);
      switchMode('inspector');
      showToast(`⚡ Switched to 4-Plane Cockpit for ${d.capsuleB.title}`);
    });

  } catch (err) {
    container.innerHTML = `
      <div class="diff-error-card">
        <span class="err-icon">⚠️</span>
        <h3>Differential Analysis Failed</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

function formatJsonOrText(val) {
  if (val === null || val === undefined) return 'none';
  if (typeof val === 'string') return val;
  try {
    return JSON.stringify(val, null, 2);
  } catch {
    return String(val);
  }
}

function showToast(msg) {
  const el = document.getElementById('studioToast');
  if (!el) return;
  if (toastTimer) clearTimeout(toastTimer);
  el.textContent = msg;
  el.style.display = 'block';
  toastTimer = setTimeout(() => {
    el.style.display = 'none';
    toastTimer = null;
  }, 4200);
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

initStudio();
