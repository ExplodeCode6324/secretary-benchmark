import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import test from "node:test";
import assert from "node:assert/strict";
import {
  descriptor,
  benchmarkRoleModel,
} from "../../online/benchmark/live-model.ts";
import {
  goAPI,
  goModel,
  goResponseMeter,
  goTariff,
} from "../../online/benchmark/stage-c-go-provider.ts";
import { checkGoHeadroom } from "../../online/benchmark/stage-c-go-quota.ts";

test("pinned SUT main and task serialize Go requests to the approved endpoint", async () => {
  const model = descriptor("deepseek-flash", "opencode-go");
  const saved = globalThis.fetch;
  let sent = 0;
  try {
    globalThis.fetch = async (input, opts) => {
      const req = new Request(input, opts),
        body = await req.json();
      assert.equal(req.url, goAPI + "/chat/completions");
      assert.equal(req.headers.get("authorization"), "Bearer mock-go-secret");
      assert.equal(body.model, goModel);
      assert.equal(body.reasoning_effort, "low");
      assert.equal(body.stream_options?.include_usage, true);
      assert.equal(body.service_tier, undefined);
      assert.equal(body.prompt_cache_retention, undefined);
      sent++;
      const frames = [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "test" } },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        },
      ];
      return new Response(
        frames
          .map(
            (f) =>
              "data: " +
              JSON.stringify({ id: "test", model: goModel, ...f }) +
              "\n\n",
          )
          .join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    for (const role of ["main", "task"] as const) {
      const config = benchmarkRoleModel(model, "mock-go-secret", role);
      const stream = await config.stream(
        model,
        normalizeContext({
          messages: [
            { role: "user", content: "offline fixture", timestamp: 0 },
          ],
        }),
      );
      assert.equal((await stream.result()).stopReason, "stop");
    }
    assert.equal(sent, 2);
  } finally {
    globalThis.fetch = saved;
  }
});
test("Go requires headroom in every window and retains a disputed tariff interval", () => {
  const ok = { status: "ok", percent: 0 };
  const usage = { rolling: ok, weekly: ok, monthly: ok };
  checkGoHeadroom(usage, 0.7718592);
  for (const window of Object.keys(usage)) {
    assert.throws(() =>
      checkGoHeadroom(
        { ...usage, [window]: { status: "ok", percent: 99 } },
        0.001,
      ),
    );
    assert.throws(() =>
      checkGoHeadroom({ ...usage, [window]: undefined }, 0.001),
    );
  }
  const peak = Date.parse("2026-11-24T01:00:00Z");
  assert.equal(goTariff(2, peak, peak + 1000).exact, 2);
  assert.equal(goTariff(2, peak - 1, peak + 1000).exact, null);
  const m = goResponseMeter();
  m.observe({
    usage: {
      opencode: { cost: 0.002, allowance: { base: 1 }, provider: "mock" },
    },
  });
  assert.deepEqual(m.receipt, {
    reported_cost: 0.002,
    allowance: { base: 1 },
    identity: { provider: "mock" },
  });
});
