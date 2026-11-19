/**
 * KALA Core — Causal Fault Graph & Cross-Boundary Correlation Engine
 * Synthesizes Browser UI interactions, HTTP/WS network traces, Backend Terminal
 * stdout/stderr logs, Local Source Code AST/lines, and Uncommitted Git Diffs
 * into deterministic end-to-end Causal Fault Chains.
 */

import { parseStackAndCode } from './stack-parser.js';
import { correlateStackWithGitDiff } from './git-inspector.js';

/**
 * Analyzes a frozen slice of multi-plane events and constructs the Causal Fault Graph.
 * @param {object} slice Frozen buffer slice from `KalaRingBuffer.freezeSlice()`
 * @param {object} gitState Captured Git working-tree state
 * @param {string} [cwd]
 */
export function buildCausalAnalysis(slice, gitState, cwd = process.cwd()) {
  const events = slice.events || [];
  const startTimeMs = slice.startTimeMs || 0;

  const uiActions = [];
  const networkCalls = [];
  const terminalErrors = [];
  const terminalLogs = [];
  const browserErrors = [];
  const timelineMarkers = [];

  // 1. Classify and enrich events across planes
  for (const evt of events) {
    const relTimeMs = Math.max(0, +(evt.timestampMs - startTimeMs).toFixed(2));

    if (evt.plane === 'BROWSER') {
      if (
        evt.type === 'UI_CLICK' ||
        evt.type === 'UI_SUBMIT' ||
        evt.type === 'UI_KEYDOWN' ||
        evt.type === 'UI_NAVIGATE'
      ) {
        uiActions.push({ ...evt, relTimeMs });
        timelineMarkers.push({
          id: evt.id,
          relTimeMs,
          timestampMs: evt.timestampMs,
          kind: 'ui_action',
          label:
            evt.type === 'UI_NAVIGATE'
              ? `NAVIGATE: ${evt.payload?.to || evt.payload?.url || 'route'}`
              : `${evt.type.replace('UI_', '')}: ${evt.payload?.selector || evt.payload?.text || 'Element'}`,
          severity: 'info',
        });
      } else if (
        evt.type === 'UNCAUGHT_ERROR' ||
        evt.type === 'UNHANDLED_REJECTION' ||
        (evt.type === 'CONSOLE' && evt.severity === 'error')
      ) {
        const stackInfo = parseStackAndCode(
          evt.payload?.stack || evt.payload?.message || '',
          cwd
        );
        const enriched = { ...evt, relTimeMs, stackInfo };
        browserErrors.push(enriched);
        timelineMarkers.push({
          id: evt.id,
          relTimeMs,
          timestampMs: evt.timestampMs,
          kind: 'browser_error',
          label: `Browser Error: ${(evt.payload?.message || 'Exception').slice(0, 80)}`,
          severity: 'error',
        });
      }
    } else if (evt.plane === 'NETWORK') {
      if (evt.type === 'HTTP_TRACE') {
        const status = evt.payload?.status || 0;
        const isError = status >= 400 || Boolean(evt.payload?.error);
        const enriched = { ...evt, relTimeMs, isError };
        networkCalls.push(enriched);

        if (isError || status >= 400) {
          timelineMarkers.push({
            id: evt.id,
            relTimeMs,
            timestampMs: evt.timestampMs,
            kind: 'network_error',
            label: `HTTP ${status || 'ERR'} ${evt.payload?.method || 'GET'} ${evt.payload?.url || ''}`,
            severity: status >= 500 ? 'fatal' : 'error',
          });
        }
      }
    } else if (evt.plane === 'TERMINAL') {
      const text = evt.payload?.text || '';
      const stackInfo =
        evt.payload?.stackInfo?.hasStack
          ? evt.payload.stackInfo
          : parseStackAndCode(text, cwd);

      const isErr =
        evt.type === 'TERMINAL_STDERR' ||
        evt.severity === 'error' ||
        evt.severity === 'fatal' ||
        stackInfo.hasStack ||
        /(error|exception|traceback|panic|fatal|unhandled|eaddrinuse|syntaxerror|typeerror|referenceerror)/i.test(
          text
        );

      const enriched = { ...evt, relTimeMs, stackInfo, isErr };
      terminalLogs.push(enriched);

      if (isErr) {
        terminalErrors.push(enriched);
        timelineMarkers.push({
          id: evt.id,
          relTimeMs,
          timestampMs: evt.timestampMs,
          kind: 'terminal_error',
          label: `Terminal stderr: ${text.trim().split('\n')[0].slice(0, 80)}`,
          severity: stackInfo.hasStack ? 'fatal' : 'error',
        });
      }
    }
  }

  // 2. Construct Causal Fault Chains
  const causalChains = [];
  const usedTerminalErrIds = new Set();

  // First pass: Anchor chains on failed HTTP calls or HTTP calls that triggered backend errors
  for (const net of networkCalls) {
    const reqStartMs = net.payload?.startTimeMs || net.timestampMs - (net.payload?.durationMs || 50);
    const reqEndMs = net.timestampMs;
    const urlPath = extractPathname(net.payload?.url || '');

    // Find the UI action that triggered this network call
    let triggerUi = null;
    if (net.traceId) {
      triggerUi = uiActions.find((u) => u.traceId === net.traceId);
    }
    if (!triggerUi) {
      // Closest preceding UI click within 2500ms before request started
      for (let i = uiActions.length - 1; i >= 0; i--) {
        const u = uiActions[i];
        const delta = reqStartMs - u.timestampMs;
        if (delta >= -50 && delta <= 2500) {
          triggerUi = u;
          break;
        }
      }
    }

    // Find backend terminal logs/errors emitted during or immediately after this request
    const linkedTerminalLogs = terminalLogs.filter((t) => {
      // 1. Direct trace ID match
      if (net.traceId && (t.traceId === net.traceId || (t.payload?.text || '').includes(net.traceId))) {
        return true;
      }
      // If t explicitly has a traceId that differs from net.traceId, do not link
      if (t.traceId && net.traceId && t.traceId !== net.traceId) {
        return false;
      }
      // If t log text contains a different trace ID, do not link
      const otherTraceMatch = /(?:X-Blackbox-Trace-Id|X-Kala-Trace-Id|traceId|trace_id|trace:)[=:\s]+([a-zA-Z0-9_-]{6,64})/i.exec(
        t.payload?.text || ''
      );
      if (otherTraceMatch && net.traceId && otherTraceMatch[1] !== net.traceId) {
        return false;
      }

      const inTimeWindow =
        t.timestampMs >= reqStartMs - 25 && t.timestampMs <= reqEndMs + 350;
      if (!inTimeWindow) return false;
      if (urlPath && (t.payload?.text || '').includes(urlPath)) return true;
      return t.isErr;
    });

    const primaryTerminalErr =
      linkedTerminalLogs.find((t) => t.stackInfo?.hasStack) ||
      linkedTerminalLogs.find((t) => t.isErr) ||
      null;

    const isDirectBackendFault =
      primaryTerminalErr &&
      ((net.traceId && primaryTerminalErr.traceId === net.traceId) ||
        (urlPath && (primaryTerminalErr.payload?.text || '').includes(urlPath)));

    if (net.isError || isDirectBackendFault) {
      if (primaryTerminalErr) {
        usedTerminalErrIds.add(primaryTerminalErr.id);
      }

      const allFrames = primaryTerminalErr?.stackInfo?.frames || [];
      const gitOverlaps = correlateStackWithGitDiff(allFrames, gitState);

      // Find any subsequent browser error within 500ms after the HTTP response
      const resultingBrowserErr = browserErrors.find(
        (b) =>
          (net.traceId && b.traceId === net.traceId) ||
          (b.timestampMs >= reqStartMs && b.timestampMs <= reqEndMs + 600)
      );

      const correlationConfidence =
        net.traceId && primaryTerminalErr?.traceId === net.traceId
          ? 'EXACT_TRACE_ID (100%)'
          : primaryTerminalErr && urlPath && (primaryTerminalErr.payload?.text || '').includes(urlPath)
          ? 'TEMPORAL_AND_ROUTE_MATCH (96%)'
          : primaryTerminalErr
          ? 'TEMPORAL_WINDOW_CORRELATION (88%)'
          : 'CLIENT_NETWORK_FAULT (92%)';

      causalChains.push({
        chainId: `chain_${causalChains.length + 1}`,
        traceId: net.traceId || `inferred_${net.id}`,
        confidence: correlationConfidence,
        severity:
          (net.payload?.status || 0) >= 500 || primaryTerminalErr?.stackInfo?.hasStack
            ? 'CRITICAL'
            : 'ERROR',
        steps: buildChainSteps({
          triggerUi,
          net,
          primaryTerminalErr,
          resultingBrowserErr,
          gitOverlaps,
          startTimeMs,
        }),
        triggerUi: triggerUi
          ? {
              timestampMs: triggerUi.timestampMs,
              relTimeMs: triggerUi.relTimeMs,
              selector: triggerUi.payload?.selector,
              text: triggerUi.payload?.text,
              tagName: triggerUi.payload?.tagName,
            }
          : null,
        networkRequest: {
          method: net.payload?.method,
          url: net.payload?.url,
          status: net.payload?.status,
          durationMs: net.payload?.durationMs,
          requestBody: net.payload?.requestBody,
          responseBody: net.payload?.responseBody,
        },
        backendError: primaryTerminalErr
          ? {
              timestampMs: primaryTerminalErr.timestampMs,
              relTimeMs: primaryTerminalErr.relTimeMs,
              processName: primaryTerminalErr.source,
              rawText: primaryTerminalErr.payload?.text,
              primaryFrame: primaryTerminalErr.stackInfo?.primaryUserFrame || null,
              frames: primaryTerminalErr.stackInfo?.frames || [],
            }
          : null,
        browserError: resultingBrowserErr
          ? {
              message: resultingBrowserErr.payload?.message,
              stack: resultingBrowserErr.payload?.stack,
              primaryFrame: resultingBrowserErr.stackInfo?.primaryUserFrame || null,
            }
          : null,
        gitDiffOverlaps: gitOverlaps,
      });
    }
  }

  // Second pass: Standalone backend terminal crashes that didn't go through an HTTP trace
  for (const termErr of terminalErrors) {
    if (usedTerminalErrIds.has(termErr.id)) continue;
    const allFrames = termErr.stackInfo?.frames || [];
    const gitOverlaps = correlateStackWithGitDiff(allFrames, gitState);

    causalChains.push({
      chainId: `chain_${causalChains.length + 1}`,
      traceId: termErr.traceId || `term_${termErr.id}`,
      confidence: 'BACKEND_RUNTIME_EXCEPTION (95%)',
      severity: termErr.stackInfo?.hasStack ? 'CRITICAL' : 'ERROR',
      steps: buildChainSteps({
        triggerUi: null,
        net: null,
        primaryTerminalErr: termErr,
        resultingBrowserErr: null,
        gitOverlaps,
        startTimeMs,
      }),
      triggerUi: null,
      networkRequest: null,
      backendError: {
        timestampMs: termErr.timestampMs,
        relTimeMs: termErr.relTimeMs,
        processName: termErr.source,
        rawText: termErr.payload?.text,
        primaryFrame: termErr.stackInfo?.primaryUserFrame || null,
        frames: allFrames,
      },
      browserError: null,
      gitDiffOverlaps: gitOverlaps,
    });
  }

  // Third pass: Standalone frontend uncaught exceptions (e.g. null reference on click)
  for (const bErr of browserErrors) {
    const alreadyInChain = causalChains.some(
      (c) => c.browserError && c.browserError.message === bErr.payload?.message
    );
    if (alreadyInChain) continue;

    // Find closest UI click before this browser exception
    let triggerUi = null;
    for (let i = uiActions.length - 1; i >= 0; i--) {
      const u = uiActions[i];
      const delta = bErr.timestampMs - u.timestampMs;
      if (delta >= -20 && delta <= 1500) {
        triggerUi = u;
        break;
      }
    }

    const allFrames = bErr.stackInfo?.frames || [];
    const gitOverlaps = correlateStackWithGitDiff(allFrames, gitState);

    causalChains.push({
      chainId: `chain_${causalChains.length + 1}`,
      traceId: bErr.traceId || `front_${bErr.id}`,
      confidence: 'FRONTEND_DOM_TO_EXCEPTION (95%)',
      severity: 'ERROR',
      steps: buildChainSteps({
        triggerUi,
        net: null,
        primaryTerminalErr: null,
        resultingBrowserErr: bErr,
        gitOverlaps,
        startTimeMs,
      }),
      triggerUi: triggerUi
        ? {
            timestampMs: triggerUi.timestampMs,
            relTimeMs: triggerUi.relTimeMs,
            selector: triggerUi.payload?.selector,
            text: triggerUi.payload?.text,
          }
        : null,
      networkRequest: null,
      backendError: null,
      browserError: {
        message: bErr.payload?.message,
        stack: bErr.payload?.stack,
        primaryFrame: bErr.stackInfo?.primaryUserFrame || null,
        frames: allFrames,
      },
      gitDiffOverlaps: gitOverlaps,
    });
  }

  // Sort causal chains: CRITICAL first, then failed network calls (5xx, 4xx), then most recent
  causalChains.sort((a, b) => {
    const sevRank = (s) => (s === 'CRITICAL' ? 3 : s === 'ERROR' ? 2 : 1);
    const diffSev = sevRank(b.severity) - sevRank(a.severity);
    if (diffSev !== 0) return diffSev;
    const aStatus = a.networkRequest?.status || 0;
    const bStatus = b.networkRequest?.status || 0;
    if ((bStatus >= 400) !== (aStatus >= 400)) {
      return (bStatus >= 400 ? 1 : 0) - (aStatus >= 400 ? 1 : 0);
    }
    return (b.backendError?.timestampMs || b.networkRequest?.startTimeMs || 0) -
           (a.backendError?.timestampMs || a.networkRequest?.startTimeMs || 0);
  });

  const rootCauseSummary = synthesizeRootCauseSummary(causalChains, gitState);

  return {
    totalChains: causalChains.length,
    causalChains,
    rootCauseSummary,
    timelineMarkers,
    counts: {
      uiActions: uiActions.length,
      networkCalls: networkCalls.length,
      failedNetworkCalls: networkCalls.filter((n) => n.isError).length,
      terminalErrors: terminalErrors.length,
      browserErrors: browserErrors.length,
    },
  };
}

