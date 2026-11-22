import {
  prepareTierSamples,
  verifyTierSamples,
} from "../../online/benchmark/stage-b-tier-samples.ts";
import { fingerprint } from "../../online/benchmark/source.ts";
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
import {
  benchmarkRoleModel,
  descriptor,
  meteredFetch,
} from "../../online/benchmark/live-model.ts";
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
async function fixture(t: TestContext, p = policy()) {
  const approval = randomUUID(),
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

function explicitTierPolicy() {
  const p = policy();
  for (const model of ["gpt-6-luna", "gpt-6.2-sol"] as const)
    p.providers[model].request_service_tier = "default";
  return p;
}
test("explicit OpenAI tier is checked before reservation and confirmed by the terminal response", async (t) => {
  const f = await fixture(t, explicitTierPolicy()),
    model = "gpt-6-luna";
  for (const request of [
    {},
    { service_tier: "auto" },
    { service_tier: "priority" },
    { service_tier: null },
  ]) {
    await assert.rejects(
      () => f.send(model, stream([]), true, request),
      /TIER|PRICING/,
    );
  }
  assert.equal(f.calls(), 0);
  assert.equal(ledger(f.root).entries.size, 0);
  const done = (tier: string) => ({
    type: "response.completed",
    response: {
      model,
      service_tier: tier,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    },
  });
  const confirmed = await f.send(model, stream([done("default")]), true, {
    service_tier: "default",
  });
  assert.equal(confirmed.outcome, "RESPONSE_COMPLETE");
  assert.equal((confirmed.usage as any).returned_service_tier, "default");
  const changed = await f.send(model, stream([done("priority")]), true, {
    service_tier: "default",
  });
  assert.equal(changed.outcome, "PROVENANCE_CHANGE");
  assert.equal(changed.pricing_drift?.observed_tier, "priority");
  assert.equal(changed.actual_usd, null);
});

test("strict controls retain first tier drift and refuse missing or nonpublic terminal tiers", async (t) => {
  const model = "gpt-6.2-sol";
  for (const [name, early, terminal, expected] of [
    ["missing", "default", undefined, "MISSING"],
    ["nonpublic", undefined, "synthetic-private-value", "UNRECOGNIZED"],
    ["early priority then standard", "priority", "default", "priority"],
  ] as const) {
    await t.test(name, async (t) => {
      const f = await fixture(t, explicitTierPolicy());
      const e = await f.send(
        model,
        stream([
          {
            type: "response.in_progress",
            response: { model, service_tier: early },
          },
          {
            type: "response.completed",
            response: { model, service_tier: terminal },
          },
        ]),
        true,
        { service_tier: "default" },
      );
      assert.equal(e.outcome, "PROVENANCE_CHANGE");
      assert.equal(e.pricing_drift?.observed_tier, expected);
      assert.equal(e.pricing_drift?.requested_tier, "default");
      assert.equal(e.actual_usd, null);
      assert.ok(
        !fs
          .readFileSync(path.join(f.root, "campaign/attempts.jsonl"), "utf8")
          .includes("synthetic-private-value"),
      );
    });
  }
});

test("a strict control cannot claim a confirmed response from a bare DONE marker", async (t) => {
  const f = await fixture(t, explicitTierPolicy());
  const model = "gpt-6-luna";
  const entry = await f.send(
    model,
    stream([
      {
        type: "response.in_progress",
        response: { model, service_tier: "default" },
      },
    ]),
    true,
    { service_tier: "default" },
  );
  assert.notEqual(entry.outcome, "RESPONSE_COMPLETE");
  assert.equal(entry.actual_usd, null);
  assert.notEqual((entry.usage as any)?.returned_service_tier, "default");
});

test("tier drift survives replay before the stream settles and blocks a second model", async (t) => {
  const f = await fixture(t, explicitTierPolicy());
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const model = "gpt-6-luna";
  const response = await f.open(
    model,
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    ),
    true,
    { service_tier: "default" },
  );
  const reader = response.body!.getReader();
  source.enqueue(
    new TextEncoder().encode(
      "data: " +
        JSON.stringify({
          type: "response.in_progress",
          response: { model, service_tier: "flex" },
        }) +
        "\n\n",
    ),
  );
  await reader.read();
  try {
    const replay = [...ledger(f.root).entries.values()];
    assert.equal(replay[0].settled, false);
    assert.equal(replay[0].pricing_drift?.observed_tier, "flex");
    await assert.rejects(
      () => f.send("deepseek-flash", stream([])),
      /PROVENANCE_CHANGE/,
    );
    assert.equal(f.calls(), 1);
  } finally {
    source.close();
    while (!(await reader.read()).done) {}
  }
  assert.equal(
    [...ledger(f.root).entries.values()][0].outcome,
    "PROVENANCE_CHANGE",
  );
});

