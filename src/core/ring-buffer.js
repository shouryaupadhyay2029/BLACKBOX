/**
 * BLACKBOX Core — High-Precision Multi-Plane Lock-Free Rolling Ring Buffer
 * Maintains a bounded, time-evicted (default 60s) and memory-capped (default 64MB)
 * circular telemetry window across Browser, Network, Terminal, and Git planes.
 */

const BOOT_WALL_MS = Date.now();
const BOOT_HR_NS = process.hrtime.bigint();

/**
 * Returns monotonic timestamp in microseconds since Unix epoch.
 */
export function nowMicros() {
  const deltaNs = process.hrtime.bigint() - BOOT_HR_NS;
  return BigInt(BOOT_WALL_MS) * 1000n + deltaNs / 1000n;
}

/**
 * Returns floating-point milliseconds with microsecond precision.
 */
export function nowPreciseMs() {
  const deltaNs = Number(process.hrtime.bigint() - BOOT_HR_NS);
  return BOOT_WALL_MS + deltaNs / 1e6;
}

export class BlackboxRingBuffer {
  /**
   * @param {object} options
   * @param {number} [options.windowMs=60000] Rolling retention window in ms (default 60s)
   * @param {number} [options.maxEvents=25000] Maximum event capacity
   * @param {number} [options.maxBytes=67108864] Maximum memory footprint in bytes (64MB)
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxEvents = options.maxEvents ?? 25_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;

    /** @type {Array<object>} */
    this.events = [];
    this.currentBytes = 0;
    this.seqCounter = 0;

    // Fast lookup maps for causal correlation
    /** @type {Map<string, Array<object>>} */
    this.traceIndex = new Map();
    /** @type {object|null} Latest full DOM snapshot so any frozen window has a base DOM */
    this.latestDomBaseline = null;
    /** @type {object|null} Latest browser storage state */
    this.latestStorageState = null;

