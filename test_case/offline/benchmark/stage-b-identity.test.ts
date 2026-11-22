import { acceptedPages } from "../../online/benchmark/stage-b-capture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { roleModel } from "../../../sut/secretary/src/pi_secretary/src/model.ts";
import { createCampaign, ledger } from "../../online/benchmark/campaign.ts";
import { captureBodies } from "../../online/benchmark/baseline-b0.ts";
import {
  mkdir,
  repository,
  sha,
  writeJSON,
} from "../../online/benchmark/io.ts";
import { descriptor, meteredFetch } from "../../online/benchmark/live-model.ts";
import {
  returnedIdentity,
  stageModels,
  validatePhysical,
  type StageModel,
  type PhysicalPolicy,
  type ProviderRule,
} from "../../online/benchmark/stage-b-policy.ts";
import {
  beforeLane,
  stageState,
} from "../../online/benchmark/stage-b-dispatch.ts";
import { attributeLane } from "../../online/benchmark/stage-b-report-publication.ts";

function rule(model: StageModel): ProviderRule {
  return {
    checked_at: new Date().toISOString(),
    published_version: model,
    allowed_returned_models: [
      model,
      model + "-fixture-a",
      model + "-fixture-b",
    ],
    provenance_sha256: sha("fixture"),
    publication_url:
      model === "deepseek-flash"
        ? "https://api-docs.deepseek.com/fixture"
        : "https://openai.com/fixture",
    input_rate: 1,
    cache_input_rate: 0.1,
    cache_write_rate: model === "deepseek-flash" ? 1 : 1.25,
    output_rate: 1,
    tier: "default",
    cache_retention: "default",
    context_band: "all-admitted-input",
    context_upper_tokens: 4096,
    max_input_bytes: 4096,
    max_requested_output: 200,
    billed_output: 200,
  };
}
function policy(): PhysicalPolicy {
  return {
    schema: "issue122-physical-v3",
    freeze_sha256: sha("offline fixture"),
    providers: Object.fromEntries(
      stageModels.map((model) => [model, rule(model)]),
    ) as PhysicalPolicy["providers"],
  };
}
const frame = (model?: string, usage?: object) => ({ model, usage });
const stream = (frames: object[]) =>
  new Response(
    frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") +
      "data: [DONE]\n\n",
  );