test("the pinned SDK hook preserves the product budget and refuses a replacement or mutation of the explicit tier", async () => {
  const m = descriptor("gpt-6.2-sol");
  const ctx = normalizeContext({
    messages: [
      { role: "user", content: "Synthetic tier regression", timestamp: 1 },
    ],
  });
  for (const mutation of ["nondefault", "delete", "budget"] as const) {
    let seen = 0,
      transmissions = 0;
    const cfg = benchmarkRoleModel(
      m,
      "offline-synthetic-key",
      "task",
      "default",
    );
    const result = await (
      await cfg.stream(m, ctx, {
        maxTokens: 128,
        onPayload: (payload) => {
          const p = payload as Record<string, unknown>;
          seen++;
          assert.equal(p.service_tier, "default");
          if (mutation === "delete") {
            delete p.service_tier;
            return;
          }
          return mutation === "nondefault"
            ? { ...p, service_tier: "priority" }
            : { ...p, max_output_tokens: 999 };
        },
        fetch: async () => {
          transmissions++;
          return new Response("{}", { status: 400 });
        },
      })
    ).result();
    assert.equal(result.stopReason, "error");
    assert.equal(seen, 1);
    assert.equal(transmissions, 0);
  }
});

test("failed, incomplete and HTTP-error responses without a tier preserve their failure classification", async (t) => {
  for (const [name, response, outcome] of [
    [
      "failed",
      stream([
        {
          type: "response.failed",
          response: { model: "gpt-6-luna", status: "failed" },
        },
      ]),
      "STREAM_UNCERTAIN",
    ],
    [
      "incomplete",
      stream([
        {
          type: "response.incomplete",
          response: { model: "gpt-6-luna", status: "incomplete" },
        },
      ]),
      "STREAM_UNCERTAIN",
    ],
    [
      "rate limit",
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
        status: 429,
      }),
      "RATE_LIMITED",
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const f = await fixture(t, explicitTierPolicy());
      const entry = await f.send("gpt-6-luna", response, true, {
        service_tier: "default",
      });
      assert.equal(entry.outcome, outcome);
      assert.equal(entry.pricing_drift, undefined);
      assert.equal(entry.actual_usd, null);
    });
  }
});

