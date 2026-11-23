import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { archivedBatch } from "../../online/benchmark/stage-c-archived-results.ts";
import { archiveFacility } from "../../online/benchmark/archive.ts";
import {
  prepareCompletionCalibration,
  completedBatchReport,
} from "../../online/benchmark/stage-c-grading.ts";
import {
  createCampaign,
  closeCampaign,
} from "../../online/benchmark/campaign.ts";
import { fingerprint } from "../../online/benchmark/source.ts";
import { combineResults } from "../../online/benchmark/stage-c-combine.ts";
import {
  flashRule,
  freezeBatch,
  loadCompletion,
  completionApproval,
  projectCampaign,
} from "../../online/benchmark/stage-c-freeze.ts";
import {
  stageCases,
  caseDefinition,
  sutCommit,
  piCommit,
} from "../../online/benchmark/stage-c-plan.ts";
import {
  sha,
  repository,
  readJSON,
  writeJSON,
} from "../../online/benchmark/io.ts";

test("combined reports keep the denominator, reject overlapping lineages and bind both paired branches", () => {
  const dir = new URL("./fixtures/stage-c/", import.meta.url);
  const inputs = JSON.parse(
    fs.readFileSync(new URL("rehearsal-inputs.json", dir), "utf8"),
  );
  delete inputs.evidence_class;
  for (const c of stageCases())
    inputs.samples[c.id] = inputs.samples["C04-resident"];
  inputs.calibration = {
    reader: "fixture",
    version: "v",
    rubric_sha256: sha("r"),
    packet_sha256: sha("p"),
    key_sha256: sha("k"),
    max_attempts: 3,
  };
  const providers = {
    "deepseek-flash": flashRule(
      fs.readFileSync(new URL("rehearsal-rates.md", dir)),
      "2026-11-24T00:00:00Z",
    ),
  };
  const projection = projectCampaign(inputs, providers);
  const snapshots = projection.batches.map((batch, i) => {
    const hash = sha("synthetic freeze " + i);
    const rows = batch.flatMap((r) => {
      const c = caseDefinition(r.lane.scenario),
        branches = c.pair
          ? stageCases().filter((x) => x.pair?.id === c.pair!.id)
          : [c];
      return branches.map((v) => ({
        source_lineage: r.lane.lane,
        scenario: v.id,
        model: r.lane.model,
        repeat: r.lane.repeat,
        profile: r.lane.profile,
        external_recipe_sha256:
          v.pair?.position === "B" ? r.pair : r.trial.timeline,
        status: "INCOMPLETE",
        reason: "FIXTURE_INTERRUPTED",
        family: v.family,
        grades: Object.fromEntries(v.assertions.map((a) => [a, "NOT_TESTED"])),
        c16: null,
        physical_attempts_on_shared_lineage: 0,
        assessment_status: "NOT_TESTED",
        published_version: providers["deepseek-flash"].published_version,
        identities: [],
        assessment_attempts: 0,
      }));
    });
    return {
      hash,
      archive_sha256: sha("archive" + i),
      calibration: {
        status: "NOT_TESTED",
        attempts: 0,
        receipt_sha256: null,
        packet_sha256: inputs.calibration.packet_sha256,
      },
      projection,
      freeze: {
        evidence_class: "LIVE",
        grade: inputs.calibration,
        providers,
        source: {
          head: "fixture",
          sut: {
            commit: sutCommit,
            submodules: { "src/pi_resource": piCommit },
          },
        },
        batch_index: i + 1,
        batch,
        projection_sha256: sha(JSON.stringify(projection)),
      },
      result: {
        evidence_class: "LIVE",
        batch_closed: true,
        freeze_sha256: hash,
        rows,
        schema: "issue122-completion-results-v1",
        observations: rows.length,
        lineages: batch.length,
        charged_usd: 0,
        metered_attempts: 0,
        physical_sends: 0,
        known_usd: 0,
        unresolved_cost_reservation_usd: 0,
      },
      decisions: { workload: "synthetic decision " + i },
    };
  });
  const partial = combineResults([snapshots[0]]);
  assert.deepEqual(partial.dispositions, {
    COMPLETED: 0,
    INCOMPLETE: 1,
    UNRUN: 98,
  });
  assert.throws(
    () => combineResults([snapshots[0], snapshots[0]]),
    /AGGREGATE_ROW/,
  );
  const all = combineResults(snapshots.toReversed());
  assert.equal(all.reported_observations, 99);
  assert.equal(Object.keys(all.families).length, 6);
  assert(all.excluded.some((x) => x.scenario === "C12a"));
  assert(all.excluded.some((x) => x.reason.includes("#125")));
  for (const [field, value] of [
    ["known_usd", "0"],
    ["charged_usd", NaN],
    ["unresolved_cost_reservation_usd", -1],
    ["physical_sends", 0.5],
  ]) {
    const bad = structuredClone(snapshots[0]);
    Object.assign(bad.result, { [String(field)]: value });
    assert.throws(() => combineResults([bad]), /AGGREGATE_ACCOUNTING/);
  }
  for (const patch of [
    { assessment_attempts: undefined },
    { assessment_attempts: 4 },
    { assessment_status: "ACCEPTED" },
    { status: "UNRUN", physical_attempts_on_shared_lineage: 1 },
    { grades: {} },
    { status: "UNKNOWN" },
  ]) {
    const bad = structuredClone(snapshots[0]);
    Object.assign(bad.result.rows[0], patch);
    assert.throws(() => combineResults([bad]), /AGGREGATE_ROW|GRADE_DECISION/);
  }
  const unapproved = structuredClone(snapshots[0]);
  Object.assign(unapproved.calibration, {
    status: "PASSED",
    attempts: 1,
    receipt_sha256: sha("grade"),
  });
  assert.throws(() => combineResults([unapproved]), /GRADE_DECISION/);
  const changed = structuredClone(snapshots);
  changed.at(-1)!.result.rows[0].external_recipe_sha256 = sha("changed");
  assert.throws(() => combineResults(changed), /AGGREGATE_ROW/);
});