async function fixture(t: TestContext) {
  const p = policy(),
    approval = randomUUID(),
    root = path.join(repository, ".local/benchmark/tests", approval),
    episode = randomUUID(),
    evidence = path.join(root, "evidence", episode);
  mkdir(evidence);
  await createCampaign(root, approval, undefined, undefined, p);
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.unlinkSync(
      path.join(
        repository,
        ".local/benchmark/.campaign-registry",
        approval + ".json",
      ),
    );
  });
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), {
    schema: "issue122-dispatch-v2",
    ended: false,
    freeze_sha256: p.freeze_sha256,
    terminals: {},
    probes: {},
    repairs: {},
  });
  let calls = 0;
  function bind(model: StageModel, response: Response) {
    const lane = "probe--" + model;
    writeJSON(path.join(root, "campaign/active-stage-b.json"), {
      state: "OPEN",
      lane,
      episode: episode + model,
      model,
      freeze_sha256: p.freeze_sha256,
    });
    const args = {
      root,
      run: episode,
      episode: episode + model,
      lane,
      evidence,
      model,
      key: "offline-identity-key",
      maxSends: 3,
      stageFreeze: p.freeze_sha256,
    };
    return meteredFetch(args, async () => {
      calls++;
      return response;
    });
  }
  async function open(
    model: StageModel,
    response: Response,
    usageRequest = true,
    extra: Record<string, unknown> = {},
  ) {
    const api = descriptor(model),
      fetch = bind(model, response);
    const chat = api.api === "openai-completions";
    const body = JSON.stringify({
      model,
      stream: true,
      ...(chat
        ? {
            max_tokens: 200,
            ...(usageRequest
              ? { stream_options: { include_usage: true } }
              : {}),
          }
        : { max_output_tokens: 200 }),
      ...extra,
    });
    return fetch(api.baseUrl + (chat ? "/chat/completions" : "/responses"), {
      method: "POST",
      body,
    });
  }
  async function send(...args: Parameters<typeof open>) {
    await (await open(...args)).text();
    return [...ledger(root).entries.values()].at(-1)!;
  }
  return { bind, open, send, calls: () => calls, root };
}
test("R7 freeze accepts only small, unique exact identifier lists containing the requested alias", () => {
  const p = policy();
  validatePhysical(p);
  for (const list of [
    [],
    ["wrong"],
    ["deepseek-flash", "deepseek-flash"],
    ["deepseek-flash", "*"],
    ["deepseek-flash", "a", "b", "c", "d"],
  ]) {
    assert.throws(
      () =>
        validatePhysical({
          ...p,
          providers: {
            ...p.providers,
            "deepseek-flash": {
              ...rule("deepseek-flash"),
              allowed_returned_models: list,
            },
          },
        }),
      /PROVENANCE_INVALID/,
    );
  }
  const allow = rule("deepseek-flash").allowed_returned_models;
  assert.equal(
    returnedIdentity(allow, undefined, ["wrong", allow[0]]),
    "IDENTITY_MISMATCH_FIRST_CONTACT",
  );
  assert.equal(
    returnedIdentity(allow, undefined, [allow[1], allow[2]]),
    "VERSION_TRANSITION",
  );
  assert.equal(
    returnedIdentity(allow, allow[0], ["wrong"]),
    "VERSION_TRANSITION",
  );
  assert.equal(returnedIdentity(allow, allow[0], []), "IDENTITY_UNKNOWN");
});
test("B0 intercepts all three real SDK serializers and observes the chat usage switch", async () => {
  const requests = await captureBodies(
    normalizeContext({
      messages: [
        { role: "user", content: "Offline observation.", timestamp: 0 },
      ],
    }),
  );
  assert.deepEqual(
    requests.map((r) => [r.model, r.chat_stream_usage_requested]),
    stageModels.map((m) => [m, m === "deepseek-flash" ? true : null]),
  );
  assert.ok(
    requests.every((r) => r.bytes > 0 && /^[a-f0-9]{64}$/.test(r.sha256)),
  );
});
test("first-contact mismatch holds Flash and controls independently; error body identities never establish a match", async (t) => {
  const f = await fixture(t);
  for (const model of ["deepseek-flash", "gpt-6-luna"] as const) {
    const http = await f.send(
      model,
      new Response(
        JSON.stringify({ model, error: { code: "rate_limit_exceeded" } }),
        { status: 429 },
      ),
    );
    assert.equal(http.outcome, "RATE_LIMITED");
    const before = f.calls();
    if (model === "deepseek-flash") {
      await assert.rejects(
        () => f.send(model, stream([]), false),
        /STREAM_USAGE_REQUIRED/,
      );
      assert.equal(f.calls(), before);
    }
    const item = await f.send(model, stream([frame("unexpected")]));
    assert.equal(item.outcome, "IDENTITY_MISMATCH_FIRST_CONTACT");
    assert.equal(
      item.attempt.chat_stream_usage_requested,
      model === "deepseek-flash" ? true : undefined,
    );
    await assert.rejects(
      () => f.send(model, stream([frame(model)])),
      /STAGE_B_IDENTITY_HOLD/,
    );
    assert.equal(f.calls(), before + 1);
  }
  const unknown = await f.send("gpt-6.2-sol", stream([frame()]));
  assert.equal(unknown.outcome, "IDENTITY_UNKNOWN");
});
test("snapshot match survives sender restart; a second allowed snapshot changes the observed version", async (t) => {
  const f = await fixture(t),
    model = "deepseek-flash";
  const first = await f.send(
    model,
    stream([frame(model + "-fixture-a"), frame(model + "-fixture-a")]),
  );
  assert.equal(first.outcome, "RESPONSE_COMPLETE");
  const second = await f.send(model, stream([frame(model + "-fixture-b")]));
  assert.equal(second.outcome, "VERSION_TRANSITION");
  await assert.rejects(() => f.send(model, stream([])), /STAGE_B_VERSION_HOLD/);
  const mixed = await f.send(
    "gpt-6-luna",
    stream([
      frame("gpt-6-luna"),
      frame("gpt-6-luna-fixture-a"),
      frame("gpt-6-luna"),
    ]),
  );
  assert.equal(mixed.outcome, "VERSION_TRANSITION");
  const lane = "probe--" + model;
  const view = (outcome: string, returned: string) =>
    attributeLane(
      [],
      lane,
      model,
      rule(model),
      [
        {
          at: first.attempt.at,
          settled_at: first.settled_at!,
          outcome,
          returned_model_sha256: sha(returned),
        },
      ],
      false,
    );
  assert.equal(
    view("RESPONSE_COMPLETE", model + "-fixture-a"),
    "FROZEN_RETURNED_IDENTIFIER",
  );
  assert.equal(
    view("RESPONSE_COMPLETE", model),
    "SEGREGATED_PUBLICATION_UNCERTAIN",
  );
  assert.equal(
    view("IDENTITY_MISMATCH_FIRST_CONTACT", "wrong"),
    "SEGREGATED_IDENTITY_MISMATCH_FIRST_CONTACT",
  );
  assert.equal(
    view("VERSION_TRANSITION", model + "-fixture-b"),
    "SEGREGATED_VERSION_TRANSITION",
  );
});
test("ambiguous reasoning below each individual limit retains the reservation and stops other models", async (t) => {
  const f = await fixture(t),
    model = "deepseek-flash";
  const bad = {
    prompt_tokens: 20,
    completion_tokens: 100,
    completion_tokens_details: { reasoning_tokens: 150 },
  };
  const result = await f.send(
    model,
    stream([
      frame(model, bad),
      frame(model, { prompt_tokens: 20, completion_tokens: 100 }),
    ]),
  );
  assert.equal(result.component_violation, true);
  assert.equal(result.actual_usd, null);
  assert.equal(result.charged_usd, result.attempt.reserved_usd);
  await assert.rejects(
    () => f.send("gpt-6-luna", stream([frame("gpt-6-luna")])),
    /STAGE_B_BOUND_VIOLATION/,
  );
});

