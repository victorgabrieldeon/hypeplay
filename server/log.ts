/**
 * The server's log: one JSON object per line ({"time","level","msg",…fields}), warn and error on stderr, the rest on
 * stdout; and the same out by OTLP when the telemetry is on (server/otlp.ts, index.ts' useTelemetry). LOG_LEVEL
 * (debug, info, warn, error; info by default) hides what's below it. An Error in the fields goes as its name, message
 * and stack.
 */
import type { Level, Telemetry } from "./otlp";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let min = ORDER[(process.env.LOG_LEVEL ?? "").toLowerCase() as Level] ?? ORDER.info;
let telemetry: Telemetry | null = null;
let out: (level: Level, line: string) => void = (level, line) => void (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);

const plain = (v: unknown): unknown => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v);

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < min) return;
  const rec: Record<string, unknown> = { time: new Date().toISOString(), level, msg };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && !(k in rec)) rec[k] = plain(v);
  let line: string;
  try {
    line = JSON.stringify(rec);
  } catch {
    line = JSON.stringify({ time: rec.time, level, msg, fields: "(não serializável)" });
  }
  out(level, line);
  if (telemetry?.enabled) {
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v instanceof Error) {
        attrs["exception.type"] = v.name;
        attrs["exception.message"] = v.message;
        attrs["exception.stacktrace"] = v.stack;
      } else attrs[k] = v;
    }
    telemetry.log(level, msg, attrs);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

/** The log also goes out by OTLP (index.ts). */
export function useTelemetry(t: Telemetry) {
  telemetry = t;
}

/** Tests: where the lines go, and the level. Returns how to put it back. */
export function captureLog(level: Level = "debug"): { lines: Record<string, unknown>[]; restore(): void } {
  const lines: Record<string, unknown>[] = [];
  const was = { out, min };
  out = (_, line) => void lines.push(JSON.parse(line));
  min = ORDER[level];
  return {
    lines,
    restore() {
      out = was.out;
      min = was.min;
    },
  };
}
