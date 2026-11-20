import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  baselineCases,
  baselineManifest,
} from "../../online/benchmark/baseline-scenarios.ts";
import {
  maintenanceBoundary,
  assertQuiescent,
  assertSameMemory,
  interruptionReuse,
  interruptionElements,
  worldBoundary,
  coldEvidence,
  effectVerdict,
  validateSemanticGrade,
  baselineVersion,
  routes,
} from "../../online/benchmark/baseline-evidence.ts";
import {
  validateBaselineLimits,
  baselineReservation,
  assertBaselineReservation,
  type BaselineLimits,
} from "../../online/benchmark/baseline-budget.ts";
import {
  baselinePair,
  pairRestoreGuard,
} from "../../online/benchmark/baseline-pair.ts";
import {
  calibrationControls,
  validateCalibration,
  judgeAttempt,
} from "../../online/benchmark/baseline-grading.ts";
import { Domains } from "../../online/benchmark/domain.ts";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import {
  readJSON,
  repository,
  sha,
  writeJSON,
  until,
} from "../../online/benchmark/io.ts";
import {
  createCampaign,
  reserve,
  settle,
  ledger,
  closeCampaign,
} from "../../online/benchmark/campaign.ts";
import { stopDatabase } from "../../online/benchmark/postgres.ts";
import { snapshot } from "../../online/benchmark/snapshot.ts";
import { identityHash } from "../../online/benchmark/process-witness.ts";
import {
  timeline,
  visibleInputs,
  lintTimeline,
} from "../../online/benchmark/baseline-timeline.ts";
import { initializeGuard } from "../../online/benchmark/payload-guard.ts";