test("Real SDK probe payloads pass each provider's frozen pricing guard before offline transport", async (t) => {
  const f = await fixture(t),
    originalFetch = globalThis.fetch;
  const context = normalizeContext({
    messages: [{ role: "user", content: "Reply with READY.", timestamp: 0 }],
  });
  try {
    for (const id of stageModels) {
      const model = descriptor(id);
      // An offline HTTP 400 ends the SDK request without synthesizing a completion.
      globalThis.fetch = f.bind(id, new Response("{}", { status: 400 }));
      const result = await (
        await roleModel(model, "offline-identity-key").stream(model, context, {
          maxTokens: 128,
          signal: AbortSignal.timeout(10000),
        })
      ).result();
      assert.equal(result.stopReason, "error");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(f.calls(), stageModels.length);
  assert.deepEqual(
    [...ledger(f.root).entries.values()].map(({ attempt }) => [
      attempt.model,
      attempt.physical?.requested_output,
    ]),
    stageModels.map((id) => [id, 128]),
  );
});

test("OpenAI pricing overrides are refused before reservation while a routing key preserves the write-price bound", async (t) => {
  const f = await fixture(t),
    model = "gpt-6.2-sol";
  for (const overrides of [
    { prompt_cache_options: null },
    { prompt_cache_options: { ttl: "12h" } },
    { prompt_cache_retention: null },
    { prompt_cache_retention: "24h" },
    {
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "cacheable",
              prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
            },
          ],
        },
      ],
    },
  ]) {
    await assert.rejects(
      () => f.send(model, stream([]), true, overrides),
      /STAGE_B_/,
    );
    assert.equal(ledger(f.root).entries.size, 0);
    assert.equal(f.calls(), 0);
  }
  const usage = {
    input_tokens: 60,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 40 },
  };
  const entry = await f.send(
    model,
    stream([
      {
        type: "response.completed",
        response: {
          model,
          prompt_cache_options: { ttl: "30m" },
          usage,
        },
      },
    ]),
    true,
    { prompt_cache_key: "routing", input: "Explain prompt_cache_breakpoint." },
  );
  const bound = entry.attempt.physical!;
  assert.equal(entry.outcome, "RESPONSE_COMPLETE");
  assert.equal(entry.actual_usd, (10 + 10 * 0.1 + 40 * 1.25 + 10) / 1e6);
  assert.equal(
    entry.attempt.reserved_usd,
    (bound.input_bytes * 1.25 + bound.output_tokens) / 1e6,
  );
  assert.equal(f.calls(), 1);
});

