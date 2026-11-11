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
const domUrlPill = document.getElementById('domUrlPill');
const domClickBadge = document.getElementById('domClickBadge');
const cursorLaser = document.getElementById('cursorLaser');
const cursorLaserLabel = document.getElementById('cursorLaserLabel');
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
  setupActions();

  await fetchDaemonStatus();
  await loadCapsulesList();

  const urlParams = new URLSearchParams(window.location.search);
  const requestedCap = urlParams.get('capsule');
  if (requestedCap) {
    await selectCapsule(requestedCap);
  } else if (capsulesList.length > 0) {
    await selectCapsule(capsulesList[0].id);
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
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.ok) return;
    bufferStatText.textContent = `Buffer: ${data.buffer.activeEvents} evts (${data.buffer.memoryMB}MB)`;
    gitStatText.textContent = data.git.isGitRepo
      ? `${data.git.branch}@${data.git.headCommit}${
          data.git.isDirty ? ` (${data.git.modifiedCount} dirty)` : ' (clean)'
        }`
      : 'no-git';
    autoFreezeCheck.checked = Boolean(data.autoFreeze);
  } catch {
    bufferStatText.textContent = 'Daemon Disconnected';
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
  if (capsulesList.length === 0) {
    capsuleListEl.innerHTML =
      '<div class="empty-hint">No capsules frozen yet. Trigger a bug or click "Freeze Capsule Now".</div>';
    return;
  }

  capsuleListEl.innerHTML = capsulesList
    .map((c) => {
      const isFault = c.status === 'FAULT_DETECTED';
      const isActive = activeCapsule && activeCapsule.id === c.id;
      const timeStr = new Date(c.createdAt).toLocaleTimeString();
      return `
        <div class="capsule-card ${isActive ? 'active' : ''}" data-cap-id="${escapeHtml(c.id)}">
          <div class="cap-top">
            <span class="cap-badge ${isFault ? 'fault' : 'ok'}">${
        isFault ? '⚡ FAULT' : '📸 SNAPSHOT'
      }</span>
            <span class="cap-time">${escapeHtml(timeStr)}</span>
          </div>
          <div class="cap-title">${escapeHtml(c.title)}</div>
          <div class="cap-meta">
            <span>${c.totalEvents} evts · ${(c.durationMs / 1000).toFixed(1)}s</span>
            <span>${c.totalChains || 0} chain(s)</span>
          </div>
        </div>
      `;
    })
    .join('');

  capsuleListEl.querySelectorAll('.capsule-card').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-cap-id');
      selectCapsule(id);
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

  capsuleStatusTag.textContent = isFault ? '⚡ FAULT DETECTED' : '📸 HEALTHY SNAPSHOT';
  capsuleStatusTag.className = `status-tag ${isFault ? 'fault' : ''}`;
  capsuleHeadline.textContent = summary.headline || capsule.title;

  capsuleMetaText.textContent = summary.culpritFile
    ? `Culprit: ${summary.culpritFile}${summary.culpritLine ? `:${summary.culpritLine}` : ''} (${
        summary.confidence || ''
      })`
    : `Trigger: ${capsule.triggerReason}`;

  const chains = capsule.causal?.causalChains || [];
  if (chains.length === 0) {
    causalChainFlow.innerHTML =
      '<div style="font-size:11px;color:#94a3b8;">No unhandled fault chains in this capsule window. Scrub timeline below to inspect all 4 planes.</div>';
    return;
  }

  const primary = chains[0];
  causalChainFlow.innerHTML = (primary.steps || [])
    .map((step, idx) => {
      const timeBadge =
        step.relTimeMs !== null ? `+${(step.relTimeMs / 1000).toFixed(2)}s` : 'WORKING TREE';
      return `
        ${idx > 0 ? '<span class="chain-arrow">→</span>' : ''}
        <div class="chain-node">
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
              <div class="term-row log-row ${isErr ? 'stderr' : ''}" data-rel-ms="${relMs}">
                <div class="term-meta">
                  <span>[${escapeHtml(e.type)}]</span>
                  <span>+${(relMs / 1000).toFixed(3)}s</span>
                </div>
                <div>${escapeHtml(e.payload?.message || '')}</div>
              </div>
            `;
          })
          .join('');

  // 2. Network Waterfall
  const netEvents = events.filter((e) => e.plane === 'NETWORK' && e.type === 'HTTP_TRACE');
  netCount.textContent = String(netEvents.length);

  networkWaterfallList.innerHTML =
    netEvents.length === 0
      ? '<div class="empty-hint">No HTTP/WS network requests captured in this window.</div>'
      : netEvents
          .map((e, idx) => {
            const relMs = Math.max(0, e.timestampMs - startMs);
            const status = e.payload?.status || 0;
            const statusClass =
              status >= 500 ? 'status-5xx' : status >= 400 ? 'status-4xx' : 'status-2xx';
            return `
              <div class="net-row ${status >= 400 ? 'error-row' : ''}" data-net-idx="${idx}" data-rel-ms="${relMs}">
                <span class="status-pill ${statusClass}">${status || 'ERR'}</span>
                <strong style="color:#e2e8f0">${escapeHtml(e.payload?.method || 'GET')}</strong>
                <span style="color:#38bdf8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(
                  e.payload?.url || '/'
                )}</span>
                <span style="color:#94a3b8;text-align:right;">${
                  e.payload?.durationMs ?? 0
                }ms</span>
                <span style="color:#64748b;text-align:right;">+${(relMs / 1000).toFixed(2)}s</span>
              </div>
            `;
          })
          .join('');

  networkWaterfallList.querySelectorAll('.net-row').forEach((row) => {
    row.addEventListener('click', () => {
      networkWaterfallList.querySelectorAll('.net-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
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
              <div class="term-row ${isStderr ? 'stderr' : ''}" data-rel-ms="${relMs}">
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
}

function renderNetworkPayloadDetail(netEvt) {
  const p = netEvt.payload || {};
  networkPayloadInspector.innerHTML = `
    <div class="xray-card">
      <div class="xray-header">
        <span>${escapeHtml(p.method || 'GET')} ${escapeHtml(p.url || '')} → HTTP ${
    p.status || 'ERR'
  }</span>
        <span>${p.durationMs || 0}ms</span>
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
      </div>
    </div>
  `;
}

function renderSourceXrayPane(capsule) {
  const snippets = [];
  const seen = new Set();

  // Gather snippets from causal chains & terminal events
  for (const chain of capsule.causal?.causalChains || []) {
    const frames = [
      ...(chain.backendError?.frames || []),
      ...(chain.browserError?.primaryFrame ? [chain.browserError.primaryFrame] : []),
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
    return;
  }

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
            <span style="font-size:10px;color:#94a3b8">${escapeHtml(snippet.filePath)}</span>
          </div>
          <div>${codeLines}</div>
        </div>
      `;
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
          Crash at <strong>${escapeHtml(overlaps[0].file)}:${
          overlaps[0].crashLine
        }</strong> directly overlaps uncommitted working-tree edit hunk <code>${escapeHtml(
          overlaps[0].hunkRange
        )}</code>!
        </div>
      </div>
    `
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
      <pre class="code-block">${escapeHtml(
        git.rawDiff || 'No uncommitted diff against HEAD.'
      )}</pre>
    </div>
  `;
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
    domReplayFrame.srcdoc =
      activeDomEvt.payload?.html ||
      '<html><body style="font-family:sans-serif;padding:20px;">No DOM Snapshot</body></html>';
  }

  // 2. Update Click Laser Overlay
  if (activeClickEvt) {
    const vp = activeDomEvt?.payload?.viewport || { width: 1000, height: 700 };
    const xPct = Math.min(95, Math.max(5, ((activeClickEvt.payload?.clientX || 200) / (vp.width || 1000)) * 100));
    const yPct = Math.min(95, Math.max(5, ((activeClickEvt.payload?.clientY || 200) / (vp.height || 700)) * 100));
    cursorLaser.style.display = 'block';
    cursorLaser.style.left = `${xPct}%`;
    cursorLaser.style.top = `${yPct}%`;
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
}

function setupModeSwitcher() {
  const stages = {
    inspector: document.getElementById('inspectorStage'),
    live: document.getElementById('liveStage'),
    diff: document.getElementById('diffStage'),
  };

  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      Object.entries(stages).forEach(([k, el]) => {
        el.style.display = k === mode ? 'flex' : 'none';
      });
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
    if (!activeCapsule) return;
    const blob = new Blob([JSON.stringify(activeCapsule, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${activeCapsule.id}.blackbox.json`;
    a.click();
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
    }
  });

  document.getElementById('refreshCapsulesBtn').addEventListener('click', loadCapsulesList);

  autoFreezeCheck.addEventListener('change', async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoFreeze: autoFreezeCheck.checked }),
    });
  });

  document.getElementById('runDiffBtn').addEventListener('click', runCapsuleDiff);
}

