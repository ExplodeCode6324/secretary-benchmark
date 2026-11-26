import {
  delivery,
  deliveryRequest,
  nativeWriteRecipe,
} from "./stage-c-fault.ts";
import { retestWorkload } from "./stage-c-targeted-policy.ts";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ledger } from "./campaign.ts";
import { read, sha, requireThat } from "./io.ts";
import { caseDefinition } from "./stage-c-plan.ts";
import { c16Disposition } from "./stage-c-observations.ts";
import {
  checkWorkloadClosure,
  targetWorkloadSource,
  workloadLanes,
  type WorkloadRoute,
} from "./targeted-reader-workload.ts";
import type { verifyTargetedReceipt } from "./targeted-reader-grade.ts";

type Grade = ReturnType<typeof verifyTargetedReceipt>;
const decisive = (v: unknown) => v === "PASS" || v === "FAIL";
const semantic = (v: unknown) =>
  v === "PASS" || v === "FAIL" ? v : "UNRESOLVED";
export function agreedAssertions(grade: Grade | undefined) {
  if (
    !grade?.accepted ||
    grade.official.status !== "ACCEPTED" ||
    grade.supplemental.status !== "ACCEPTED"
  )
    return null;
  const rows = grade.official.assertions;
  requireThat(
    Array.isArray(rows) &&
      isDeepStrictEqual(rows, grade.supplemental.assertions) &&
      grade.official.visibility === grade.supplemental.visibility,
    "TARGETED_RECEIPTS_DISAGREE",
  );
  return Object.fromEntries(
    rows.map((a: { assertion: string; verdict: string }) => [
      a.assertion,
      a.verdict,
    ]),
  ) as Record<string, string>;
}

/** Derive a public workload row from sealed terminal, ledger and verified blind assessment.
 * A missing reader or even a missing run still occupies its preassigned repeat. */