function buildChainSteps({
  triggerUi,
  net,
  primaryTerminalErr,
  resultingBrowserErr,
  gitOverlaps,
  startTimeMs,
}) {
  const steps = [];

  if (triggerUi) {
    steps.push({
      plane: 'BROWSER',
      relTimeMs: +(triggerUi.timestampMs - startTimeMs).toFixed(1),
      title: `User clicked "${triggerUi.payload?.text || triggerUi.payload?.selector || 'Element'}"`,
      detail: `Selector: ${triggerUi.payload?.selector || 'unknown'}`,
    });
  }

  if (net) {
    steps.push({
      plane: 'NETWORK',
      relTimeMs: +(net.timestampMs - startTimeMs).toFixed(1),
      title: `${net.payload?.method || 'GET'} ${net.payload?.url} -> HTTP ${net.payload?.status || 'ERR'} (${net.payload?.durationMs || 0}ms)`,
      detail: net.traceId ? `Trace-ID: ${net.traceId}` : 'Localhost HTTP Wiretap',
    });
  }

  if (primaryTerminalErr) {
    const firstLine = (primaryTerminalErr.payload?.text || '')
      .trim()
      .split(/\r?\n/)[0]
      .slice(0, 120);
    const frame = primaryTerminalErr.stackInfo?.primaryUserFrame;
    steps.push({
      plane: 'TERMINAL',
      relTimeMs: +(primaryTerminalErr.timestampMs - startTimeMs).toFixed(1),
      title: `Backend stderr: ${firstLine}`,
      detail: frame
        ? `Location: ${frame.snippet?.fileName || frame.rawFile}:${frame.lineNumber} in ${frame.functionName}()`
        : `Process: ${primaryTerminalErr.source}`,
    });
  }

  if (resultingBrowserErr) {
    const bFrame = resultingBrowserErr.stackInfo?.primaryUserFrame;
    steps.push({
      plane: 'BROWSER',
      relTimeMs: +(resultingBrowserErr.timestampMs - startTimeMs).toFixed(1),
      title: `Browser Exception: ${(resultingBrowserErr.payload?.message || '').slice(0, 110)}`,
      detail: bFrame
        ? `at ${bFrame.snippet?.fileName || bFrame.rawFile}:${bFrame.lineNumber}${bFrame.functionName ? ` in ${bFrame.functionName}()` : ''}`
        : 'Uncaught client error',
    });
  }

  if (gitOverlaps && gitOverlaps.length > 0) {
    const top = gitOverlaps[0];
    steps.push({
      plane: 'GIT',
      relTimeMs: null,
      title: `Uncommitted Git Edit Overlap (${top.confidence})`,
      detail: `${top.file}:${top.crashLine} overlaps dirty hunk ${top.hunkRange}`,
    });
  }

  return steps;
}