// --- 5. Live Flight Deck & Capsule Differ ---
function appendLiveFeedEvent(evt) {
  if (!liveStreamFeed) return;
  const row = document.createElement('div');
  row.className = `term-row ${evt.severity === 'error' || evt.severity === 'fatal' ? 'stderr' : ''}`;
  const summary =
    evt.plane === 'NETWORK'
      ? `${evt.payload?.method || 'GET'} ${evt.payload?.url || ''} -> HTTP ${evt.payload?.status}`
      : evt.plane === 'TERMINAL'
      ? (evt.payload?.text || '').trim().slice(0, 240)
      : evt.type === 'UI_CLICK'
      ? `Clicked ${evt.payload?.selector || ''} ("${evt.payload?.text || ''}")`
      : evt.payload?.message || evt.type;

  row.innerHTML = `
    <div class="term-meta">
      <span><span class="plane-badge plane-${evt.plane.toLowerCase()}">${escapeHtml(
    evt.plane
  )}</span> ${escapeHtml(evt.type)} ${evt.traceId ? `· 🔗 ${escapeHtml(evt.traceId)}` : ''}</span>
      <span>${new Date(evt.timestampMs).toLocaleTimeString()}</span>
    </div>
    <div>${escapeHtml(summary)}</div>
  `;
  liveStreamFeed.prepend(row);
  while (liveStreamFeed.children.length > 120) {
    liveStreamFeed.lastChild.remove();
  }
}

