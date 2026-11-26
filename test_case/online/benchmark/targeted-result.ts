import { continuationUsage } from "./stage-c-continuation-usage.ts";
import { continuationWorkload, isRetest } from "./stage-c-targeted-policy.ts";
import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
import { isDeepStrictEqual } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { read, repository, sha, requireThat } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import { readerAction } from "./targeted-reader-cli.ts";
import {
  validateTargetedFreeze,
  retestSeries,
  targetedRoutes,
  type TargetedReaderFreeze,
  type TargetedRoute,
} from "./targeted-reader-grade.ts";
import {
  checkWorkloadClosure,
  workloadLanes,
} from "./targeted-reader-workload.ts";
import {
  agreedAssertions,
  targetedWorkloadResult,
} from "./targeted-workload-result.ts";
import { targetedAccountedAmount } from "./stage-c-targeted-account.ts";
import { ledger } from "./campaign.ts";

const baselineSHA =
  "2c900be744be13ae1646242b9243c6f908e82a63204d2ec9b30bacb0062017a3";
const json = (file: string, expected: string) => {
  const bytes = read(file);
  requireThat(
    /^[a-f0-9]{64}$/.test(expected) && sha(bytes) === expected,
    "TARGETED_EXPORT_DIGEST",
  );
  return JSON.parse(bytes.toString());
};
const safeReason = (s: unknown) =>
  typeof s === "string" && /^[A-Z0-9_]{1,100}$/.test(s)
    ? s
    : s
      ? "DETAILS_IN_PRIVATE_ARCHIVE"
      : null;

