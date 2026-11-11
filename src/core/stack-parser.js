/**
 * KALA Core — Multi-Language Stack Trace Parser & Local Source-Code X-Ray
 * Automatically parses stack frames from Node.js/V8, TypeScript, Python, Go, and Rust
 * terminal output, resolves local filesystem paths (Windows & POSIX), and extracts
 * the exact surrounding source lines from disk at the moment of the error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regex patterns for common runtime stack frames
const V8_FRAME_REGEX =
  /^\s*at\s+(?:(?<fn>.+?)\s+\((?<fileWithParen>.+?):(?<line>\d+)(?::(?<col>\d+))?\)|(?<fileBare>.+?):(?<lineBare>\d+)(?::(?<colBare>\d+))?)\s*$/;

const PYTHON_FRAME_REGEX =
  /^\s*File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>[^\s\r\n]+))?/;

const GO_RUST_FRAME_REGEX =
  /^\s*(?:at\s+|\s+)?(?<file>(?:[A-Za-z]:\\|\/|\.\/|src\/)[^\s:]+?\.(?:go|rs|py|js|ts|tsx|jsx|mjs|cjs)):(?<line>\d+)(?::(?<col>\d+))?/;

/**
 * Strips ANSI escape sequences from terminal text.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text = '') {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

/**
 * Normalizes a file reference (including `file:///C:/...` URLs or relative paths)
 * into an absolute filesystem path if it exists locally.
 * @param {string} rawFile
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveLocalFile(rawFile, cwd = process.cwd()) {
  if (!rawFile) return null;
  let candidate = rawFile.trim();

  if (candidate.startsWith('node:') || candidate.startsWith('internal/')) {
    return null;
  }

  try {
    if (candidate.startsWith('file://')) {
      candidate = fileURLToPath(candidate);
    }
  } catch {
    candidate = candidate.replace(/^file:\/\/\/?/, '');
  }

  const attempts = [
    candidate,
    path.resolve(cwd, candidate),
  ];

  for (const attempt of attempts) {
    try {
      if (fs.existsSync(attempt) && fs.statSync(attempt).isFile()) {
        return attempt;
      }
    } catch {
      // ignore invalid path syntax
    }
  }
  return null;
}

/**
 * Reads surrounding source code lines from a local file around `targetLine`.
 * @param {string} filePath
 * @param {number} targetLine 1-indexed line number
 * @param {number} [contextRadius=6] Number of lines before and after
 */
export function extractSourceSnippet(filePath, targetLine, contextRadius = 6) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const allLines = content.split(/\r?\n/);
    const totalLines = allLines.length;
    if (targetLine < 1 || targetLine > totalLines) return null;

    const startLine = Math.max(1, targetLine - contextRadius);
    const endLine = Math.min(totalLines, targetLine + contextRadius);

    const lines = [];
    for (let ln = startLine; ln <= endLine; ln++) {
      lines.push({
        lineNumber: ln,
        isTarget: ln === targetLine,
        code: allLines[ln - 1],
      });
    }

    return {
      filePath,
      fileName: path.basename(filePath),
      targetLine,
      startLine,
      endLine,
      lines,
    };
  } catch {
    return null;
  }
}

/**
 * Parses a block of terminal or error text for stack frames and enriches user frames
 * with live source code snippets from disk.
 * @param {string} rawText
 * @param {string} [cwd]
 */
export function parseStackAndCode(rawText, cwd = process.cwd()) {
  const cleanText = stripAnsi(rawText);
  const lines = cleanText.split(/\r?\n/);
  const frames = [];

  for (const line of lines) {
    const match =
      V8_FRAME_REGEX.exec(line) ||
      PYTHON_FRAME_REGEX.exec(line) ||
      GO_RUST_FRAME_REGEX.exec(line);

    if (match && match.groups) {
      const rawFile = match.groups.file || match.groups.fileWithParen || match.groups.fileBare;
      const rawLine = match.groups.line || match.groups.lineBare;
      const rawCol = match.groups.col || match.groups.colBare;
      if (!rawFile || !rawLine) continue;

      const lineNum = parseInt(rawLine, 10);
      const colNum = rawCol ? parseInt(rawCol, 10) : null;
      const fnName = match.groups.fn || '<anonymous>';

      const resolvedPath = resolveLocalFile(rawFile, cwd);
      const isNodeModules =
        rawFile.includes('node_modules') ||
        (resolvedPath && resolvedPath.includes('node_modules'));
      const isInternal =
        rawFile.startsWith('node:') ||
        rawFile.includes('internal/') ||
        isNodeModules;

      let snippet = null;
      if (resolvedPath && !isInternal && frames.filter((f) => f.snippet).length < 3) {
        snippet = extractSourceSnippet(resolvedPath, lineNum, 6);
      }

      frames.push({
        functionName: fnName,
        rawFile,
        resolvedPath,
        lineNumber: lineNum,
        columnNumber: colNum,
        isUserCode: Boolean(resolvedPath && !isInternal),
        snippet,
      });
    }
  }

  const primaryUserFrame = frames.find((f) => f.isUserCode && f.snippet) || frames[0] || null;

  return {
    hasStack: frames.length > 0,
    frames,
    primaryUserFrame,
  };
}
