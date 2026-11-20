import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendJSON,
  mkdir,
  read,
  readJSON,
  repository,
  sha,
  writeJSON,
} from "../../online/benchmark/io.ts";
import {
  buildStageBReport,
  prepareStageBCalibration,
  beginStageBCalibration,
  finishStageBCalibration,
  prepareStageBGrade,
  beginStageBGrade,
  finishStageBGrade,
} from "../../online/benchmark/stage-b-report.ts";
import {
  calibrationBase,
  type CalibrationBinding,
} from "../../online/benchmark/stage-b-report-calibration.ts";
import {
  stageModels,
  stageSlots,
  type ProviderRule,
} from "../../online/benchmark/stage-b-policy.ts";
import { baselineCases } from "../../online/benchmark/baseline-scenarios.ts";
import { attributeLane } from "../../online/benchmark/stage-b-report-publication.ts";

const date = (n: number) =>
  new Date(Date.UTC(2026, 10, 20, 12, n)).toISOString();
const judge = { model: "Opus 5.5", effort: "Extra" };
function facility(t: TestContext) {
  const root = path.join(
    repository,
    ".local/benchmark",
    "test-stage-b-report-" + randomUUID(),
  );
  mkdir(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function pages(url: string) {
  return [{ url, sha256: sha("synthetic published page") }];
}
function rule(model: string): ProviderRule {
  const url =
    model === "deepseek-flash"
      ? "https://api-docs.deepseek.com/fixture"
      : "https://openai.com/fixture";
  return {
    checked_at: date(0),
    published_version: model,
    allowed_returned_model: model,
    publication_url: url,
    tier: "default",
    cache_retention: "default",
    context_band: "all-admitted-input",
    context_upper_tokens: 4096,
    input_rate: 2,
    cache_input_rate: 1,
    output_rate: 5,
    provenance_sha256: sha(JSON.stringify(pages(url))),
    max_input_bytes: 2048,
    max_requested_output: 64,
    billed_output: 64,
  };
}
function dossier(root: string, b: CalibrationBinding) {
  const providers = Object.fromEntries(stageModels.map((m) => [m, rule(m)]));
  const cases = baselineCases(true);
  const freeze = {
    schema: "issue122-stage-b-freeze-v2",
    expected_usd: 3,
    worst_usd: 9,
    inputs: {
      providers,
      calibration_packet_sha256: b.packet_sha256,
      calibration_key_sha256: b.private_key_sha256,
    },
    estimates: stageModels.map((model) => ({
      model,
      expected_usd: 1,
      worst_usd: 3,
    })),
    worklist: stageSlots.map((s) => ({
      ...s,
      oracle_sha256: sha(
        JSON.stringify(cases.find((c) => c.id === s.scenario)!.oracle),
      ),
      timeline_sha256: sha(s.scenario),
      input_sha256: sha(s.lane),
      forecast: {
        expected_usd: 0.25,
        worst_usd: 0.75,
        expected_seconds: 900,
        expected_sends: 11,
        over_lane_limits: false,
      },
    })),
  };
  const file = path.join(root, "configs/stage-b-freeze.json");
  writeJSON(file, freeze);
  const hash = sha(read(file));
  writeJSON(path.join(root, "campaign/manifest.json"), {
    version: 1,
    approval_id: "offline-fixture",
    facility: root,
    state: "CLOSED",
    physical_policy: {
      schema: "issue122-physical-v2",
      freeze_sha256: hash,
      providers,
    },
  });
  return hash;
}
function answer(root: string, b: CalibrationBinding) {
  return {
    judge,
    packet_sha256: b.packet_sha256,
    labels: readJSON<
      { id: string; expected: "PASS" | "FAIL" | "UNRESOLVED" }[]
    >(path.join(root, calibrationBase, "private/key.json")).map(
      ({ id, expected }) => ({ id, verdict: expected }),
    ),
  };
}
test("offline empty cohort shows planned coverage, null prices and no semantic or probe credit", (t) => {
  const root = facility(t),
    r = buildStageBReport(root);
  assert.equal(r.planned_slots, 12);
  assert.equal(r.counts_by_disposition.PLANNED, 12);
  assert.equal(r.terminal_slots, 0);
  assert.equal(r.overall.worst_usd, null);
  assert.equal(r.overall.invoice_usd, null);
  assert.deepEqual(r.probes, []);
  assert.ok(
    r.slots.every((s) => s.semantic.exercised === 0 && s.semantic.passed === 0),
  );
  assert.equal(r.slots[9].lane_cap, 157);
  assert.deepEqual(
    readJSON(path.join(root, "reports/issue122-stage-b.json")),
    r,
  );
});
test("calibration is private, prepared once, frozen on disk, and failed semantic submission is final", async (t) => {
  const root = facility(t),
    binding = await prepareStageBCalibration(root);
  assert.deepEqual(await prepareStageBCalibration(root), binding);
  const packetFile = path.join(root, calibrationBase, "blind.json"),
    keyFile = path.join(root, calibrationBase, "private/key.json");
  assert.equal(binding.packet_sha256, sha(read(packetFile)));
  assert.equal(binding.private_key_sha256, sha(read(keyFile)));
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const packet = readJSON(packetFile),
    controls = packet.controls;
  assert.equal(controls.length, 22);
  assert.equal(new Set(controls.map((r: any) => r.assertion)).size, 10);
  assert.ok(
    controls.every(
      (r: any) => Object.keys(r).sort().join(",") === "assertion,id,text",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(binding),
    /controls":\[|expected|private\/key/,
  );
  dossier(root, binding);
  await assert.rejects(
    beginStageBCalibration(root, {
      ...binding,
      private_key_sha256: sha("other"),
    }),
    /FREEZE_MISMATCH/,
  );
  await beginStageBCalibration(root, binding);
  await assert.rejects(beginStageBCalibration(root, binding), /ATTEMPT_OPEN/);
  const bad = answer(root, binding);
  bad.labels[0].verdict = bad.labels[0].verdict === "PASS" ? "FAIL" : "PASS";
  const failed = await finishStageBCalibration(root, binding, 1, bad);
  assert.equal(failed.status, "FAILED");
  await assert.rejects(
    beginStageBCalibration(root, binding),
    /RETRY_FORBIDDEN/,
  );
  await assert.rejects(
    prepareStageBGrade(root, stageSlots[0].lane),
    /CALIBRATION_REQUIRED/,
  );
  assert.equal(buildStageBReport(root).calibration.first_failure, "FAILED");
  fs.appendFileSync(packetFile, " ");
  await assert.rejects(
    prepareStageBCalibration(root),
    /COMMITTED_FILE_CHANGED/,
  );
});
test("three identical mechanical attempts exhaust the only calibration batch", async (t) => {
  const root = facility(t),
    binding = await prepareStageBCalibration(root);
  dossier(root, binding);
  for (let i = 1; i <= 3; i++) {
    const reserved = await beginStageBCalibration(root, binding);
    assert.equal(reserved.number, i);
    assert.equal(reserved.packet_sha256, binding.packet_sha256);
    const receipt = await finishStageBCalibration(root, binding, i, {
      mechanical: "NO_RESPONSE",
      evidence_sha256: sha("fixture" + i),
    });
    assert.equal(receipt.first_failure, "NO_RESPONSE");
  }
  await assert.rejects(
    beginStageBCalibration(root, binding),
    /RETRY_FORBIDDEN/,
  );
});

function trialFixture(root: string, freeze: string, text: string) {
  const slot = stageSlots[6],
    episode = randomUUID(),
    run = randomUUID(),
    lane = slot.lane,
    model = slot.model;
  const dir = path.join(root, "evidence", run),
    proof = {
      journal_digest: sha("journal"),
      requirements: [],
      outcome: { probe_payload: sha("wire"), probe_response: sha("answer") },
      excerpts: [{ kind: "probe_reply", source_sha256: sha("answer"), text }],
      task: {
        condition_met_or_answered: true,
        window_complete: true,
        matching_writes: 2,
        physical_writes: 2,
        unknown_writes: 0,
        effects: "FAIL",
      },
    };
  const excerpt = path.join(dir, "stage-b-semantic-evidence.json");
  writeJSON(excerpt, {
    schema: "issue122-stage-excerpts-v1",
    excerpts: proof.excerpts,
  });
  const file = path.join(dir, "stage-b-evidence.json");
  writeJSON(file, {
    schema: "issue122-stage-scenario-evidence-v1",
    episode,
    lane,
    freeze_sha256: freeze,
    timeline_sha256: sha(slot.scenario),
    failures: [],
    trail: {},
    proof,
    excerpts_sha256: sha(read(excerpt)),
    semantic: "UNRESOLVED",
  });
  const evidence = sha(read(file));
  writeJSON(path.join(dir, "seal.json"), {
    id: run,
    files: [
      { path: path.basename(file), sha256: evidence, bytes: read(file).length },
    ],
  });
  const terminal = {
    status: "COMPLETED",
    at: date(5),
    reason: "PROTOCOL_COMPLETE",
    episode,
    evidence,
  };
  const state = {
    schema: "issue122-dispatch-v2",
    end_checked: true,
    freeze_sha256: freeze,
    terminals: {
      [lane]: terminal,
      [stageSlots[0].lane]: {
        status: "NOT_DISPATCHED_PREFLIGHT",
        reason: "a private host string",
        at: date(1),
      },
    },
  };
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), state);
  let previous = "0".repeat(64),
    sequence = 0;
  function frame(event: unknown) {
    sequence++;
    const hash = sha(JSON.stringify(event) + previous + sequence);
    appendJSON(path.join(root, "campaign/attempts.jsonl"), {
      previous,
      sequence,
      hash,
      event,
    });
    previous = hash;
  }
  function attempt(which: string, role: string, response: boolean) {
    const id = randomUUID();
    frame({
      type: "RESERVE",
      attempt: {
        id,
        at: date(2),
        model,
        lane: which,
        run: which === lane ? run : randomUUID(),
        episode: which === lane ? episode : randomUUID(),
        request_sha256: sha(id),
        reserved_usd: 0.01,
        physical: {
          freeze_sha256: freeze,
          input_bytes: 1000,
          requested_output: 64,
          output_tokens: 64,
          role,
        },
      },
    });
    frame({
      type: "SETTLE",
      id,
      at: date(3),
      outcome: response ? "RESPONSE_COMPLETE" : "RATE_LIMITED",
      actual_usd: response ? 0.000055 : null,
      usage: response
        ? {
            returned_model: model,
            provider: {
              input_tokens: 20,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 10 },
              output_tokens_details: { reasoning_tokens: 2 },
              raw: "a private host string",
            },
          }
        : {
            status: 429,
            error_sha256: sha("private raw error"),
            raw: "a private host string",
          },
    });
  }
  attempt("probe--" + model, "probe", true);
  attempt(lane, "main", false);
  attempt(lane, "task", true);
  const journal = path.join(root, "campaign/publication.jsonl"),
    pub = pages(rule(model).publication_url);
  for (const [point, at] of [
    [lane + ":start", date(1)],
    [lane + ":end", date(4)],
    ["campaign:end", date(6)],
  ])
    appendJSON(journal, { at, point, model, pages: pub, status: "MATCH" });
  return { lane, model, state, journal, episode };
}
test("offline dispatcher, ledger, sealed excerpts, price provenance and one-shot grading compose", async (t) => {
  const root = facility(t),
    b = await prepareStageBCalibration(root),
    hash = dossier(root, b);
  const { lane, state } = trialFixture(
    root,
    hash,
    "The checklist was written exactly once.",
  );
  const before = buildStageBReport(root);
  assert.equal(before.terminal_slots, 2);
  assert.equal(before.slots[6].status, "COMPLETED");
  assert.equal(before.slots[6].semantic.exercised, 0);
  assert.equal(before.slots[6].first_failed_attempt?.outcome, "RATE_LIMITED");
  assert.equal(before.slots[6].host?.task?.effects, "FAIL");
  assert.equal(before.probes.length, 1);
  assert.equal(before.overall.physical_reservations, 3);
  assert.equal(before.overall.unknown_full_reservation_usd, 0.01);
  assert.equal(
    before.slots[6].attempts[1].provider_usage?.cached_input_tokens,
    10,
  );
  assert.equal(before.models[1].price_provenance?.context_upper_tokens, 4096);
  assert.equal(
    before.models[1].price_provenance?.cached_input_usd_per_million,
    1,
  );
  assert.equal(before.overall.invoice_usd, null);
  assert.doesNotMatch(
    JSON.stringify(before),
    /a private host string|checklist was written|private\/key/,
  );
  assert.equal(
    before.slots[6].identity,
    "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN",
  );
  await beginStageBCalibration(root, b);
  assert.equal(
    (await finishStageBCalibration(root, b, 1, answer(root, b))).status,
    "PASSED",
  );
  const batch = await prepareStageBGrade(root, lane);
  await assert.rejects(prepareStageBGrade(root, lane), /NO_OVERWRITE/);
  const attempt = await beginStageBGrade(root, lane, batch.packet_sha256);
  const packet = readJSON(path.join(root, attempt.blind_file));
  assert.doesNotMatch(
    JSON.stringify(packet),
    /gpt-6|deepseek|input_rate|oracles\/|\bFAIL\b|source_sha256|unknown_writes":"/,
  );
  const judgments = packet.assertions.map((assertion: string) => ({
    assertion,
    verdict: "PASS",
    rationale: "Synthetic fixture cites the scalar evidence.",
    evidence: [packet.evidence.find((r: any) => r.assertion === assertion).id],
  }));
  await finishStageBGrade(root, lane, batch.packet_sha256, 1, {
    judge,
    packet_sha256: batch.packet_sha256,
    judgments,
  });
  await assert.rejects(
    beginStageBGrade(root, lane, batch.packet_sha256),
    /RETRY_FORBIDDEN/,
  );
  const graded = buildStageBReport(root);
  assert.equal(graded.slots[6].semantic.exercised, 2);
  assert.equal(graded.slots[6].semantic.failed, 1);
  assert.equal(
    graded.slots[6].judgments.find((j) => j.assertion === "effects")
      ?.judge_verdict,
    "PASS",
  );
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), {
    ...state,
    end_checked: false,
  });
  assert.equal(buildStageBReport(root).slots[6].semantic.exercised, 0);
  await assert.rejects(
    beginStageBGrade(root, lane, batch.packet_sha256),
    /IDENTITY_HOLD/,
  );
});
test("blinding refuses a provider echo and fails closed on a changed scenario reference", async (t) => {
  const root = facility(t),
    b = await prepareStageBCalibration(root),
    hash = dossier(root, b);
  const { lane, state } = trialFixture(
    root,
    hash,
    "sk-fixture-private-sentinel",
  );
  await beginStageBCalibration(root, b);
  await finishStageBCalibration(root, b, 1, answer(root, b));
  await assert.rejects(prepareStageBGrade(root, lane), /BLIND_DISCLOSURE/);
  const original = state.terminals[lane];
  writeJSON(path.join(root, "campaign/stage-b-dispatch.json"), {
    ...state,
    terminals: { [lane]: { ...original, evidence: sha("changed") } },
  });
  assert.throws(() => buildStageBReport(root), /EVIDENCE_CHANGED/);
});
test("alias window requires attributable start, end and campaign-end receipts", () => {
  const { lane, model } = stageSlots[0],
    r = rule(model);
  const sends = [
    {
      at: date(2),
      settled_at: date(4),
      outcome: "RESPONSE_COMPLETE",
      returned_model_sha256: sha(model),
    },
  ];
  const check = (entries: Parameters<typeof attributeLane>[0]) =>
    attributeLane(entries, lane, model, r, sends, true);
  const receipt = (point: string, n: number) => ({
    point,
    at: date(n),
    model,
    status: "MATCH" as const,
    pages: pages(r.publication_url),
  });
  const start = receipt(lane + ":start", 1),
    end = receipt(lane + ":end", 5),
    final = receipt("campaign:end", 6);
  assert.equal(
    check([start, end, final]),
    "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN",
  );
  assert.equal(
    check([start, { ...end, status: "CHANGED" }, final]),
    "SEGREGATED_PUBLICATION_TRANSITION",
  );
  assert.equal(
    check([start, { ...end, status: "UNAVAILABLE" }, final]),
    "SEGREGATED_PUBLICATION_UNCERTAIN",
  );
  assert.equal(
    check([start, { ...end, at: date(3) }, final]),
    "SEGREGATED_PUBLICATION_UNCERTAIN",
  );
  assert.equal(
    check([{ ...start, pages: [] }, end, final]),
    "SEGREGATED_PUBLICATION_UNCERTAIN",
  );
  assert.equal(check([start, end]), "HELD_CAMPAIGN_END_PUBLICATION");
});
