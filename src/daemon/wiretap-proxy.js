/**
 * KALA Daemon — Zero-Config Localhost HTTP Wiretap & Reverse Proxy
 * Can optionally sit in front of any target localhost port, automatically:
 * 1. Injecting & propagating `X-Kala-Trace-Id` headers to the backend
 * 2. Capturing full request/response bodies & timings into the Ring Buffer
 * 3. Auto-injecting the KALA Browser Agent script into HTML responses
 */

import http from 'node:http';
import { nowPreciseMs } from '../core/ring-buffer.js';

export class WiretapProxy {
  /**
   * @param {object} options
   * @param {number} options.listenPort Port for the wiretap proxy to listen on
   * @param {string} options.targetOrigin Target backend origin, e.g. 'http://127.0.0.1:4500'
   * @param {number} [options.kalaPort=9876] KALA daemon port for script injection
   * @param {import('../core/ring-buffer.js').KalaRingBuffer} options.ringBuffer
   * @param {Function} [options.onHttp5xx] Callback when a 5xx response occurs
   */
  constructor(options = {}) {
    this.listenPort = options.listenPort;
    this.targetOrigin = options.targetOrigin;
    this.kalaPort = options.kalaPort || 9876;
    this.ringBuffer = options.ringBuffer;
    this.onHttp5xx = options.onHttp5xx || null;
    this.server = null;
  }

  async start() {
    const targetUrl = new URL(this.targetOrigin);

    this.server = http.createServer((clientReq, clientRes) => {
      const startTimeMs = nowPreciseMs();
      const traceId =
        clientReq.headers['x-kala-trace-id'] ||
        `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

      const reqChunks = [];
      clientReq.on('data', (c) => {
        if (reqChunks.length < 30) reqChunks.push(c);
      });

      const proxyHeaders = {
        ...clientReq.headers,
        host: targetUrl.host,
        'x-kala-trace-id': traceId,
        'accept-encoding': 'identity', // uncompressed so we can inspect/inject HTML cleanly
      };

      const proxyReq = http.request(
        {
          hostname: targetUrl.hostname,
          port: targetUrl.port || 80,
          path: clientReq.url,
          method: clientReq.method,
          headers: proxyHeaders,
        },
        (proxyRes) => {
          const resChunks = [];
          proxyRes.on('data', (c) => resChunks.push(c));

          proxyRes.on('end', () => {
            const endTimeMs = nowPreciseMs();
            const durationMs = +(endTimeMs - startTimeMs).toFixed(2);
            const fullResBuffer = Buffer.concat(resChunks);
            const contentType = String(proxyRes.headers['content-type'] || '');

            // Record HTTP_TRACE in Ring Buffer (unless it's a static asset noise)
            const isStaticAsset = /\.(png|jpg|jpeg|gif|svg|ico|woff2?|ttf|css)(\?|$)/i.test(
              clientReq.url || ''
            );

            if (!isStaticAsset) {
              const reqBodyStr = Buffer.concat(reqChunks).toString('utf8').slice(0, 4096);
              const resBodyStr =
                contentType.includes('json') || contentType.includes('text/plain')
                  ? fullResBuffer.toString('utf8').slice(0, 8192)
                  : `[${contentType || 'binary'} ${fullResBuffer.length} bytes]`;

              const status = proxyRes.statusCode || 200;
              const evt = this.ringBuffer.push({
                timestampMs: endTimeMs,
                plane: 'NETWORK',
                type: 'HTTP_TRACE',
                severity: status >= 500 ? 'fatal' : status >= 400 ? 'error' : 'info',
                traceId,
                source: 'wiretap-proxy',
                payload: {
                  method: clientReq.method,
                  url: clientReq.url,
                  status,
                  startTimeMs,
                  durationMs,
                  requestHeaders: sanitizeHeaders(clientReq.headers),
                  responseHeaders: sanitizeHeaders(proxyRes.headers),
                  requestBody: tryParseJson(reqBodyStr),
                  responseBody: tryParseJson(resBodyStr),
                },
              });

              if (status >= 500 && this.onHttp5xx) {
                this.onHttp5xx({
                  reason: `HTTP_${status}_${clientReq.method}`,
                  event: evt,
                });
              }
            }

            // If HTML response, automatically inject the KALA Browser Agent script if not present
            let outBuffer = fullResBuffer;
            if (contentType.includes('text/html')) {
              const htmlStr = fullResBuffer.toString('utf8');
              if (!htmlStr.includes('/sdk/browser-agent.js')) {
                const scriptTag = `<script src="http://localhost:${this.kalaPort}/sdk/browser-agent.js" data-kala-endpoint="http://localhost:${this.kalaPort}"></script>`;
                const modifiedHtml = htmlStr.includes('</head>')
                  ? htmlStr.replace('</head>', `${scriptTag}</head>`)
                  : `${scriptTag}${htmlStr}`;
                outBuffer = Buffer.from(modifiedHtml, 'utf8');
              }
            }

            const outHeaders = {
              ...proxyRes.headers,
              'content-length': String(outBuffer.length),
              'x-kala-trace-id': traceId,
            };
            clientRes.writeHead(proxyRes.statusCode || 200, outHeaders);
            clientRes.end(outBuffer);
          });
        }
      );

      proxyReq.on('error', (err) => {
        const endTimeMs = nowPreciseMs();
        this.ringBuffer.push({
          timestampMs: endTimeMs,
          plane: 'NETWORK',
          type: 'HTTP_TRACE',
          severity: 'error',
          traceId,
          source: 'wiretap-proxy',
          payload: {
            method: clientReq.method,
            url: clientReq.url,
            status: 502,
            startTimeMs,
            durationMs: +(endTimeMs - startTimeMs).toFixed(2),
            error: err.message,
          },
        });

        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(
          JSON.stringify({
            error: 'KALA Wiretap Proxy Error: Target backend unreachable',
            target: this.targetOrigin,
            detail: err.message,
          })
        );
      });

      clientReq.on('data', (chunk) => proxyReq.write(chunk));
      clientReq.on('end', () => proxyReq.end());
    });

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);
      this.server.listen(this.listenPort, '127.0.0.1', () => {
        resolve(this.listenPort);
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }
}

function sanitizeHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/authorization|cookie|secret|token/i.test(k)) {
      out[k] = '***REDACTED***';
    } else {
      out[k] = v;
    }
  }
  return out;
}

function tryParseJson(str) {
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