    // Listeners for live streaming (Studio UI / SSE / WebSocket)
    /** @type {Set<Function>} */
    this.subscribers = new Set();
  }

  /**
   * Push a telemetry event into the rolling ring buffer.
   * @param {object} rawEvent
   * @returns {object} Normalized, timestamped event
   */
  push(rawEvent) {
    const serverTimeMs = nowPreciseMs();
    const seq = ++this.seqCounter;

    // If the event comes from the browser with a client timestamp, preserve both and align
    const timestampMs =
      typeof rawEvent.timestampMs === 'number' &&
      Math.abs(rawEvent.timestampMs - serverTimeMs) < 10_000
        ? rawEvent.timestampMs
        : serverTimeMs;

    const event = {
      id: rawEvent.id || `evt_${seq}_${Math.random().toString(36).slice(2, 7)}`,
      seq,
      timestampMs,
      serverTimeMs,
      isoTime: new Date(Math.floor(timestampMs)).toISOString(),
      plane: rawEvent.plane || 'SYSTEM', // 'BROWSER' | 'NETWORK' | 'TERMINAL' | 'GIT' | 'SYSTEM'
      type: rawEvent.type || 'UNKNOWN',
      severity: rawEvent.severity || 'info', // 'info' | 'warn' | 'error' | 'fatal'
      traceId: rawEvent.traceId || null,
      source: rawEvent.source || 'localhost',
      payload: rawEvent.payload || {},
    };

    // Estimate byte size without full serialization overhead
    const approxBytes = this._estimateSize(event);
    event._bytes = approxBytes;

    // Update sticky baselines so even if the initial page load happened >60s ago,
    // a newly frozen capsule always has the latest DOM tree and storage state!
    if (event.plane === 'BROWSER' && event.type === 'DOM_SNAPSHOT') {
      this.latestDomBaseline = event;
    } else if (event.plane === 'BROWSER' && event.type === 'STORAGE_SNAPSHOT') {
      this.latestStorageState = event;
    }

    this.events.push(event);
    this.currentBytes += approxBytes;

    if (event.traceId) {
      let bucket = this.traceIndex.get(event.traceId);
      if (!bucket) {
        bucket = [];
        this.traceIndex.set(event.traceId, bucket);
      }
      bucket.push(event);
    }

    this.evictExpired(serverTimeMs);

    // Notify live Flight Deck subscribers
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // Ignore subscriber error
      }
    }

    return event;
  }

  /**
   * Evicts events older than `windowMs` or exceeding `maxEvents` / `maxBytes`.
   * @param {number} [referenceMs]
   */
  evictExpired(referenceMs = nowPreciseMs()) {
    const cutoffMs = referenceMs - this.windowMs;
    let removeCount = 0;

    while (
      removeCount < this.events.length &&
      (this.events[removeCount].serverTimeMs < cutoffMs ||
        this.events.length - removeCount > this.maxEvents ||
        this.currentBytes > this.maxBytes)
    ) {
      const evicted = this.events[removeCount];
      this.currentBytes = Math.max(0, this.currentBytes - (evicted._bytes || 256));
      if (evicted.traceId) {
        const bucket = this.traceIndex.get(evicted.traceId);
        if (bucket) {
          const idx = bucket.indexOf(evicted);
          if (idx !== -1) bucket.splice(idx, 1);
          if (bucket.length === 0) this.traceIndex.delete(evicted.traceId);
        }
      }
      removeCount++;
    }

    if (removeCount > 0) {
      this.events.splice(0, removeCount);
    }
  }

  /**
   * Freezes and extracts a coherent time-slice snapshot of the rolling buffer.
   * Ensures a baseline DOM snapshot is always included at the start of the slice.
   * @param {object} [opts]
   * @param {number} [opts.durationMs] Optional override window (defaults to this.windowMs)
   * @returns {object} Frozen buffer slice
   */
  freezeSlice(opts = {}) {
    const endTimeMs = nowPreciseMs();
    const durationMs = opts.durationMs ?? this.windowMs;
    const startTimeMs = endTimeMs - durationMs;

    this.evictExpired(endTimeMs);

    const slicedEvents = this.events
      .filter((e) => e.serverTimeMs >= startTimeMs && e.serverTimeMs <= endTimeMs + 1000)
      .map((e) => {
        const { _bytes, ...clean } = e;
        return clean;
      });

    // Ensure the slice contains at least one DOM_SNAPSHOT so visual replay always works
    const hasDomSnapshot = slicedEvents.some(
      (e) => e.plane === 'BROWSER' && e.type === 'DOM_SNAPSHOT'
    );
    if (!hasDomSnapshot && this.latestDomBaseline) {
      const { _bytes, ...cleanDom } = this.latestDomBaseline;
      slicedEvents.unshift({
        ...cleanDom,
        note: 'Injected sticky baseline DOM snapshot',
      });
    }

    // Ensure storage state is present
    const hasStorage = slicedEvents.some(
      (e) => e.plane === 'BROWSER' && e.type === 'STORAGE_SNAPSHOT'
    );
    if (!hasStorage && this.latestStorageState) {
      const { _bytes, ...cleanStorage } = this.latestStorageState;
      slicedEvents.unshift({
        ...cleanStorage,
        note: 'Injected sticky storage snapshot',
      });
    }

    // Sort deterministically by timestampMs, then sequence number
    slicedEvents.sort((a, b) => a.timestampMs - b.timestampMs || a.seq - b.seq);

    const actualStartMs =
      slicedEvents.length > 0 ? slicedEvents[0].timestampMs : startTimeMs;
    const actualEndMs =
      slicedEvents.length > 0
        ? slicedEvents[slicedEvents.length - 1].timestampMs
        : endTimeMs;

    return {
      startTimeMs: actualStartMs,
      endTimeMs: actualEndMs,
      durationMs: Math.max(1, actualEndMs - actualStartMs),
      totalEvents: slicedEvents.length,
      bufferBytes: this.currentBytes,
      planeCounts: this._countByPlane(slicedEvents),
      events: slicedEvents,
    };
  }

  /**
   * Returns all events matching a specific `traceId`.
   * @param {string} traceId
   */
  getEventsByTraceId(traceId) {
    return (this.traceIndex.get(traceId) || []).map(({ _bytes, ...clean }) => clean);
  }

  /**
   * Subscribe to real-time incoming telemetry events.
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Returns current buffer statistics.
   */
  getStats() {
    this.evictExpired();
    return {
      activeEvents: this.events.length,
      memoryBytes: this.currentBytes,
      memoryMB: +(this.currentBytes / (1024 * 1024)).toFixed(2),
      windowMs: this.windowMs,
      activeTraces: this.traceIndex.size,
      hasDomBaseline: Boolean(this.latestDomBaseline),
      planeCounts: this._countByPlane(this.events),
      oldestEventMs: this.events[0]?.timestampMs || null,
      newestEventMs: this.events[this.events.length - 1]?.timestampMs || null,
    };
  }

  clear() {
    this.events = [];
    this.currentBytes = 0;
    this.traceIndex.clear();
  }

  _countByPlane(events) {
    const counts = { BROWSER: 0, NETWORK: 0, TERMINAL: 0, GIT: 0, SYSTEM: 0 };
    for (const e of events) {
      counts[e.plane] = (counts[e.plane] || 0) + 1;
    }
    return counts;
  }

  _estimateSize(event) {
    try {
      const str = JSON.stringify(event.payload);
      return 180 + (str ? str.length * 2 : 0);
    } catch {
      return 512;
    }
  }
}

// Backward-compatibility alias
export const KalaRingBuffer = BlackboxRingBuffer;
