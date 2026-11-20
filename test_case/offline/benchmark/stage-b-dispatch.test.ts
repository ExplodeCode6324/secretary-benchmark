import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Domains } from "../../online/benchmark/domain.ts";
import { archiveFacility } from "../../online/benchmark/archive.ts";
import { randomUUID } from "node:crypto";
import {
  stageModels,
  stageSlots,
  checkAdmission,
  physicalBound,
  providerFailure,
  validatePhysical,
  physicalUsageKnown,
  type PhysicalPolicy,
} from "../../online/benchmark/stage-b-policy.ts";
import {
  createCampaign,
  ledger,
  reserve,
  settle,
  closeCampaign,
} from "../../online/benchmark/campaign.ts";
import { meteredFetch } from "../../online/benchmark/live-model.ts";
import {
  initialState,
  beforeLane,
  firstLaneFailure,
  driveWorklist,
} from "../../online/benchmark/stage-b-dispatch.ts";
import {
  checkPublication,
  forecastLane,
} from "../../online/benchmark/stage-b-freeze.ts";
import {
  repository,
  mkdir,
  readJSON,
  read,
  writeJSON,
  sha,
} from "../../online/benchmark/io.ts";
const clock = Date.now(),
  hash = sha("fixture-policy");
test("An explicit frozen C16 deferral retains all twelve slots and dispatches only the first nine workloads", async () => {
  assert.throws(
    () => initialState(hash, undefined as never),
    /C16_DECISION_REQUIRED/,
  );
  const state = initialState(hash, "DEFERRED_BY_DECISION");
  const saved = structuredClone(state.terminals);
  const dispatched: string[] = [];
  await driveWorklist(
    state,
    () => [],
    async (slot) => {
      dispatched.push(slot.lane);
      (slot.scenario === "probe" ? state.probes : state.terminals)[slot.lane] =
        {
          status: "COMPLETED",
          reason: "FIXTURE",
          at: new Date().toISOString(),
        };
    },
    () => assert.fail("no physical refusal expected"),
    false,
  );
  assert.deepEqual(
    dispatched.filter((lane) => !lane.startsWith("probe--")),
    stageSlots.slice(0, 9).map((s) => s.lane),
  );
  assert.equal(Object.keys(state.terminals).length, 12);
  for (const slot of stageSlots.slice(9)) {
    assert.equal(saved[slot.lane].status, "DEFERRED_BY_DECISION");
    assert.deepEqual(state.terminals[slot.lane], saved[slot.lane]);
  }
});
test("Closed probe-only Stage B facility archives exact frozen files and refuses changed or unclaimed data", async () => {
  const root = path.join(repository, ".local/benchmark/tests", randomUUID());
  const destination = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "stage-b-archive-")),
  );
  try {
    await Domains.use(root, async (domains) => {
      const b0 = path.join(root, "configs/issue122-b0.json"),
        inputs = path.join(root, "configs/stage-b-inputs.json"),
        frozen = path.join(root, "configs/stage-b-freeze.json");
      writeJSON(b0, { fixture: "B0" });
      writeJSON(inputs, { fixture: "price and calibration hashes" });
      writeJSON(frozen, {
        schema: "issue122-stage-b-freeze-v2",
        inputs: readJSON(inputs),
        b0_sha256: sha(read(b0)),
      });
      const bound = { ...policy(), freeze_sha256: sha(read(frozen)) };
      await createCampaign(root, randomUUID(), undefined, undefined, bound);
      const state = initialState(bound.freeze_sha256, "DISPATCH");
      const terminal = {
        status: "HALTED" as const,
        reason: "OPERATOR",
        at: new Date().toISOString(),
      };
      for (const model of stageModels)
        state.probes["probe--" + model] = terminal;
      for (const slot of stageSlots) state.terminals[slot.lane] = terminal;
      state.ended = true;
      writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), state);
      writeJSON(
        path.join(root, "campaign/probes", randomUUID(), "http-fixture.json"),
        { status: 429 },
      );
      await domains.closeStoppedCampaign();
    });
    assert.equal((await archiveFacility(root, destination)).status, "DRY_RUN");
    const b0 = path.join(root, "configs/issue122-b0.json");
    writeJSON(b0, { fixture: "altered" });
    await assert.rejects(
      () => archiveFacility(root, destination),
      /INPUT_CHANGED/,
    );
    writeJSON(b0, { fixture: "B0" });
    writeJSON(path.join(root, "configs/unknown.json"), {});
    await assert.rejects(
      () => archiveFacility(root, destination),
      /CONFIG_UNSUPPORTED/,
    );
    fs.unlinkSync(path.join(root, "configs/unknown.json"));
  } finally {
    fs.rmSync(destination, { recursive: true });
  }
});
function policy(): PhysicalPolicy {
  const providers = Object.fromEntries(
    stageModels.map((model) => [
      model,
      {
        checked_at: new Date(clock - 1000).toISOString(),
        published_version: "offline version",
        allowed_returned_models: [model],
        provenance_sha256: sha("test pages"),
        publication_url:
          model === "deepseek-flash"
            ? "https://api-docs.deepseek.com/quick_start/pricing"
            : "https://developers.openai.com/api/docs/models/" + model,
        input_rate: 1,
        output_rate: 1,
        cache_input_rate: 1,
        tier: "default",
        cache_retention: "default",
        context_band: "all-admitted-input",
        context_upper_tokens: 1000,
        max_input_bytes: 1000,
        max_requested_output: 48,
        billed_output: model === "deepseek-flash" ? 128 : "REQUEST_CAP",
      },
    ]),
  ) as PhysicalPolicy["providers"];
  return { schema: "issue122-physical-v2", freeze_sha256: hash, providers };
}
test("Stage B binds all grants, physical components and first-send calendar independently of USD", () => {
  const p = policy();
  validatePhysical(p);
  for (const legacy of [
    { schema: "baseline-v1" },
    { ...p, ceiling_usd: null },
    { ...p, ceiling_usd: 0 },
  ])
    assert.throws(() => validatePhysical(legacy as PhysicalPolicy));
  assert.equal(stageSlots.length, 12);
  for (const model of stageModels)
    assert.deepEqual(
      stageSlots.filter((s) => s.model === model).map((s) => s.cap),
      [160, 160, 160, 157],
    );
  const lane = stageSlots[0];
  const attempt = {
    model: lane.model,
    lane: lane.lane,
    episode: "episode",
    at: new Date(clock).toISOString(),
  };
  const check = (
    prior: (typeof attempt)[],
    id = lane.lane,
    episode = "episode",
    time = clock,
  ) => checkAdmission(p, prior, id, lane.model, episode, time);
  check([]);
  assert.throws(() => check([attempt], lane.lane, "another"), /LINEAGE/);
  assert.throws(
    () => check([attempt], lane.lane, "episode", clock + 3600000),
    /LANE_TIME/,
  );
  assert.throws(
    () => check([attempt], stageSlots[5].lane, "other", clock + 43200000),
    /CAMPAIGN_TIME/,
  );
  assert.throws(() => check(Array(160).fill(attempt)), /REQUEST_LIMIT/);
  assert.throws(
    () =>
      check(Array(481).fill({ ...attempt, lane: "older", episode: "older" })),
    /REQUEST_LIMIT/,
  );
  assert.throws(
    () =>
      check(
        Array(1800).fill({
          ...attempt,
          model: "gpt-6-luna",
          lane: "older",
          episode: "older",
        }),
      ),
    /REQUEST_LIMIT/,
  );
  assert.throws(
    () => check([], lane.lane, "episode", clock + 86400000),
    /STALE_PROVENANCE/,
  );
  for (const [bytes, output] of [
    [1001, 1],
    [5, 49],
    [0, 48],
  ])
    assert.throws(
      () => physicalBound(p, lane.model, bytes, output, "main"),
      /BODY_BOUND/,
    );
  assert.equal(
    physicalBound(p, "deepseek-flash", 500, 48, "task").output_tokens,
    128,
  );
  assert.equal(
    physicalUsageKnown({
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 2 },
    }),
    false,
  );
});
test("Only attributable provider account errors authorize comparator exclusion", () => {
  const model = "deepseek-flash";
  const lane = "probe--" + model;
  const attempted: Parameters<typeof beforeLane>[1] = [
    {
      settled: true,
      charged_usd: 1,
      outcome: "IDENTITY_MISMATCH_FIRST_CONTACT",
      attempt: {
        id: "fixture",
        run: "fixture",
        lane,
        model,
        episode: "fixture",
        at: new Date(clock).toISOString(),
        reserved_usd: 1,
        pid: 1,
        request_sha256: hash,
      },
    },
  ];
  assert.equal(
    firstLaneFailure(attempted, lane)?.reason,
    "IDENTITY_MISMATCH_FIRST_CONTACT",
  );
  const later = beforeLane(
    initialState(hash, "DISPATCH"),
    attempted,
    model,
    clock,
  );
  assert.equal(typeof later === "object" && later.reason, "IDENTITY_HOLD");
  const failure = (
    model: (typeof stageModels)[number],
    status: number,
    code: string,
  ) =>
    providerFailure(
      model,
      status,
      Buffer.from(JSON.stringify({ error: { code } })),
    );
  for (const id of ["gpt-6-luna", "gpt-6.2-sol"] as const) {
    assert.equal(failure(id, 429, "insufficient_quota"), "EXHAUSTED_QUOTA");
    assert.equal(failure(id, 429, "rate_limit_exceeded"), "RATE_LIMITED");
    assert.equal(failure(id, 402, ""), "UNKNOWN");
    assert.equal(failure(id, 503, "insufficient_quota"), "TRANSIENT");
    assert.equal(failure(id, 403, ""), "UNKNOWN");
  }
  assert.equal(failure("deepseek-flash", 402, ""), "EXHAUSTED_QUOTA");
  assert.equal(
    failure("deepseek-flash", 429, "insufficient_quota"),
    "RATE_LIMITED",
  );
});
test("Sender fsyncs physical reservations and enforces cross-model stop even when computed dollars fall", async () => {
  const p = policy(),
    root = path.join(repository, ".local/benchmark/tests", randomUUID()),
    model = "gpt-6-luna",
    lane = "probe--" + model,
    episode = randomUUID();
  const evidence = path.join(root, "evidence", episode);
  mkdir(evidence);
  await createCampaign(root, randomUUID(), undefined, undefined, p);
  const state = initialState(hash, "DISPATCH");
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), state);
  const activate = (id: string, subject: string, lineage: string) =>
    writeJSON(path.join(root, "campaign/active-stage-b.json"), {
      state: "OPEN",
      lane: id,
      model: subject,
      episode: lineage,
      freeze_sha256: hash,
    });
  activate(lane, model, episode);
  let calls = 0;
  const stream = meteredFetch(
    {
      root,
      model,
      run: episode,
      episode,
      lane,
      evidence,
      key: "offline-test-key",
      maxSends: 3,
      stageFreeze: hash,
    },
    async () => {
      calls++;
      assert.equal(ledger(root).entries.size, calls);
      const data = {
        model,
        usage: {
          input_tokens: 1,
          output_tokens: 21,
          output_tokens_details: { reasoning_tokens: 20 },
        },
      };
      return new Response(
        "data: " + JSON.stringify(data) + "\n\ndata: [DONE]\n\n",
      );
    },
  );
  const payload = { model, stream: true, max_output_tokens: 20 };
  const send = (body: object) =>
    stream("https://api.openai.com/v1/responses", {
      method: "POST",
      body: JSON.stringify(body),
    });
  try {
    await assert.rejects(
      () => send({ ...payload, service_tier: "priority" }),
      /PRICING_TIER/,
    );
    await (await send(payload)).text();
    const records = [...ledger(root).entries.values()],
      entry = records[0];
    assert.equal(entry.component_violation, true);
    assert(entry.charged_usd < entry.attempt.reserved_usd);
    assert.equal(
      firstLaneFailure(records, lane)?.status,
      "STOPPED_BOUND_VIOLATION",
    );
    assert.deepEqual(
      stageSlots
        .map((slot) => beforeLane(state, records, slot.model, Date.now()))
        .map((row) => (typeof row === "object" ? row.status : row)),
      Array(12).fill("STOPPED_BOUND_VIOLATION"),
    );
    const other = stageSlots[0];
    activate(other.lane, other.model, "another");
    await assert.rejects(
      () =>
        reserve(root, {
          model: other.model,
          episode: "another",
          lane: other.lane,
          run: "another",
          reserved_usd: 1,
          request_sha256: hash,
          physical: physicalBound(p, other.model, 40, 20, "main"),
        }),
      /BOUND_VIOLATION/,
    );
    assert.equal(calls, 1);
  } finally {
    await closeCampaign(root);
  }
});
test("Unknown costs retain full reservation, primary repair preserves counters and comparator identity holds are scoped", async () => {
  const root = path.join(repository, ".local/benchmark/tests", randomUUID()),
    p = policy(),
    state = initialState(hash, "DISPATCH");
  await createCampaign(root, randomUUID(), undefined, undefined, p);
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), state);
  try {
    for (const [model, outcome] of [
      ["deepseek-flash", "AUTH"],
      ["gpt-6-luna", "EXHAUSTED_QUOTA"],
      ["gpt-6.2-sol", "VERSION_TRANSITION"],
    ] as const) {
      const lane = "probe--" + model;
      writeJSON(path.join(root, "campaign/active-stage-b.json"), {
        state: "OPEN",
        lane,
        model,
        episode: lane,
        freeze_sha256: hash,
      });
      const details = {
        model,
        lane,
        episode: lane,
        run: lane,
        request_sha256: hash,
        reserved_usd: 0.01,
      };
      await assert.rejects(() => reserve(root, details), /PHYSICAL_REQUIRED/);
      const id = await reserve(root, {
        ...details,
        physical: physicalBound(p, model, 40, 20, "probe"),
      });
      await settle(root, id, outcome, null, null);
      const rows = [...ledger(root).entries.values()];
      assert.equal(rows.at(-1)!.charged_usd, 0.01);
      if (model === "deepseek-flash") {
        assert.equal(beforeLane(state, rows, "gpt-6.2-sol", clock), "PAUSE");
        state.repairs[id] = new Date().toISOString();
        writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), state);
        assert.equal(
          beforeLane(state, rows, "deepseek-flash", clock),
          undefined,
        );
      } else {
        const early = beforeLane(state, rows, model, clock);
        assert.equal(
          typeof early === "object" && early.reason,
          model === "gpt-6-luna" ? "EXHAUSTED_QUOTA" : "VERSION_HOLD",
        );
      }
    }
    assert.equal(ledger(root).entries.size, 3);
    const manifest = path.join(root, "campaign/manifest.json"),
      original = readJSON(manifest);
    const downgraded = { ...original, ceiling_usd: null };
    delete downgraded.physical_policy;
    writeJSON(manifest, downgraded);
    try {
      await assert.rejects(
        () =>
          reserve(root, {
            model: "deepseek-flash",
            run: "legacy",
            request_sha256: hash,
            reserved_usd: 0,
          }),
        /REGISTRY_MISMATCH/,
      );
    } finally {
      writeJSON(manifest, original);
    }
  } finally {
    await closeCampaign(root);
  }
});
test("Freeze publication change and full-workload time risk are detectable without provider access", async () => {
  const page = {
    url: "https://api-docs.deepseek.com/quick_start/pricing",
    sha256: sha("v1"),
  };
  await checkPublication([page], async () => new Response("v1"));
  await assert.rejects(
    () => checkPublication([page], async () => new Response("v2")),
    /PROVENANCE_CHANGE/,
  );
  const forecast = forecastLane(
    [{ action: "MASTER_MESSAGE" }, { action: "IDLE_WAIT", seconds: 60 }],
    policy().providers["deepseek-flash"],
    {
      ordinary_sends_per_turn: 2,
      sends_per_maintenance: 3,
      extra_task_sends: 1,
      seconds_per_send: 800,
      restart_seconds: 20,
      observation_seconds: 2,
      expected_input_tokens: 50,
      expected_output_tokens: 10,
    },
    157,
  );
  assert.equal(forecast.expected_sends, 5);
  assert.equal(forecast.expected_seconds, 4060);
  assert(forecast.over_lane_limits);
});
test("Twelve ordered trial dispositions survive a primary pause and repair without reroll; control quota and identity use separate denominators", async () => {
  const state = initialState(hash, "DISPATCH"),
    records: Parameters<typeof beforeLane>[1] = [];
  const attempted: string[] = [];
  const record = (lane: string, decision: (typeof state.terminals)[string]) => {
    const rows = lane.startsWith("probe--") ? state.probes : state.terminals;
    assert(!rows[lane]);
    rows[lane] = decision;
  };
  const drive = () =>
    driveWorklist(
      state,
      () => records,
      async (slot) => {
        const lane = slot.lane,
          id = randomUUID(),
          at = new Date(clock).toISOString();
        assert(!attempted.includes(lane));
        attempted.push(lane);
        const outcome =
          slot.scenario !== "C05-W"
            ? "RESPONSE_COMPLETE"
            : slot.model === "deepseek-flash"
              ? "AUTH"
              : slot.model === "gpt-6-luna"
                ? "VERSION_TRANSITION"
                : "EXHAUSTED_QUOTA";
        records.push({
          attempt: {
            id,
            model: slot.model,
            lane,
            episode: id,
            run: id,
            at,
            pid: 1,
            reserved_usd: 1,
            request_sha256: hash,
          },
          outcome,
          settled: true,
          settled_sequence: records.length + 1,
          charged_usd: 1,
        });
        record(
          lane,
          firstLaneFailure(records, lane) ?? {
            status: "COMPLETED",
            reason: "FIXTURE_PROTOCOL",
            at,
          },
        );
      },
      record,
      false,
      () => clock,
    );
  const pause = await drive();
  assert.equal(pause?.state, "PAUSED_PRIMARY");
  assert.equal(Object.keys(state.terminals).length, 1);
  const first = structuredClone(state.terminals);
  state.repairs[pause!.attempt] = new Date(clock + 1000).toISOString();
  await drive();
  assert.equal(Object.keys(state.terminals).length, 12);
  assert.equal(Object.keys(state.probes).length, 3);
  assert.deepEqual(
    state.terminals[stageSlots[0].lane],
    first[stageSlots[0].lane],
  );
  const status = Object.values(state.terminals).map((r) => r.status);
  for (const [key, count] of Object.entries({
    COMPLETED: 3,
    INCOMPLETE: 2,
    VERSION_TRANSITION: 1,
    NOT_DISPATCHED_PREFLIGHT: 3,
    SKIPPED_CONTROL_QUOTA: 3,
  }))
    assert.equal(status.filter((s) => s === key).length, count);
});
