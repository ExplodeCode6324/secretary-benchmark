// The rehearsal uses real worker/ledger/reader code but cannot enter the live report.
// Adapt only the envelope and denominator in memory to exercise the same combineResults validations.
import assert from "node:assert/strict";
import path from "node:path";
import { read, readJSON, sha } from "../../../online/benchmark/io.ts";
import { stageCases } from "../../../online/benchmark/stage-c-plan.ts";
import {
  projectCampaign,
  freezeFile,
  type FrozenBatch,
} from "../../../online/benchmark/stage-c-freeze.ts";
import { combineResults } from "../../../online/benchmark/stage-c-combine.ts";
import { attemptHistory } from "../../../online/benchmark/stage-b-report-calibration.ts";
import type { completedBatchReport } from "../../../online/benchmark/stage-c-grading.ts";

export function assertCombinedRehearsal(
  root: string,
  hash: string,
  report: ReturnType<typeof completedBatchReport>,
) {
  const frozen = readJSON(freezeFile(root));
  assert.equal(frozen.evidence_class, "OFFLINE_SSE");
  assert.equal(report.evidence_class, "OFFLINE_SSE");
  assert.equal(report.physical_sends, 0);
  const inputs = readJSON(path.join(root, "inputs/stage-c-preflight.json"));
  delete inputs.evidence_class;
  delete inputs.rehearsal_scenario;
  delete inputs.rehearsal_read;
  for (const c of stageCases())
    inputs.samples[c.id] ??= inputs.samples["C04-resident"];
  const projection = projectCampaign(inputs, frozen.providers);
  const batch: FrozenBatch = frozen.batch;
  const admitted = new Set(batch.map((r) => r.lane.lane));
  const remaining = projection.batches
    .flat()
    .filter((r) => !admitted.has(r.lane.lane));
  projection.batches = [batch, remaining];
  const prefix = "oracles/completion/calibration",
    history = attemptHistory(root, prefix),
    last = history.at(-1);
  const calibration = {
    attempts: history.length,
    status: last?.result?.status ?? "NOT_TESTED",
    packet_sha256: frozen.grade.packet_sha256,
    receipt_sha256: last?.result
      ? sha(
          read(
            path.join(root, prefix, "attempt-" + last.number + "-result.json"),
          ),
        )
      : null,
  };
  const combined = combineResults([
    {
      hash,
      archive_sha256: sha("rehearsal test only"),
      projection,
      calibration,
      decisions: {
        workload: "synthetic rehearsal",
        grading: "synthetic reader",
      },
      freeze: {
        ...frozen,
        evidence_class: "LIVE",
        batch_index: 1,
        projection_sha256: sha(JSON.stringify(projection)),
      },
      result: {
        ...report,
        evidence_class: "LIVE",
        physical_sends: report.metered_attempts,
      },
    },
  ]);
  assert.equal(combined.reported_observations, report.observations);
  assert.equal(combined.physical_attempts, report.metered_attempts);
  assert.equal(combined.known_usd, report.known_usd);
  return combined;
}
