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
  const old = json(
    path.join(repository, "evidence/issue122-completion.json"),
    baselineSHA,
  );
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
    requireThat(
      original?.effective_assessment !== "ACCEPTED" &&
        original?.freeze_sha256 === f.archived[route].source_freeze_sha256,
      "TARGETED_SOURCE_C06",
    );
    return {
      case: "C06-resident-B",
      repeat: i + 2,
      reader_accepted: !!gradeFor(route)?.accepted,
      route,
      source_archive_sha256: f.archived[route].source_archive_sha256,
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
    historical_baseline_sha256: baselineSHA,
    original_observations: old.comparison_rows_effective.length,
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
    reader_billing: final.billing,
    reader_usage: final.usage,
    workloads,
    archived_reader_rows: archived,
    readers: publicReaders,
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
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const [facility, series, digest] = process.argv.slice(2);
  requireThat(process.argv.length === 5, "TARGETED_RESULT_ARGUMENTS");
  process.stdout.write(
    JSON.stringify(targetedResult(facility, series, digest), null, 2) + "\n",
  );
}