type BlindAttempt = {
  id: string;
  state: string;
  started: number;
  calibrationTime?: number;
  previousCalibration?: string | null;
};
export function blindHistory(route: TargetedRoute, attempts: BlindAttempt[]) {
  let passed: BlindAttempt | undefined, rejected: BlindAttempt | undefined;
  let pending = false;
  for (const a of attempts) {
    requireThat(
      Number.isFinite(a.started) && !pending && !rejected,
      "CONTINUATION_REPEAT_AFTER_RECEIPT",
    );
    if (passed)
      requireThat(
        route === "calibration" &&
          a.previousCalibration === passed.id &&
          a.started >= passed.calibrationTime! + 86400000,
        "CONTINUATION_DUPLICATE_GRADE",
      );
    if (a.state === "GRADED") passed = a;
    else if (a.state === "READER_RECEIPT_REJECTED") rejected = a;
    else if (a.state === "PENDING_RECONCILIATION") pending = true;
    else
      requireThat(
        [
          "CONFIRMED_UNSENT",
          "RECONCILED_NO_GRADE",
          "PROVIDER_REFUSED",
        ].includes(a.state),
        "CONTINUATION_UNKNOWN_DISPOSITION",
      );
  }
  return { passed, rejected };
}
/** Replay the immutable publication chain and prohibit new attempts after the first publication. */
export function verifyReaderPublications(seriesDir: string, latest: any) {
  let row = latest;
  let cursor = seriesDir;
  while (true) {
    const { sequence, predecessor_sha256: predecessor } = row.publication;
    requireThat(
      Number.isSafeInteger(sequence) &&
        sequence >= 1 &&
        path.basename(path.dirname(cursor)) === "publications" &&
        fs.realpathSync(cursor) === cursor &&
        sha(read(path.join(cursor, "series-final.json"))) ===
          path.basename(cursor),
      "READER_PUBLICATION_IDENTITY",
    );
    if (sequence === 1) {
      requireThat(predecessor === null, "READER_PUBLICATION_ORIGIN");
      break;
    }
    requireThat(
      typeof predecessor === "string" && /^[a-f0-9]{64}$/.test(predecessor),
      "READER_PUBLICATION_PARENT",
    );
    const child = cursor;
    cursor = path.join(path.dirname(cursor), predecessor);
    const prior = json(path.join(cursor, "series-final.json"), predecessor);
    requireThat(
      prior.publication?.sequence === sequence - 1 &&
        [
          "series_sha256",
          "operator_release_sha256",
          "workload_freeze_sha256",
          "workload_dispatch_sha256",
          "confirmed_system_failure_sha256",
        ].every((k) => row[k] === prior[k]) &&
        isDeepStrictEqual(
          Object.keys(row.routes).sort(),
          Object.keys(prior.routes).sort(),
        ),
      "READER_PUBLICATION_BINDING",
    );
    for (const [route, previous] of Object.entries<any>(prior.routes)) {
      const next = row.routes[route];
      const attempts = previous.attempts ?? [],
        continued = next.attempts ?? [];
      requireThat(
        attempts.length === continued.length &&
          attempts.every(
            (a: any, i: number) =>
              a.attempt === continued[i].attempt &&
              [
                "context.json",
                "outcome.json",
                "metadata.json",
                "a-query.txt",
                "a-dispatch.json",
                "a-raw.txt",
                "a-transport.json",
                "a-receipt.json",
                "provider-source",
                "provider-evidence.json",
                "assessment.json",
                "restore-selection.json",
                "reconciliation.json",
                "metering-evidence.json",
                "metering-source",
              ].every((file) => {
                const dir = path.join("exchange", route, "attempts", a.attempt);
                const old = path.join(cursor, dir, file);
                return (
                  !fs.existsSync(old) ||
                  read(old).equals(read(path.join(child, dir, file)))
                );
              }),
          ),
        "READER_PUBLICATION_ATTEMPT_CHANGED",
      );
      if (
        previous.status !== "UNRESOLVED" ||
        previous.reason !== "PENDING_RECONCILIATION"
      )
        requireThat(
          ["status", "reason", "selected_attempt", "assessment"].every((k) =>
            isDeepStrictEqual(next[k], previous[k]),
          ),
          "READER_PUBLISHED_GRADE_CHANGED",
        );
    }
    row = prior;
  }
}
export function continuationReaderView(
  seriesDir: string,
  facility: string,
  final: any,
  f: TargetedReaderFreeze,
) {
  const publication =
    f.routes.calibration.decision_sha256 ===
    continuationWorkload.decision_sha256;
  if (publication) {
    requireThat(final.publication, "READER_PUBLICATION_REQUIRED");
    verifyReaderPublications(seriesDir, final);
  }
  const grades = new Map<TargetedRoute, ReturnType<typeof readerAction>>();
  const all: any[] = [];
  let failedCalibrationAt: number | undefined;
  const readers = (["calibration", "c16-repeat1", "c12b"] as const).map(
    (route) => {
      const row = final.routes[route];
      const ex = path.join(seriesDir, "exchange", route);
      const dir = path.join(ex, "attempts");
      const list = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      const attempts = row.attempts ?? [];
      requireThat(
        Array.isArray(attempts) &&
          isDeepStrictEqual(list, attempts.map((a: any) => a.attempt).sort()),
        "CONTINUATION_READER_HISTORY",
      );
      const history: BlindAttempt[] = [];
      for (const [index, attempt] of attempts.entries()) {
        const id = attempt.attempt;
        requireThat(
          typeof id === "string" &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id),
          "CONTINUATION_ATTEMPT_ID",
        );
        const input = (name: string) => path.join(dir, id, name);
        const parsed = (name: string) =>
          JSON.parse(read(input(name)).toString("utf8"));
        const original = parsed("outcome.json");
        const ctx = parsed("context.json");
        requireThat(
          ctx.sequence === index + 1 &&
            ctx.attempt === id &&
            ctx.route === route &&
            ctx.series_sha256 === final.series_sha256 &&
            ctx.packet_sha256 === f.routes[route].packet_sha256 &&
            ctx.query_sha256 === f.routes[route].query_sha256 &&
            ctx.metadata_sha256 === sha(read(input("metadata.json"))) &&
            ctx.query_sha256 === sha(read(input("a-query.txt"))) &&
            Object.entries(ctx).every(([k, v]) => original[k] === v),
          "CONTINUATION_ATTEMPT_BINDING",
        );
        const merged = fs.existsSync(input("reconciliation.json"))
          ? parsed("reconciliation.json")
          : original;
        if (fs.existsSync(input("metering-evidence.json"))) {
          const meter = parsed("metering-evidence.json");
          requireThat(
            meter.attempt === id &&
              meter.source_sha256 === sha(read(input("metering-source"))),
            "CONTINUATION_METERING_SOURCE",
          );
          for (const key of ["actual_cash_usd", "actual_equivalent_usd"])
            if (meter[key] != null) merged[key] = meter[key];
          merged.metering_sha256 = sha(read(input("metering-evidence.json")));
        }
        const restore = fs.existsSync(input("restore-selection.json"))
          ? parsed("restore-selection.json").source_sha256
          : null;
        requireThat(
          restore === null ||
            (typeof restore === "string" &&
              /^[0-9a-f]{64}$/.test(restore) &&
              restore === attempt.reconciliation_sha256),
          "CONTINUATION_RESTORED_RECEIPT",
        );
        const transport = restore
          ? input("recovery/" + restore + "/a-transport.json")
          : input("a-transport.json");
        requireThat(
          isDeepStrictEqual(merged, attempt) &&
            attempt.physical_dispatches ===
              Number(fs.existsSync(input("a-dispatch.json"))) &&
            attempt.transport_sha256 ===
              (fs.existsSync(transport) ? sha(read(transport)) : null),
          "CONTINUATION_ACCOUNTING",
        );
        if (attempt.physical_dispatches) {
          const dispatch = parsed("a-dispatch.json");
          requireThat(
            dispatch.series_sha256 === ctx.series_sha256 &&
              dispatch.route === route &&
              dispatch.input_sha256 === ctx.query_sha256 &&
              dispatch.metadata_sha256 === ctx.metadata_sha256,
            "CONTINUATION_DISPATCH_IDENTITY",
          );
        }
        const wire = fs.existsSync(transport)
          ? JSON.parse(read(transport).toString())
          : null;
        const complete =
          wire?.http_status === 200 &&
          ["length", "stop"].includes(wire.finish_reason) &&
          !wire.stream_incomplete &&
          !wire.transport_exception_type;
        const received = ["GRADED", "READER_RECEIPT_REJECTED"].includes(
          attempt.state,
        );
        requireThat(
          received === complete &&
            (!received || attempt.physical_dispatches === 1),
          "CONTINUATION_RECEIPT_CLASS",
        );
        let calibrationTime;
        if (
          received &&
          (publication ||
            fs.existsSync(input("assessment.json")) ||
            attempt.state === "GRADED" ||
            fs.existsSync(
              restore
                ? input("recovery/" + restore + "/a-receipt.json")
                : input("a-receipt.json"),
            ))
        ) {
          const verified = readerAction(
            "verify",
            seriesDir,
            final.series_sha256,
            route,
            facility,
            id,
            restore ?? undefined,
          );
          requireThat(
            "official" in verified &&
              verified.accepted === (attempt.state === "GRADED") &&
              gradeJSONBytes(verified).equals(
                gradeJSONBytes(parsed("assessment.json")),
              ),
            "CONTINUATION_RECEIPT_REPLAY",
          );
          calibrationTime = Date.parse(verified.calibration_native_at);
        }
        if (attempt.state === "CONFIRMED_UNSENT")
          requireThat(
            !attempt.physical_dispatches,
            "CONTINUATION_FALSE_UNSENT",
          );
        if (attempt.state === "PROVIDER_REFUSED")
          requireThat(
            attempt.physical_dispatches === 1 &&
              [400, 401, 402, 403, 404, 413, 422, 429].includes(
                wire?.http_status,
              ),
            "CONTINUATION_FALSE_REFUSAL",
          );
        if (attempt.state === "RECONCILED_NO_GRADE") {
          const evidence = parsed("provider-evidence.json"),
            source = parsed("provider-source");
          requireThat(
            original.state === "PENDING_RECONCILIATION" &&
              evidence.resolution === "NO_COMPLETED_GRADE" &&
              evidence.series_sha256 === ctx.series_sha256 &&
              evidence.route === route &&
              evidence.attempt === id &&
              evidence.packet_sha256 === ctx.packet_sha256 &&
              [
                "AUTHENTICATED_PROVIDER_NO_COMPLETION",
                "AUTHENTICATED_PROVIDER_REJECTION",
              ].includes(evidence.basis) &&
              evidence.wire_sha256 === parsed("a-dispatch.json").wire_sha256 &&
              source.wire_sha256 === evidence.wire_sha256 &&
              source.resolution === evidence.resolution &&
              !!source.provider_reference &&
              source.provider_reference === evidence.provider_reference &&
              sha(read(input("provider-source"))) === evidence.source_sha256 &&
              sha(read(input("provider-evidence.json"))) ===
                attempt.reconciliation_sha256,
            "CONTINUATION_NO_GRADE_PROOF",
          );
        }
        const started = Date.parse(ctx.started_at);
        if (route !== "calibration" && failedCalibrationAt !== undefined)
          requireThat(
            started < failedCalibrationAt,
            "CONTINUATION_AFTER_FAILED_CALIBRATION",
          );
        history.push({
          id,
          state: attempt.state,
          started,
          calibrationTime,
          previousCalibration: ctx.previous_calibration,
        });
        all.push(attempt);
      }
      const decision = blindHistory(route, history);
      if (route === "calibration" && decision.rejected)
        failedCalibrationAt = decision.rejected.started;
      let mark;
      if (row.status === "GRADED") {
        const selected = JSON.parse(
          read(path.join(ex, "selection.json")).toString(),
        );
        requireThat(
          !decision.rejected &&
            decision.passed?.id === selected.attempt &&
            selected.attempt === row.selected_attempt &&
            attempts.some(
              (a: any) =>
                a.state === "GRADED" && a.attempt === selected.attempt,
            ),
          "CONTINUATION_SELECTION",
        );
        const archived = json(
          path.join(dir, selected.attempt, "assessment.json"),
          selected.assessment_sha256,
        );
        const result = readerAction(
          "verify",
          seriesDir,
          final.series_sha256,
          route,
          facility,
        );
        requireThat(
          "official" in result &&
            result.accepted &&
            gradeJSONBytes(result).equals(gradeJSONBytes(row.assessment)) &&
            gradeJSONBytes(result).equals(gradeJSONBytes(archived)),
          "CONTINUATION_GRADE_REPLAY",
        );
        mark = result;
        grades.set(route, result);
      } else {
        requireThat(
          (row.status === "NOT_TESTED" ||
            (publication &&
              row.status === "UNRESOLVED" &&
              ((row.reason === "CALIBRATION_UNAVAILABLE_AT_PUBLICATION" &&
                route !== "calibration" &&
                Object.hasOwn(f.routes, route) &&
                !decision.passed &&
                !decision.rejected &&
                !attempts.some(
                  (a: any) => a.state === "PENDING_RECONCILIATION",
                ) &&
                (final.routes.calibration.status === "UNRESOLVED" ||
                  (final.publication.predecessor_sha256 &&
                    json(
                      path.join(
                        path.dirname(seriesDir),
                        final.publication.predecessor_sha256,
                        "series-final.json",
                      ),
                      final.publication.predecessor_sha256,
                    ).routes[route]?.reason === row.reason))) ||
                (route !== "calibration" &&
                  row.reason === "FIRST_RECEIPT_REJECTED" &&
                  !!decision.rejected) ||
                (["PENDING_RECONCILIATION", "RECONCILED_NO_GRADE"].includes(
                  row.reason,
                ) &&
                  attempts.at(-1)?.state === row.reason &&
                  attempts.at(-1)?.physical_dispatches === 1 &&
                  (row.reason !== "RECONCILED_NO_GRADE" ||
                    final.publication.sequence > 1))))) &&
            !row.assessment &&
            !row.selected_attempt &&
            (!fs.existsSync(path.join(ex, "selection.json")) ||
              (route === "calibration" &&
                (decision.rejected ||
                  (publication && row.status === "UNRESOLVED")) &&
                decision.passed?.id ===
                  JSON.parse(read(path.join(ex, "selection.json")).toString())
                    .attempt)),
          "CONTINUATION_TERMINAL",
        );
        requireThat(
          row.status === "UNRESOLVED" ||
            (!Object.hasOwn(f.routes, route) &&
              row.reason ===
                f.unavailable?.[route as "c12b" | "c16-repeat1"]) ||
            (row.reason === "CALIBRATION_FAILED" &&
              failedCalibrationAt !== undefined) ||
            (row.reason === "FIRST_RECEIPT_REJECTED" && !!decision.rejected) ||
            (row.reason === "CONFIRMED_SECRETARY_SYSTEM_FAILURE" &&
              !!final.confirmed_system_failure_sha256) ||
            (row.reason === "NO_ELIGIBLE_CANDIDATE" &&
              Object.keys(f.routes).length === 1),
          "CONTINUATION_UNTESTED_REASON",
        );
      }
      return {
        route,
        status: row.status,
        reason: safeReason(row.reason),
        accepted: !!mark,
        official_status: mark?.official.status ?? null,
        supplemental_status: mark?.supplemental.status ?? null,
        official_sha256: mark?.official_sha256 ?? null,
        supplemental_sha256: mark?.supplemental_sha256 ?? null,
        matched_controls:
          route === "calibration" ? (mark?.official.matched ?? null) : null,
        returned_model: mark?.returned_model ?? null,
        attempts: attempts.length,
        native_dispatches: attempts.reduce(
          (s: number, a: any) => s + a.physical_dispatches,
          0,
        ),
        unresolved_attempts: attempts.filter(
          (a: any) => a.state === "PENDING_RECONCILIATION",
        ).length,
      };
    },
  );
  const totals = final.reader_totals;
  requireThat(
    totals.attempts === all.length &&
      totals.physical_dispatches ===
        all.reduce((n, a) => n + a.physical_dispatches, 0),
    "CONTINUATION_COUNTS",
  );
  for (const k of ["actual_cash_usd", "actual_equivalent_usd"])
    requireThat(
      all.every(
        (a) =>
          a[k] === null ||
          (typeof a[k] === "number" && Number.isFinite(a[k]) && a[k] >= 0),
      ) &&
        Math.abs(totals[k] - all.reduce((n, a) => n + (a[k] ?? 0), 0)) < 1e-9 &&
        totals[k + "_unknown_attempts"] ===
          all.filter((a) => a[k] === null).length,
      "CONTINUATION_COST_TOTALS",
    );
  for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"])
    requireThat(
      totals.token_usage[k] ===
        all.reduce((n, a) => n + (a.usage?.[k] ?? 0), 0),
      "CONTINUATION_TOKENS",
    );
  return { grades, readers };
}