export function targetedWorkloadResult(
  facility: string,
  closure: ReturnType<typeof checkWorkloadClosure>,
  route: WorkloadRoute,
  grade?: Grade,
) {
  const lane = workloadLanes[route],
    scenario = route === "c16-repeat1" ? "C16-combined" : "C12b";
  const terminal = closure.state.terminals[lane];
  requireThat(!grade || grade.route === route, "TARGETED_RESULT_ROUTE");
  const semanticGrades = agreedAssertions(grade);
  const assertions: Record<string, string> = Object.fromEntries(
    caseDefinition(scenario).assertions.map((a) => [a, "NOT_TESTED"]),
  );
  const attempts = [...ledger(facility).entries.values()].filter(
    (e) => e.attempt.lane === lane,
  );
  let gate = "OPEN",
    verdict = "UNRESOLVED",
    gaps: string[] = [],
    mechanical: any = null,
    pendingProposals: number | null = null;
  const base = {
    ...(closure.rehearsal
      ? { evidence_class: "OFFLINE_SSE", physical_provider_sends: 0 }
      : {}),
    case: scenario,
    repeat: 1,
    reader_accepted: !!semanticGrades,
    lane,
    workload_route: "opencode-go",
    status: terminal.status,
    freeze_sha256: closure.freeze_sha256,
    dispatch_sha256: closure.dispatch_sha256,
    trial_sha256: terminal.report_sha256 ?? null,
    workload_attempts: attempts.length,
    ...(closure.series === retestWorkload.series
      ? {
          workload_confirmed_unsent_reservations: attempts.filter(
            (e) => e.outcome === "RETEST_CONFIRMED_NO_POST",
          ).length,
        }
      : {}),
    terminal_reason:
      typeof terminal.reason === "string" &&
      /^[A-Z_0-9]{2,100}$/.test(terminal.reason)
        ? terminal.reason
        : terminal.reason
          ? "DETAILS_IN_PRIVATE_ARCHIVE"
          : null,
  };
  if (!terminal.run || !terminal.report_sha256) {
    requireThat(!semanticGrades, "TARGETED_UNBOUND_GRADE");
    return {
      ...base,
      assertions,
      gate,
      verdict,
      gaps: ["NO_SEALED_TRIAL"],
      mechanical,
      pending_proposals: pendingProposals,
    };
  }
  requireThat(/^[0-9a-f-]{36}$/.test(terminal.run), "TARGETED_RESULT_RUN");
  const dir = path.join(facility, "evidence", terminal.run),
    file = path.join(dir, "stage-c-trial.json");
  const raw = read(file),
    trial = JSON.parse(raw.toString());
  requireThat(
    sha(raw) === terminal.report_sha256 &&
      trial.run === terminal.run &&
      trial.descriptor.scenario === scenario &&
      trial.evidence_class === (closure.rehearsal ? "OFFLINE_SSE" : "LIVE") &&
      trial.physical_provider_sends ===
        (closure.rehearsal
          ? 0
          : attempts.filter((e) => e.outcome !== "RETEST_CONFIRMED_NO_POST")
              .length) &&
      attempts.every((e) => e.attempt.run === terminal.run),
    "TARGETED_SEALED_TRIAL",
  );
  const obs = trial.observations.find(
    (o: any) => o.physical && o.run === terminal.run,
  );
  const hasResponse = attempts.some(
    (e) =>
      e.settled &&
      e.outcome === "RESPONSE_COMPLETE" &&
      (e.usage as { response_complete?: boolean; route?: string } | null)
        ?.response_complete === true &&
      (e.usage as { route?: string } | null)?.route === "opencode-go",
  );
  const retest = closure.series === retestWorkload.series;
  let boundTaskResponse = false;
  if (retest && route === "c12b" && trial.recovery_members) {
    const member = (name: string) => {
      const digest = trial.recovery_members[name];
      if (!digest) return null;
      const bytes = read(path.join(dir, name));
      requireThat(sha(bytes) === digest, "RETEST_RECOVERY_MEMBER");
      return bytes.toString();
    };
    const barrier = JSON.parse(member("stage-c-barrier.json") ?? "null");
    const failure = JSON.parse(member("stage-c-target-failure.json") ?? "null");
    if (!barrier && failure?.reason === "C12B_PREFAULT_CONTENT_MISMATCH") {
      const writes = (member("stage-c-physical-writes.jsonl") ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((v) => JSON.parse(v));
      const dispatched = (member("stage-c-write-attempts.jsonl") ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((v) => JSON.parse(v));
      const w = writes[0];
      requireThat(
        failure.run === terminal.run &&
          failure.request ===
            deliveryRequest(terminal.run, nativeWriteRecipe) &&
          writes.length === 1 &&
          w.run === terminal.run &&
          w.request === failure.request &&
          w.lineage === trial.recovery_lineage &&
          w.operation === failure.operation &&
          path.basename(w.resource) === delivery.name &&
          w.expected_hash === sha(delivery.bytes) &&
          /^[0-9a-f]{64}$/.test(w.observed_hash) &&
          w.observed_hash !== w.expected_hash &&
          dispatched.some((a) =>
            [
              "run",
              "lineage",
              "domain",
              "request",
              "execution",
              "operation",
              "resource",
              "parameter_hash",
              "pid",
            ].every((k) => a[k] === w[k]),
          ),
        "RETEST_PREFAULT_CONTENT_BINDING",
      );
      mechanical = {
        effects: "FAIL",
        observed_writes: 1,
        final_content_matches: false,
      };
      assertions.effects = "FAIL";
    }
    if (barrier) {
      requireThat(
        barrier.run === terminal.run &&
          typeof trial.recovery_lineage === "string" &&
          barrier.lineage === trial.recovery_lineage &&
          barrier.request ===
            deliveryRequest(terminal.run, nativeWriteRecipe) &&
          barrier.expected_hash === sha(delivery.bytes) &&
          path.basename(barrier.resource) === delivery.name,
        "RETEST_BARRIER_BINDING",
      );
      const writes = (member("stage-c-physical-writes.jsonl") ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const matches = writes.filter(
        (w) =>
          [
            "run",
            "domain",
            "lineage",
            "request",
            "execution",
            "resource",
            "expected_hash",
          ].every((k) => w[k] === barrier[k]) &&
          w.observed_hash === barrier.expected_hash,
      );
      if (matches.length >= 2 && isDeepStrictEqual(matches[0], barrier)) {
        mechanical = { effects: "FAIL", observed_writes: matches.length };
        assertions.effects = "FAIL";
      }
      boundTaskResponse = attempts.some((e) => {
        if (
          !e.settled ||
          e.outcome !== "RESPONSE_COMPLETE" ||
          !(e.usage as any)?.response_complete ||
          (e.usage as any)?.route !== "opencode-go"
        )
          return false;
        const send = JSON.parse(
          read(path.join(dir, "send-" + e.attempt.id + ".json")).toString(),
        );
        return (
          send.id === e.attempt.id &&
          send.attribution?.role === "task" &&
          barrier.task_contexts?.includes(send.attribution.context_sha256)
        );
      });
    }
  }
  if (!obs || !hasResponse) {
    requireThat(!semanticGrades, "TARGETED_UNBOUND_GRADE");
    return {
      ...base,
      assertions,
      gate,
      verdict,
      gaps: [
        obs ? "NO_COMPLETED_PROVIDER_RESPONSE" : "NO_PHYSICAL_OBSERVATION",
      ],
      mechanical,
      pending_proposals: pendingProposals,
    };
  }
  for (const assertion of Object.keys(assertions)) {
    const witness = obs.witness.assertions[assertion];
    if (retest && assertion === "effects" && mechanical?.effects === "FAIL")
      continue;
    assertions[assertion] = decisive(witness)
      ? witness
      : (semanticGrades?.[assertion] ?? witness ?? "NOT_TESTED");
    if (
      obs.witness.structural_gaps.length &&
      !decisive(witness) &&
      assertions[assertion] !== "NOT_TESTED"
    )
      assertions[assertion] = "UNRESOLVED";
  }
  if (route === "c16-repeat1") {
    const src =
      obs.targeted_capture?.status === "CAPTURED"
        ? targetWorkloadSource(facility, closure, route)
        : null;
    if (src?.capture)
      pendingProposals = src.capture.proposals.filter(
        (p: any) => p.state === "WAIT_AUTH" && p.effect === "NOT_STARTED",
      ).length;
    if (obs.physical.maintenance?.item_lineage === "NOT_TESTED")
      assertions.item_lineage = "NOT_TESTED";
    const ref = trial.observations.find(
      (o: any) => o.mechanism === "HOST_PRODUCT_READ_LOG",
    );
    const visibility = grade?.official.visibility;
    const closed = c16Disposition(
      obs.physical,
      ref,
      semanticGrades && ["COLD", "RESIDENT", "OPAQUE"].includes(visibility)
        ? {
            visibility,
            maintenance: semantic(semanticGrades.maintenance_current),
            use: semantic(semanticGrades.use_current),
            audited_surfaces:
              !!src && !grade?.maintenance_evidence_inconclusive,
          }
        : undefined,
      obs.witness.probe_chain,
      attempts.some(
        (e) =>
          e.attempt.id === obs.physical.outcome.probe_send &&
          e.outcome === "RESPONSE_COMPLETE",
      ),
    );
    gate = closed.gate;
    verdict = closed.verdict;
    gaps = [...closed.gaps];
    if (!src || !semanticGrades || grade?.maintenance_evidence_inconclusive)
      assertions.maintenance_current = "UNRESOLVED";
    assertions.use_current = closed.use;
    mechanical = {
      retention: closed.retention,
      use: closed.use,
      visibility: closed.branch,
    };
  } else {
    const observation = trial.observations.find(
      (o: any) => o.host_assisted === true,
    );
    if (
      (!retest || (boundTaskResponse && observation?.unknown_journal)) &&
      observation?.old_exit &&
      observation?.new_start &&
      observation?.verify_receipt_sha256
    ) {
      const source = targetWorkloadSource(facility, closure, route);
      requireThat(
        "mechanical_effects" in source.proof,
        "TARGETED_RESULT_RECOVERY_BINDING",
      );
      mechanical = {
        ...source.observation,
        effects: source.proof.mechanical_effects,
      };
      if (
        retest &&
        mechanical.reconciled &&
        typeof observation.content_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(observation.content_sha256) &&
        !mechanical.final_content_matches
      )
        mechanical.effects = "FAIL";
      assertions.effects = mechanical.effects;
      if (mechanical.effects === "FAIL") {
        verdict = "FAIL";
        gate = "CLOSED";
      } else if (
        terminal.status === "COMPLETED" &&
        mechanical.effects === "PASS" &&
        mechanical.reconciled &&
        mechanical.observed_writes === 1 &&
        mechanical.final_content_matches
      ) {
        verdict = "PASS";
        gate = "CLOSED";
      } else gaps.push("RECOVERY_EVIDENCE_INCOMPLETE");
    } else {
      assertions.effects = mechanical?.effects ?? "NOT_TESTED";
      gaps.push("MISSING_BOUND_RECOVERY");
    }
  }
  if (terminal.status !== "COMPLETED" && gate === "CLOSED") {
    gate = "OPEN";
    verdict = "UNRESOLVED";
    gaps.push("WORKLOAD_INCOMPLETE");
  }
  return {
    ...base,
    assertions,
    gate,
    verdict,
    gaps,
    mechanical,
    pending_proposals: pendingProposals,
  };
}
