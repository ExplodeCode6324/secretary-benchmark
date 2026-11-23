// The aggregate reads portable, hash-bound exports. Only an exact-head runner produces each individual batch result.
import path from "node:path";
import { read, readJSON, requireThat, sha } from "./io.ts";
import { caseDefinition, stageCases } from "./stage-c-plan.ts";
import type { FrozenBatch } from "./stage-c-freeze.ts";

type Decision = { workload: string; grading?: string };
type Snapshot = {
  freeze: any;
  projection: { batches: FrozenBatch[] };
  result: any;
  hash: string;
  decisions: Decision;
};
const reference = (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 400;
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
      if (row.assessment_attempts)
        requireThat(
          reference(s.decisions.grading) &&
            s.decisions.grading !== s.decisions.workload,
          "STAGE_C_AGGREGATE_GRADE_DECISION",
        );
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
    matrix_sha256: matrix,
    expected_lineages: 93,
    expected_observations: 99,
    reported_observations: observed.size,
    rows,
    proposals: snapshots.map((s) => ({
      freeze_sha256: s.hash,
      runner: s.freeze.source.head,
      decisions: s.decisions,
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
  return combineResults(
    index.batches.map((b: any) => {
      requireThat(
        [b.freeze_sha256, b.results_sha256].every(
          (h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h),
        ),
        "STAGE_C_AGGREGATE_DIGEST",
      );
      const dir = path.join(root, "inputs", "batches", b.freeze_sha256),
        freeze = read(path.join(dir, "stage-c-freeze.json")),
        result = read(path.join(dir, "stage-c-results.json"));
      requireThat(
        sha(freeze) === b.freeze_sha256 && sha(result) === b.results_sha256,
        "STAGE_C_AGGREGATE_DIGEST",
      );
      return {
        hash: b.freeze_sha256,
        freeze: JSON.parse(freeze.toString()),
        projection: readJSON(path.join(dir, "stage-c-projection.json")),
        result: JSON.parse(result.toString()),
        decisions: b.decisions,
      };
    }),
  );
}
