/**
 * Metrics and logs out by OpenTelemetry (OTLP over HTTP, JSON), only when OTEL_EXPORTER_OTLP_ENDPOINT is set: without
 * it, everything here does nothing (no timer, no memory kept). No dependencies, so the ps2-builder's image (no
 * node_modules) uses it too.
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT    the collector's base address (SigNoz: http://<host>:4318); /v1/metrics, /v1/logs
 *   OTEL_EXPORTER_OTLP_HEADERS     k=v,k2=v2 sent with each export (SigNoz Cloud: signoz-ingestion-key=<key>)
 *   OTEL_SERVICE_NAME              the service's name (each process has its own default)
 *   OTEL_RESOURCE_ATTRIBUTES       k=v,k2=v2 more about the service (deployment.environment=prod, …)
 *   OTEL_METRIC_EXPORT_INTERVAL    ms between metric exports (60000)
 *
 * Counters and histograms are cumulative since the process started; gauges are read at each export.
 */

export type Attrs = Record<string, string | number | boolean>;
export type Level = "debug" | "info" | "warn" | "error";

export interface Counter {
  add(n: number, attrs?: Attrs): void;
}
export interface Histogram {
  record(value: number, attrs?: Attrs): void;
}
export interface Telemetry {
  readonly enabled: boolean;
  counter(name: string, o?: { description?: string; unit?: string }): Counter;
  histogram(name: string, o: { description?: string; unit?: string; bounds: number[] }): Histogram;
  /** Read at each export: one value, or one per set of attributes. */
  gauge(name: string, o: { description?: string; unit?: string }, read: () => number | [number, Attrs][]): void;
  log(level: Level, msg: string, attrs?: Record<string, unknown>): void;
  /** Sends what's pending now. */
  flush(): Promise<void>;
  /** The last flush, and the timers stop. */
  shutdown(): Promise<void>;
}

const noop: Telemetry = {
  enabled: false,
  counter: () => ({ add() {} }),
  histogram: () => ({ record() {} }),
  gauge() {},
  log() {},
  flush: async () => {},
  shutdown: async () => {},
};

/** "k=v,k2=v2" (values URL-encoded, as the spec says). */
export function parsePairs(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const k = part.slice(0, at).trim();
    const raw = part.slice(at + 1).trim();
    let v = raw;
    try {
      v = decodeURIComponent(raw);
    } catch {
      // (not encoded after all: as it is)
    }
    if (k) out[k] = v;
  }
  return out;
}

type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
function value(v: unknown): AnyValue {
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isSafeInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Error) return { stringValue: `${v.name}: ${v.message}` };
  return { stringValue: JSON.stringify(v) ?? String(v) };
}
export const attributes = (a: Record<string, unknown> = {}) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => ({ key, value: value(v) }));

/** One key per set of attributes, the same whatever their order. */
const keyOf = (a: Attrs = {}) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

const SEVERITY: Record<Level, number> = { debug: 5, info: 9, warn: 13, error: 17 };
/** Logs waiting to go out at most; past it the oldest go (the collector away for long). */
const MAX_LOGS = 2000;
const LOG_EVERY_MS = 5000;

export interface TelemetryOptions {
  endpoint: string;
  service: string;
  headers?: Record<string, string>;
  resource?: Record<string, string>;
  intervalMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  /** Starts the export timers (the default); tests call flush() themselves. */
  timers?: boolean;
}

