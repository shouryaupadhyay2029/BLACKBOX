/**
 * KALA Core — Capsule Vault, Persistence Engine, Capsule Differ & AI Diagnostic Compiler
 * Persists frozen `.kala.json` bug capsules, indexes metadata, diffs any two capsules,
 * and compiles surgical root-cause diagnostic prompts for AI coding agents & MCP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { captureGitState, captureRedactedEnv } from './git-inspector.js';
import { buildCausalAnalysis } from './causal-correlator.js';

export class CapsuleVault {
  /**
   * @param {object} options
   * @param {string} [options.storageDir] Directory where capsules are stored
   * @param {string} [options.projectCwd] Target project root for Git & source code resolution
   */
  constructor(options = {}) {
    this.projectCwd = options.projectCwd || process.cwd();
    this.storageDir =
      options.storageDir || path.join(this.projectCwd, '.kala', 'capsules');

    fs.mkdirSync(this.storageDir, { recursive: true });
    this.indexFile = path.join(this.storageDir, 'index.json');
    this.capsulesIndex = this._loadIndex();
  }

  /**
   * Creates, analyzes, and persists a complete Time-Travel Bug Capsule from a ring buffer slice.
   * @param {object} params
   * @param {object} params.slice Frozen buffer slice from `KalaRingBuffer.freezeSlice()`
   * @param {string} [params.triggerReason='MANUAL_FREEZE'] Why this capsule was frozen
   * @param {string} [params.title] Optional custom title
   * @param {string} [params.notes] Optional developer notes
   */
  createCapsule({
    slice,
    triggerReason = 'MANUAL_FREEZE',
    title = '',
    notes = '',
  }) {
    const now = new Date();
    const id = `cap_${now.toISOString().replace(/[:.]/g, '-')}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;

    const gitState = captureGitState(this.projectCwd);
    const envState = captureRedactedEnv();
    const causal = buildCausalAnalysis(slice, gitState, this.projectCwd);

    const resolvedTitle =
      title ||
      (causal.rootCauseSummary?.status === 'FAULT_DETECTED'
        ? causal.rootCauseSummary.headline
        : `Flight Capsule (${triggerReason}) @ ${now.toLocaleTimeString()}`);

    const capsule = {
      schemaVersion: '1.0.0',
      id,
      createdAt: now.toISOString(),
      createdAtMs: now.getTime(),
      triggerReason,
      title: resolvedTitle,
      notes,
      status: causal.rootCauseSummary?.status || 'SNAPSHOT',
      window: {
        startTimeMs: slice.startTimeMs,
        endTimeMs: slice.endTimeMs,
        durationMs: slice.durationMs,
        totalEvents: slice.totalEvents,
        planeCounts: slice.planeCounts,
      },
      causal,
      git: gitState,
      environment: envState,
      events: slice.events,
    };

    capsule.aiDiagnosticMarkdown = this.compileAiDiagnosticPrompt(capsule);

    // Save full capsule file
    const filePath = path.join(this.storageDir, `${id}.kala.json`);
    fs.writeFileSync(filePath, JSON.stringify(capsule, null, 2), 'utf8');

    // Update lightweight index
    const summaryEntry = {
      id: capsule.id,
      createdAt: capsule.createdAt,
      createdAtMs: capsule.createdAtMs,
      triggerReason: capsule.triggerReason,
      title: capsule.title,
      status: capsule.status,
      totalEvents: capsule.window.totalEvents,
      durationMs: capsule.window.durationMs,
      planeCounts: capsule.window.planeCounts,
      totalChains: capsule.causal.totalChains,
      culpritFile: capsule.causal.rootCauseSummary?.culpritFile || null,
      culpritLine: capsule.causal.rootCauseSummary?.culpritLine || null,
      gitBranch: capsule.git.branch,
      gitDirty: capsule.git.isDirty,
      filePath,
    };

    this.capsulesIndex.unshift(summaryEntry);
    if (this.capsulesIndex.length > 100) {
      this.capsulesIndex.length = 100;
    }
    this._saveIndex();

    return capsule;
  }

  /**
   * Lists all saved capsules (newest first).
   */
  listCapsules() {
    this.capsulesIndex = this._loadIndex();
    return this.capsulesIndex;
  }

  /**
   * Loads a full capsule by ID (or returns the latest capsule if id === 'latest').
   * @param {string} id
   */
  getCapsule(id = 'latest') {
    this.capsulesIndex = this._loadIndex();
    const target =
      id === 'latest'
        ? this.capsulesIndex[0]
        : this.capsulesIndex.find((c) => c.id === id);

    if (!target) return null;

    try {
      const filePath =
        target.filePath || path.join(this.storageDir, `${target.id}.kala.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Imports an external `.kala.json` capsule payload into the local vault.
   * @param {object} capsuleData
   */
  importCapsule(capsuleData) {
    if (!capsuleData || !capsuleData.events) {
      throw new Error('Invalid KALA capsule format: missing events array');
    }
    const id =
      capsuleData.id ||
      `cap_imported_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    capsuleData.id = id;
    if (!capsuleData.aiDiagnosticMarkdown) {
      capsuleData.aiDiagnosticMarkdown = this.compileAiDiagnosticPrompt(capsuleData);
    }

    const filePath = path.join(this.storageDir, `${id}.kala.json`);
    fs.writeFileSync(filePath, JSON.stringify(capsuleData, null, 2), 'utf8');

    const summaryEntry = {
      id,
      createdAt: capsuleData.createdAt || new Date().toISOString(),
      createdAtMs: capsuleData.createdAtMs || Date.now(),
      triggerReason: capsuleData.triggerReason || 'IMPORTED_CAPSULE',
      title: capsuleData.title || `Imported Capsule (${id})`,
      status: capsuleData.status || 'SNAPSHOT',
      totalEvents: capsuleData.events.length,
      durationMs: capsuleData.window?.durationMs || 0,
      planeCounts: capsuleData.window?.planeCounts || {},
      totalChains: capsuleData.causal?.totalChains || 0,
      culpritFile: capsuleData.causal?.rootCauseSummary?.culpritFile || null,
      culpritLine: capsuleData.causal?.rootCauseSummary?.culpritLine || null,
      gitBranch: capsuleData.git?.branch || null,
      gitDirty: Boolean(capsuleData.git?.isDirty),
      filePath,
    };

    this.capsulesIndex = this.capsulesIndex.filter((c) => c.id !== id);
    this.capsulesIndex.unshift(summaryEntry);
    this._saveIndex();
    return capsuleData;
  }

  /**
   * Compares two capsules (`capsuleA` vs `capsuleB`) to highlight regressions in
   * HTTP status codes, new terminal exceptions, and modified Git files.
   */
  diffCapsules(idA, idB) {
    const capA = typeof idA === 'object' ? idA : this.getCapsule(idA);
    const capB = typeof idB === 'object' ? idB : this.getCapsule(idB);
    if (!capA || !capB) {
      throw new Error('Both capsules must exist to compute a differential comparison.');
    }

    const endpointsA = this._summarizeEndpoints(capA.events);
    const endpointsB = this._summarizeEndpoints(capB.events);
    const allRoutes = new Set([...Object.keys(endpointsA), ...Object.keys(endpointsB)]);

    const routeDiffs = [];
    for (const route of allRoutes) {
      const a = endpointsA[route] || null;
      const b = endpointsB[route] || null;
      if (!a || !b || a.lastStatus !== b.lastStatus || Math.abs(a.avgMs - b.avgMs) > 100) {
        routeDiffs.push({
          route,
          before: a,
          after: b,
          regression: Boolean(b && b.lastStatus >= 400 && (!a || a.lastStatus < 400)),
        });
      }
    }

    return {
      capsuleA: { id: capA.id, title: capA.title, createdAt: capA.createdAt },
      capsuleB: { id: capB.id, title: capB.title, createdAt: capB.createdAt },
      statusChange: `${capA.status} -> ${capB.status}`,
      routeDiffs,
      newCausalChains: capB.causal?.causalChains || [],
      gitCommitChange: `${capA.git?.headCommit || 'none'} -> ${capB.git?.headCommit || 'none'}`,
      gitModifiedFilesAfter: capB.git?.modifiedFiles || [],
    };
  }

  /**
   * Compiles a complete, crystal-clear Markdown diagnostic packet designed for
   * 1-shot bug resolution by an AI coding agent or human engineer.
   * @param {object} capsule
   */
  compileAiDiagnosticPrompt(capsule) {
    const lines = [];
    const summary = capsule.causal?.rootCauseSummary || {};
    const chains = capsule.causal?.causalChains || [];

    lines.push(`# KALA Flight Recorder — Full-Stack Bug Capsule (${capsule.id})`);
    lines.push(`- **Captured At:** ${capsule.createdAt}`);
    lines.push(`- **Trigger:** \`${capsule.triggerReason}\``);
    lines.push(`- **Diagnosis Status:** \`${summary.status || capsule.status}\``);
    lines.push(`- **Headline:** ${summary.headline || capsule.title}`);
    if (summary.culpritFile) {
      lines.push(
        `- **Primary Culprit Location:** \`${summary.culpritFile}${
          summary.culpritLine ? `:${summary.culpritLine}` : ''
        }\`${summary.culpritFunction ? ` in \`${summary.culpritFunction}()\`` : ''}`
      );
    }
    lines.push('');

    if (chains.length > 0) {
      lines.push(`## 1. End-to-End Causal Fault Chain`);
      for (const chain of chains.slice(0, 3)) {
        lines.push(`### Chain \`${chain.chainId}\` — Confidence: ${chain.confidence}`);
        for (let i = 0; i < chain.steps.length; i++) {
          const s = chain.steps[i];
          const timeTag = s.relTimeMs !== null ? `[+${s.relTimeMs}ms]` : '[GIT]';
          lines.push(
            `${i + 1}. **${timeTag} [${s.plane}]** ${s.title} — _${s.detail}_`
          );
        }
        lines.push('');

        if (chain.networkRequest && chain.networkRequest.url) {
          lines.push(`#### Network Payload (\`${chain.networkRequest.method} ${chain.networkRequest.url}\` -> HTTP ${chain.networkRequest.status})`);
          if (chain.networkRequest.requestBody) {
            lines.push('**Request Body:**');
            lines.push('```json');
            lines.push(
              typeof chain.networkRequest.requestBody === 'string'
                ? chain.networkRequest.requestBody.slice(0, 1500)
                : JSON.stringify(chain.networkRequest.requestBody, null, 2).slice(0, 1500)
            );
            lines.push('```');
          }
          if (chain.networkRequest.responseBody) {
            lines.push('**Response Body:**');
            lines.push('```json');
            lines.push(
              typeof chain.networkRequest.responseBody === 'string'
                ? chain.networkRequest.responseBody.slice(0, 1500)
                : JSON.stringify(chain.networkRequest.responseBody, null, 2).slice(0, 1500)
            );
            lines.push('```');
          }
        }

        if (chain.backendError) {
          lines.push(`#### Backend Terminal Stack Trace (\`${chain.backendError.processName}\`)`);
          lines.push('```text');
          lines.push((chain.backendError.rawText || '').trim().slice(0, 2500));
          lines.push('```');

          const snippet = chain.backendError.primaryFrame?.snippet;
          if (snippet) {
            lines.push(
              `#### Local Source Code X-Ray (\`${snippet.filePath}:${snippet.targetLine}\`)`
            );
            lines.push('```javascript');
            for (const ln of snippet.lines) {
              const prefix = ln.isTarget ? '>>> ' : '    ';
              lines.push(
                `${prefix}${String(ln.lineNumber).padStart(4, ' ')} | ${ln.code}`
              );
            }
            lines.push('```');
          }
        }

        if (chain.browserError) {
          lines.push(`#### Browser Client Exception`);
          lines.push('```text');
          lines.push(
            `${chain.browserError.message}\n${chain.browserError.stack || ''}`.trim()
          );
          lines.push('```');
        }
      }
    }

    if (capsule.git?.isGitRepo) {
      lines.push(`## 2. Git Working-Tree State (Branch: \`${capsule.git.branch}\` @ \`${capsule.git.headCommit}\`)`);
      if (capsule.git.isDirty) {
        lines.push(
          `Uncommitted modifications in ${capsule.git.modifiedFiles.length} file(s):`
        );
        for (const mf of capsule.git.modifiedFiles.slice(0, 15)) {
          lines.push(`- \`[${mf.status}] ${mf.path}\``);
        }
        if (capsule.git.rawDiff) {
          lines.push('\n```diff');
          lines.push(capsule.git.rawDiff.slice(0, 4000));
          lines.push('```');
        }
      } else {
        lines.push('Working tree is clean.');
      }
    }

    return lines.join('\n');
  }

  _summarizeEndpoints(events = []) {
    const map = {};
    for (const e of events) {
      if (e.plane === 'NETWORK' && e.type === 'HTTP_TRACE') {
        const key = `${e.payload?.method || 'GET'} ${e.payload?.url || '/'}`;
        if (!map[key]) {
          map[key] = { count: 0, lastStatus: 0, totalMs: 0, avgMs: 0 };
        }
        map[key].count++;
        map[key].lastStatus = e.payload?.status || 0;
        map[key].totalMs += e.payload?.durationMs || 0;
        map[key].avgMs = Math.round(map[key].totalMs / map[key].count);
      }
    }
    return map;
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      }
    } catch {
      // ignore corrupted index
    }
    return [];
  }

  _saveIndex() {
    try {
      fs.writeFileSync(
        this.indexFile,
        JSON.stringify(this.capsulesIndex, null, 2),
        'utf8'
      );
    } catch {
      // ignore write failure
    }
  }
}
