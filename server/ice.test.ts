import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { iceServers, STUN } from "./ice";

test("stun only without TURN settings", () => {
  expect(iceServers({ user: "42", now: 1_700_000_000_000 })).toEqual([{ urls: STUN }]);
  expect(iceServers({ turnUrl: "turn:x:3478", user: "42", now: 1_700_000_000_000 })).toEqual([{ urls: STUN }]);
});

test("turn with a 12 h coturn REST credential", () => {
  const username = `${1_700_000_000 + 43_200}:42`;
  const credential = createHmac("sha1", "s3cret").update(username).digest("base64");
  expect(iceServers({ turnUrl: "turn:turn.exemplo.com:3478", turnSecret: "s3cret", user: "42", now: 1_700_000_000_000 })).toEqual([
    { urls: STUN },
    { urls: "turn:turn.exemplo.com:3478", username, credential },
  ]);
});
