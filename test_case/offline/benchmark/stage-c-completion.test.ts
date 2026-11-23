import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { legacyLayout } from "../../online/benchmark/stage-c.ts";
import {
  describeTrial,
  prospectiveMatrix,
} from "../../online/benchmark/stage-c-plan.ts";
import { wireIdentity } from "../../online/benchmark/stage-c-identity.ts";
import { countRecoveryWrites } from "../../online/benchmark/stage-c-recovery.ts";
import { installStageCFault } from "../../online/benchmark/stage-c-fault.ts";
import { jobsAtCap } from "../../online/benchmark/stage-c-correction.ts";
import { lines } from "../../online/benchmark/stage-b-scenarios-evidence.ts";
import { sha } from "../../online/benchmark/io.ts";

test("read both archived v1 layouts and reject mixed row fields", () => {
  const rows = ["r35", "r36"].map(
    (v) =>
      JSON.parse(
        fs.readFileSync(
          new URL("./fixtures/stage-c/" + v + ".json", import.meta.url),
          "utf8",
        ),
      ).row,
  );
  assert.deepEqual(rows.map(legacyLayout), [
    "R35_TEMPLATE",
    "R36_TEMPLATE_AND_FIXTURE",
  ]);
  assert.throws(
    () => legacyLayout({ ...rows[0], ...rows[1] }),
    /UNKNOWN_LEGACY_LAYOUT/,
  );
});
test("model and lineage selections preserve the shared source and all C16 repeats", () => {
  const matrix = prospectiveMatrix();
  assert.equal(
    matrix.rows.filter((r) => r.scenario === "C16-combined").length,
    3,
  );
  const a = describeTrial(
      "C02-incidental",
      1,
      "deepseek-flash",
      "OFFLINE_FIXTURE",
    ),
    b = describeTrial("C02-implicit", 1, "deepseek-flash", "OFFLINE_FIXTURE");
  assert.equal(a.seed, b.seed);
  assert.equal(a.lineage_group, b.lineage_group);
  assert.notEqual(a.external_inputs_sha256, b.external_inputs_sha256);
  assert.throws(
    () => describeTrial("C16-combined", 1, "deepseek-flash", "BASELINE"),
    /CAPACITY_RECIPE_REQUIRED/,
  );
  assert.throws(
    () => prospectiveMatrix({}, ["deepseek-flash", "deepseek-flash"]),
    /MODEL_SELECTION/,
  );
});
test("wire identifies absent, unknown and changing fingerprints per send", () => {
  const observer = wireIdentity(
    new Headers({ "x-request-id": "req_1" }),
    "secret-token",
  );
  assert.equal(observer.receipt(false).fingerprint_status, "UNKNOWN");
  observer.observe({ id: "resp1" });
  assert.equal(observer.receipt(true).fingerprint_status, "ABSENT");
  observer.observe({ response: { id: "resp1", system_fingerprint: "fp_a" } });
  observer.observe({ id: "resp1", system_fingerprint: "fp_b" });
  const r = observer.receipt(true);
  assert.deepEqual(
    [r.response_ids, r.provider_request_ids, r.system_fingerprints],
    [["resp1"], ["req_1"], ["fp_a", "fp_b"]],
  );
  assert.equal(r.fingerprint_status, "CHANGED_WITHIN_SEND");
});
test("the correction cutoff excludes a job exactly at the cutoff", () => {
  const job = {
    record_type: "CompactionJob",
    session_id: "s",
    mode: "WORKING_MEMORY",
    id: "job",
    updated_at: "2026-11-23T00:00:00.000Z",
  };
  assert.equal(
    jobsAtCap([{ records: [job], events: [] }], "s", Date.parse(job.updated_at))
      .length,
    0,
  );
});
test("post-restart finish counts verified wrong bytes and duplicate writes and parks on inconsistent proof", (t) => {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "issue122-write-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const resource = path.join(dir, "continuity.txt");
  fs.writeFileSync(path.join(dir, "stage-c-barrier.json"), "{}");
  const op = {
    id: "o",
    scope: { execution_id: "e" },
    action: { action: "file.write", resource, parameters_hash: "p" },
    state: "DISPATCHED",
  };
  let cas = Buffer.from("wrong");
  const auth = {
    dispatch() {},
    finish(_id: string, _receipt: unknown, _outcome: string) {},
  };
  installStageCFault(
    {
      authorization: auth,
      store: {
        get: () => op,
        find: () => ({ owner_id: "domain" }),
        bytes: () => cas,
      },
    } as any,
    { id: "run", lineage: "lineage", evidence: dir } as any,
    () => {
      throw Error("PARKED");
    },
  );
  const finish = () =>
    auth.finish("o", { result: {}, evidence: { sha256: sha(cas) } }, "APPLIED");
  fs.writeFileSync(resource, cas);
  finish();
  const log = path.join(dir, "stage-c-physical-writes.jsonl");
  const [wrong] = lines(log);
  assert.equal(wrong.observed_hash, sha("wrong"));
  assert.equal(countRecoveryWrites([wrong], [wrong], wrong, false), "FAIL");
  cas = Buffer.from("alpha");
  fs.writeFileSync(resource, cas);
  finish();
  finish();
  const good = lines(log).slice(1);
  assert.equal(countRecoveryWrites([good[0]], good, good[0], false), "FAIL");
  fs.writeFileSync(resource, "bad");
  assert.throws(finish, /PARKED/);
  assert.equal(lines(log).length, 3);
});