test("both explicit controls bind ten offline product wire bodies and reject a changed digest, order, or physical cap", async (t) => {
  const p = explicitTierPolicy();
  for (const model of ["gpt-6-luna", "gpt-6.2-sol"] as const) {
    Object.assign(p.providers[model], {
      max_input_bytes: 32768,
      context_upper_tokens: 32768,
      max_requested_output: 32768,
      billed_output: "REQUEST_CAP",
    });
  }
  const f = await fixture(t, p);
  await prepareTierSamples(f.root, p);
  const source = fingerprint();
  const rows = verifyTierSamples(f.root, p, source);
  assert.equal(rows.length, 10);
  assert.ok(
    rows.every(
      (r) =>
        r.service_tier === "default" &&
        (r.path === "probe"
          ? r.product_payload_sha256 === null
          : r.sha256 === r.product_payload_sha256),
    ),
  );
  assert.equal(f.calls(), 0);
  assert.equal(ledger(f.root).entries.size, 0);
  const file = path.join(f.root, "configs/stage-b-tier-samples.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  const changed = structuredClone(saved);
  changed.samples[1].wire = changed.samples[1].wire.replace(
    '"default"',
    '"auto"',
  );
  writeJSON(file, changed);
  assert.throws(() => verifyTierSamples(f.root, p, source), /SAMPLE_BINDING/);
  writeJSON(file, { ...saved, samples: [...saved.samples].reverse() });
  assert.throws(() => verifyTierSamples(f.root, p, source), /SAMPLE_BINDING/);
  writeJSON(file, saved);
  p.providers["gpt-6-luna"].max_input_bytes = 10;
  assert.throws(() => verifyTierSamples(f.root, p, source), /BODY_BOUND/);
});

test("the explicit policy requires both OpenAI controls and excludes DeepSeek", () => {
  const p = explicitTierPolicy();
  validatePhysical(p);
  delete p.providers["gpt-6-luna"].request_service_tier;
  assert.throws(() => validatePhysical(p), /PROVENANCE_INVALID/);
  p.providers["gpt-6-luna"].request_service_tier = "default";
  p.providers["deepseek-flash"].request_service_tier = "default";
  assert.throws(() => validatePhysical(p), /PROVENANCE_INVALID/);
});

test("conflicting provider options cannot be discarded by the simple adapter", () => {
  const m = descriptor("gpt-6-luna");
  const config = benchmarkRoleModel(
    m,
    "offline-synthetic-key",
    "main",
    "default",
  );
  const opts = {
    maxTokens: 128,
    serviceTier: "auto",
    fetch: async () => {
      throw Error("UNEXPECTED_TRANSPORT");
    },
  };
  assert.throws(
    () => config.stream(m, normalizeContext({ messages: [] }), opts),
    /STAGE_B_PRICING_TIER/,
  );
});

function retentionPolicy() {
  const p = explicitTierPolicy();
  for (const model of ["gpt-6-luna", "gpt-6.2-sol"] as const)
    p.providers[model].cache_retention_contract = "responses-ttl-30m-v1";
  return p;
}

test("modern cache lifetime and legacy response metadata are assessed independently", async (t) => {
  for (const model of ["gpt-6-luna", "gpt-6.2-sol"] as const) {
    await t.test(model, async (t) => {
      const f = await fixture(t, retentionPolicy());
      const usage = {
        input_tokens: 20,
        output_tokens: 1,
        input_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 0,
          cache_write_tokens_details: { ttl_30m_tokens: 0, ttl_12h_tokens: 0 },
        },
      };
      for (const fields of [
        { prompt_cache_retention: "in_memory" },
        {
          prompt_cache_options: { ttl: "30m" },
          prompt_cache_retention: "in_memory",
        },
        {},
      ]) {
        const entry = await f.send(
          model,
          stream([
            { type: "response.created", response: { model } },
            {
              type: "response.completed",
              response: { model, service_tier: "default", usage, ...fields },
            },
          ]),
          true,
          { service_tier: "default" },
        );
        assert.equal(entry.outcome, "RESPONSE_COMPLETE");
        assert.ok(typeof entry.actual_usd === "number");
        const observed = (entry.usage as any).terminal_cache_retention;
        assert.equal(observed.frame_index, 2);
        assert.equal(observed.frame_type, "response.completed");
        assert.equal(
          observed.response.legacy_retention,
          fields.prompt_cache_retention ?? "MISSING",
        );
        assert.equal(
          observed.response.modern_ttl,
          fields.prompt_cache_options?.ttl ?? "MISSING",
        );
      }
    });
  }
});

