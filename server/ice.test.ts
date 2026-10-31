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
  // (a plain turn: address goes out by UDP and by TCP: some networks only let TCP through)
  expect(iceServers({ turnUrl: "turn:turn.exemplo.com:3478", turnSecret: "s3cret", user: "42", now: 1_700_000_000_000 })).toEqual([
    { urls: STUN },
    { urls: ["turn:turn.exemplo.com:3478?transport=udp", "turn:turn.exemplo.com:3478?transport=tcp"], username, credential },
  ]);
});

test("a TURN address that says its transport, or turns:, goes out as it is", () => {
  for (const url of ["turn:turn.exemplo.com:3478?transport=tcp", "turns:turn.exemplo.com:5349"])
    expect(iceServers({ turnUrl: url, turnSecret: "s3cret", user: "42", now: 0 })[1]!.urls).toBe(url);
});