/** Input final SHA comes from the independent operator's verified archive readback. */
export function targetedResult(
  facility: string,
  seriesDir: string,
  finalSHA: string,
) {
  requireThat(/^[a-f0-9]{64}$/.test(finalSHA), "TARGETED_EXPORT_DIGEST");
  if (fs.existsSync(path.join(seriesDir, "publications")))
    seriesDir = path.join(seriesDir, "publications", finalSHA);
  const final = json(path.join(seriesDir, "series-final.json"), finalSHA);
  const f: TargetedReaderFreeze = json(
    path.join(seriesDir, "series.json"),
    final.series_sha256,
  );
  const retest = isRetest(f.series);
  const continuation = f.series === continuationWorkload.series;
  const routes = retest
    ? targetedRoutes.filter((r) => !r.startsWith("c06-"))
    : targetedRoutes;
  requireThat(
    final.schema ===
      (continuation
        ? "issue122-r77-reader-final-v1"
        : retest
          ? "issue122-r75-reader-final-v1"
          : "issue122-r67-reader-final-v1") &&
      final.all_terminal === true &&
      isDeepStrictEqual(Object.keys(final.routes).sort(), [...routes].sort()),
    "TARGETED_INCOMPLETE_FINAL",
  );
  validateTargetedFreeze(f);
  requireThat(
    f.workload_freeze_sha256 === final.workload_freeze_sha256 &&
      f.workload_dispatch_sha256 === final.workload_dispatch_sha256,
    "TARGETED_RESULT_WORKLOAD_BINDING",
  );
  const closure = checkWorkloadClosure(
    facility,
    f.workload_freeze_sha256,
    f.workload_dispatch_sha256,
  );
  requireThat(
    !closure.rehearsal && closure.series === f.series,
    "TARGETED_SERIES_BINDING",
  );
  const frozen = json(
    path.join(facility, "configs/stage-c-freeze.json"),
    f.workload_freeze_sha256,
  );
  requireThat(
    final.operator_release_sha256 ===
      frozen.targeted_supplement.reader_operator_release_sha256,
    "TARGETED_OPERATOR_RELEASE",
  );
  if (continuation) {
    const stop = final.confirmed_system_failure_sha256;
    if (stop) validateProductFailure(facility, closure, stop);
    const { readers, grades } = continuationReaderView(
      seriesDir,
      facility,
      final,
      f,
    );
    return {
      ...workloadSummary(
        facility,
        closure,
        (route) => {
          const result = grades.get(route);
          return result && "official" in result ? result : undefined;
        },
        f.archived,
      ),
      schema: "issue122-retest-result-v1",
      parent_supplement_sha256:
        "fa9333ee77eeb904b6ef778b774cd74ccd6dbebabc2cdf71ffa9bd029088798c",
      series_sha256: final.series_sha256,
      reader_final_sha256: finalSHA,
      workload_freeze_sha256: closure.freeze_sha256,
      dispatch_sha256: closure.dispatch_sha256,
      workload_provider: frozen.providers["deepseek-flash"].published_version,
      workload_requested_model: frozen.role_model.main,
      reader: frozen.grade.reader,
      reader_rubric_sha256: frozen.grade.rubric_sha256,
      reader_operator_release_sha256: final.operator_release_sha256,
      reader_billing: final.reader_totals,
      reader_usage: final.reader_totals.token_usage,
      readers,
      confirmed_system_failure_sha256: stop,
    };
  }
  const readers = routes.map((route) => {
    const row = final.routes[route];
    let assessment;
    if (row.dual_sha256) {
      const original = json(
        path.join(seriesDir, "exchange", route, "dual-readback.json"),
        row.dual_sha256,
      );
      requireThat(
        original.series_sha256 === final.series_sha256 &&
          original.route === route &&
          original.native_archive_sha256 === row.archive_sha256,
        "TARGETED_RESULT_READBACK",
      );
      if (row.official_sha256 || row.supplemental_sha256) {
        const replay = readerAction(
          "verify",
          seriesDir,
          final.series_sha256,
          route,
          facility,
        );
        requireThat(
          "official" in replay &&
            gradeJSONBytes(replay).equals(
              gradeJSONBytes(original.assessment),
            ) &&
            sha(gradeJSONBytes(replay.official)) === row.official_sha256 &&
            sha(gradeJSONBytes(replay.supplemental)) ===
              row.supplemental_sha256 &&
            replay.accepted === row.accepted,
          "TARGETED_RESULT_DUAL",
        );
        assessment = replay;
      } else
        requireThat(
          original.assessment.status === "NOT_TESTED" && !row.accepted,
          "TARGETED_RESULT_NO_NATIVE_GRADE",
        );
    } else
      requireThat(
        !row.accepted &&
          !row.native_launch &&
          row.possible_provider_sends === 0,
        "TARGETED_RESULT_UNSENT",
      );
    return { route, row, assessment };
  });
  const gradeFor = (route: TargetedRoute) =>
    readers.find((r) => r.route === route)?.assessment;
  const summary = workloadSummary(facility, closure, gradeFor, f.archived);
  const publicReaders = readers.map(({ route, row, assessment }) => ({
    route,
    status: row.status,
    reason: safeReason(row.reason),
    native_dispatches: row.native_dispatches,
    delivery: row.provider_delivery,
    confirmed_provider_sends: row.confirmed_provider_sends,
    possible_provider_sends: row.possible_provider_sends,
    official_status: row.official_status,
    supplemental_status: row.supplemental_status,
    official_sha256: row.official_sha256,
    supplemental_sha256: row.supplemental_sha256,
    native_archive_sha256: row.archive_sha256,
    dispatch_sha256: row.dispatch_sha256,
    transport_sha256: row.transport_sha256,
    accepted: row.accepted,
    returned_model: row.returned_model,
    reported_cash_usd: row.reported_cash_usd,
    list_cost_usd: row.list_cost_usd,
    matched_controls:
      route === "calibration" ? (assessment?.official.matched ?? null) : null,
  }));
  return {
    schema: retest
      ? "issue122-retest-result-v1"
      : "issue122-supplement-result-v1",
    ...(retest
      ? {
          parent_supplement_sha256:
            "fa9333ee77eeb904b6ef778b774cd74ccd6dbebabc2cdf71ffa9bd029088798c",
        }
      : {}),
    historical_baseline_sha256: summary.historical_baseline_sha256,
    original_observations: summary.original_observations,
    series_sha256: final.series_sha256,
    reader_final_sha256: finalSHA,
    workload_freeze_sha256: closure.freeze_sha256,
    dispatch_sha256: closure.dispatch_sha256,
    workload_provider: frozen.providers["deepseek-flash"].published_version,
    workload_requested_model: frozen.role_model.main,
    reader: frozen.grade.reader,
    reader_rubric_sha256: frozen.grade.rubric_sha256,
    reader_operator_release_sha256: final.operator_release_sha256,
    reader_account_snapshot_sha256: final.account_snapshot_sha256,
    workload_attempts: summary.workload_attempts,
    workload_accounted_usd_upper_or_measured:
      summary.workload_accounted_usd_upper_or_measured,
    workload_returned_models: summary.workload_returned_models,
    reader_billing: final.billing,
    reader_usage: final.usage,
    workloads: summary.workloads,
    archived_reader_rows: summary.archived_reader_rows,
    readers: publicReaders,
    c16: summary.c16,
    c12b_complete_live_witness: summary.c12b_complete_live_witness,
  };
}
function workloadSummary(
  facility: string,
  closure: ReturnType<typeof checkWorkloadClosure>,
  gradeFor: (route: TargetedRoute) => Parameters<typeof agreedAssertions>[0],
  sources?: TargetedReaderFreeze["archived"],
) {
  const old = json(
    path.join(repository, "evidence/issue122-completion.json"),
    baselineSHA,
  );
  const workloads = (["c16-repeat1", "c12b"] as const).map((route) =>
    targetedWorkloadResult(facility, closure, route, gradeFor(route)),
  );
  const historical = old.recovery_series
    .filter((r: any) => r.case === "C16-combined")
    .sort((a: any, b: any) => a.repeat - b.repeat);
  requireThat(
    historical.length === 3 &&
      historical[0].c16.gate === "OPEN" &&
      historical
        .slice(1)
        .every((r: any) => r.c16.gate === "CLOSED" && r.c16.verdict === "FAIL"),
    "TARGETED_ORIGINAL_C16",
  );
  const effective = [
    {
      repeat: 1,
      route: "opencode-go",
      gate: workloads[0].gate,
      verdict: workloads[0].verdict,
    },
    ...historical.slice(1).map((r: any) => ({
      repeat: r.repeat,
      route: r.workload_route,
      gate: r.c16.gate,
      verdict: r.c16.verdict,
    })),
  ];
  const archived = isRetest(closure.series)
    ? []
    : (["c06-98", "c06-99"] as const).map((route, i) => {
        const original = old.comparison_rows_effective.find(
          (r: any) => r.case === "C06-resident-B" && r.repeat === i + 2,
        );
        const archive = old.archives.find(
          (a: any) => a.freeze_sha256 === original?.freeze_sha256,
        );
        requireThat(
          original &&
            original.effective_assessment !== "ACCEPTED" &&
            archive &&
            (!sources ||
              original.freeze_sha256 === sources[route].source_freeze_sha256),
          "TARGETED_SOURCE_C06",
        );
        return {
          case: "C06-resident-B",
          repeat: i + 2,
          reader_accepted: !!gradeFor(route)?.accepted,
          route,
          source_archive_sha256:
            sources?.[route].source_archive_sha256 ?? archive.archive_sha256,
          source_freeze_sha256: original.freeze_sha256,
          workload_route: original.workload_route,
          assertions: agreedAssertions(gradeFor(route)) ?? {
            natural_access: "NOT_TESTED",
          },
        };
      });
  const transactions = [...ledger(facility).entries.values()];
  requireThat(
    transactions.every((e) => workloads.some((w) => w.lane === e.attempt.lane)),
    "TARGETED_EXPORT_FOREIGN_ATTEMPT",
  );
  return {
    ...(closure.series === continuationWorkload.series
      ? { workload_usage: continuationUsage(facility) }
      : {}),
    historical_baseline_sha256: baselineSHA,
    original_observations: old.comparison_rows_effective.length,
    workload_attempts: transactions.length,
    workload_accounted_usd_upper_or_measured: transactions.reduce(
      (n, e) => n + targetedAccountedAmount(e),
      0,
    ),
    workload_returned_models: [
      ...new Set(
        transactions.flatMap((e) =>
          e.returned_model ? [e.returned_model] : [],
        ),
      ),
    ],
    workloads,
    archived_reader_rows: archived,
    c16: {
      historical_adjudicable: 2,
      historical_denominator: 3,
      positions: effective,
      adjudicable: effective.filter((r) => r.gate === "CLOSED").length,
    },
    c12b_complete_live_witness:
      !closure.rehearsal &&
      workloads[1].gate === "CLOSED" &&
      (workloads[1].verdict === "PASS" ||
        (isRetest(closure.series) && workloads[1].verdict === "FAIL")),
  };
}
function validateProductFailure(
  facility: string,
  closure: ReturnType<typeof checkWorkloadClosure>,
  digest: string,
) {
  const record = json(
    path.join(facility, "campaign/secretary-system-failure.json"),
    digest,
  );
  const t = closure.state.terminals[record.lane];
  requireThat(
    record.schema === "issue122-secretary-system-failure-v1" &&
      record.freeze_sha256 === closure.freeze_sha256 &&
      typeof record.reason === "string" &&
      record.reason.length > 0 &&
      t?.run === record.run &&
      /^[0-9a-f-]{36}$/.test(record.run) &&
      /^[a-zA-Z0-9_.-]+$/.test(record.evidence_file) &&
      ![".", ".."].includes(record.evidence_file),
    "CONTINUATION_PRODUCT_STOP",
  );
  const source = path.join(facility, "evidence", record.run);
  requireThat(
    sha(read(path.join(source, "stage-c-trial.json"))) === t.report_sha256 &&
      sha(read(path.join(source, record.evidence_file))) ===
        record.evidence_sha256,
    "CONTINUATION_PRODUCT_EVIDENCE",
  );
}
/** The independent proof digest must come from verified archive readback. */
export function retestBeforeReader(
  facility: string,
  file: string,
  digest: string,
) {
  const proof = json(file, digest);
  const { workload_freeze_sha256: freeze, workload_dispatch_sha256: dispatch } =
    proof;
  const closure = checkWorkloadClosure(facility, freeze, dispatch);
  const frozen = json(
    path.join(facility, "configs/stage-c-freeze.json"),
    freeze,
  );
  const scope = frozen.targeted_supplement;
  const ledgerFile = path.join(facility, "campaign/attempts.jsonl");
  const hash = (s: unknown) =>
    typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (scope.series === continuationWorkload.series) {
    requireThat(
      closure.series === proof.series &&
        proof.schema === "issue122-r77-reader-activation-blocked-v1" &&
        proof.status === "STOPPED_BEFORE_READER_ACTIVATION" &&
        proof.workload_attempts_sha256 ===
          (fs.existsSync(ledgerFile) ? sha(read(ledgerFile)) : null) &&
        isDeepStrictEqual(proof.workload_terminals, closure.state.terminals) &&
        hash(proof.workload_closed_claim_sha256) &&
        hash(proof.private_evidence_sha256) &&
        proof.provider_calls_by_evidence_verifier === 0 &&
        proof.proof_verifier_sha256 === scope.proof_verifier_sha256 &&
        proof.operator_release_sha256 ===
          scope.reader_operator_release_sha256 &&
        proof.operator_package_sha256 === scope.reader_package_sha256 &&
        proof.native_adapter_sha256 === scope.reader_native_sha256,
      "CONTINUATION_PREACTIVATION",
    );
    if (closure.rehearsal)
      requireThat(
        isGoRehearsal(facility) &&
          proof.evidence_class === "OFFLINE_SSE" &&
          proof.fixture_before_sha256 === proof.before_observation_sha256 &&
          sha(
            read(path.join(facility, "fixture-account/reader-baseline.json")),
          ) === proof.fixture_before_sha256 &&
          scope.before_observation_sha256 ===
            proof.template_before_observation_sha256 &&
          sha(read(path.join(facility, "inputs/reader-before.json"))) ===
            proof.template_before_observation_sha256,
        "CONTINUATION_OFFLINE_BEFORE",
      );
    else
      requireThat(
        proof.evidence_class === undefined &&
          proof.before_observation_sha256 === scope.before_observation_sha256,
        "CONTINUATION_LIVE_BEFORE",
      );
    if (proof.stop === "CONFIRMED_SECRETARY_SYSTEM_FAILURE")
      validateProductFailure(
        facility,
        closure,
        proof.confirmed_system_failure_sha256,
      );
    else
      requireThat(
        proof.stop === "NO_ELIGIBLE_CANDIDATE" &&
          proof.confirmed_system_failure_sha256 === null,
        "CONTINUATION_STOP_REASON",
      );
    requireThat(
      isDeepStrictEqual(proof.reader_totals, {
        attempts: 0,
        physical_dispatches: 0,
        actual_cash_usd: 0,
        actual_equivalent_usd: 0,
      }) &&
        Object.keys(proof.routes).sort().join(",") ===
          "c12b,c16-repeat1,calibration",
      "CONTINUATION_ZERO_TOTALS",
    );
    const readers = (["calibration", "c16-repeat1", "c12b"] as const).map(
      (route) => {
        requireThat(
          isDeepStrictEqual(proof.routes[route], {
            status: "NOT_TESTED",
            reason: proof.stop,
            physical_dispatches: 0,
          }),
          "CONTINUATION_ZERO_ROUTE",
        );
        return {
          route,
          status: "NOT_TESTED",
          reason: proof.stop,
          native_dispatches: 0,
          possible_provider_sends: 0,
          confirmed_provider_sends: 0,
          accepted: false,
        };
      },
    );
    return {
      ...workloadSummary(facility, closure, () => undefined),
      schema: closure.rehearsal
        ? "issue122-retest-rehearsal-v1"
        : "issue122-retest-result-v1",
      ...(closure.rehearsal
        ? { evidence_class: "OFFLINE_SSE", physical_provider_sends: 0 }
        : {}),
      parent_supplement_sha256:
        "fa9333ee77eeb904b6ef778b774cd74ccd6dbebabc2cdf71ffa9bd029088798c",
      workload_freeze_sha256: freeze,
      dispatch_sha256: dispatch,
      workload_provider: frozen.providers["deepseek-flash"].published_version,
      workload_requested_model: frozen.role_model.main,
      reader: frozen.grade.reader,
      reader_rubric_sha256: frozen.grade.rubric_sha256,
      reader_operator_release_sha256: proof.operator_release_sha256,
      reader_activation_blocked_sha256: digest,
      reader_activation: proof.status,
      reader_stop: proof.stop,
      reader_billing: proof.reader_totals,
      readers,
    };
  }
  requireThat(
    isRetest(closure.series) &&
      proof.series === closure.series &&
      proof.schema === "issue122-r75-reader-activation-blocked-v1" &&
      proof.status === "STOPPED_BEFORE_READER_ACTIVATION" &&
      proof.series_final_sha256 === null &&
      proof.workload_attempts_sha256 ===
        (fs.existsSync(ledgerFile) ? sha(read(ledgerFile)) : null) &&
      hash(proof.workload_closed_claim_sha256) &&
      isDeepStrictEqual(proof.workload_terminals, closure.state.terminals) &&
      hash(proof.proof_verifier_sha256) &&
      scope.proof_verifier_sha256 === proof.proof_verifier_sha256 &&
      hash(proof.before_observation_sha256) &&
      (closure.rehearsal
        ? isGoRehearsal(facility) &&
          proof.evidence_class === "OFFLINE_SSE" &&
          proof.fixture_before_sha256 === proof.before_observation_sha256 &&
          sha(
            read(path.join(facility, "fixture-account/reader-baseline.json")),
          ) === proof.fixture_before_sha256 &&
          scope.before_observation_sha256 ===
            proof.template_before_observation_sha256 &&
          sha(read(path.join(facility, "inputs/reader-before.json"))) ===
            proof.template_before_observation_sha256
        : proof.evidence_class === undefined &&
          scope.before_observation_sha256 ===
            proof.before_observation_sha256) &&
      scope.reader_operator_release_sha256 === proof.operator_release_sha256 &&
      scope.reader_package_sha256 === proof.operator_package_sha256 &&
      scope.reader_native_sha256 === proof.native_adapter_sha256 &&
      (proof.stop === "WORKLOAD_HOLD"
        ? hash(proof.workload_scoped_hold_sha256) &&
          typeof proof.hold_reason === "string"
        : proof.stop === "NO_ELIGIBLE_CANDIDATE" &&
          proof.workload_scoped_hold_sha256 === null &&
          proof.hold_reason === null),
    "RETEST_PREACTIVATION_BINDING",
  );
  const routes = ["calibration", "c16-repeat1", "c12b"] as const;
  requireThat(
    isDeepStrictEqual(Object.keys(proof.routes).sort(), [...routes].sort()),
    "RETEST_PREACTIVATION_ROUTES",
  );
  const readers = routes.map((route) => {
    const r = proof.routes[route];
    requireThat(
      r.status === "NOT_TESTED" &&
        r.reason === proof.stop &&
        r.allow_resend === false &&
        [
          "reservations",
          "launches",
          "native_dispatches",
          "possible_provider_sends",
          "confirmed_provider_sends",
        ].every((k) => r[k] === 0) &&
        [
          "official_sha256",
          "supplemental_sha256",
          "receipt_sha256",
          "transport_sha256",
        ].every((k) => r[k] === null),
      "RETEST_PREACTIVATION_ROUTE",
    );
    return {
      route,
      status: r.status,
      reason: r.reason,
      native_dispatches: 0,
      possible_provider_sends: 0,
      confirmed_provider_sends: 0,
      accepted: false,
    };
  });
  requireThat(
    [
      "reservations",
      "launches",
      "possible_provider_sends",
      "confirmed_provider_sends",
      "allowance_equivalent_usd",
      "cash_charge_usd",
      "new_unresolved_reader_reservation_usd",
    ].every((k) => proof.reader_totals[k] === 0),
    "RETEST_PREACTIVATION_TOTALS",
  );
  return {
    ...workloadSummary(facility, closure, () => undefined),
    schema: closure.rehearsal
      ? "issue122-retest-rehearsal-v1"
      : "issue122-retest-result-v1",
    ...(closure.rehearsal
      ? { evidence_class: "OFFLINE_SSE", physical_provider_sends: 0 }
      : {}),
    parent_supplement_sha256:
      "fa9333ee77eeb904b6ef778b774cd74ccd6dbebabc2cdf71ffa9bd029088798c",
    workload_freeze_sha256: freeze,
    dispatch_sha256: dispatch,
    workload_provider: frozen.providers["deepseek-flash"].published_version,
    workload_requested_model: frozen.role_model.main,
    reader: frozen.grade.reader,
    reader_rubric_sha256: frozen.grade.rubric_sha256,
    reader_operator_release_sha256: proof.operator_release_sha256,
    reader_activation_blocked_sha256: digest,
    reader_activation: proof.status,
    reader_stop: proof.stop,
    reader_billing: proof.reader_totals,
    readers,
  };
}
/** Reconstruct the published pre-activation stop. Only the independently
 * archived disposition and its original workload ledger are admissible here. */
