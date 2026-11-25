import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { read, repository, sha, requireThat } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import { readerAction } from "./targeted-reader-cli.ts";
import {
  validateTargetedFreeze,
  targetedRoutes,
  type TargetedReaderFreeze,
  type TargetedRoute,
} from "./targeted-reader-grade.ts";
import { checkWorkloadClosure } from "./targeted-reader-workload.ts";
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

/** Input final SHA comes from the independent operator's verified archive readback. */
export function targetedResult(
  facility: string,
  seriesDir: string,
  finalSHA: string,
) {
  const final = json(path.join(seriesDir, "series-final.json"), finalSHA);
  requireThat(
    final.schema === "issue122-r67-reader-final-v1" &&
      final.all_terminal === true &&
      isDeepStrictEqual(
        Object.keys(final.routes).sort(),
        [...targetedRoutes].sort(),
      ),
    "TARGETED_INCOMPLETE_FINAL",
  );
  const f: TargetedReaderFreeze = json(
    path.join(seriesDir, "series.json"),
    final.series_sha256,
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
  const frozen = json(
    path.join(facility, "configs/stage-c-freeze.json"),
    f.workload_freeze_sha256,
  );
  requireThat(
    final.operator_release_sha256 ===
      frozen.targeted_supplement.reader_operator_release_sha256,
    "TARGETED_OPERATOR_RELEASE",
  );
  const readers = targetedRoutes.map((route) => {
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
    schema: "issue122-supplement-result-v1",
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
  const archived = (["c06-98", "c06-99"] as const).map((route, i) => {
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
      workloads[1].gate === "CLOSED" && workloads[1].verdict === "PASS",
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
  const [facility, series, digest] = process.argv.slice(2);
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