test("cache drift records field, safe values and first frame before later clean completion", async (t) => {
  const model = "gpt-6-luna";
  for (const [name, fields, expected, reason] of [
    [
      "modern extended",
      {
        prompt_cache_options: { ttl: "12h" },
        prompt_cache_retention: "in_memory",
      },
      "prompt_cache_options.ttl",
      "CACHE_RETENTION",
    ],
    [
      "legacy extended",
      { prompt_cache_options: { ttl: "30m" }, prompt_cache_retention: "24h" },
      "prompt_cache_retention",
      "CACHE_RETENTION",
    ],
    [
      "wrong domain",
      { prompt_cache_options: { ttl: "in_memory" } },
      "prompt_cache_options.ttl",
      "CACHE_RETENTION",
    ],
    [
      "unknown",
      { prompt_cache_retention: "private-value-do-not-retain" },
      "prompt_cache_retention",
      "CACHE_RETENTION",
    ],
    [
      "invalid container",
      { prompt_cache_options: ["private-value-do-not-retain"] },
      "prompt_cache_options",
      "CACHE_RETENTION",
    ],
    [
      "unknown option",
      {
        prompt_cache_options: { ttl: "30m", "private-value-do-not-retain": 1 },
      },
      "prompt_cache_options",
      "CACHE_RETENTION",
    ],
    [
      "invalid mode",
      { prompt_cache_options: { mode: "private-value-do-not-retain" } },
      "prompt_cache_options.mode",
      "CACHE_RETENTION",
    ],
    [
      "positive long writes",
      {
        usage: {
          input_tokens_details: {
            cache_write_tokens_details: { ttl_12h_tokens: 1 },
          },
        },
      },
      "usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens",
      "CACHE_WRITE_12H",
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const f = await fixture(t, retentionPolicy());
      const entry = await f.send(
        model,
        stream([
          { type: "response.created", response: { model } },
          { type: "response.in_progress", response: { model, ...fields } },
          {
            type: "response.completed",
            response: {
              model,
              service_tier: "default",
              prompt_cache_options: { ttl: "30m" },
            },
          },
        ]),
        true,
        { service_tier: "default" },
      );
      assert.equal(entry.outcome, "PROVENANCE_CHANGE");
      assert.equal(entry.actual_usd, null);
      assert.equal(entry.pricing_drift?.reason, reason);
      const observation = entry.pricing_drift?.cache_retention;
      assert.equal(observation?.frame_index, 2);
      assert.equal(observation?.frame_type, "response.in_progress");
      assert.equal(observation?.scope, "response");
      assert.equal(observation?.field, expected);
      assert.equal(
        (entry.usage as any).terminal_cache_retention.response.modern_ttl,
        "30m",
      );
      assert.ok(
        !fs
          .readFileSync(path.join(f.root, "campaign/attempts.jsonl"), "utf8")
          .includes("private-value-do-not-retain"),
      );
      await assert.rejects(
        () => f.send("deepseek-flash", stream([])),
        /PROVENANCE_CHANGE/,
      );
    });
  }
});

test("cache observation survives an interrupted stream, rejects forged replay and cannot leak an unrecognized frame", async (t) => {
  const f = await fixture(t, retentionPolicy()),
    model = "gpt-6-luna";
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await f.open(
    model,
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller;
        },
      }),
    ),
    true,
    { service_tier: "default" },
  );
  const reader = response.body!.getReader();
  source.enqueue(
    new TextEncoder().encode(
      "data: " +
        JSON.stringify({
          type: "private-frame-kind",
          prompt_cache_options: { ttl: "private-cache-value" },
          response: { model, prompt_cache_retention: "in_memory" },
        }) +
        "\n\n",
    ),
  );
  await reader.read();
  try {
    const [entry] = ledger(f.root).entries.values();
    assert.equal(entry.settled, false);
    assert.equal(entry.pricing_drift?.cache_retention?.scope, "frame");
    assert.equal(entry.pricing_drift?.cache_retention?.frame_type, "OTHER");
    await assert.rejects(
      () => f.send("deepseek-flash", stream([])),
      /PROVENANCE_CHANGE/,
    );
    assert.equal(f.calls(), 1);
  } finally {
    await reader.cancel();
  }
  const [entry] = ledger(f.root).entries.values();
  assert.equal(entry.outcome, "PROVENANCE_CHANGE");
  assert.equal((entry.usage as any)?.terminal_cache_retention, undefined);
  const file = path.join(f.root, "campaign/attempts.jsonl");
  const saved = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(saved, /private-frame-kind|private-cache-value/);
  const frames = saved
    .trimEnd()
    .split("\n")
    .map((x) => JSON.parse(x));
  const target = frames.find((x) => x.event.type === "PRICING_DRIFT");
  target.event.cache_retention.frame_type = "private-frame-kind";
  let previous = "0".repeat(64);
  for (const frame of frames) {
    frame.previous = previous;
    previous = frame.hash = sha(
      JSON.stringify(frame.event) + previous + frame.sequence,
    );
  }
  fs.writeFileSync(
    file,
    frames.map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  assert.throws(() => ledger(f.root), /CACHE|DRIFT/);
});

