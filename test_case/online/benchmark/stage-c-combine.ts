import {
  archivedC04,
  c04Freeze,
  firstC16,
  c04Trial,
  validateSeries,
} from "./stage-c-remaining-series.ts";
// The aggregate reads portable, hash-bound exports. Only an exact-head runner produces each individual batch result.
import path from "node:path";
import { selectGoBatch, beforeGo } from "./stage-c-go-continuation.ts";
import { isDeepStrictEqual } from "node:util";
import {
  goReader,
  goReaderPolicy,
  goVisibilityVersion,
  officialReader,
  visibilityV2,
} from "./stage-c-visibility-rubric.ts";
import { scoringRubric } from "./stage-c-grading.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
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
  assessment_grade?: Snapshot["freeze"]["grade"];
  assessment_amendment?: string;
  original_calibration?: Snapshot["calibration"];
  calibration: {
    kind?: string;
    origin?: any;
    go?: unknown;
    inference_dispatches?: number;
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
  const go = Boolean(s.freeze.go_continuation);
  const known = go ? r.tariff_estimate_usd : r.known_usd;
  const reserved = go
    ? r.unresolved_tariff_reservation_usd
    : r.unresolved_cost_reservation_usd;
  const limit = go ? r.tariff_guard_usd : r.charged_usd;
  requireThat(
    !go ||
      (r.billing_basis === "opencode_go_subscription_allowance" &&
        r.cash_charge_usd === null &&
        r.known_usd === null &&
        r.charged_usd === null &&
        r.unresolved_cost_reservation_usd === null),
    "STAGE_C_GO_ACCOUNTING",
  );
  requireThat(
    r.schema === "issue122-completion-results-v1" &&
      r.batch_closed === true &&
      Array.isArray(r.rows) &&
      r.observations === r.rows.length &&
      r.lineages === s.freeze.batch.length &&
      count(r.physical_sends) &&
      r.metered_attempts === r.physical_sends &&
      [known, reserved, limit].every(money) &&
      Math.abs(limit - known - reserved) <= 1e-9 * Math.max(1, limit) &&
      (r.physical_sends > 0 || limit === 0),
    "STAGE_C_AGGREGATE_ACCOUNTING",
  );
  requireThat(
    hash(s.archive_sha256) &&
      c &&
      count(c.attempts) &&
      c.attempts <= 3 &&
      hash(c.packet_sha256) &&
      c.packet_sha256 ===
        (s.assessment_grade ?? s.freeze.grade).packet_sha256 &&
      (c.attempts === 0
        ? (c.status === "NOT_TESTED" && c.receipt_sha256 === null) ||
          (go &&
            c.kind === "REFERENCE" &&
            c.inference_dispatches === 0 &&
            c.status === "PASSED" &&
            c.receipt_sha256 ===
              s.freeze.go_continuation.calibration_origin?.receipt_sha256)
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
  const effective = (s: Snapshot) => s.assessment_grade ?? s.freeze.grade;
  const grader = effective(
    snapshots.find((s) => effective(s).version === visibilityV2) ??
      snapshots[0],
  );
  const recovery = new Map<string, any>();
  const quotaRecoveries = new Map<string, any>();
  const originals = new Map<string, any>();
  const priorGo: Snapshot[] = [];
  let goTariff = 0,
    goReserve = 0,
    goSends = 0;
  const order = (s: Snapshot) =>
    s.freeze.go_continuation
      ? 10 + s.freeze.batch_index
      : Number(Boolean(s.freeze.remaining_series));
  const ordered = [...snapshots].sort((a, b) => order(a) - order(b));
  for (const s of ordered) {
    if (s.freeze.remaining_series) {
      validateSeries(
        s.freeze.remaining_series,
        s.freeze.batch_index,
        s.projection.batches,
      );
      requireThat(
        s.freeze.remaining_series.matrix_sha256 === matrix,
        "STAGE_C_SERIES_MATRIX",
      );
    }
    const go = s.freeze.go_continuation;
    if (go) {
      requireThat(
        s.freeze.remaining_series &&
          !priorGo.some((v) => v.freeze.batch_index === s.freeze.batch_index) &&
          priorGo.every(
            (v) =>
              v.freeze.go_continuation.decision_sha256 === go.decision_sha256,
          ) &&
          s.freeze.providers["deepseek-flash"].route === "opencode-go",
        "STAGE_C_GO_AGGREGATE_BINDING",
      );
      for (const p of Object.values(beforeGo))
        requireThat(
          ordered.some(
            (x) => x.hash === p.freeze && x.archive_sha256 === p.archive,
          ),
          "STAGE_C_GO_PRIOR_ARCHIVE",
        );
      if (go.calibration_origin) {
        const origin = priorGo.find(
          (x) => x.freeze.batch_index === go.source_partition,
        );
        requireThat(
          origin &&
            origin.hash === go.calibration_origin.freeze_sha256 &&
            origin.archive_sha256 === go.calibration_origin.archive_sha256 &&
            origin.calibration.kind === "ORIGIN" &&
            origin.calibration.attempts === 1 &&
            origin.calibration.status === "PASSED" &&
            isDeepStrictEqual(
              origin.calibration.origin,
              go.calibration_origin,
            ) &&
            isDeepStrictEqual(s.calibration.origin, go.calibration_origin) &&
            s.calibration.kind === "REFERENCE",
          "STAGE_C_GO_CALIBRATION_SOURCE",
        );
      }
      if (go.calibration_withheld)
        requireThat(
          s.calibration.attempts === 0 &&
            s.calibration.status === "NOT_TESTED" &&
            s.result.rows.every((r: any) => !r.assessment_attempts),
          "STAGE_C_GO_CALIBRATION_WITHHELD",
        );
      priorGo.push(s);
    }
    const g = s.assessment_grade ?? s.freeze.grade;
    requireThat(
      g &&
        reference(g.reader) &&
        reference(g.version) &&
        hash(g.rubric_sha256) &&
        hash(g.key_sha256) &&
        (go
          ? g.reader === goReader &&
            g.version === goVisibilityVersion &&
            isDeepStrictEqual(g.transport, goReaderPolicy) &&
            g.rubric_sha256 ===
              sha(gradeJSONBytes(scoringRubric(goReader, goVisibilityVersion)))
          : g.reader === grader.reader &&
            ((g.version === grader.version &&
              g.rubric_sha256 === grader.rubric_sha256) ||
              (grader.version === visibilityV2 &&
                grader.reader === officialReader &&
                grader.rubric_sha256 ===
                  sha(
                    gradeJSONBytes(scoringRubric(officialReader, visibilityV2)),
                  ) &&
                g.version === "issue122-comparison-reader-v1" &&
                g.rubric_sha256 ===
                  sha(gradeJSONBytes(scoringRubric(officialReader))) &&
                s.calibration.status === "FAILED" &&
                s.result.rows.every((r: any) => r.assessment_attempts === 0)))),
      "STAGE_C_AGGREGATE_RUBRIC",
    );
    requireThat(
      s.freeze.evidence_class === "LIVE" &&
        s.result.evidence_class === "LIVE" &&
        s.result.batch_closed &&
        s.result.freeze_sha256 === s.hash &&
        sha(JSON.stringify(s.projection)) === s.freeze.projection_sha256 &&
        JSON.stringify(
          go
            ? selectGoBatch(
                s.projection.batches,
                s.freeze.remaining_series,
                go,
                s.freeze.batch_index,
              )
            : s.projection.batches[s.freeze.batch_index - 1],
        ) === JSON.stringify(s.freeze.batch) &&
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
      const previous = observed.get(id);
      const quotaOnly =
        previous?.row.identities?.length === 1 &&
        previous.row.identities[0].outcome === "EXHAUSTED_QUOTA" &&
        previous.row.identities[0].returned_model === null &&
        previous.row.status === "INCOMPLETE" &&
        previous.row.reason === "SCENARIO_PRODUCT_BLOCKED";
      const zeroSend =
        previous?.row.status === "UNRUN" &&
        previous.row.reason === "HOLD_EXHAUSTED_QUOTA" &&
        previous.row.identities.length === 0;
      const goRepeat =
        go &&
        [5, 6].includes(go.partition) &&
        previous?.freeze_sha256 === go.prior_freezes[go.partition] &&
        !quotaRecoveries.has(id) &&
        previous.row.assessment_attempts === 0 &&
        (zeroSend || (go.scope === 84 && quotaOnly));
      requireThat(
        !go || (go.partition === 7 ? !previous : goRepeat),
        "STAGE_C_GO_NO_REPLACEMENT",
      );
      const authorizedRepeat =
        previous?.freeze_sha256 === firstC16 &&
        s.freeze.remaining_series?.previous_c16 === firstC16 &&
        s.freeze.batch_index === 2 &&
        row.scenario === "C16-combined" &&
        previous.row.status === "INCOMPLETE" &&
        previous.row.reason === "UNSUPPORTED_OPERATION_STATE" &&
        previous.row.assessment_attempts === 0;

      requireThat(
        match &&
          (!previous || authorizedRepeat || goRepeat) &&
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
          ...(go ? ["opencode-go"] : []),
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
        included.observations.add(
          authorizedRepeat ? "c16-recovery-1/" + id : id,
        );
        included.lineages.add(
          authorizedRepeat
            ? "c16-recovery-1/" + row.source_lineage
            : row.source_lineage,
        );
        identities.set(stratum, included);
      }
      if (goRepeat && zeroSend) originals.set(id, previous);
      if (goRepeat && quotaOnly)
        requireThat(!quotaRecoveries.has(id), "STAGE_C_GO_DUPLICATE_RECOVERY");
      (goRepeat && quotaOnly
        ? quotaRecoveries
        : authorizedRepeat
          ? recovery
          : observed
      ).set(id, {
        ...(go
          ? {
              route: "opencode-go",
              original_freeze_sha256: previous?.freeze_sha256 ?? null,
            }
          : {}),
        ...(authorizedRepeat
          ? {
              series: "c16-recovery-1",
              lane_identity: "c16-recovery-1/" + row.source_lineage,
              original_freeze_sha256: firstC16,
            }
          : {}),
        ...match,
        freeze_sha256: s.hash,
        reader_version: g.version,
        reader_rubric_sha256: g.rubric_sha256,
        runner: s.freeze.source.head,
        row,
      });
    }
    requireThat(
      sends.size === s.result.physical_sends &&
        lineages.size === s.result.lineages,
      "STAGE_C_AGGREGATE_ACCOUNTING",
    );
    const amendment = s.result.archived_control;
    if (amendment) {
      const id = key(archivedC04, "C04-resident"),
        original = observed.get(id);
      requireThat(
        s.freeze.remaining_series?.partition === 2 &&
          s.calibration.status === "PASSED" &&
          original?.freeze_sha256 === c04Freeze &&
          original.row.assessment_attempts === 0 &&
          amendment.source_freeze === c04Freeze &&
          amendment.trial_sha256 === c04Trial &&
          hash(amendment.packet_sha256) &&
          ["ACCEPTED", "REJECTED", "MECHANICAL"].includes(amendment.status) &&
          (amendment.status === "ACCEPTED"
            ? verdicts.includes(amendment.verdict)
            : amendment.verdict === null),
        "STAGE_C_ARCHIVED_C04_ASSESSMENT",
      );
      const row = {
        ...original.row,
        assessment_attempts: 1,
        assessment_status: amendment.status,
      };
      if (amendment.status === "ACCEPTED")
        row.grades = { ...row.grades, natural_access: amendment.verdict };
      observed.set(id, {
        ...original,
        row,
        previous_assessment: original.row,
        assessment_freeze_sha256: s.hash,
        reader_version: g.version,
        reader_rubric_sha256: g.rubric_sha256,
      });
    }
    physical += s.result.physical_sends;
    if (go) {
      goTariff += s.result.tariff_estimate_usd;
      goReserve += s.result.unresolved_tariff_reservation_usd;
      goSends += s.result.physical_sends;
    } else {
      known += s.result.known_usd;
      unpriced += s.result.unresolved_cost_reservation_usd;
    }
  }
  const rows = expected.map(
    (r) =>
      observed.get(key(r.lane, r.case_id)) ?? {
        ...r,
        row: { status: "UNRUN", reason: "BATCH_RESULTS_UNAVAILABLE" },
      },
  );
  const comparisonRows = rows;
  const familyRows = comparisonRows.map((r) => {
    const c = caseDefinition(r.case_id);
    return {
      family: c.family,
      source_lineage: r.lane,
      status: r.row.status,
      grades:
        r.row.grades ??
        Object.fromEntries(c.assertions.map((a) => [a, "NOT_TESTED"])),
      version: r.reader_version ?? null,
      rubric_sha256: r.reader_rubric_sha256 ?? null,
    };
  });
  const versions = new Map(
    snapshots.map((s) => {
      const grade = effective(s);
      return [grade.rubric_sha256, grade.version] as const;
    }),
  );
  const familySummary = familyResults(familyRows);
  // Retain execution denominators across all 99 rows. Only group semantic counts
  // across observations assessed with the same rubric.
  const family_counts_by_reader = [...versions].map(
    ([rubric_sha256, version]) => ({
      rubric_sha256,
      version,
      families: familyResults(
        familyRows.filter((r) => r.rubric_sha256 === rubric_sha256),
      ).families,
    }),
  );
  const families =
    versions.size === 1
      ? familySummary.families
      : Object.fromEntries(
          Object.entries(familySummary.families).map(
            ([name, { assertions, ...denominators }]) => [name, denominators],
          ),
        );
  return {
    schema: "issue122-cross-batch-v1",
    families,
    excluded: familySummary.excluded,
    family_counts_by_reader,
    matrix_sha256: matrix,
    expected_lineages: 93,
    expected_observations: 99,
    reported_observations: observed.size,
    c16_recovery: [...recovery.values()],
    ...(priorGo.length
      ? {
          go_zero_send_originals: [...originals.values()],
          go_quota_recovery: [...quotaRecoveries.values()],
          comparison_rows: comparisonRows,
          go_subscription: {
            cash_charge_usd: null,
            tariff_estimate_usd: goTariff,
            unresolved_tariff_reservation_usd: goReserve,
            physical_sends: goSends,
            reader: priorGo.map((s) => ({
              freeze: s.hash,
              calibration: s.calibration,
              candidates: s.result.candidate_reader_go,
            })),
          },
          comparison_dispositions: Object.fromEntries(
            ["COMPLETED", "INCOMPLETE", "UNRUN"].map((st) => [
              st,
              comparisonRows.filter((r) => r.row.status === st).length,
            ]),
          ),
        }
      : {}),
    rows,
    proposals: snapshots.map((s) => ({
      freeze_sha256: s.hash,
      runner: s.freeze.source.head,
      decisions: s.decisions,
      grade: s.assessment_grade ?? s.freeze.grade,
      ...(s.assessment_amendment
        ? {
            grading_amendment_sha256: s.assessment_amendment,
            original_grade: s.freeze.grade,
            original_calibration: s.original_calibration,
          }
        : {}),
      calibration: s.calibration,
      archive_sha256: s.archive_sha256,
    })),
    dispositions: Object.fromEntries(
      ["COMPLETED", "INCOMPLETE", "UNRUN"].map((status) => [
        status,
        rows.filter((r) => r.row.status === status).length,
      ]),
    ),
    c16_closed: (recovery.size ? [...recovery.values()] : rows).filter(
      (r) => r.case_id === "C16-combined" && r.row.c16?.gate === "CLOSED",
    ).length,
    strata: [...identities].map(([stratum, v]) => ({
      stratum: JSON.parse(stratum),
      observations: v.observations.size,
      lineages: v.lineages.size,
    })),
    reader_disputed_usd: snapshots.reduce(
      (n, s) =>
        n +
        Number((s.calibration as { disputed_usd?: number }).disputed_usd ?? 0) +
        Number(s.result.candidate_reader_disputed_usd ?? 0),
      0,
    ),
    reader_metered_usd:
      Math.round(
        snapshots.reduce(
          (n, s) =>
            n +
            Number(
              (s.calibration as { metered_usd?: number }).metered_usd ?? 0,
            ) +
            Number(s.result.candidate_reader_metered_usd ?? 0),
          0,
        ) * 1e9,
      ) / 1e9,
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
