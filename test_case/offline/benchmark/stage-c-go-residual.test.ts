import assert from "node:assert/strict";
import { test } from "node:test";
import {
  goResidualSource,
  residualParent,
} from "../../online/benchmark/stage-c-go-residual.ts";
import {
  beforeGo,
  goDecision,
  selectGoBatch,
  type GoContinuation,
} from "../../online/benchmark/stage-c-go-continuation.ts";
import { goGradeGate } from "../../online/benchmark/stage-c-go-grading.ts";
import type { FrozenBatch } from "../../online/benchmark/stage-c-freeze.ts";
import type { RemainingSeries } from "../../online/benchmark/stage-c-remaining-series.ts";
import { sha } from "../../online/benchmark/io.ts";

test("a residual freeze carries only its two unspent parent lanes and requires the shared calibration", () => {
  const matrix = sha("test matrix"),
    decision = sha("test decision"),
    series = {
      matrix_sha256: matrix,
      decision_sha256: decision,
      partition: 5,
    } as RemainingSeries;
  const g: GoContinuation = {
    scope: 84,
    matrix_sha256: matrix,
    prior_decision_sha256: decision,
    decision_sha256: sha(JSON.stringify(goDecision(84, series))),
    partition: 5,
    source_partition: 5,
    prior_freezes: { 5: beforeGo[5].freeze, 6: beforeGo[6].freeze },
    prior_archives: { 5: beforeGo[5].archive, 6: beforeGo[6].archive },
    residual: structuredClone(goResidualSource),
    pending_calibration: {
      freeze_sha256: goResidualSource.freeze,
      packet_sha256: sha("packet"),
      rubric_sha256: sha("rubric"),
      key_sha256: sha("key"),
    },
  };
  const batch = [
    beforeGo[5].spent,
    "r1-C07-cancelled--deepseek-flash",
    ...goResidualSource.lanes,
  ].map((lane, i) => ({ lane: { lane, cap: 87, seed: i } })) as FrozenBatch;
  const batches = [[], [], [], [], batch];
  const residual = selectGoBatch(batches, series, g, 5);
  assert.deepEqual(residual, batch.slice(2));
  assert.equal(goGradeGate(g, false), true);
  assert.throws(() => goGradeGate(g, true), /SHARED_CALIBRATION/);
  assert.throws(
    () =>
      selectGoBatch(
        batches,
        series,
        { ...g, pending_calibration: undefined },
        5,
      ),
    /GO_SCOPE/,
  );
  assert.throws(
    () =>
      residualParent({
        residual: { ...goResidualSource, lanes: [beforeGo[5].spent] },
      }),
    /PARENT_CHANGED/,
  );
  assert.throws(
    () => selectGoBatch([[], [], [], [], batch.slice(0, -1)], series, g, 5),
    /RESIDUAL_INVENTORY/,
  );
});
