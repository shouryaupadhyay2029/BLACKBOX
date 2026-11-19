/**
 * BLACKBOX Core — Zero-Dependency Source Map v3 (VLQ) Resolver
 * Fetches dev-server transformed modules (Vite, Next.js, Webpack, Parcel) on localhost,
 * extracts inline base64 or external `.map` Source Maps, and translates compiled browser
 * stack line/column coordinates back to exact original TypeScript/TSX/JSX source lines.
 */

const VLQ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < VLQ_CHARS.length; i++) {
  VLQ_LOOKUP[VLQ_CHARS.charCodeAt(i)] = i;
}

// Small bounded cache so repeated errors in the same file don't refetch Vite
const sourceMapCache = new Map();

function decodeVlqSegment(str, index) {
  let result = 0;
  let shift = 0;
  let continuation = true;

  while (continuation && index < str.length) {
    const code = str.charCodeAt(index++);
    const digit = code < 128 ? VLQ_LOOKUP[code] : -1;
    if (digit === -1) break;
    continuation = (digit & 32) !== 0;
    result += (digit & 31) << shift;
    shift += 5;
  }

  const isNeg = (result & 1) === 1;
  const value = result >> 1;
  return [isNeg ? -value : value, index];
}

/**
 * Resolves a 1-indexed (compiledLine, compiledCol) in a Source Map v3 object
 * to a 1-indexed { originalLine, originalColumn, originalSource }.
 * @param {object} map Parsed Source Map v3 JSON
 * @param {number} targetLine 1-indexed generated line number
 * @param {number} [targetCol=0] 1-indexed generated column number
 */
export function lookupSourceMapPosition(map, targetLine, targetCol = 1) {
  if (!map || typeof map.mappings !== 'string' || targetLine < 1) return null;

  const lines = map.mappings.split(';');
  if (targetLine > lines.length) return null;

  let sourceIndex = 0;
  let origLine = 0;
  let origCol = 0;
  let nameIndex = 0;

  let bestMatch = null;
  const wantedCol0 = Math.max(0, (targetCol || 1) - 1);

  for (let genLineIdx = 0; genLineIdx < targetLine; genLineIdx++) {
    const lineStr = lines[genLineIdx];
    let genCol = 0;
    let i = 0;

    while (i < lineStr.length) {
      if (lineStr[i] === ',') {
        i++;
        continue;
      }

      let val;
      [val, i] = decodeVlqSegment(lineStr, i);
      genCol += val;

      if (i < lineStr.length && lineStr[i] !== ',') {
        [val, i] = decodeVlqSegment(lineStr, i);
        sourceIndex += val;

        [val, i] = decodeVlqSegment(lineStr, i);
        origLine += val;

        [val, i] = decodeVlqSegment(lineStr, i);
        origCol += val;

        if (i < lineStr.length && lineStr[i] !== ',') {
          [val, i] = decodeVlqSegment(lineStr, i);
          nameIndex += val;
        }

        if (genLineIdx === targetLine - 1) {
          const candidate = {
            originalLine: origLine + 1,
            originalColumn: origCol + 1,
            originalSource: Array.isArray(map.sources) ? map.sources[sourceIndex] || null : null,
            originalName: Array.isArray(map.names) ? map.names[nameIndex] || null : null,
            genCol,
          };

          if (!bestMatch) {
            bestMatch = candidate;
          } else if (genCol <= wantedCol0 && genCol >= bestMatch.genCol) {
            bestMatch = candidate;
          } else if (
            bestMatch.genCol > wantedCol0 &&
            Math.abs(genCol - wantedCol0) < Math.abs(bestMatch.genCol - wantedCol0)
          ) {
            bestMatch = candidate;
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Fetches a localhost dev-server JS/TSX response and extracts its inline or linked Source Map v3.
 * @param {string} moduleUrl e.g. http://localhost:5173/src/app/console/TopBar.tsx?t=123
 */
export async function fetchDevServerSourceMap(moduleUrl) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(moduleUrl)) {
    return null;
  }

  const cached = sourceMapCache.get(moduleUrl);
  if (cached && Date.now() - cached.ts < 8000) {
    return cached.map;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const res = await fetch(moduleUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const code = await res.text();

    let map = null;
    // 1. Inline base64 source map (Vite / esbuild / Babel)
    const inlineMatch = /\/\/[#@]\s*sourceMappingURL=data:application\/json(?:;charset=[^;]+)?;base64,([A-Za-z0-9+/=]+)/.exec(
      code
    );
    if (inlineMatch && inlineMatch[1]) {
      const jsonStr = Buffer.from(inlineMatch[1], 'base64').toString('utf8');
      map = JSON.parse(jsonStr);
    } else {
      // 2. External .map URL fallback
      const extMatch = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+\.map(?:\?[^\s'"]*)?)/.exec(code);
      if (extMatch && extMatch[1]) {
        const mapUrl = new URL(extMatch[1], moduleUrl).toString();
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 800);
        const mapRes = await fetch(mapUrl, { signal: c2.signal });
        clearTimeout(t2);
        if (mapRes.ok) {
          map = await mapRes.json();
        }
      }
    }

    if (sourceMapCache.size > 40) {
      const oldestKey = sourceMapCache.keys().next().value;
      sourceMapCache.delete(oldestKey);
    }
    sourceMapCache.set(moduleUrl, { ts: Date.now(), map });
    return map;
  } catch {
    return null;
  }
}

/**
 * Rewrites localhost URL line:col frames inside a browser stack trace string using live Source Maps.
 * Returns the original stack if no localhost source maps are found.
 * @param {string} stackText
 * @returns {Promise<string>}
 */
export async function resolveBrowserStackWithSourceMaps(stackText = '') {
  if (!stackText || !/https?:\/\/(localhost|127\.0\.0\.1)/i.test(stackText)) {
    return stackText;
  }

  const lines = String(stackText).split(/\r?\n/);
  const urlFrameRe = /(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s)]+?):(\d+)(?::(\d+))?/g;
  const resolvedLines = [];

  for (const line of lines) {
    let updated = line;
    const matches = [...line.matchAll(urlFrameRe)];
    for (const m of matches) {
      const [fullMatch, modUrl, lineStr, colStr] = m;
      if (modUrl.includes('.vite/deps') || modUrl.includes('node_modules') || modUrl.includes('browser-agent.js')) {
        continue;
      }
      const map = await fetchDevServerSourceMap(modUrl);
      if (!map) continue;
      const pos = lookupSourceMapPosition(map, parseInt(lineStr, 10), colStr ? parseInt(colStr, 10) : 1);
      if (pos && pos.originalLine > 0) {
        const replacement = `${modUrl}:${pos.originalLine}:${pos.originalColumn || 1}`;
        updated = updated.replace(fullMatch, replacement);
      }
    }
    resolvedLines.push(updated);
  }

  return resolvedLines.join('\n');
}
