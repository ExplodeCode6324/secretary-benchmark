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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledger } from "../../online/benchmark/campaign.ts";
import { recoverySender } from "../../online/benchmark/stage-c-recovery-sender.ts";
import { meteredFetch } from "../../online/benchmark/live-model.ts";
import { fingerprint } from "../../online/benchmark/source.ts";
import { writeJSON } from "../../online/benchmark/io.ts";

test("C12b gate waits for the actual metered stream settlement and for the task, with time left", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "retest-sender-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true }));
  writeJSON(path.join(root, "campaign/manifest.json"), {
    version: 1,
    approval_id: "fixture",
    source: fingerprint(),
    facility: root,
    state: "OPEN",
    ceiling_usd: null,
    created_at: new Date().toISOString(),
  });
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(evidence, { mode: 0o700 });
  let taskActive = true,
    main = 0;
  const gate = recoverySender(
    () => [...ledger(root).entries.values()].every((e) => e.settled),
    () => taskActive,
  );
  const signal = AbortSignal.timeout(10000);
  const deadline = Date.now() + 120000;
  let bytes!: ReadableStreamDefaultController<Uint8Array>;
  const fetcher = meteredFetch(
    {
      root,
      run: "fixture",
      model: "deepseek-flash",
      maxSends: 1,
      evidence,
      key: "offline-placeholder",
    },
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            bytes = c;
          },
        }),
      ),
  );
  const delayed = gate.admit(signal, "main", deadline, async () => {
    main++;
  });
  const response = await gate.admit(signal, "task", deadline, async () => {
    assert.equal(gate.check(), false);
    return fetcher("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "deepseek-flash",
        stream: true,
        max_tokens: 64,
        messages: [],
      }),
    });
  });
  assert.equal(gate.check(), false);
  taskActive = false;
  gate.writing = true;
  bytes.enqueue(
    new TextEncoder().encode(
      'data: {"model":"deepseek-flash","usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ),
  );
  bytes.close();
  await response.text();
  assert.equal(gate.check(), true);
  assert.equal(main, 0);
  await assert.rejects(
    gate.admit(signal, "main", Date.now() + 39000, async () => {
      main++;
    }),
    /WINDOW_EXHAUSTED/,
  );
  gate.writing = false;
  await delayed;
  assert.equal(main, 1);
  assert.equal(ledger(root).entries.size, 1);
});