const bytes = Buffer.from("fixture host evidence");
const ref = { path: "owned-evidence", sha256: sha(bytes) };
const read = () => bytes;
const job = {
  id: "j1",
  mode: "WORKING_MEMORY",
  state: "COMMITTED",
  source_event_ids: ["B"],
  source_end_sequence: 8,
  updated_at: "2026-11-18T00:00:00Z",
};
test("#122 maintenance excludes context crop, distinguishes four deadline states, retains first failure", () => {
  const ctx = { at_cap: true, session_state: "IDLE", settings_blocked: false };
  assert.equal(
    maintenanceBoundary([{ ...job, mode: "CONTEXT_COMPACTION" }], "B", 8, ctx)
      .status,
    "NOT_TRIGGERED",
  );
  assert.equal(
    maintenanceBoundary([{ ...job, source_event_ids: ["A"] }], "B", 8, ctx)
      .status,
    "NOT_TRIGGERED",
  );
  assert.equal(
    maintenanceBoundary([{ ...job, state: "SUMMARIZING" }], "B", 8, ctx).status,
    "RUNNING_AT_CAP",
  );
  assert.equal(
    maintenanceBoundary([{ ...job, state: "STALE" }], "B", 8, ctx).status,
    "STALE_DISCARDED_AT_CAP",
  );
  const fail = {
    ...job,
    state: "FAILED",
    next_attempt_at: "2026-11-18T00:02:00Z",
  };
  assert.equal(
    maintenanceBoundary([fail], "B", 8, ctx).status,
    "FAILED_RETRY_PENDING",
  );
  assert.equal(
    maintenanceBoundary([{ ...fail, next_attempt_at: null }], "B", 8, ctx)
      .status,
    "FAILED_TERMINAL",
  );
  const result = maintenanceBoundary([fail, { ...job, id: "j2" }], "B", 8, ctx);
  assert.equal(result.status, "COMMITTED");
  assert.equal(result.first_failure?.id, "j1");
});
test("#122 due maintenance and in-flight calls prevent a paired probe", () => {
  const q = {
    maintenance_due: false,
    maintenance_running: false,
    summary_pending: false,
    last_handled_sequence: 0,
    session_id: "main",
    consciousness: [
      { session_id: "task", revision: 3, covered_event_sequence: 999 },
      { session_id: "main", revision: 1, covered_event_sequence: 0 },
    ],
    sessions: [{ state: "IDLE" }],
    compactions: [],
    extractions: [],
    calls: [],
  };
  assertQuiescent(q);
  assert.throws(
    () => assertQuiescent({ ...q, last_handled_sequence: 8 }),
    /NOT_QUIESCENT/,
  );
  assert.throws(
    () => assertQuiescent({ ...q, summary_pending: true }),
    /NOT_QUIESCENT/,
  );
  assert.throws(
    () => assertQuiescent({ ...q, maintenance_running: true }),
    /NOT_QUIESCENT/,
  );
  assert.throws(
    () =>
      assertSameMemory(
        { revision: 1, covered_sequence: 8, last_handled_sequence: 8 },
        { revision: 2, covered_sequence: 8, last_handled_sequence: 8 },
      ),
    /MEMORY_DRIFT/,
  );
  assert.throws(
    () => assertQuiescent({ ...q, maintenance_due: true }),
    /NOT_QUIESCENT/,
  );
  assert.throws(
    () => assertQuiescent({ ...q, calls: [{ state: "IN_FLIGHT" }] }),
    /NOT_QUIESCENT/,
  );
  assert.throws(() => assertQuiescent({ ...q, sessions: [] }), /NOT_QUIESCENT/);
});
test("#122 source coverage is expanded and unsupported/harness-excluded remain different", () => {
  const rows = baselineManifest();
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(new Set(rows.map((r) => r.template)).size, 16);
  assert.deepEqual([...new Set(rows.map((r) => r.family))].sort(), [
    "M1",
    "M2",
    "M3",
    "M4",
    "M5",
    "M6",
  ]);
  assert.equal(routes.scope_import.status, "HARNESS_EXCLUDED");
  assert.equal(routes.text_attachment.status, "UNSUPPORTED");
  for (const id of ["C02", "C05"]) {
    const pair = baselineCases().filter((r) => r.pair?.id === id);
    assert.deepEqual(
      pair.map((r) => r.pair?.position),
      ["A", "B"],
    );
    assert.deepEqual(pair[0].setup, pair[1].setup);
    assert(pair.every((r) => r.pair?.post_restart));
  }
});
test("#122 missing or changed interruption element requires C12b", () => {
  const complete = Object.fromEntries(
    interruptionElements.map((k) => [k, [ref]]),
  );
  assert.equal(interruptionReuse(complete, read).c12b_required, null);
  for (const key of interruptionElements)
    assert.equal(
      interruptionReuse({ ...complete, [key]: [] }, read).c12b_required,
      true,
    );
  assert.equal(
    interruptionReuse(complete, () => Buffer.from("changed")).c12b_required,
    true,
  );
});
test("#122 World export preserves genuine restart and first eligible request", () => {
  const witnesses = ["STOPPED", "RUNNING"].map((observed, i) => {
    const identity = {
      machine: "fixture",
      boot: "boot",
      pid: 100 + i,
      start: String(i),
      token: "same-domain",
    };
    return Buffer.from(
      JSON.stringify({
        schema: "benchmark-process-witness-v1",
        identity,
        identity_sha256: identityHash(identity),
        observed,
        at: `2026-11-18T00:00:0${i}Z`,
      }),
    );
  });
  const witnessRefs = witnesses.map((b, i) => ({
    path: "witness" + i,
    sha256: sha(b),
  }));
  const read = (p: string) =>
    p.startsWith("witness") ? witnesses[Number(p.slice(-1))] : bytes;
  const p = {
    restart: {
      kind: "DIRECT_SAME_DOMAIN" as const,
      old_identity: JSON.parse(witnesses[0].toString()).identity_sha256,
      new_identity: JSON.parse(witnesses[1].toString()).identity_sha256,
      old_exit: witnessRefs[0],
      new_start: witnessRefs[1],
      restart_observed: true,
    },
    commit_sequence: 5,
    first_eligible_sequence: 8,
    request_sequence: 8,
    committed: ref,
    request: ref,
  };
  assert.equal(worldBoundary(p, read).restart_observed, true);
  assert.throws(
    () => worldBoundary({ ...p, request_sequence: 9 }, read),
    /REQUEST_BOUNDARY/,
  );
  assert.throws(
    () =>
      worldBoundary(
        {
          ...p,
          restart: { ...p.restart, new_identity: p.restart.old_identity },
        },
        read,
      ),
    /RESTART_UNPROVEN/,
  );
  assert.throws(
    () => worldBoundary(p, () => Buffer.from("changed")),
    /EVIDENCE_CHANGED/,
  );
});
test("#122 resident/opaque/unchecked echoes cannot pass a cold claim; missing read is failure", () => {
  const p = {
    request: ref,
    surfaces: {
      context: "ABSENT",
      profile: "ABSENT",
      consciousness: "ABSENT",
      recall: "ABSENT",
    } as const,
    semantic_review: ref,
    opaque: false,
    original_read: ref,
    used_source: true,
  };
  assert.equal(coldEvidence(p, read), "PASS");
  assert.equal(coldEvidence({ ...p, opaque: true }, read), "UNRESOLVED");
  assert.equal(
    coldEvidence(
      { ...p, surfaces: { ...p.surfaces, recall: "PRESENT" } },
      read,
    ),
    "UNRESOLVED",
  );
  assert.equal(coldEvidence({ ...p, original_read: null }, read), "FAIL");
  assert.equal(effectVerdict(0, 0, false, 0), "UNRESOLVED");
  assert.equal(effectVerdict(1, 2, false, 1), "FAIL");
});
test("#122 semantic extension is bound and incomplete evidence cannot support PASS", () => {
  const g = {
    schema: baselineVersion as typeof baselineVersion,
    case_id: "C08-inference",
    packet_sha256: sha("packet"),
    judgments: [
      {
        assertion: "authority_chain" as const,
        verdict: "PASS" as const,
        evidence: [ref],
        rationale: "confirmed source",
      },
    ],
  };
  const e = { ...g, assertions: ["authority_chain"] };
  validateSemanticGrade(g, e, read);
  assert.throws(
    () =>
      validateSemanticGrade({ ...g, schema: "secretary-v3" as any }, e, read),
    /GRADE_BINDING/,
  );
  assert.throws(
    () =>
      validateSemanticGrade(
        { ...g, judgments: [{ ...g.judgments[0], evidence: [] }] },
        e,
        read,
      ),
    /EVIDENCE_MISSING/,
  );
  assert.throws(
    () => validateSemanticGrade({ ...g, judgments: [] }, e, read),
    /GRADE_COVERAGE/,
  );
  const controls = calibrationControls();
  assert(!JSON.stringify(controls.packet).includes('"expected"'));
  const result = controls.private_key.map((k) => ({
    id: k.id,
    verdict: k.expected,
  }));
  validateCalibration(result, controls.private_key);
  assert.throws(
    () => validateCalibration(result.slice(1), controls.private_key),
    /CALIBRATION_FAILED/,
  );
  assert.throws(
    () =>
      judgeAttempt(
        [{ packet_sha256: "old", kind: "MECHANICAL" }],
        "new",
        1,
        false,
      ),
    /RETRY_FORBIDDEN/,
  );
});
function limits(): BaselineLimits {
  const ids = ["gpt-6.1-sol", "deepseek-flash", "gpt-6-luna"];
  return {
    schema: "issue122-budget-v1",
    reservations: 12,
    models: Object.fromEntries(
      ids.map((id) => [
        id,
        {
          usd: 5,
          reservations: 4,
          input_rate: 2,
          output_rate: 10,
          price_source: "fixture-not-current-price",
          output_bound_source: "fixture-provider-contract",
          requested_cap_bounds_billed_output: false,
          verified_max_output: 100,
        },
      ]),
    ),
    lanes: Object.fromEntries(
      ids.map((id, i) => [
        "lane" + i,
        { model: id, usd: 5, reservations: 4, connectivity: false },
      ]),
    ),
  };
}
test("#122 reservation uses UTF8 and verified reasoning output maximum, unknown bounds refuse", () => {
  const p = limits();
  validateBaselineLimits(p, 15);
  const m = p.models["gpt-6.1-sol"];
  assert.equal(baselineReservation("中文", 10, m), (6 * 2 + 100 * 10) / 1e6);
  assert.throws(
    () => baselineReservation("x", 10, { ...m, verified_max_output: null }),
    /OUTPUT_BOUND_UNKNOWN/,
  );
  assert.throws(
    () =>
      validateBaselineLimits(
        { ...p, models: { ...p.models, "gpt-6.1-sol": { ...m, usd: 6 } } },
        15,
      ),
    /ALLOCATION|BOUND_REQUIRED/,
  );
  const next = {
    model: "gpt-6.1-sol",
    lane: "lane0",
    episode: "lineage",
    run: "run",
    reserved_usd: 1,
  };
  assertBaselineReservation(p, [], next, Date.now());
  const old = {
    attempt: { ...next, at: new Date().toISOString() },
    charged_usd: 4.5,
  };
  assert.throws(
    () => assertBaselineReservation(p, [old], next, Date.now()),
    /BUDGET_EXHAUSTED/,
  );
  assert.throws(
    () =>
      assertBaselineReservation(
        p,
        [old],
        { ...next, episode: "new", reserved_usd: 0.1 },
        Date.now(),
      ),
    /LANE_REBIND/,
  );
});
test("#122 durable campaign counts unknown usage and restart descendants without resetting", async () => {
  const root = path.join(repository, ".local/benchmark/tests", randomUUID());
  await createCampaign(root, "fixture-122-" + randomUUID(), 15, limits());
  const send = {
    model: "gpt-6.1-sol",
    lane: "lane0",
    episode: "lineage",
    run: "first",
    request_sha256: sha("request"),
    reserved_usd: 2.6,
  };
  const id = await reserve(root, send);
  await settle(root, id, "NETWORK_UNCERTAIN", null, null);
  assert.equal(ledger(root).charged_usd, 2.6);
  await assert.rejects(
    reserve(root, { ...send, run: "restored" }),
    /BUDGET_EXHAUSTED/,
  );
  await reserve(root, {
    ...send,
    model: "deepseek-flash",
    lane: "lane1",
    episode: "other",
  });
  await closeCampaign(root);
});
test("#122 pair guard refuses effects, new Tasks, changed sinks and unconfirmed workers", () => {
  pairRestoreGuard([], [], [], [], true);
  for (const extra of [
    { effect: "PARTIAL" },
    { state: "AUTHORIZED" },
    { state: "DISPATCHED" },
  ]) {
    assert.throws(
      () =>
        pairRestoreGuard(
          [],
          [{ record_type: "Operation", id: "o", ...extra }],
          [],
          [],
          true,
        ),
      /UNEXPECTED_EFFECT/,
    );
  }
  assert.throws(
    () =>
      pairRestoreGuard(
        [],
        [{ record_type: "TaskPlan", id: "t" }],
        [],
        [],
        true,
      ),
    /NEW_TASK/,
  );
  assert.throws(
    () =>
      pairRestoreGuard(
        [],
        [{ record_type: "Operation", id: "o", effect: "UNKNOWN" }],
        [],
        [],
        true,
      ),
    /UNEXPECTED_EFFECT/,
  );
  assert.throws(() => pairRestoreGuard([], [], [], [{}], true), /SINK_CHANGED/);
  assert.throws(
    () => pairRestoreGuard([], [], [], [], false),
    /WORKER_UNCONFIRMED/,
  );
});
test(
  "#122 source A survives as evidence while one restored B excludes A; second restore is refused",
  { timeout: 90000 },
  async () => {
    const root = path.join(repository, ".local/benchmark/tests", randomUUID());
    await Domains.use(root, async (d) => {
      const source = await d.start((await d.create()).id);
      initializeGuard(root, source.lineage);
      const capacity = readJSON(
        path.join(source.evidence, "issue122-capacity-candidates.json"),
      );
      for (const row of capacity.filter(
        (r: any) => r.profile === "RC98304_CANDIDATE",
      )) {
        assert.equal(row.budget.effective_context_window, 98304);
        assert.equal(row.task_budget.effective_context_window, 98304);
        assert.deepEqual(row.window, { count: 2, ratio: 0.05 });
      }
      let receipt: any;
      try {
        receipt = await baselinePair(
          d,
          source,
          {
            id: "paired",
            a_effectful: false,
            future_a: ["probe-B"],
            future_b: [],
            deadline: Date.now() + 60000,
          },
          async (r, p) => {
            const before = snapshot(path.join(r.active, "core"));
            const inputs = before.records.filter(
              (x) => x.record_type === "Input",
            );
            if (p === "B") assert.equal(inputs.length, 0);
            await new CoreClient(r.endpoint!).command("messages", {
              request_id: randomUUID(),
              text: "probe-" + p,
            });
            await until(
              () =>
                readJSON(path.join(r.evidence, "observed.json")).inputs === 1,
            );
          },
        );
        assert.equal(d.raw(source.id).state, "RETIRED");
        assert.equal(receipt.first_failure, null);
        assert.deepEqual(receipt.a.input_sha256, [sha("probe-A")]);
        assert.equal(
          snapshot(
            path.join(root, "retired", source.id, "core"),
          ).records.filter((r) => r.record_type === "Input").length,
          1,
        );
        await assert.rejects(
          d.restore(source.id, receipt.checkpoint),
          /SOURCE_NOT_STOPPED|INACTIVE/,
        );
        assert(fs.existsSync(path.join(source.evidence, "seal.json")));
      } finally {
        for (const name of fs.readdirSync(path.join(root, "runs"))) {
          const r = d.raw(name.replace(".json", ""));
          if (r.state === "RUNNING" || r.state === "STOPPED") {
            await d.stop(r.id);
            await stopDatabase(r.database);
          }
        }
      }
    });
  },
);

