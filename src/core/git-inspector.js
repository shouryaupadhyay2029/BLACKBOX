/**
 * KALA Core — Git Working-Tree Dirty State Inspector & Secret-Safe Env Snapshotter
 * Captures uncommitted file modifications, parses unified diff hunks into line ranges,
 * cross-references stack trace crash lines against uncommitted code edits, and snapshots
 * secret-masked environment metadata.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

const SECRET_KEY_PATTERN =
  /(key|secret|token|password|passwd|pwd|auth|credential|private|jwt|dsn|connection_string|database_url|stripe|openai|anthropic|aws)/i;

const SECRET_VALUE_PATTERN =
  /^(sk-[a-zA-Z0-9_-]{12,}|ghp_[a-zA-Z0-9]{20,}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|AKIA[0-9A-Z]{16})$/;

/**
 * Safely runs a git command in `cwd` with a short timeout.
 */
function runGit(args, cwd = process.cwd()) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      timeout: 2500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parses unified git diff output into structured file diffs and modified line ranges.
 * @param {string} diffText
 * @param {string} cwd
 */
export function parseUnifiedDiff(diffText, cwd = process.cwd()) {
  if (!diffText) return [];
  const files = [];
  const fileChunks = diffText.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split(/\r?\n/);
    const headerMatch = /^a\/(.+?)\s+b\/(.+)$/.exec(lines[0] || '');
    const relativePath = headerMatch ? headerMatch[2] : 'unknown';
    const absPath = path.resolve(cwd, relativePath);

    const hunks = [];
    const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

    let currentHunk = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const m = HUNK_HEADER.exec(line);
      if (m) {
        const newStart = parseInt(m[3], 10);
        const newCount = m[4] !== undefined ? parseInt(m[4], 10) : 1;
        currentHunk = {
          header: line,
          contextHeading: (m[5] || '').trim(),
          oldStart: parseInt(m[1], 10),
          oldCount: m[2] !== undefined ? parseInt(m[2], 10) : 1,
          newStart,
          newCount,
          newEnd: newStart + Math.max(0, newCount - 1),
          changes: [],
        };
        hunks.push(currentHunk);
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        if (!line.startsWith('+++') && !line.startsWith('---')) {
          currentHunk.changes.push(line);
        }
      }
    }

    files.push({
      relativePath,
      absPath,
      hunks,
      rawDiff: `diff --git ${chunk}`.slice(0, 12000),
    });
  }

  return files;
}

/**
 * Captures the complete Git state of `cwd` (branch, commit, dirty files, parsed diff hunks).
 * @param {string} [cwd]
 */
export function captureGitState(cwd = process.cwd()) {
  const branch = runGit('rev-parse --abbrev-ref HEAD', cwd);
  if (!branch) {
    return {
      isGitRepo: false,
      cwd,
      branch: null,
      headCommit: null,
      headSubject: null,
      isDirty: false,
      modifiedFiles: [],
      diffFiles: [],
      rawDiff: '',
    };
  }

  const headCommit = runGit('rev-parse --short HEAD', cwd) || 'uncommitted';
  const headSubject = runGit('log -1 --pretty=%s', cwd) || '';
  const statusOutput = runGit('status --porcelain', cwd) || '';

  const modifiedFiles = statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3).trim(),
    }));

  // Get both staged and unstaged diffs against HEAD (or working tree if no HEAD commit yet)
  let rawDiff = runGit('diff HEAD --unified=3', cwd);
  if (rawDiff === null) {
    rawDiff = runGit('diff --unified=3', cwd) || '';
  }

  const diffFiles = parseUnifiedDiff(rawDiff, cwd);

  return {
    isGitRepo: true,
    cwd,
    branch,
    headCommit,
    headSubject,
    isDirty: modifiedFiles.length > 0,
    modifiedFiles,
    diffFiles,
    rawDiff: (rawDiff || '').slice(0, 35000),
  };
}

/**
 * Cross-checks whether any stack frame from a crash falls inside or near
 * an uncommitted Git diff hunk!
 * @param {Array<object>} stackFrames
 * @param {object} gitState
 */
export function correlateStackWithGitDiff(stackFrames = [], gitState = null) {
  if (!gitState || !gitState.isGitRepo || !gitState.diffFiles?.length) {
    return [];
  }

  const matches = [];
  for (const frame of stackFrames) {
    if (!frame.resolvedPath && !frame.rawFile) continue;
    const normFramePath = (frame.resolvedPath || frame.rawFile)
      .replace(/\\/g, '/')
      .toLowerCase();

    for (const diffFile of gitState.diffFiles) {
      const normDiffAbs = diffFile.absPath.replace(/\\/g, '/').toLowerCase();
      const normDiffRel = diffFile.relativePath.replace(/\\/g, '/').toLowerCase();

      if (normFramePath === normDiffAbs || normFramePath.endsWith(normDiffRel)) {
        for (const hunk of diffFile.hunks) {
          // Check if crash line is within +/- 8 lines of an uncommitted diff hunk
          if (
            frame.lineNumber >= hunk.newStart - 8 &&
            frame.lineNumber <= hunk.newEnd + 8
          ) {
            matches.push({
              file: diffFile.relativePath,
              crashLine: frame.lineNumber,
              functionName: frame.functionName,
              hunkRange: `L${hunk.newStart}-L${hunk.newEnd}`,
              hunkHeader: hunk.header,
              changes: hunk.changes.slice(0, 15),
              confidence:
                frame.lineNumber >= hunk.newStart && frame.lineNumber <= hunk.newEnd
                  ? 'DIRECT_HIT'
                  : 'NEARBY_EDIT',
            });
          }
        }
      }
    }
  }

  return matches;
}

/**
 * Captures environment variables while strictly redacting secrets, tokens, and credentials.
 * @param {object} [envObj=process.env]
 */
export function captureRedactedEnv(envObj = process.env) {
  const safeEnv = {};
  const allowlistPrefixes = ['NODE_', 'NPM_', 'PORT', 'HOST', 'BLACKBOX_', 'KALA_', 'VITE_', 'NEXT_PUBLIC_'];

  for (const [key, val] of Object.entries(envObj)) {
    if (val === undefined) continue;
    const strVal = String(val);

    if (SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(strVal)) {
      const preview =
        strVal.length > 6 ? `${strVal.slice(0, 2)}***REDACTED(${strVal.length} chars)***` : '***REDACTED***';
      safeEnv[key] = preview;
    } else if (allowlistPrefixes.some((p) => key.startsWith(p))) {
      safeEnv[key] = strVal;
    }
  }

  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    cwd: process.cwd(),
    variables: safeEnv,
  };
}