test("closed zero-send batch exports from the report producer match the archived files", async () => {
  const root = path.join(
    repository,
    ".local/benchmark/tests",
    "aggregate-" + randomUUID(),
  );
  const fixture = new URL("./fixtures/stage-c/", import.meta.url);
  const inputs = JSON.parse(
    fs.readFileSync(new URL("rehearsal-inputs.json", fixture), "utf8"),
  );
  delete inputs.evidence_class;
  for (const c of stageCases())
    inputs.samples[c.id] = inputs.samples["C04-resident"];
  inputs.source = fingerprint();
  inputs.calibration = await prepareCompletionCalibration(root);
  fs.mkdirSync(path.join(root, "inputs/official"), { recursive: true });
  fs.copyFileSync(
    new URL("rehearsal-rates.md", fixture),
    path.join(root, "inputs/official/flash-pricing.md"),
  );
  writeJSON(path.join(root, "inputs/stage-c-preflight.json"), inputs);
  const { hash } = freezeBatch(root, 1, new Date().toISOString());
  const approval = completionApproval(hash, false);
  const { batch, policy } = loadCompletion(root, hash, approval);
  // Exercise the real report and archive formats without dispatching a workload or performing a provider preflight.
  await createCampaign(root, approval, undefined, undefined, policy);
  const terminals = Object.fromEntries(
    batch.map((r) => [
      r.lane.lane,
      { status: "UNRUN", reason: "BATCH_STOPPED" },
    ]),
  );
  writeJSON(path.join(root, "campaign/stage-c-dispatch.json"), {
    ended: true,
    freeze_sha256: hash,
    terminals,
  });
  await closeCampaign(root);
  const result = completedBatchReport(root, hash);
  writeJSON(path.join(root, "reports/stage-c-results.json"), result);
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "archive-comparison-")),
  );
  try {
    const exports = path.join(tmp, "exports"),
      folder = path.join(exports, hash);
    fs.mkdirSync(folder, { recursive: true });
    for (const f of [
      "configs/stage-c-freeze.json",
      "reports/stage-c-projection.json",
      "reports/stage-c-results.json",
    ])
      fs.copyFileSync(path.join(root, f), path.join(folder, path.basename(f)));
    const a = await archiveFacility(root, tmp, true);
    const id = path.basename(a.archive_directory!),
      day = path.basename(path.dirname(a.archive_directory!));
    const entry = {
      archive_id: id,
      archive_day: day,
      archive_sha256: a.archive_sha256,
      freeze_sha256: hash,
      decisions: { workload: "fixture-only" },
    };
    const imported = archivedBatch(tmp, exports, entry);
    const aggregate = combineResults([imported]);
    assert.equal(aggregate.physical_attempts, 0);
    assert.equal(aggregate.dispositions.UNRUN, 99);
    assert.equal(aggregate.proposals[0].calibration.status, "NOT_TESTED");
    const f = path.join(folder, "stage-c-results.json");
    writeJSON(f, {
      ...readJSON<Record<string, unknown>>(f),
      physical_sends: 1,
    });
    assert.throws(
      () =>
        archivedBatch(tmp, exports, {
          ...entry,
          results_sha256: sha(fs.readFileSync(f)),
        }),
      /ARCHIVED_EXPORT/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