test("Over-limit serialized bodies only refuse that lane before transport and the exact limit is admitted", async (t) => {
  const f = await fixture(t);
  function padded(model: StageModel, bytes: number) {
    const base = { model, stream: true, max_output_tokens: 200, input: "" };
    return {
      input: "a".repeat(bytes - Buffer.byteLength(JSON.stringify(base))),
    };
  }
  const tooBig = "gpt-6-luna",
    exact = "gpt-6.2-sol";
  await assert.rejects(
    () => f.send(tooBig, stream([]), true, padded(tooBig, 4097)),
    /BODY_BOUND/,
  );
  assert.equal(f.calls(), 0);
  assert.equal(ledger(f.root).entries.size, 0);
  const refusal = JSON.parse(
    fs
      .readFileSync(
        path.join(f.root, "campaign/physical-refusals.jsonl"),
        "utf8",
      )
      .trim(),
  );
  assert.equal(refusal.lane, "probe--" + tooBig);
  assert.equal(refusal.reason, "STAGE_B_BODY_BOUND");
  const entry = await f.send(
    exact,
    stream([frame(exact)]),
    true,
    padded(exact, 4096),
  );
  assert.equal(entry.attempt.physical?.input_bytes, 4096);
  assert.equal(entry.outcome, "RESPONSE_COMPLETE");
});

test("Missing price details retain the reservation without holding the next model", async (t) => {
  const f = await fixture(t),
    model = "gpt-6-luna";
  const first = await f.send(
    model,
    stream([
      frame(model, {
        input_tokens: 20,
        output_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
      }),
    ]),
  );
  assert.equal(first.component_violation, false);
  assert.equal(first.actual_usd, null);
  assert.equal(first.charged_usd, first.attempt.reserved_usd);
  const other = "deepseek-flash";
  const next = await f.send(
    other,
    stream([
      frame(other, {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_cache_hit_tokens: 0,
      }),
    ]),
  );
  assert.equal(next.actual_usd, 6 / 1e6);
});

