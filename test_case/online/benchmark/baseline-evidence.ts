import { requireThat, sha } from "./io.ts";
import { identityHash } from "./process-witness.ts";

export const baselineVersion = "secretary-issue122-semantic-v1";
export type Verdict = "PASS" | "FAIL" | "UNRESOLVED" | "NOT_TESTED";
export const routes = {
  master: {
    status: "SUPPORTED",
    source: "api/routes.ts:messages",
    authority: "Master, exact scope only",
  },
  quote: {
    status: "SUPPORTED",
    source: "api/routes.ts:messages",
    authority: "quoted source, never Master permission",
  },
  task: {
    status: "SUPPORTED",
    source: "executor-tools.ts:submit_result / feedback.ts",
    authority: "Task result, never Master permission",
  },
  imported_note: {
    status: "SUPPORTED",
    source: "scopes.ts:virtual Shared / executor-tools.ts:read",
    authority:
      "scripted file hash + read receipt, distinct from Task interpretation",
  },
  scope_import: {
    status: "HARNESS_EXCLUDED",
    source: "snapshot.ts:restorePreflight / domain.ts:start,checkpoint,restore",
    authority: "#120 isolation boundary; product supports import",
  },
  text_attachment: {
    status: "UNSUPPORTED",
    source: "attachments.ts:imageFormat",
    authority: "only PNG/JPEG in this cohort",
  },
  resource_present: {
    status: "SUPPORTED",
    source: "task-triggers.ts:conditions",
    authority: "scripted owned file only after WAIT_PRECONDITION",
  },
  answer: {
    status: "SUPPORTED",
    source: "api/routes.ts:decisions/:id/answer",
    authority: "exact pending decision",
  },
  semantic_retraction: {
    status: "SUPPORTED",
    source: "world-accept.ts:RETRACT",
    authority: "new Master retraction + exact authorized World operation",
  },
  handled_text_withdrawal: {
    status: "UNSUPPORTED",
    source: "attachment-withdrawal.ts",
    authority: "physical withdrawal does not support HANDLED plain text",
  },
} as const;

export type MaintenanceJob = {
  id: string;
  mode: string;
  state: string;
  source_event_ids: string[];
  source_end_sequence: number;
  updated_at: string;
  next_attempt_at?: string | null;
};
/** B event is the main.message source linked to its input; sequence is its handled boundary.
 * Product source_event_ids contain main.message, not input.handled marker IDs.
 * Preserve attempts; a successful retry never deletes its predecessor. */
export function maintenanceBoundary(
  jobs: MaintenanceJob[],
  event: string,
  sequence: number,
  context: {
    at_cap: boolean;
    session_state: string;
    settings_blocked: boolean;
  },
) {
  requireThat(
    !!event && Number.isSafeInteger(sequence) && sequence > 0,
    "BASELINE_BOUNDARY_INVALID",
  );
  const eligible = jobs.filter(
    (j) =>
      j.mode !== "CONTEXT_COMPACTION" &&
      j.source_end_sequence >= sequence &&
      j.source_event_ids.includes(event),
  );
  const committed = eligible.filter((j) => j.state === "COMMITTED");
  const failures = eligible.filter((j) => j.state === "FAILED");
  const last = eligible.at(-1);
  const status = committed.length
    ? "COMMITTED"
    : !context.at_cap
      ? "PENDING"
      : !last
        ? "NOT_TRIGGERED"
        : ["QUEUED", "SUMMARIZING", "VALIDATING"].includes(last.state)
          ? "RUNNING_AT_CAP"
          : last.state === "FAILED"
            ? last.next_attempt_at
              ? "FAILED_RETRY_PENDING"
              : "FAILED_TERMINAL"
            : last.state === "STALE"
              ? "STALE_DISCARDED_AT_CAP"
              : "UNCLASSIFIED_AT_CAP";
  return {
    status,
    first_committed: committed[0]?.id ?? null,
    attempts: eligible,
    first_failure: failures[0] ?? null,
    next_attempt_at: last?.next_attempt_at ?? null,
    maintenance_failure:
      status === "FAILED_RETRY_PENDING" || status === "FAILED_TERMINAL",
    semantic: "UNRESOLVED" as Verdict,
    context,
  };
}

