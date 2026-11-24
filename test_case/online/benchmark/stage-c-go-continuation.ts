import { isDeepStrictEqual } from "node:util";
import { requireThat, sha } from "./io.ts";
import type { FrozenBatch } from "./stage-c-freeze.ts";
import type { GoCalibrationOrigin } from "./stage-c-go-grading.ts";
import type { RemainingSeries } from "./stage-c-remaining-series.ts";

export const beforeGo = {
  5: {
    freeze: "5a2bb23670006a5a6fd737bc63db4720a2c358a8f1892379557a752b691c4f09",
    archive: "4a009cd7eaab5374ef681a999532432758ccb65a7824324e0550a06c87f2a4cf",
    spent: "r3-C02--deepseek-flash",
  },
  6: {
    freeze: "baee2bd0035019ad3749b8e6fe8ef56f7c7a25c71c838bfe3f8cbcc9682f75e2",
    archive: "06ee1f5919b90d2137501b8f8fde7bf32fe06c9450205e1e2b6fb02c5814c7f2",
    spent: "r1-C07-open--deepseek-flash",
  },
} as const;
export type GoContinuation = {
  scope: 84;
  decision_sha256: string;
  prior_decision_sha256: string;
  matrix_sha256: string;
  prior_freezes: Record<string, string>;
  prior_archives: Record<string, string>;
  source_partition: 5 | 7;
  partition: 5 | 6 | 7;
  calibration_origin?: GoCalibrationOrigin;
  calibration_withheld?: true;
};
export function goDecision(scope: GoContinuation["scope"], s: RemainingSeries) {
  return {
    route: "opencode-go",
    matrix_sha256: s.matrix_sha256,
    original_decision_sha256: s.decision_sha256,
    first_contact: "r1-C04-nonexistent--deepseek-flash",
    checkpoint_policy: "RETAIN_CURRENT",
    quota_admission: "PER_REQUEST_20_50_100_USD_EQUIVALENT_ONE_PERCENT_MARGIN",
    calibration_valid_hours: 24,
    trajectories: scope,
    scope: "all-zero-send-and-two-402",
    supplement_calls: 10620,
    reader_calibrations: 6,
    candidate_slots: 99,
    workload_limit_usd: 8197.144704,
    reader_limit_usd: 21.823488,
    calibration_slot: 6,
    source_partition: 5,
    prior: beforeGo,
  };
}
export function selectGoBatch(
  batches: FrozenBatch[],
  series: RemainingSeries,
  g: GoContinuation,
  index: number,
) {
  const decision = goDecision(g.scope, series);
  requireThat(
    g.scope === 84 &&
      g.partition === index &&
      series.partition === index &&
      [5, 6, 7].includes(index) &&
      g.source_partition === decision.source_partition &&
      index >= g.source_partition &&
      g.prior_decision_sha256 === series.decision_sha256 &&
      g.matrix_sha256 === series.matrix_sha256 &&
      isDeepStrictEqual(g.prior_freezes, {
        5: beforeGo[5].freeze,
        6: beforeGo[6].freeze,
      }) &&
      isDeepStrictEqual(g.prior_archives, {
        5: beforeGo[5].archive,
        6: beforeGo[6].archive,
      }) &&
      sha(JSON.stringify(decision)) === g.decision_sha256 &&
      (index === g.source_partition
        ? !g.calibration_origin && !g.calibration_withheld
        : Number(Boolean(g.calibration_origin)) +
            Number(g.calibration_withheld === true) ===
          1),
    "STAGE_C_GO_SCOPE",
  );
  const batch = batches[index - 1];
  if (index === 7) return batch;
  const spent = beforeGo[index as 5 | 6].spent;
  requireThat(batch[0].lane.lane === spent, "STAGE_C_GO_PRIOR_ATTEMPT");
  const [first, ...rest] = batch;
  return [
    { ...first, lane: { ...first.lane, cap: first.lane.cap - 1 } },
    ...rest,
  ];
}
