import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveBeat, estimate, pillLabel, stopFromStore, type CacheStatus } from "./status.ts";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 10, 6, 0, 0);

function status(over: Partial<CacheStatus> = {}, beat: Partial<CacheStatus["beat"]> = {}): CacheStatus {
  return {
    supported: true,
    model: "claude-opus-5-5",
    ttl: "1h",
    cachedTokens: 200_000,
    lastRequestAt: NOW - 10 * MIN,
    cachebeatLoaded: true,
    defaultOn: true,
    stop: null,
    beat: { state: "unknown", intervalMin: null, at: null, report: null, ...beat },
    ...over,
  };
}

test("a default-on guess is not shown as on", () => {
  assert.equal(effectiveBeat(status(), NOW), "default-on");
  assert.match(pillLabel(status(), estimate(status(), NOW), NOW) ?? "", /beat \(default\)/);
  assert.equal(estimate(status(), NOW).nextBeatAt, null);
});

test("no reply stays unknown when the default is null or cachebeat is not loaded", () => {
  for (const over of [{ defaultOn: null }, { cachebeatLoaded: false }]) {
    const s = status(over);
    assert.equal(effectiveBeat(s, NOW), "unknown");
    assert.match(pillLabel(s, estimate(s, NOW), NOW) ?? "", /beat \?/);
  }
});

test("a stale or untimed on reply falls back to default-on", () => {
  assert.equal(effectiveBeat(status({}, { state: "on", intervalMin: 4, at: NOW - 26 * 60 * MIN }), NOW), "default-on");
  assert.equal(effectiveBeat(status({}, { state: "on", intervalMin: 4, at: null }), NOW), "default-on");
});

test("a confirmed off reply and a self-stop beat default-on", () => {
  assert.equal(effectiveBeat(status({}, { state: "off", at: NOW - MIN }), NOW), "off");
  assert.equal(effectiveBeat(status({ stop: { at: NOW - MIN, why: "x" } }), NOW), "stopped");
});

test("a default-off guess stays off", () => {
  assert.equal(effectiveBeat(status({ defaultOn: false }), NOW), "off");
});

test("a fresh /cachebeat on reply is on", () => {
  const s = status({}, { state: "on", intervalMin: 4, at: NOW - 5 * MIN });
  assert.equal(effectiveBeat(s, NOW), "on");
});

test("an old on reply is not on", () => {
  const s = status({ defaultOn: null }, { state: "on", intervalMin: 4, at: NOW - 26 * 60 * MIN });
  assert.equal(effectiveBeat(s, NOW), "unknown");
});

test("a self-stop newer than the on reply wins", () => {
  const s = status({ stop: { at: NOW - 3 * MIN, why: "the cache was not served" } }, { state: "on", intervalMin: 4, at: NOW - 30 * MIN });
  assert.equal(effectiveBeat(s, NOW), "stopped");
  assert.equal(estimate(s, NOW).nextBeatAt, null);
  assert.match(pillLabel(s, estimate(s, NOW), NOW) ?? "", /stopped/);
});

test("a self-stop older than the latest reply is ignored", () => {
  const s = status({ stop: { at: NOW - 30 * MIN, why: "x" } }, { state: "on", intervalMin: 4, at: NOW - 2 * MIN });
  assert.equal(effectiveBeat(s, NOW), "on");
});

test("stopFromStore picks the folder's newest entry, ignoring junk", () => {
  const store = { stops: { "/a": { at: 5, why: "w" }, "/b": { at: "x" } } };
  assert.deepEqual(stopFromStore(store, "/a"), { at: 5, why: "w" });
  assert.equal(stopFromStore(store, "/b"), null);
  assert.equal(stopFromStore(store, "/c"), null);
  assert.equal(stopFromStore(null, "/a"), null);
  assert.equal(stopFromStore({ stops: 3 }, "/a"), null);
});

test("an on reply with no timestamp is unknown, since its age cannot be told", () => {
  const s = status({ defaultOn: null }, { state: "on", intervalMin: 4, at: null });
  assert.equal(effectiveBeat(s, NOW), "unknown");
});