export function blockedTargetedResult(facility: string, receiptPath: string) {
  const receiptSHA =
    "e22ef97d521c10ca2289ccdc5b66e39de61e9cdaf3bd3afbe607e303c7e4770e";
  const attemptsSHA =
    "a3cd90a301f2e9548514b9a0e1d46d1e6db7e5654dc2386393c679552b17f94e";
  const reader = json(receiptPath, receiptSHA);
  const closure = checkWorkloadClosure(
    facility,
    reader.workload_freeze_sha256,
    reader.workload_dispatch_sha256,
  );
  const frozen = json(
    path.join(facility, "configs/stage-c-freeze.json"),
    closure.freeze_sha256,
  );
  requireThat(
    reader.schema === "issue122-r67-reader-activation-blocked-v1" &&
      reader.status === "STOPPED_BEFORE_READER_ACTIVATION" &&
      reader.series_final_sha256 === null &&
      reader.operator_release_sha256 ===
        frozen.targeted_supplement.reader_operator_release_sha256 &&
      reader.reader_totals.possible_provider_sends === 0 &&
      sha(read(path.join(facility, "campaign/attempts.jsonl"))) === attemptsSHA,
    "TARGETED_PREACTIVATION_EVIDENCE",
  );
  const summary = workloadSummary(facility, closure, () => undefined);
  const entries = [...ledger(facility).entries.values()];
  const confirmed = entries.filter((e) => e.outcome === "RESPONSE_COMPLETE");
  const uncertain = entries.filter((e) => e.outcome !== "RESPONSE_COMPLETE");
  const meter = (e: (typeof entries)[number]) =>
    (
      e.usage as {
        go_meter: {
          list_cost: number;
          cash_debit_usd: number;
          billing_source: string;
        };
      }
    ).go_meter;
  requireThat(
    confirmed.every(
      (e) =>
        e.settled &&
        e.actual_usd != null &&
        meter(e).billing_source === "go" &&
        meter(e).cash_debit_usd === 0,
    ) &&
      uncertain.length === 1 &&
      uncertain[0].outcome === "NETWORK_UNCERTAIN" &&
      uncertain[0].actual_usd === null,
    "TARGETED_PREACTIVATION_SETTLEMENT",
  );
  const last = uncertain[0];
  const observedSHA =
    "cfdd1a05e30dbc3d82182c924ed06a89d508c5b2ed5ce6d8b1e46b32d82a1819";
  const observed = json(
    path.join(facility, "evidence", last.attempt.run, "observed.json"),
    observedSHA,
  );
  const session = observed.sessions.find(
    (s: { id: string }) => s.id === observed.session_id,
  );
  requireThat(
    last === entries.at(-1) &&
      last.attempt.lane === summary.workloads[0].lane &&
      session?.state === "RECOVERY_BLOCKED" &&
      last.settled_at &&
      session.updated_at > last.settled_at,
    "TARGETED_PREACTIVATION_SESSION",
  );
  const interruption = {
    observed_sha256: observedSHA,
    session_state: session.state,
    session_revision: session.revision,
    session_updated_at: session.updated_at,
    request_ordinal: entries.length,
    request_reserved_at: last.attempt.at,
    request_settled_at: last.settled_at,
    transport_cause: "UNKNOWN",
  };
  const readers = targetedRoutes.map((route) => {
    const r = reader.routes[route];
    requireThat(
      r.status === "NOT_TESTED" &&
        r.reservations === 0 &&
        r.launches === 0 &&
        r.possible_provider_sends === 0 &&
        r.official_sha256 === null &&
        r.supplemental_sha256 === null,
      "TARGETED_PREACTIVATION_ROUTE",
    );
    return {
      route,
      status: r.status,
      reason: r.reason,
      native_dispatches: r.native_dispatches,
      confirmed_provider_sends: r.confirmed_provider_sends,
      possible_provider_sends: r.possible_provider_sends,
      official_sha256: r.official_sha256,
      supplemental_sha256: r.supplemental_sha256,
      accepted: false,
    };
  });
  return {
    schema: "issue122-supplement-result-v1",
    ...summary,
    workloads: [
      { ...summary.workloads[0], interruption },
      summary.workloads[1],
    ],
    workload_freeze_sha256: closure.freeze_sha256,
    dispatch_sha256: closure.dispatch_sha256,
    workload_attempts_sha256: attemptsSHA,
    workload_provider: frozen.providers["deepseek-flash"].published_version,
    workload_requested_model: frozen.role_model.main,
    reader: frozen.grade.reader,
    reader_rubric_sha256: frozen.grade.rubric_sha256,
    reader_operator_release_sha256: reader.operator_release_sha256,
    series_sha256: null,
    reader_final_sha256: null,
    reader_activation_blocked_sha256: receiptSHA,
    reader_activation: reader.status,
    reader_prepare_failure: reader.first_entry.error,
    workload_scoped_hold_reason: reader.hold_reason,
    workload_scoped_hold_sha256: reader.workload_scoped_hold_sha256,
    workload_billing: {
      confirmed_responses: confirmed.length,
      confirmed_list_usd: Number(
        confirmed.reduce((n, e) => n + meter(e).list_cost, 0).toFixed(12),
      ),
      confirmed_cash_usd: 0,
      uncertain_requests: uncertain.length,
      uncertain_reserved_usd: uncertain[0].attempt.reserved_usd,
      uncertain_actual_usd: null,
    },
    reader_billing: reader.reader_totals,
    readers,
  };
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const args = process.argv.slice(2);
  if (args[0] === "--retest-before-reader") {
    requireThat(args.length === 4, "RETEST_PREACTIVATION_ARGUMENTS");
    process.stdout.write(
      JSON.stringify(retestBeforeReader(args[1], args[2], args[3]), null, 2) +
        "\n",
    );
    process.exit(0);
  }
  if (args[0] === "--sealed-lane") {
    const [, root, freeze, route] = args;
    requireThat(
      args.length === 4 && (route === "c12b" || route === "c16-repeat1"),
      "RETEST_LANE_ARGUMENTS",
    );
    const closure = checkWorkloadClosure(root, freeze, undefined, route);
    const report = targetedWorkloadResult(root, closure, route);
    requireThat(report.lane === workloadLanes[route], "RETEST_LANE_ARGUMENTS");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exit(0);
  }
  const [facility, series, digest] = args;
  requireThat(process.argv.length === 5, "TARGETED_RESULT_ARGUMENTS");
  process.stdout.write(
    JSON.stringify(
      facility === "--activation-blocked"
        ? blockedTargetedResult(path.resolve(series), path.resolve(digest))
        : targetedResult(facility, series, digest),
      null,
      2,
    ) + "\n",
  );
}