import { completionCommand } from "../../online/benchmark/stage-c-dispatch.ts";
import { c16Disposition } from "../../online/benchmark/stage-c-observations.ts";
import { flashBilling } from "../../online/benchmark/stage-c-identity.ts";
import {
  checkAdmission,
  type PhysicalPolicy,
} from "../../online/benchmark/stage-b-policy.ts";
import { repository } from "../../online/benchmark/io.ts";
test("completion start refuses historical approval before facility or upstream access", async () => {
  const root = path.join(
    repository,
    ".local/benchmark/tests",
    "unapproved-" + process.pid,
  );
  await assert.rejects(
    () => completionCommand(root, "start", "issue122-stage-b", sha("fixture")),
    /APPROVAL_BINDING/,
  );
  assert(!fs.existsSync(root));
});
test("a scheduled lineage has its own explicit attempt and time limits and fresh source", () => {
  const checked = "2026-11-23T00:00:00Z",
    now = Date.parse(checked);
  const l = {
    lane: "r1-C16-combined--deepseek-flash",
    scenario: "C16-combined",
    model: "deepseek-flash",
    repeat: 1,
    seed: 122,
    profile: "RC98304",
    cap: 340,
    seconds: 7200,
  } as const;
  const p = {
    schema: "issue122-completion-physical-v1",
    freeze_sha256: sha("freeze"),
    providers: {
      "deepseek-flash": {
        checked_at: checked,
        published_version: "example",
        allowed_returned_models: ["deepseek-flash"],
        publication_url: "https://api-docs.deepseek.com/quick_start/pricing.md",
        tier: "default",
        cache_retention: "default",
        context_band: "all-admitted-input",
        context_upper_tokens: 1000000,
        cache_input_rate: 0.006,
        cache_write_rate: 0.3,
        input_rate: 0.3,
        output_rate: 1.2,
        max_input_bytes: 1000000,
        max_requested_output: 384000,
        billed_output: 393216,
        provenance_sha256: sha("price"),
      },
    },
    lanes: [l],
    batch_seconds: 43200,
  } as PhysicalPolicy;
  const a = { model: l.model, lane: l.lane, episode: "line", at: checked };
  assert.doesNotThrow(() =>
    checkAdmission(
      p,
      Array(200).fill(a),
      l.lane,
      l.model,
      "line",
      now + 4000000,
    ),
  );
  assert.throws(
    () =>
      checkAdmission(
        p,
        Array(340).fill(a),
        l.lane,
        l.model,
        "line",
        now + 4000000,
      ),
    /REQUEST_LIMIT/,
  );
  assert.throws(
    () => checkAdmission(p, [a], l.lane, l.model, "line", now + 7200000),
    /LANE_TIME/,
  );
  assert.throws(
    () => checkAdmission(p, [], l.lane, l.model, "line", now + 86400000),
    /STALE_PROVENANCE/,
  );
  assert.throws(
    () => checkAdmission(p, [a], l.lane, l.model, "other", now),
    /LINEAGE_CHANGED/,
  );
});
test("a conclusive retention failure closes C16 only alongside every structural and semantic witness", () => {
  const visibility = {
    measured: true,
    opaque: false,
    raw_projection_exit: "LITERAL_EXIT",
    original_projection_exit: "SOURCE_EXIT",
  };
  const proof = {
    requirements: [],
    outcome: { probe_send: "s" },
    cold: {
      source_event: "ev",
      source_input: "i",
      restart_observed: true,
      pre_restart_send: "s0",
      pre_restart: visibility,
      probe: visibility,
    },
    maintenance: {
      samples: [
        { job: "j1", covered: 10 },
        { job: "j2", covered: 20 },
      ],
    },
  } as any;
  const ref = { source: { event: "ev", input: "i" }, result: "PASS" } as any;
  const grade = {
    visibility: "RESIDENT",
    maintenance: "PASS",
    use: "PASS",
    audited_surfaces: true,
  } as const;
  const chain = { complete: true, final: true, original_delivered: false };
  assert.equal(c16Disposition(proof, ref, grade, chain, true).verdict, "PASS");
  assert.equal(
    c16Disposition(proof, ref, { ...grade, visibility: "COLD" }, chain, true)
      .verdict,
    "FAIL",
  );
  assert.equal(
    c16Disposition(proof, { ...ref, result: "FAIL" }, grade, chain, true)
      .verdict,
    "FAIL",
  );
  assert.equal(
    c16Disposition(
      proof,
      { ...ref, result: "FAIL" },
      { ...grade, visibility: "OPAQUE" },
      chain,
      true,
    ).gate,
    "OPEN",
  );
  assert.equal(
    c16Disposition(proof, { ...ref, result: "UNRESOLVED" }, grade, chain, true)
      .gate,
    "OPEN",
  );
  assert.equal(c16Disposition(proof, ref, grade, chain, false).gate, "OPEN");
});
test("schedule prices weekend usage exactly and bounds potential weekday peak billing", () => {
  const stamp = (s: string) => Date.parse("2026-11-" + s + "Z");
  assert.equal(
    flashBilling(10, stamp("22T02:00:00"), stamp("22T02:01:00")).exact,
    5,
  );
  assert.equal(
    flashBilling(10, stamp("23T00:59:55"), stamp("23T01:00:02")).maximum,
    10,
  );
  assert.equal(
    flashBilling(10, stamp("23T02:00:00"), stamp("23T02:01:00")).exact,
    null,
  );
});
