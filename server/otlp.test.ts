import { expect, test } from "bun:test";
import { createTelemetry, parsePairs, telemetryFromEnv } from "./otlp";

function collector() {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 200 });
  };
  return { sent, fetch };
}

test("without OTEL_EXPORTER_OTLP_ENDPOINT nothing is kept or sent", async () => {
  const t = telemetryFromEnv("x", {});
  expect(t.enabled).toBe(false);
  t.counter("a").add(1);
  t.log("info", "hi");
  await t.flush();
  expect(telemetryFromEnv("x", { OTEL_EXPORTER_OTLP_ENDPOINT: "  " }).enabled).toBe(false);
});

test("pairs: k=v lists, URL-decoded, the odd ones skipped", () => {
  expect(parsePairs("signoz-ingestion-key=abc%3D%3D, b = 2,bad,=x")).toEqual({ "signoz-ingestion-key": "abc==", b: "2" });
  expect(parsePairs(undefined)).toEqual({});
});

test("metrics go out as OTLP JSON: cumulative sums, histograms with their buckets, gauges read at export", async () => {
  const c = collector();
  let t = 1_700_000_000_000;
  const tel = createTelemetry({ endpoint: "http://otel:4318/", service: "hypeplay", headers: { k: "v" }, resource: { env: "test" }, fetch: c.fetch, now: () => t, timers: false });
  const bytes = tel.counter("disc.bytes", { unit: "By" });
  bytes.add(100, { game: "ps2/a" });
  bytes.add(50, { game: "ps2/a" });
  bytes.add(7, { game: "ps2/b" });
  const h = tel.histogram("games.duration", { unit: "ms", bounds: [10, 100] });
  for (const v of [5, 10, 50, 500]) h.record(v);
  let people = 3;
  tel.gauge("people.online", {}, () => people);
  tel.gauge("rooms", {}, () => [[2, { kind: "ps2" }]]);
  t += 5000;
  await tel.flush();
  expect(c.sent).toHaveLength(1);
  const [{ url, headers, body }] = c.sent;
  expect(url).toBe("http://otel:4318/v1/metrics");
  expect(headers).toMatchObject({ "Content-Type": "application/json", k: "v" });
  const rm = body.resourceMetrics[0];
  expect(rm.resource.attributes).toEqual([
    { key: "service.name", value: { stringValue: "hypeplay" } },
    { key: "env", value: { stringValue: "test" } },
  ]);
  const metrics = Object.fromEntries(rm.scopeMetrics[0].metrics.map((m: any) => [m.name, m]));
  const sum = metrics["disc.bytes"].sum;
  expect(sum.aggregationTemporality).toBe(2);
  expect(sum.isMonotonic).toBe(true);
  expect(sum.dataPoints.map((p: any) => [p.attributes[0].value.stringValue, p.asDouble])).toEqual([
    ["ps2/a", 150],
    ["ps2/b", 7],
  ]);
  expect(sum.dataPoints[0].startTimeUnixNano).toBe("1700000000000000000");
  expect(sum.dataPoints[0].timeUnixNano).toBe("1700000005000000000");
  const hp = metrics["games.duration"].histogram.dataPoints[0];
  expect(hp).toMatchObject({ count: "4", sum: 565, min: 5, max: 500, explicitBounds: [10, 100], bucketCounts: ["2", "1", "1"] });
  expect(metrics["people.online"].gauge.dataPoints[0].asDouble).toBe(3);
  expect(metrics["rooms"].gauge.dataPoints[0].attributes).toEqual([{ key: "kind", value: { stringValue: "ps2" } }]);
  // (cumulative: the next export carries the totals, and the gauge as it is then)
  people = 1;
  bytes.add(1, { game: "ps2/b" });
  await tel.flush();
  const again = Object.fromEntries(c.sent[1]!.body.resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => [m.name, m]));
  expect(again["disc.bytes"].sum.dataPoints[1].asDouble).toBe(8);
  expect(again["people.online"].gauge.dataPoints[0].asDouble).toBe(1);
});

test("the same attributes in another order are the same series", async () => {
  const c = collector();
  const tel = createTelemetry({ endpoint: "http://o", service: "s", fetch: c.fetch, timers: false });
  const n = tel.counter("n");
  n.add(1, { a: "1", b: "2" });
  n.add(1, { b: "2", a: "1" });
  await tel.flush();
  expect(c.sent[0]!.body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints).toHaveLength(1);
});

test("logs go out in batches to /v1/logs with their severity and attributes", async () => {
  const c = collector();
  const tel = createTelemetry({ endpoint: "http://o", service: "s", fetch: c.fetch, now: () => 1000, timers: false });
  tel.log("warn", "slow", { game: "ps2/a", ms: 12.5, ok: false, n: 3 });
  tel.log("error", "boom");
  await tel.flush();
  expect(c.sent.map((s) => s.url)).toEqual(["http://o/v1/logs"]);
  const records = c.sent[0]!.body.resourceLogs[0].scopeLogs[0].logRecords;
  expect(records[0]).toMatchObject({ severityNumber: 13, severityText: "WARN", body: { stringValue: "slow" }, timeUnixNano: "1000000000" });
  expect(records[0].attributes).toEqual([
    { key: "game", value: { stringValue: "ps2/a" } },
    { key: "ms", value: { doubleValue: 12.5 } },
    { key: "ok", value: { boolValue: false } },
    { key: "n", value: { intValue: "3" } },
  ]);
  expect(records[1].severityNumber).toBe(17);
  // (sent once: nothing pending after)
  await tel.flush();
  expect(c.sent).toHaveLength(1);
});

test("a collector that fails is said once, and the server goes on", async () => {
  const errors: string[] = [];
  const was = console.error;
  console.error = (s: string) => void errors.push(s);
  try {
    let calls = 0;
    const tel = createTelemetry({
      endpoint: "http://o",
      service: "s",
      fetch: async () => {
        calls++;
        throw new Error("refused");
      },
      timers: false,
    });
    tel.counter("n").add(1);
    await tel.flush();
    await tel.flush();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ level: "warn", msg: "otlp export failed" });
  } finally {
    console.error = was;
  }
});
