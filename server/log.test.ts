import { afterEach, expect, test } from "bun:test";
import { captureLog, log } from "./log";

let cap = captureLog();
afterEach(() => {
  cap.restore();
  cap = captureLog();
});

test("one JSON object per line, with the fields", () => {
  log.info("listening", { port: 3003, skip: undefined });
  expect(cap.lines).toHaveLength(1);
  const [line] = cap.lines;
  expect(line).toMatchObject({ level: "info", msg: "listening", port: 3003 });
  expect(typeof line!.time).toBe("string");
  expect("skip" in line!).toBe(false);
});

test("an Error goes as its name, message and stack; a field can't take time, level or msg", () => {
  log.error("failed", { err: new TypeError("bad"), msg: "other" });
  const [line] = cap.lines as any[];
  expect(line.msg).toBe("failed");
  expect(line.err).toMatchObject({ name: "TypeError", message: "bad" });
  expect(line.err.stack).toContain("TypeError");
});

test("below the level, nothing", () => {
  cap.restore();
  cap = captureLog("warn");
  log.info("quiet");
  log.warn("loud");
  expect(cap.lines.map((l) => l.msg)).toEqual(["loud"]);
});
