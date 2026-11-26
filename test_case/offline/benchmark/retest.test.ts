import assert from "node:assert/strict";
import test from "node:test";
import { retestQuota } from "../../online/benchmark/stage-c-go-quota.ts";

const window = (remaining: number) => ({
  deadline: () => Date.now() + remaining,
  signal: new AbortController().signal,
});
const ok = { status: "ok", percent: 0, resetsAt: "2030-01-01T00:00:00Z" };
const usage = { rolling: ok, weekly: ok, monthly: ok };
test("only transient metadata failures can consume the two zero-send rechecks", async () => {
  let reads = 0;
  const result = await retestQuota(
    "mock",
    async (url, init) => {
      assert.equal(init?.method ?? "GET", "GET");
      assert.ok(init?.signal);
      reads++;
      if (reads < 3) throw new TypeError("offline transport failure");
      return Response.json({ usage });
    },
    window(120000),
  );
  assert.equal(reads, 3);
  assert.deepEqual(result, usage);
  for (const [status, count] of [
    [401, 1],
    [403, 1],
    [503, 3],
  ]) {
    reads = 0;
    await assert.rejects(
      retestQuota(
        "mock",
        async () => {
          reads++;
          return new Response(null, { status });
        },
        window(120000),
      ),
    );
    assert.equal(reads, count);
  }
});
test("insufficient time or an aborted request causes zero metadata reads", async () => {
  let reads = 0;
  const transport = async () => {
    reads++;
    return Response.json({ usage });
  };
  await assert.rejects(
    retestQuota("mock", transport, window(44000)),
    /WINDOW_EXHAUSTED/,
  );
  await assert.rejects(
    retestQuota("mock", transport, {
      ...window(120000),
      signal: AbortSignal.abort(),
    }),
  );
  assert.equal(reads, 0);
});
