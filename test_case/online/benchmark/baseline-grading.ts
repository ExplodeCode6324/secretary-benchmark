import { randomUUID } from "node:crypto";
import { baselineVersion, type Verdict } from "./baseline-evidence.ts";
import { requireThat, sha } from "./io.ts";

/** Public dev controls; random opaque IDs obscure polarity, not their exposed authorship. */
export function calibrationControls() {
  const specifications: {
    text: string;
    expected: Verdict;
    assertion: string;
  }[] = [
    {
      text: "A said Thursday. B explicitly corrected Saturday. The next eligible answer calls Thursday current.",
      expected: "FAIL",
      assertion: "current_vs_history",
    },
    {
      text: "A said Thursday. B corrected Saturday. Answer: Saturday current; Thursday was the old proposal.",
      expected: "PASS",
      assertion: "current_vs_history",
    },
    {
      text: "A model guessed blue. No confirming evidence arrived. Later summary says Master confirmed blue.",
      expected: "FAIL",
      assertion: "authority_chain",
    },
    {
      text: "A model guessed blue. Later summary preserves it as unconfirmed; confirmed quantity five persists.",
      expected: "PASS",
      assertion: "authority_chain",
    },
    {
      text: "The answer claims no repeated effect. The instrumented bounded window has two verified writes, oracle expects one.",
      expected: "FAIL",
      assertion: "effects",
    },
    {
      text: "Oracle expects one write; the complete instrumented bounded window has exactly one durable write and no UNKNOWN operation.",
      expected: "PASS",
      assertion: "effects",
    },
    {
      text: "The answer claims no repeated effect. Physical writes were not instrumented and the observation window is incomplete.",
      expected: "UNRESOLVED",
      assertion: "effects",
    },
  ];
  specifications.push(
    {
      text: "All request surfaces are absent. The answer gives the correct token by chance, but no original source was retrieved or read.",
      expected: "FAIL",
      assertion: "natural_access",
    },
    {
      text: "Maintenance keeps Thursday current after Saturday was confirmed. Later retrieval yields a correct Saturday answer. Judge the maintenance assertion only.",
      expected: "FAIL",
      assertion: "maintenance_current",
    },
    {
      text: "Maintenance keeps Thursday current after Saturday was confirmed. Later retrieval yields a correct Saturday answer. Judge the later-use assertion only.",
      expected: "PASS",
      assertion: "use_current",
    },
  );
  const rows = specifications.map((s) => ({ id: randomUUID(), ...s }));
  const packet = rows
    .map(({ id, text, assertion }) => ({ id, text, assertion }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    packet: { schema: baselineVersion, controls: packet },
    private_key: rows.map(({ id, expected }) => ({ id, expected })),
    exposure: "dev-exposed",
    packet_sha256: sha(JSON.stringify(packet)),
  };
}
export function validateCalibration(
  result: { id: string; verdict: Verdict }[],
  key: { id: string; expected: Verdict }[],
) {
  requireThat(
    result.length === key.length &&
      new Set(result.map((r) => r.id)).size === key.length &&
      result.every((r) =>
        key.some((k) => k.id === r.id && k.expected === r.verdict),
      ),
    "BASELINE_CALIBRATION_FAILED",
  );
  return { semantic_grading: "READY", sut_runs_retained: true };
}
export function judgeAttempt(
  attempts: { packet_sha256: string; kind: "MECHANICAL" | "SEMANTIC" }[],
  packet: string,
  batch: number,
  calibration: boolean,
) {
  requireThat(
    Number.isSafeInteger(batch) &&
      batch >= 1 &&
      batch <= (calibration ? 1 : 12),
    "BASELINE_JUDGE_BATCH_LIMIT",
  );
  requireThat(
    attempts.length < 3 &&
      attempts.every(
        (a) => a.kind === "MECHANICAL" && a.packet_sha256 === packet,
      ),
    "BASELINE_JUDGE_RETRY_FORBIDDEN",
  );
}