export type Quiescence = {
  maintenance_due: boolean;
  maintenance_running: boolean;
  summary_pending: boolean;
  last_handled_sequence: number;
  session_id: string;
  consciousness: {
    session_id: string;
    revision: number;
    covered_event_sequence?: number;
  }[];
  sessions: { state: string }[];
  compactions: { state: string }[];
  extractions: { state: string }[];
  calls: { state: string }[];
};
export function memoryBoundary(
  o: Pick<Quiescence, "session_id" | "consciousness" | "last_handled_sequence">,
) {
  const main = o.consciousness.filter(
    (record) => record.session_id === o.session_id,
  );
  requireThat(
    !!o.session_id &&
      main.length === 1 &&
      Number.isSafeInteger(o.last_handled_sequence),
    "BASELINE_MEMORY_BOUNDARY_MISSING",
  );
  const c = main[0];
  return {
    revision: c.revision,
    covered_sequence: c.covered_event_sequence ?? 0,
    last_handled_sequence: o.last_handled_sequence,
  };
}
export function assertSameMemory(
  expected: ReturnType<typeof memoryBoundary>,
  actual: ReturnType<typeof memoryBoundary>,
) {
  requireThat(
    JSON.stringify(expected) === JSON.stringify(actual),
    "BASELINE_PAIR_MEMORY_DRIFT",
  );
}
export function assertQuiescent(o: Quiescence, requireCovered = true) {
  requireThat(
    o.maintenance_due === false &&
      o.maintenance_running === false &&
      (!requireCovered ||
        (o.summary_pending === false &&
          memoryBoundary(o).covered_sequence >= o.last_handled_sequence)) &&
      o.sessions.length > 0 &&
      o.sessions.every((s) => s.state === "IDLE") &&
      !o.compactions.some((j) =>
        ["QUEUED", "SUMMARIZING", "VALIDATING"].includes(j.state),
      ) &&
      !o.extractions.some((j) => ["QUEUED", "RUNNING"].includes(j.state)) &&
      !o.calls.some((j) => ["PREPARED", "IN_FLIGHT"].includes(j.state)),
    "BASELINE_NOT_QUIESCENT",
  );
}

export type Reference = { path: string; sha256: string };
export function verifyReferences(
  refs: Reference[],
  read: (path: string) => Buffer,
) {
  requireThat(refs.length > 0, "BASELINE_EVIDENCE_MISSING");
  for (const ref of refs)
    requireThat(
      /^[a-f0-9]{64}$/.test(ref.sha256) && sha(read(ref.path)) === ref.sha256,
      "BASELINE_EVIDENCE_CHANGED",
    );
}
export const interruptionElements = [
  "pre_fault_binding",
  "post_fsync_marker",
  "old_exit",
  "new_identity",
  "unknown_state",
  "verify_write",
  "same_identity_history",
] as const;
export type InterruptionEvidence = Partial<
  Record<(typeof interruptionElements)[number], Reference[]>
>;
/** An unavailable archive is the same incomplete evidence contract, never an exemption. */
export function interruptionReuse(
  proof: InterruptionEvidence,
  read: (path: string) => Buffer,
) {
  const missing = interruptionElements.filter((k) => {
    try {
      verifyReferences(proof[k] ?? [], read);
      return false;
    } catch {
      return true;
    }
  });
  return {
    c12b_required: missing.length > 0 ? true : null,
    missing,
    status: missing.length
      ? "REUSED_REPORT_ONLY"
      : "REFERENCES_VERIFIED_IDENTITY_REVIEW_REQUIRED",
    limitation:
      "Host references require semantic identity review; never an autonomous reconciliation claim",
  };
}