test("Non-default TTL is durable before settlement and a later frame cannot erase it", async (t) => {
  const model = "gpt-6-luna";
  const usage = {
    input_tokens: 20,
    output_tokens: 5,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  };
  for (const [label, early] of [
    [
      "positive 12h write in a usage frame",
      {
        model,
        usage: {
          ...usage,
          input_tokens_details: {
            cache_write_tokens: 1,
            cache_write_tokens_details: {
              ttl_30m_tokens: 0,
              ttl_12h_tokens: 1,
            },
          },
        },
      },
    ],
    [
      "echoed response option",
      {
        type: "response.in_progress",
        response: { model, prompt_cache_options: { ttl: "12h" } },
      },
    ],
  ] as const) {
    await t.test(label, async (t) => {
      const f = await fixture(t),
        encoder = new TextEncoder();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const incoming = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
          },
        }),
      );
      const response = await f.open(model, incoming);
      const reader = response.body!.getReader();
      source.enqueue(encoder.encode("data: " + JSON.stringify(early) + "\n\n"));
      await reader.read();
      try {
        // A fresh metered sender rereads the on-disk campaign before the first
        // response finishes. It must see the price change on another model too.
        const recorded = [...ledger(f.root).entries.values()];
        assert.equal(recorded[0].settled, false);
        assert.deepEqual(
          beforeLane(
            stageState(f.root),
            recorded,
            "deepseek-flash",
            Date.now(),
          ),
          {
            at: recorded[0].pricing_drift!.at,
            status: "HALTED",
            reason: "PROVENANCE_CHANGE",
          },
        );
        await assert.rejects(
          () => f.send("deepseek-flash", stream([frame("deepseek-flash")])),
          /PROVENANCE_CHANGE/,
        );
        assert.equal(f.calls(), 1);
      } finally {
        source.enqueue(
          encoder.encode(
            "data: " +
              JSON.stringify(frame(model, usage)) +
              "\n\ndata: [DONE]\n\n",
          ),
        );
        source.close();
        while (!(await reader.read()).done) {}
      }
      const entry = [...ledger(f.root).entries.values()][0];
      assert.equal(entry.outcome, "PROVENANCE_CHANGE");
      assert.equal(entry.actual_usd, null);
      assert.equal(entry.charged_usd, entry.attempt.reserved_usd);
    });
  }
});

test("Provider input beyond the frozen short-context band keeps unknown cost and stops other models", async (t) => {
  for (const model of ["gpt-6.2-sol", "gpt-6-luna"] as const) {
    await t.test(model, async (t) => {
      const f = await fixture(t);
      const valid = {
        input_tokens: 1,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      };
      const entry = await f.send(
        model,
        stream([
          frame(model, { ...valid, input_tokens: 272001 }),
          frame(model, valid),
        ]),
      );
      assert.equal(entry.component_violation, true);
      assert.equal(entry.actual_usd, null);
      assert.equal(entry.charged_usd, entry.attempt.reserved_usd);
      await assert.rejects(
        () => f.send("deepseek-flash", stream([frame("deepseek-flash")])),
        /BOUND_VIOLATION/,
      );
      assert.equal(f.calls(), 1);
    });
  }
});

test("a captured file check distinguishes a returned alias from verified publication coverage", () => {
  const model = "gpt-6-luna";
  const lane = "fixture";
  const pages = acceptedPages(model);
  const policy = {
    ...rule(model),
    provenance_sha256: sha(JSON.stringify(pages)),
  };
  const stamp = (ms: number) => new Date(ms).toISOString();
  const observed = [
    {
      at: stamp(2),
      settled_at: stamp(3),
      outcome: "RESPONSE_COMPLETE",
      returned_model_sha256: sha(model),
    },
  ];
  const boundaries: Parameters<typeof attributeLane>[0] = [
    "fixture:start",
    "fixture:end",
    "campaign:end",
  ].map((point, i) => ({
    point,
    model,
    at: stamp([1, 4, 5][i]),
    pages,
    status: "CAPTURE_MATCH" as const,
  }));
  const attribute = (log: Parameters<typeof attributeLane>[0]) =>
    attributeLane(log, lane, model, policy, observed, true);
  assert.equal(attribute(boundaries), "BACKEND_UNVERIFIED_ALIAS_ONLY");
  assert.equal(
    attribute(boundaries.slice(0, 2)),
    "HELD_CAMPAIGN_END_CAPTURE_CHECK",
  );
  assert.equal(
    attribute(boundaries.map((x) => ({ ...x, status: "MATCH" }))),
    "SEGREGATED_CAPTURE_UNCERTAIN",
  );
  assert.equal(
    attribute([{ ...boundaries[0], pages: [] }, ...boundaries.slice(1)]),
    "SEGREGATED_CAPTURE_UNCERTAIN",
  );
});
