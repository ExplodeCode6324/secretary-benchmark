import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
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
    cache_input_rate: 1,
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
    schema: "issue122-physical-v2",
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
    freeze_sha256: p.freeze_sha256,
    terminals: {},
    probes: {},
    repairs: {},
  });
  let calls = 0;
  async function send(
    model: StageModel,
    response: Response,
    usageRequest = true,
  ) {
    const lane = "probe--" + model,
      api = descriptor(model);
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
    const fetch = meteredFetch(args, async () => {
      calls++;
      return response;
    });
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
    });
    await (
      await fetch(api.baseUrl + (chat ? "/chat/completions" : "/responses"), {
        method: "POST",
        body,
      })
    ).text();
    return [...ledger(root).entries.values()].at(-1)!;
  }
  return { send, calls: () => calls, root };
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