test("cache retention policy cannot cover just one control or DeepSeek", () => {
  const p = retentionPolicy();
  validatePhysical(p);
  delete p.providers["gpt-6.2-sol"].cache_retention_contract;
  assert.throws(() => validatePhysical(p), /PROVENANCE_INVALID/);
  p.providers["gpt-6.2-sol"].cache_retention_contract = "responses-ttl-30m-v1";
  p.providers["deepseek-flash"].cache_retention_contract =
    "responses-ttl-30m-v1";
  assert.throws(() => validatePhysical(p), /PROVENANCE_INVALID/);
});

test("empty options and documented cache modes make no TTL assertion", async (t) => {
  const model = "gpt-6-luna";
  for (const options of [
    {},
    { mode: "implicit" },
    { mode: "explicit", ttl: null },
  ]) {
    const f = await fixture(t, retentionPolicy());
    const entry = await f.send(
      model,
      stream([
        {
          type: "response.completed",
          response: {
            model,
            service_tier: "default",
            prompt_cache_options: options,
          },
        },
      ]),
      true,
      { service_tier: "default" },
    );
    assert.equal(entry.outcome, "RESPONSE_COMPLETE");
    assert.equal(entry.pricing_drift, undefined);
    assert.equal(
      (entry.usage as any).terminal_cache_retention.response.modern_ttl,
      "MISSING",
    );
  }
});

test("positive nested long-write count takes precedence over frame-level extended echo", async (t) => {
  const f = await fixture(t, retentionPolicy()),
    model = "gpt-6-luna";
  const entry = await f.send(
    model,
    stream([
      {
        type: "response.completed",
        prompt_cache_retention: "24h",
        response: {
          model,
          service_tier: "default",
          usage: {
            input_tokens_details: {
              cache_write_tokens_details: { ttl_12h_tokens: 1 },
            },
          },
        },
      },
    ]),
    true,
    { service_tier: "default" },
  );
  assert.equal(entry.pricing_drift?.reason, "CACHE_WRITE_12H");
  assert.equal(entry.pricing_drift?.cache_retention?.scope, "response");
  assert.equal(
    entry.pricing_drift?.cache_retention?.frame.legacy_retention,
    "24h",
  );
});

test("invalid 12h usage makes the estimate unknown through settlement without stopping the campaign", async (t) => {
  for (const breakdown of [
    {},
    { ttl_12h_tokens: null },
    { ttl_12h_tokens: -1 },
    { ttl_12h_tokens: 0.5 },
    { ttl_12h_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { ttl_12h_tokens: "private-count-do-not-retain" },
    "private-count-do-not-retain",
    null,
  ]) {
    const f = await fixture(t, retentionPolicy()),
      model = "gpt-6.2-sol";
    const usage = {
      input_tokens: 20,
      output_tokens: 1,
      input_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
        cache_write_tokens_details: breakdown,
      },
    };
    const valid = {
      ...usage,
      input_tokens_details: {
        ...usage.input_tokens_details,
        cache_write_tokens_details: { ttl_12h_tokens: 0, ttl_30m_tokens: 0 },
      },
    };
    const entry = await f.send(
      model,
      stream([
        { type: "response.in_progress", response: { model, usage } },
        {
          type: "response.completed",
          response: { model, service_tier: "default", usage: valid },
        },
      ]),
      true,
      { service_tier: "default" },
    );
    assert.equal(entry.outcome, "RESPONSE_COMPLETE");
    assert.equal(entry.actual_usd, null);
    assert.equal(entry.pricing_drift, undefined);
    assert.equal((entry.usage as any).invalid_long_write_count, true);
    assert.doesNotMatch(
      fs.readFileSync(path.join(f.root, "campaign/attempts.jsonl"), "utf8"),
      /private-count-do-not-retain/,
    );
  }
});