export function createTelemetry(o: TelemetryOptions): Telemetry {
  const base = o.endpoint.replace(/\/+$/, "");
  const now = o.now ?? (() => Date.now());
  const send = o.fetch ?? ((url, init) => fetch(url, init));
  const started = now();
  const resource = { attributes: attributes({ "service.name": o.service, ...o.resource }) };
  const scope = { name: "hypeplay" };

  type Meta = { name: string; description?: string; unit?: string };
  const sums = new Map<string, Meta & { points: Map<string, { attrs: Attrs; value: number }> }>();
  const hists = new Map<string, Meta & { bounds: number[]; points: Map<string, { attrs: Attrs; counts: number[]; count: number; sum: number; min: number; max: number }> }>();
  const gauges: (Meta & { read: () => number | [number, Attrs][] })[] = [];
  let logs: object[] = [];

  let failing = false;
  async function post(path: string, body: object) {
    try {
      const r = await send(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...o.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      failing = false;
    } catch (err) {
      // (once until it works again: console, not the log, which would come back here)
      if (!failing) console.error(JSON.stringify({ time: new Date(now()).toISOString(), level: "warn", msg: "otlp export failed", path, error: String(err) }));
      failing = true;
    }
  }

  function metricsBody() {
    const t = nanos(now());
    const start = nanos(started);
    const metrics: object[] = [];
    for (const m of sums.values()) {
      if (!m.points.size) continue;
      metrics.push({
        name: m.name,
        description: m.description,
        unit: m.unit,
        sum: {
          aggregationTemporality: 2,
          isMonotonic: true,
          dataPoints: [...m.points.values()].map((p) => ({ attributes: attributes(p.attrs), startTimeUnixNano: start, timeUnixNano: t, asDouble: p.value })),
        },
      });
    }
    for (const m of hists.values()) {
      if (!m.points.size) continue;
      metrics.push({
        name: m.name,
        description: m.description,
        unit: m.unit,
        histogram: {
          aggregationTemporality: 2,
          dataPoints: [...m.points.values()].map((p) => ({
            attributes: attributes(p.attrs),
            startTimeUnixNano: start,
            timeUnixNano: t,
            count: String(p.count),
            sum: p.sum,
            min: p.min,
            max: p.max,
            explicitBounds: m.bounds,
            bucketCounts: p.counts.map(String),
          })),
        },
      });
    }
    for (const g of gauges) {
      let read: [number, Attrs][];
      try {
        const v = g.read();
        read = typeof v === "number" ? [[v, {}]] : v;
      } catch {
        continue;
      }
      metrics.push({
        name: g.name,
        description: g.description,
        unit: g.unit,
        gauge: { dataPoints: read.map(([v, a]) => ({ attributes: attributes(a), timeUnixNano: t, asDouble: v })) },
      });
    }
    return metrics.length ? { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics }] }] } : null;
  }

  async function flushLogs() {
    if (!logs.length) return;
    const logRecords = logs;
    logs = [];
    await post("/v1/logs", { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }] });
  }
  async function flushMetrics() {
    const body = metricsBody();
    if (body) await post("/v1/metrics", body);
  }

  const timers: ReturnType<typeof setInterval>[] = [];
  if (o.timers !== false) {
    timers.push(setInterval(() => void flushMetrics(), o.intervalMs ?? 60_000), setInterval(() => void flushLogs(), LOG_EVERY_MS));
    for (const t of timers) t.unref?.();
  }

  return {
    enabled: true,
    counter(name, meta = {}) {
      const m = sums.get(name) ?? { name, ...meta, points: new Map() };
      sums.set(name, m);
      return {
        add(n, attrs = {}) {
          if (!(n >= 0)) return;
          const k = keyOf(attrs);
          const p = m.points.get(k) ?? { attrs, value: 0 };
          p.value += n;
          m.points.set(k, p);
        },
      };
    },
    histogram(name, meta) {
      const m = hists.get(name) ?? { name, ...meta, points: new Map() };
      hists.set(name, m);
      return {
        record(v, attrs = {}) {
          if (!Number.isFinite(v)) return;
          const k = keyOf(attrs);
          let p = m.points.get(k);
          if (!p) m.points.set(k, (p = { attrs, counts: new Array(m.bounds.length + 1).fill(0), count: 0, sum: 0, min: v, max: v }));
          let i = m.bounds.findIndex((b) => v <= b);
          if (i < 0) i = m.bounds.length;
          p.counts[i]!++;
          p.count++;
          p.sum += v;
          p.min = Math.min(p.min, v);
          p.max = Math.max(p.max, v);
        },
      };
    },
    gauge(name, meta, read) {
      gauges.push({ name, ...meta, read });
    },
    log(level, msg, attrs) {
      const t = nanos(now());
      logs.push({ timeUnixNano: t, observedTimeUnixNano: t, severityNumber: SEVERITY[level], severityText: level.toUpperCase(), body: { stringValue: msg }, attributes: attributes(attrs) });
      if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
    },
    async flush() {
      await Promise.all([flushMetrics(), flushLogs()]);
    },
    async shutdown() {
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      await Promise.all([flushMetrics(), flushLogs()]);
    },
  };
}

/** From the OTEL_* environment; without OTEL_EXPORTER_OTLP_ENDPOINT, one that does nothing. */
export function telemetryFromEnv(service: string, env: Record<string, string | undefined> = process.env): Telemetry {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint) return noop;
  const interval = Number(env.OTEL_METRIC_EXPORT_INTERVAL);
  return createTelemetry({
    endpoint,
    service: env.OTEL_SERVICE_NAME?.trim() || service,
    headers: parsePairs(env.OTEL_EXPORTER_OTLP_HEADERS),
    resource: parsePairs(env.OTEL_RESOURCE_ATTRIBUTES),
    intervalMs: interval > 0 ? interval : 60_000,
  });
}

/** Seconds a build takes: from a minute to a few hours (ps2-builder/builder.ts). */
export const BUILD_SECONDS = [30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800];