export type RestartEvidence = {
  kind: "DIRECT_SAME_DOMAIN" | "CHECKPOINT_RESTORE";
  old_identity: string;
  new_identity: string;
  old_exit: Reference;
  new_start: Reference;
  restart_observed: boolean;
};
export function verifyRestart(
  r: RestartEvidence,
  read: (path: string) => Buffer,
) {
  requireThat(
    r &&
      ["DIRECT_SAME_DOMAIN", "CHECKPOINT_RESTORE"].includes(r.kind) &&
      r.restart_observed === true &&
      !!r.old_identity &&
      !!r.new_identity &&
      r.old_identity !== r.new_identity,
    "BASELINE_RESTART_UNPROVEN",
  );
  verifyReferences([r.old_exit, r.new_start], read);
  const old = JSON.parse(read(r.old_exit.path).toString());
  const next = JSON.parse(read(r.new_start.path).toString());
  requireThat(
    old.schema === "benchmark-process-witness-v1" &&
      next.schema === old.schema &&
      old.observed === "STOPPED" &&
      next.observed === "RUNNING" &&
      identityHash(old.identity) === old.identity_sha256 &&
      old.identity_sha256 === r.old_identity &&
      identityHash(next.identity) === next.identity_sha256 &&
      next.identity_sha256 === r.new_identity &&
      Number.isFinite(Date.parse(old.at)) &&
      Number.isFinite(Date.parse(next.at)) &&
      Date.parse(old.at) <= Date.parse(next.at),
    "BASELINE_RESTART_WITNESS",
  );
  if (r.kind === "DIRECT_SAME_DOMAIN")
    requireThat(
      old.identity.token === next.identity.token,
      "BASELINE_RESTART_DOMAIN",
    );
  return r;
}
export function worldBoundary(
  proof: {
    restart: RestartEvidence;
    commit_sequence: number;
    first_eligible_sequence: number;
    request_sequence: number;
    committed: Reference;
    request: Reference;
  },
  read: (path: string) => Buffer,
) {
  verifyRestart(proof.restart, read);
  verifyReferences([proof.committed, proof.request], read);
  requireThat(
    Number.isSafeInteger(proof.commit_sequence) &&
      proof.commit_sequence > 0 &&
      proof.first_eligible_sequence > proof.commit_sequence &&
      proof.request_sequence === proof.first_eligible_sequence,
    "BASELINE_WORLD_REQUEST_BOUNDARY",
  );
  return { ...proof, restart_observed: proof.restart.restart_observed };
}

export function coldEvidence(
  p: {
    request: Reference;
    surfaces: Record<
      "context" | "profile" | "consciousness" | "recall",
      "ABSENT" | "PRESENT" | "UNKNOWN"
    >;
    semantic_review: Reference | null;
    opaque: boolean;
    original_read: Reference | null;
    used_source: boolean;
  },
  read: (path: string) => Buffer,
): Verdict {
  verifyReferences([p.request], read);
  if (
    p.opaque ||
    !p.semantic_review ||
    Object.values(p.surfaces).some((x) => x !== "ABSENT")
  )
    return "UNRESOLVED";
  verifyReferences([p.semantic_review], read);
  if (!p.original_read || !p.used_source) return "FAIL";
  verifyReferences([p.original_read], read);
  return "PASS";
}
export function effectVerdict(
  expected: number,
  observed: number,
  completeWindow: boolean,
  unknown: number,
): Verdict {
  requireThat(
    [expected, observed, unknown].every(
      (x) => Number.isSafeInteger(x) && x >= 0,
    ),
    "BASELINE_EFFECT_COUNTS",
  );
  if (observed > expected) return "FAIL";
  if (!completeWindow || unknown) return "UNRESOLVED";
  return observed === expected ? "PASS" : "FAIL";
}

export const semanticAssertions = [
  "natural_access",
  "current_vs_history",
  "maintenance_current",
  "use_current",
  "authority_chain",
  "text_survival",
  "item_lineage",
  "obligation",
  "effects",
  "source_identity",
] as const;
export type SemanticGrade = {
  schema: typeof baselineVersion;
  case_id: string;
  packet_sha256: string;
  judgments: {
    assertion: (typeof semanticAssertions)[number];
    verdict: Verdict;
    evidence: Reference[];
    rationale: string;
  }[];
};
export function validateSemanticGrade(
  g: SemanticGrade,
  expected: {
    case_id: string;
    packet_sha256: string;
    assertions: readonly string[];
  },
  read: (path: string) => Buffer,
) {
  requireThat(
    g.schema === baselineVersion &&
      g.case_id === expected.case_id &&
      g.packet_sha256 === expected.packet_sha256,
    "BASELINE_GRADE_BINDING",
  );
  const names = g.judgments.map((j) => j.assertion);
  requireThat(
    new Set(names).size === names.length &&
      names.length === expected.assertions.length &&
      names.every((n) => expected.assertions.includes(n)),
    "BASELINE_GRADE_COVERAGE",
  );
  for (const j of g.judgments) {
    requireThat(
      ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].includes(j.verdict) &&
        typeof j.rationale === "string" &&
        j.rationale.trim().length > 0,
      "BASELINE_GRADE_LABEL",
    );
    if (j.verdict === "PASS" || j.verdict === "FAIL")
      verifyReferences(j.evidence, read);
  }
  return g;
}