function synthesizeRootCauseSummary(causalChains, gitState) {
  if (causalChains.length === 0) {
    return {
      status: 'HEALTHY_SNAPSHOT',
      headline: 'Manual Flight Recorder Snapshot (No unhandled crashes detected in window)',
      explanation:
        'All browser interactions, network payloads, terminal streams, and Git working-tree state were captured cleanly.',
      culpritFile: null,
      culpritLine: null,
    };
  }

  const primary = causalChains[0];
  const frame =
    primary.backendError?.primaryFrame || primary.browserError?.primaryFrame || null;
  const gitHit = primary.gitDiffOverlaps?.[0] || null;

  let headline = '';
  if (primary.triggerUi && primary.networkRequest && primary.backendError) {
    headline = `Clicking "${primary.triggerUi.text || primary.triggerUi.selector}" triggered ${primary.networkRequest.method} ${extractPathname(primary.networkRequest.url)} [${primary.networkRequest.status}], crashing backend at ${frame ? `${frame.snippet?.fileName || frame.rawFile}:${frame.lineNumber}` : primary.backendError.processName}`;
  } else if (primary.networkRequest && primary.backendError) {
    headline = `${primary.networkRequest.method} ${extractPathname(primary.networkRequest.url)} [${primary.networkRequest.status}] failed due to backend exception in ${frame ? `${frame.snippet?.fileName || frame.rawFile}:${frame.lineNumber}` : primary.backendError.processName}`;
  } else if (primary.backendError) {
    headline = `Backend runtime crash in ${frame ? `${frame.snippet?.fileName || frame.rawFile}:${frame.lineNumber}` : primary.backendError.processName}`;
  } else if (primary.browserError) {
    const clickPrefix = primary.triggerUi
      ? `Clicking "${primary.triggerUi.text || primary.triggerUi.selector}" caused `
      : '';
    const locSuffix = frame
      ? ` in ${frame.snippet?.fileName || frame.rawFile}:${frame.lineNumber}`
      : '';
    headline = `${clickPrefix}Frontend exception${locSuffix}: ${(primary.browserError.message || '').slice(0, 90)}`;
  } else {
    headline = `HTTP ${primary.networkRequest?.status} error on ${primary.networkRequest?.method} ${primary.networkRequest?.url}`;
  }

  let explanation = headline;
  if (gitHit) {
    explanation += ` — Direct overlap detected with uncommitted Git working-tree changes in ${gitHit.file} (${gitHit.hunkRange}).`;
  } else if (gitState?.isDirty) {
    explanation += ` — Working tree has ${gitState.modifiedFiles.length} uncommitted file(s) on branch "${gitState.branch}".`;
  }

  return {
    status: 'FAULT_DETECTED',
    headline,
    explanation,
    confidence: primary.confidence,
    culpritFile: frame?.resolvedPath || frame?.rawFile || gitHit?.file || null,
    culpritLine: frame?.lineNumber || gitHit?.crashLine || null,
    culpritFunction: frame?.functionName || null,
    sourceSnippet: frame?.snippet || null,
    gitHit,
  };
}

function extractPathname(urlStr = '') {
  try {
    if (urlStr.startsWith('/')) return urlStr;
    return new URL(urlStr).pathname;
  } catch {
    return urlStr;
  }
}