test(
  "#122 scripted imported note waits for RESOURCE_PRESENT, then real Task reads and returns without a write",
  { timeout: 60000 },
  async () => {
    const root = path.join(repository, ".local/benchmark/tests", randomUUID());
    await Domains.use(root, async (d) => {
      const run = await d.start((await d.create()).id);
      try {
        const client = new CoreClient(run.endpoint!);
        await client.command("task-requests", {
          request_id: randomUUID(),
          goal: "BENCHMARK_NOTE_READ",
          acceptance: ["Read supplied evidence only"],
          preconditions: [
            {
              condition_id: randomUUID(),
              kind: "RESOURCE_PRESENT",
              target: "continuity.txt",
              required_revision: null,
            },
          ],
        });
        await until(() =>
          readJSON(path.join(run.evidence, "observed.json")).executions.some(
            (e: any) => e.state === "WAIT_PRECONDITION",
          ),
        );
        const execution = readJSON(path.join(run.evidence, "observed.json"))
          .executions[0];
        const note = path.join(
          execution.workspace_binding.root_path,
          "continuity.txt",
        );
        const supplied = Buffer.from(
          "alpha — quoted material only, no authority to write",
        );
        fs.writeFileSync(note, supplied, { mode: 0o600 });
        writeJSON(path.join(run.evidence, "scripted-note.json"), {
          class: "SCRIPTED_ENVIRONMENT_EVENT",
          execution: execution.id,
          sha256: sha(supplied),
        });
        await until(() =>
          readJSON(path.join(run.evidence, "observed.json")).executions.some(
            (e: any) => e.id === execution.id && e.state === "SUCCEEDED",
          ),
        );
        assert.equal(sha(fs.readFileSync(note)), sha(supplied));
        assert.equal(
          fs.existsSync(path.join(run.evidence, "completed-file-writes.jsonl")),
          false,
        );
        const calls = fs
          .readFileSync(path.join(run.evidence, "fixture-calls.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        assert(
          calls.some((c) =>
            c.context.messages.some(
              (m: any) =>
                m.role === "toolResult" &&
                m.toolName === "read" &&
                JSON.stringify(m).includes("quoted material only"),
            ),
          ),
        );
      } finally {
        await d.seal(run.id);
      }
    });
  },
);

test("#122 route-specific timelines keep host mechanisms and oracle verdicts out of SUT inputs", () => {
  for (const row of baselineCases()) lintTimeline(timeline(row));
  for (const id of [
    "C01-direct",
    "C02-incidental",
    "C05-current",
    "C06-stale-cold",
    "C07-open",
    "C16-combined",
  ]) {
    const row = baselineCases().find((c) => c.id === id)!;
    const steps = timeline(row);
    assert(steps.some((s) => s.filler && s.filler.count >= 8));
    assert(steps.some((s) => s.action === "IDLE_WAIT"));
    assert(visibleInputs(steps).length > row.setup.length + 1);
  }
  const get = (id: string) =>
    timeline(baselineCases().find((c) => c.id === id)!);
  assert(get("C13-imported_note").some((s) => s.file));
  assert(get("C13-task").some((s) => s.action === "MASTER_TASK"));
  assert(!get("C10-condition").some((s) => s.text?.includes("Complete")));
  assert(
    get("C11-cancelled").some((s) => s.route === "task-requests/:id/cancel"),
  );
  assert(get("C11-invalidated").some((s) => s.text?.includes("withdraw")));
  assert.throws(
    () =>
      lintTimeline([
        { action: "MASTER_MESSAGE", text: "Fault barrier after fsync" },
      ]),
    /INPUT_LEAK/,
  );
});

test("#122 protected multiple lanes, connectivity and wall-time bounds fail closed", () => {
  const p = limits();
  p.models["gpt-6.1-sol"].reservations = 10;
  p.reservations = 18;
  p.lanes.lane0 = {
    model: "gpt-6.1-sol",
    usd: 2,
    reservations: 3,
    connectivity: true,
  };
  p.lanes.extra = {
    model: "gpt-6.1-sol",
    usd: 3,
    reservations: 7,
    connectivity: false,
  };
  validateBaselineLimits(p, 15);
  const now = Date.now();
  const next = {
    model: "gpt-6.1-sol",
    lane: "extra",
    episode: "e2",
    run: "r",
    reserved_usd: 0.1,
  };
  const entry = (lane: string, episode: string, charge: number, age = 0) => ({
    attempt: {
      model: "gpt-6.1-sol",
      lane,
      episode,
      run: "r",
      at: new Date(now - age).toISOString(),
    },
    charged_usd: charge,
  });
  assertBaselineReservation(p, [entry("lane0", "e1", 2)], next, now);
  assert.throws(
    () => assertBaselineReservation(p, [entry("lane0", "e1", 2.1)], next, now),
    /FULL_LANE_ADMISSION/,
  );
  assert.throws(
    () =>
      assertBaselineReservation(
        p,
        Array.from({ length: 3 }, () => entry("lane0", "e1", 0.1)),
        { ...next, lane: "lane0", episode: "e1" },
        now,
      ),
    /RESERVATION_LIMIT/,
  );
  assert.throws(
    () =>
      assertBaselineReservation(
        p,
        [entry("extra", "e2", 0.1, 3600001)],
        next,
        now,
      ),
    /LANE_TIME_LIMIT/,
  );
  assert.throws(
    () =>
      assertBaselineReservation(
        p,
        [entry("lane0", "e1", 0.1, 43200001)],
        next,
        now,
      ),
    /CAMPAIGN_TIME_LIMIT/,
  );
  p.lanes.lane0.reservations = 4;
  assert.throws(
    () => validateBaselineLimits(p, 15),
    /LANE_ALLOCATION|LANE_INVALID/,
  );
});

test("#122 above-reservation settlement is durable and blocks further baseline sends", async () => {
  const root = path.join(repository, ".local/benchmark/tests", randomUUID());
  await createCampaign(root, "fixture-bound-" + randomUUID(), 15, limits());
  const send = {
    model: "gpt-6.1-sol",
    lane: "lane0",
    episode: "lineage",
    run: "first",
    request_sha256: sha("request"),
    reserved_usd: 0.1,
  };
  const id = await reserve(root, send);
  await settle(root, id, "SUCCESS", { fixture: true }, 0.2);
  assert.deepEqual(ledger(root).entries.get(id)!.bound_violation, {
    reserved_usd: 0.1,
    actual_usd: 0.2,
  });
  assert.equal(ledger(root).charged_usd, 0.2);
  await assert.rejects(reserve(root, send), /RESERVATION_BOUND_VIOLATED/);
  await closeCampaign(root);
});
