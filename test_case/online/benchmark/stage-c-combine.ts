// The aggregate reads portable, hash-bound exports. Only an exact-head runner produces each individual batch result.
import path from "node:path";
import { readJSON, requireThat, sha } from "./io.ts";
import { caseDefinition, stageCases } from "./stage-c-plan.ts";
import type { FrozenBatch } from "./stage-c-freeze.ts";

import { archivedBatch } from "./stage-c-archived-results.ts";
import {
  archiveConfiguration,
  assertArchiveTargetExternal,
} from "./archive.ts";
import { familyResults } from "./stage-c-families.ts";

type Decision = { workload: string; grading?: string };
type Snapshot = {
  freeze: any;
  projection: { batches: FrozenBatch[] };
  result: any;
  hash: string;
  archive_sha256: string;
  calibration: {
    attempts: number;
    status: string;
    receipt_sha256: string | null;
    packet_sha256: string;
  };
  decisions: Decision;
};
const reference = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 400;
const money = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const verdicts = ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"];
function checkAccounting(s: Snapshot) {
  const r = s.result,
    c = s.calibration;
  requireThat(
    r.schema === "issue122-completion-results-v1" &&
      r.batch_closed === true &&
      Array.isArray(r.rows) &&
      r.observations === r.rows.length &&
      r.lineages === s.freeze.batch.length &&
      count(r.physical_sends) &&
      r.metered_attempts === r.physical_sends &&
      [r.known_usd, r.unresolved_cost_reservation_usd, r.charged_usd].every(
        money,
      ) &&
      Math.abs(
        r.charged_usd - r.known_usd - r.unresolved_cost_reservation_usd,
      ) <=
        1e-9 * Math.max(1, r.charged_usd) &&
      (r.physical_sends > 0 || r.charged_usd === 0),
    "STAGE_C_AGGREGATE_ACCOUNTING",
  );
  requireThat(
    hash(s.archive_sha256) &&
      c &&
      count(c.attempts) &&
      c.attempts <= 3 &&
      hash(c.packet_sha256) &&
      c.packet_sha256 === s.freeze.grade.packet_sha256 &&
      (c.attempts === 0
        ? c.status === "NOT_TESTED" && c.receipt_sha256 === null
        : c.status === "RESERVED"
          ? c.receipt_sha256 === null
          : ["PASSED", "FAILED", "REJECTED", "MECHANICAL"].includes(c.status) &&
            hash(c.receipt_sha256)),
    "STAGE_C_AGGREGATE_CALIBRATION",
  );
  if (c.attempts || r.rows.some((row: any) => row.assessment_attempts))
    requireThat(
      reference(s.decisions.grading) &&
        s.decisions.grading !== s.decisions.workload,
      "STAGE_C_AGGREGATE_GRADE_DECISION",
    );
}
export function combineResults(snapshots: Snapshot[]) {
  requireThat(snapshots.length > 0, "STAGE_C_AGGREGATE_EMPTY");
  const allCases = stageCases();
  function inventory(snapshot: Snapshot) {
    return snapshot.projection.batches
      .flat()
      .flatMap((r) => {
        const c = caseDefinition(r.lane.scenario);
        return (
          c.pair ? allCases.filter((v) => v.pair?.id === c.pair!.id) : [c]
        ).map((v) => ({
          lane: r.lane.lane,
          case_id: v.id,
          model: r.lane.model,
          repeat: r.lane.repeat,
          seed: r.lane.seed,
          profile: r.lane.profile,
          recipe_sha256: v.pair?.position === "B" ? r.pair : r.trial.timeline,
          sut: snapshot.freeze.source.sut.commit,
          pi: snapshot.freeze.source.sut.submodules["src/pi_resource"],
        }));
      })
      .sort(
        (a, b) =>
          a.lane.localeCompare(b.lane) || a.case_id.localeCompare(b.case_id),
      );
  }
  const expected = inventory(snapshots[0]),
    matrix = sha(JSON.stringify(expected)),
    key = (l: string, c: string) => JSON.stringify([l, c]);
  requireThat(
    expected.length === 99 &&
      new Set(expected.map((r) => r.lane)).size === 93 &&
      new Set(expected.map((r) => key(r.lane, r.case_id))).size === 99,
    "STAGE_C_AGGREGATE_DENOMINATOR",
  );
  const observed = new Map<string, any>();
  const identities = new Map<
    string,
    { observations: Set<string>; lineages: Set<string> }
  >();
  let physical = 0,
    known = 0,
    unpriced = 0;
  for (const s of snapshots) {
    requireThat(
      s.freeze.evidence_class === "LIVE" &&
        s.result.evidence_class === "LIVE" &&
        s.result.batch_closed &&
        s.result.freeze_sha256 === s.hash &&
        sha(JSON.stringify(s.projection)) === s.freeze.projection_sha256 &&
        JSON.stringify(s.projection.batches[s.freeze.batch_index - 1]) ===
          JSON.stringify(s.freeze.batch) &&
        sha(JSON.stringify(inventory(s))) === matrix &&
        reference(s.decisions.workload),
      "STAGE_C_AGGREGATE_FREEZE",
    );
    checkAccounting(s);
    const lineages = new Map<string, string>();
    const sends = new Set<string>();
    const admitted = new Set(
      s.freeze.batch.map((r: FrozenBatch[number]) => r.lane.lane),
    );
    const required = expected.filter((r) => admitted.has(r.lane));
    requireThat(
      required.length === s.result.rows.length,
      "STAGE_C_AGGREGATE_BATCH_COVERAGE",
    );
    for (const row of s.result.rows) {
      const match = required.find(
        (r) => r.lane === row.source_lineage && r.case_id === row.scenario,
      );
      const id = key(row.source_lineage, row.scenario);
      requireThat(
        match &&
          !observed.has(id) &&
          row.external_recipe_sha256 === match.recipe_sha256 &&
          row.model === match.model &&
          row.repeat === match.repeat &&
          row.profile === match.profile &&
          ["COMPLETED", "INCOMPLETE", "UNRUN"].includes(row.status),
        "STAGE_C_AGGREGATE_ROW",
      );
      const definition = caseDefinition(row.scenario);
      const lane = s.freeze.batch.find(
        (r: FrozenBatch[number]) => r.lane.lane === row.source_lineage,
      ).lane;
      const attempts = row.physical_attempts_on_shared_lineage;
      requireThat(
        count(attempts) &&
          attempts <= lane.cap &&
          Array.isArray(row.identities) &&
          row.identities.length === attempts &&
          count(row.assessment_attempts) &&
          row.assessment_attempts <= 3 &&
          (row.assessment_attempts
            ? s.calibration.status === "PASSED" &&
              ["NOT_TESTED", "ACCEPTED", "REJECTED", "MECHANICAL"].includes(
                row.assessment_status,
              )
            : row.assessment_status === "NOT_TESTED") &&
          row.family === definition.family &&
          row.published_version ===
            s.freeze.providers[row.model].published_version &&
          row.grades &&
          Object.keys(row.grades).length === definition.assertions.length &&
          definition.assertions.every((a) =>
            verdicts.includes(row.grades[a]),
          ) &&
          (row.status === "COMPLETED"
            ? attempts > 0 && row.reason === null
            : typeof row.reason === "string" && row.reason.length > 0) &&
          (row.status !== "UNRUN" ||
            (attempts === 0 &&
              row.assessment_attempts === 0 &&
              Object.values(row.grades).every((v) => v === "NOT_TESTED"))) &&
          (row.c16 === null ||
            (row.scenario === "C16-combined" &&
              ["CLOSED", "OPEN"].includes(row.c16?.gate) &&
              (row.c16.gate === "CLOSED"
                ? row.assessment_status === "ACCEPTED" &&
                  ["PASS", "FAIL"].includes(row.c16.verdict)
                : row.c16.verdict === "UNRESOLVED"))),
        "STAGE_C_AGGREGATE_ROW_EVIDENCE",
      );
      const shared = JSON.stringify([row.status, row.reason, row.identities]);
      if (lineages.has(row.source_lineage))
        requireThat(
          lineages.get(row.source_lineage) === shared,
          "STAGE_C_AGGREGATE_SHARED_LINEAGE",
        );
      else {
        lineages.set(row.source_lineage, shared);
        for (const identity of row.identities) {
          requireThat(
            typeof identity.send === "string" &&
              identity.send.length &&
              !sends.has(identity.send) &&
              Array.isArray(identity.fingerprint_digests) &&
              identity.fingerprint_digests.every(hash) &&
              [
                "PRESENT",
                "ABSENT",
                "NULL",
                "UNKNOWN",
                "CHANGED_WITHIN_SEND",
                "INVALID",
              ].includes(identity.fingerprint_status),
            "STAGE_C_AGGREGATE_IDENTITY",
          );
          sends.add(identity.send);
        }
      }
      for (const send of row.identities) {
        if (
          !send.returned_model ||
          !["PRESENT", "ABSENT", "NULL"].includes(send.fingerprint_status)
        )
          continue;
        const stratum = JSON.stringify([
          row.model,
          row.published_version,
          send.returned_model,
          send.fingerprint_status,
          send.fingerprint_digests,
        ]);
        const included = identities.get(stratum) ?? {
          observations: new Set(),
          lineages: new Set(),
        };
        included.observations.add(id);
        included.lineages.add(row.source_lineage);
        identities.set(stratum, included);
      }
      observed.set(id, {
        ...match,
        freeze_sha256: s.hash,
        runner: s.freeze.source.head,
        row,
      });
    }
    requireThat(
      sends.size === s.result.physical_sends &&
        lineages.size === s.result.lineages,
      "STAGE_C_AGGREGATE_ACCOUNTING",
    );
    physical += s.result.physical_sends;
    known += s.result.known_usd;
    unpriced += s.result.unresolved_cost_reservation_usd;
  }
  const rows = expected.map(
    (r) =>
      observed.get(key(r.lane, r.case_id)) ?? {
        ...r,
        row: { status: "UNRUN", reason: "BATCH_RESULTS_UNAVAILABLE" },
      },
  );
  return {
    schema: "issue122-cross-batch-v1",
    ...familyResults(
      rows.map((r) => {
        const c = caseDefinition(r.case_id);
        return {
          family: c.family,
          source_lineage: r.lane,
          status: r.row.status,
          grades:
            r.row.grades ??
            Object.fromEntries(c.assertions.map((a) => [a, "NOT_TESTED"])),
        };
      }),
    ),
    matrix_sha256: matrix,
    expected_lineages: 93,
    expected_observations: 99,
    reported_observations: observed.size,
    rows,
    proposals: snapshots.map((s) => ({
      freeze_sha256: s.hash,
      runner: s.freeze.source.head,
      decisions: s.decisions,
      calibration: s.calibration,
      archive_sha256: s.archive_sha256,
    })),
    dispositions: Object.fromEntries(
      ["COMPLETED", "INCOMPLETE", "UNRUN"].map((status) => [
        status,
        rows.filter((r) => r.row.status === status).length,
      ]),
    ),
    c16_closed: rows.filter(
      (r) => r.case_id === "C16-combined" && r.row.c16?.gate === "CLOSED",
    ).length,
    strata: [...identities].map(([stratum, v]) => ({
      stratum: JSON.parse(stratum),
      observations: v.observations.size,
      lineages: v.lineages.size,
    })),
    physical_attempts: physical,
    known_usd: known,
    unpriced_reservation_usd: unpriced,
  };
}
export function loadCombinedResults(root: string) {
  const index = readJSON(path.join(root, "inputs", "stage-c-batch-index.json"));
  requireThat(
    Array.isArray(index.batches) && index.batches.length > 0,
    "STAGE_C_AGGREGATE_INDEX",
  );
  const { destination, mount } = archiveConfiguration();
  assertArchiveTargetExternal(root, destination, mount);
  return combineResults(
    index.batches.map((b: any) =>
      archivedBatch(destination, path.join(root, "inputs", "batches"), b),
    ),
  );
}
