// The first live batch was already closed when Master changed the reader.
// Keep its original freeze and producer export intact. Apply only the archived assessment.
import { requireThat, sha, type FileEntry } from "./io.ts";
import { matchesReader, scoringRubric } from "./stage-c-grading.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";

export const firstReaderAmendment =
  "8de5098616b39e9dd33cebf50131a9b1456b42f87075ccbbebfff9526b428bab";
const base = "reports/reader-deepseek-v1/";
export function amendedFirstAssessment(
  freezeHash: string,
  original: any,
  result: any,
  entries: Map<string, FileEntry>,
  exported: (name: string, archived: string) => any,
  decisionHash: string,
) {
  const entryHash = (name: string) => entries.get(name)?.sha256;
  const get = (file: string) =>
    exported("reader-deepseek-v1/" + file, base + file);
  const decision = get("decision.json"),
    assessment = get("assessment.json"),
    reader = [
      "Hermes",
      decision.judge.provider,
      decision.judge.model,
      decision.judge.reasoning_effort,
    ].join("/"),
    rubric = scoringRubric(reader);
  const cal = assessment.calibration;
  requireThat(
    freezeHash === firstReaderAmendment &&
      decision.schema === "issue122-reader-amendment-v1" &&
      decision.freeze_sha256 === freezeHash &&
      original.reader === "Opus 5.5 Extra" &&
      decisionHash === entryHash(base + "decision.json") &&
      assessment.decision_sha256 === decisionHash &&
      decision.legacy_calibration_sha256 === original.packet_sha256 &&
      original.key_sha256 === decision.calibration_key_sha256 &&
      reader.startsWith("Hermes/") &&
      decision.judge.reasoning_effort === "max" &&
      decision.rubric_sha256 === sha(gradeJSONBytes(rubric)) &&
      decision.rubric_sha256 === entryHash(base + "rubric.json") &&
      decision.trial_sha256 === assessment.trial_sha256 &&
      [...entries.values()].some(
        (e) =>
          e.path.startsWith("evidence/") &&
          e.path.endsWith("/stage-c-trial.json") &&
          e.sha256 === assessment.trial_sha256,
      ) &&
      assessment.base_report_sha256 ===
        entryHash("reports/stage-c-results.json") &&
      result.rows.length === 1 &&
      result.rows[0].scenario === "C04-resident" &&
      result.rows[0].assessment_attempts === 0 &&
      result.rows[0].grades.natural_access === "UNRESOLVED" &&
      cal.packet_sha256 === decision.calibration_packet_sha256 &&
      cal.packet_sha256 === entryHash(base + "calibration-packet.json") &&
      cal.receipt_sha256 === entryHash(base + "calibration-receipt.json") &&
      typeof cal.receipt_sha256 === "string" &&
      ["PASSED", "FAILED", "MECHANICAL"].includes(cal.status),
    "STAGE_C_ARCHIVED_READER_AMENDMENT",
  );
  const candidate = assessment.candidate;
  if (candidate) {
    const packet = get("candidate-packet.json"),
      receipt = get("candidate-receipt.json");
    const g = receipt.assertions?.[0];
    requireThat(
      cal.status === "PASSED" &&
        candidate.status === "ACCEPTED" &&
        candidate.packet_sha256 === entryHash(base + "candidate-packet.json") &&
        receipt.packet_sha256 === candidate.packet_sha256 &&
        candidate.receipt_sha256 ===
          entryHash(base + "candidate-receipt.json") &&
        packet.rubric.reader === reader &&
        sha(gradeJSONBytes(packet.rubric)) === decision.rubric_sha256 &&
        matchesReader(receipt, candidate.packet_sha256, reader) &&
        receipt.assertions.length === 1 &&
        g?.assertion === "natural_access" &&
        ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].includes(g.verdict) &&
        typeof g.rationale === "string" &&
        g.rationale.trim() &&
        Array.isArray(g.evidence) &&
        (g.verdict === "NOT_TESTED" || g.evidence.length > 0) &&
        g.evidence.every((id: string) =>
          packet.evidence.some((e: any) => e.id === id),
        ),
      "STAGE_C_ARCHIVED_AMENDED_GRADE",
    );
    result = {
      ...result,
      rows: [
        {
          ...result.rows[0],
          grades: { natural_access: g.verdict },
          assessment_attempts: candidate.attempts,
          assessment_status: candidate.status,
          first_assessment_failure: candidate.first_failure,
        },
      ],
    };
  }
  return {
    result,
    calibration: cal,
    assessment_grade: {
      ...original,
      reader,
      version: rubric.version,
      rubric_sha256: decision.rubric_sha256,
      packet_sha256: cal.packet_sha256,
    },
    assessment_amendment: decisionHash,
  };
}