function populateDiffSelectors() {
  const selA = document.getElementById('diffSelectA');
  const selB = document.getElementById('diffSelectB');
  if (!selA || !selB) return;

  const opts = capsulesList
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)} (${c.id.slice(0, 16)})</option>`)
    .join('');

  selA.innerHTML = opts;
  selB.innerHTML = opts;
  if (capsulesList.length > 1) {
    selA.selectedIndex = 1;
    selB.selectedIndex = 0;
  }
}

async function runCapsuleDiff() {
  const idA = document.getElementById('diffSelectA').value;
  const idB = document.getElementById('diffSelectB').value;
  const container = document.getElementById('diffResultsContainer');
  if (!idA || !idB) return;

  try {
    const res = await fetch(
      `/api/capsules/diff?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`
    );
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const d = data.diff;
    const routesHtml =
      d.routeDiffs.length === 0
        ? '<div style="color:#94a3b8">No route status or significant latency regressions detected.</div>'
        : d.routeDiffs
            .map(
              (r) => `
          <div class="term-row ${r.regression ? 'stderr' : ''}" style="margin-bottom:6px;">
            <strong>${escapeHtml(r.route)}</strong> —
            Before: ${r.before ? `HTTP ${r.before.lastStatus} (${r.before.avgMs}ms)` : 'Not called'}
            → After: ${r.after ? `HTTP ${r.after.lastStatus} (${r.after.avgMs}ms)` : 'Not called'}
            ${r.regression ? ' <strong>[⚠️ REGRESSION]</strong>' : ''}
          </div>
        `
            )
            .join('');

    container.innerHTML = `
      <div class="xray-card">
        <div class="xray-header">
          <span>Status Transition: ${escapeHtml(d.statusChange)}</span>
          <span>Git Commit: ${escapeHtml(d.gitCommitChange)}</span>
        </div>
        <div style="padding:12px;">
          <h4 style="margin:0 0 8px 0;">Endpoint & Latency Shifts</h4>
          ${routesHtml}
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="empty-hint">Diff failed: ${escapeHtml(err.message)}</div>`;
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
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => {
    el.style.display = 'none';
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
