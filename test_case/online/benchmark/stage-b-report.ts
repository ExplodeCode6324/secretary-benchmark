import { trialArtifact, hostEvidence } from "./stage-b-report-evidence.ts";
import {
  publicationLog,
  attributeLane,
  projectedIdentity,
  gradableIdentity,
} from "./stage-b-report-publication.ts";
import fs from "node:fs";
import path from "node:path";
import { ledger, loadCampaign } from "./campaign.ts";
import { baselineCases } from "./baseline-scenarios.ts";
import {
  deploymentGuard,
  repository,
  requireThat,
  sha,
  read,
  readJSON,
  writeJSON,
} from "./io.ts";
import {
  stageModels,
  stageSlots,
  stageLane,
  physicalUsageKnown,
  ambiguousReasoning,
  validatePhysical,
} from "./stage-b-policy.ts";
import { freezeFile, type StageFreeze } from "./stage-b-freeze.ts";
import { stageBCalibrationStatus } from "./stage-b-report-calibration.ts";
import { stageBGradeEvidence } from "./stage-b-report-grading.ts";
export {
  prepareStageBCalibration,
  beginStageBCalibration,
  finishStageBCalibration,
} from "./stage-b-report-calibration.ts";
export {
  prepareStageBGrade,
  beginStageBGrade,
  finishStageBGrade,
} from "./stage-b-report-grading.ts";

const statuses = [
  "COMPLETED",
  "INCOMPLETE",
  "NOT_DISPATCHED_PREFLIGHT",
  "DEFERRED_BY_DECISION",
  "UNRUN_CAMPAIGN_TIME",
  "SKIPPED_CONTROL_QUOTA",
  "BLOCKED_PRIMARY",
  "STOPPED_BOUND_VIOLATION",
  "VERSION_TRANSITION",
  "HALTED",
] as const;
const outcomes = [
  "RESPONSE_COMPLETE",
  "EXHAUSTED_QUOTA",
  "AUTH",
  "TLS",
  "TRANSIENT",
  "RATE_LIMITED",
  "UNKNOWN",
  "VERSION_TRANSITION",
  "NETWORK_UNCERTAIN",
  "STREAM_UNCERTAIN",
  "CANCELLED_UNCERTAIN",
  "BOUND_VIOLATION",
  "IDENTITY_UNKNOWN",
  "IDENTITY_MISMATCH_FIRST_CONTACT",
  "PROVENANCE_CHANGE",
];
const reasons = [
  ...outcomes,
  ...statuses,
  "OPERATOR",
  "INFRASTRUCTURE",
  "MISSING_CONFIGURATION",
  "VERSION_HOLD",
  "IDENTITY_HOLD",
  "FROZEN_C16_DEFERRAL",
  "INCOMPLETE_QUOTA",
  "LANE_CAP",
  "LANE_TIME",
  "CAMPAIGN_TIME",
  "PROTOCOL_COMPLETE",
  "LANE_CAP_REDUCED",
  "REQUIRED_PRIMARY",
  "COMPONENT_OVERRUN",
  "RETURNED_MODEL_CHANGED",
  "ACCOUNT_PAUSE_TERMINATED",
  "CONNECTIVITY_ONLY",
  "PROBE_FAILED",
  "PARTIAL_TRIAL",
  "CONTROLLER_INTERRUPTED",
  "PREFLIGHT",
  "STAGE_B_BODY_BOUND",
  "PRIMARY_ACCOUNT",
  "ACCOUNT_EXHAUSTED",
];
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
function stamp(value: string) {
  const time = Date.parse(value);
  requireThat(Number.isFinite(time), "STAGE_B_REPORT_CLOCK_INVALID");
  return new Date(time).toISOString();
}
export function dispatchSnapshot(root: string) {
  const file = path.join(root, "campaign", "stage-b-dispatch.json");
  if (!fs.existsSync(file)) return null;
  const value = readJSON(file);
  requireThat(
    value.schema === "issue122-dispatch-v2" &&
      digest(value.freeze_sha256) &&
      value.terminals &&
      typeof value.terminals === "object" &&
      !Array.isArray(value.terminals) &&
      Object.keys(value.terminals).every((key) =>
        stageSlots.some((s) => s.lane === key),
      ),
    "STAGE_B_DISPATCH_REPORT_INVALID",
  );
  return value as {
    probes?: Record<
      string,
      { status: (typeof statuses)[number]; reason: string; at: string }
    >;
    end_checked?: boolean;
    ended?: boolean;
    freeze_sha256: string;
    terminals: Record<
      string,
      {
        status: (typeof statuses)[number];
        reason: string;
        at: string;
        episode?: string;
        run?: string;
        evidence?: string;
      }
    >;
  };
}
function safeTerminal(
  row: NonNullable<ReturnType<typeof dispatchSnapshot>>["terminals"][string],
) {
  requireThat(
    statuses.includes(row.status) &&
      typeof row.reason === "string" &&
      (row.status !== "HALTED" ||
        ["OPERATOR", "INFRASTRUCTURE", "PROVENANCE_CHANGE"].includes(
          row.reason,
        )),
    "STAGE_B_TERMINAL_INVALID",
  );
  return {
    status: row.status,
    reason: reasons.includes(row.reason)
      ? row.reason
      : "OTHER_RETAINED_PRIVATELY",
    reason_sha256: sha(row.reason),
    at: stamp(row.at),
  };
}

type LedgerEntry =
  ReturnType<typeof ledger>["entries"] extends Map<string, infer V> ? V : never;
function publicModelId(id: string) {
  return /^(?:deepseek-|gpt-|fp_)[A-Za-z0-9._:-]{1,100}$/i.test(id) ? id : null;
}
function projectAttempt(
  entry: LedgerEntry,
  freeze: string,
  ordinal: number,
  allowed: readonly string[],
  legacy: boolean,
) {
  const { attempt } = entry,
    physical = attempt.physical;
  const lane = stageLane(attempt.lane ?? "");
  requireThat(
    lane &&
      lane.model === attempt.model &&
      physical?.freeze_sha256 === freeze &&
      digest(attempt.request_sha256) &&
      amount(attempt.reserved_usd) &&
      count(physical.input_bytes) &&
      count(physical.output_tokens) &&
      ["task", "main", "maintenance", "probe"].includes(physical.role),
    "STAGE_B_REPORT_LEDGER_BINDING",
  );
  const details = entry.usage as
    | {
        provider?: any;
        status?: number;
        error_sha256?: string;
        response_complete?: boolean;
        observed_models?: string[];
      }
    | undefined;
  const provider = details?.provider,
    known = physicalUsageKnown(provider);
  const isFlash = lane.model === "deepseek-flash";
  const cached = legacy
    ? (provider?.input_tokens_details?.cached_tokens ??
      provider?.prompt_cache_hit_tokens ??
      provider?.prompt_tokens_details?.cached_tokens)
    : isFlash
      ? provider?.prompt_cache_hit_tokens
      : provider?.input_tokens_details?.cached_tokens;
  const written = isFlash
    ? undefined
    : provider?.input_tokens_details?.cache_write_tokens;
  const scheduleChanged = entry.outcome === "PROVENANCE_CHANGE";
  const outcome =
    entry.settled || scheduleChanged
      ? outcomes.includes(entry.outcome ?? "")
        ? entry.outcome!
        : "OTHER_RETAINED_PRIVATELY"
      : "RESERVED_UNSETTLED";
  return {
    ordinal,
    lane: lane.lane,
    model: lane.model,
    role: physical.role,
    at: stamp(attempt.at),
    attempt_id_sha256: sha(attempt.id),
    episode_sha256: sha(attempt.episode ?? ""),
    request_sha256: attempt.request_sha256,
    reserved_input_bytes: physical.input_bytes,
    reserved_output_tokens: physical.output_tokens,
    settled_at: entry.settled_at ? stamp(entry.settled_at) : null,
    settled_sequence: entry.settled_sequence ?? null,
    outcome,
    response_complete:
      details?.response_complete ?? outcome === "RESPONSE_COMPLETE",
    chat_stream_usage_requested:
      attempt.chat_stream_usage_requested === true ? true : null,
    components_validated: known,
    ambiguous_reasoning: ambiguousReasoning(provider),
    observed_model_sha256: Array.isArray(details?.observed_models)
      ? details.observed_models
          .slice(0, 2)
          .filter((id) => typeof id === "string")
          .map((id) => sha(id))
      : [],
    component_violation: entry.component_violation === true,
    monetary_overrun: !!entry.bound_violation,
    matched_returned_model:
      entry.returned_model && allowed.includes(entry.returned_model)
        ? publicModelId(entry.returned_model)
        : null,
    returned_model_sha256: entry.returned_model
      ? sha(entry.returned_model)
      : null,
    provider_usage: known
      ? {
          input_tokens: provider.input_tokens ?? provider.prompt_tokens,
          output_tokens: provider.output_tokens ?? provider.completion_tokens,
          cached_input_tokens: count(cached) ? cached : null,
          cache_write_tokens: count(written) ? written : null,
          reasoning_tokens:
            provider.output_tokens_details?.reasoning_tokens ??
            provider.completion_tokens_details?.reasoning_tokens ??
            null,
        }
      : null,
    http_status:
      count(details?.status) && details.status >= 100 && details.status <= 599
        ? details.status
        : null,
    error_sha256: digest(details?.error_sha256) ? details.error_sha256 : null,
    reserved_usd: attempt.reserved_usd,
    reservation_basis: scheduleChanged
      ? "FROZEN_SCHEDULE_ONLY_AFTER_PROVENANCE_CHANGE"
      : "FROZEN_SCHEDULE",
    usage_rate_estimate_usd:
      known && amount(entry.actual_usd) ? entry.actual_usd : null,
    unknown_reservation_usd:
      known && amount(entry.actual_usd) ? null : attempt.reserved_usd,
  };
}
function cost(rows: ReturnType<typeof projectAttempt>[]) {
  const completed = rows.filter((r) => r.response_complete);
  const checked = completed.filter((r) => r.components_validated).length;
  const priced = completed.filter(
    (r) => r.usage_rate_estimate_usd !== null,
  ).length;
  const drifted = rows.filter(
    (r) =>
      r.reservation_basis === "FROZEN_SCHEDULE_ONLY_AFTER_PROVENANCE_CHANGE",
  );
  return {
    physical_reservations: rows.length,
    completed_price_coverage: {
      completed_responses: completed.length,
      with_recorded_estimate: priced,
      unknown: completed.length - priced,
      percent: completed.length ? (100 * priced) / completed.length : null,
    },
    provenance_change_reservations: {
      attempts: drifted.length,
      frozen_schedule_only_usd: drifted.reduce((s, r) => s + r.reserved_usd, 0),
    },
    completed_usage_coverage: {
      completed_responses: completed.length,
      validated_components: checked,
      unchecked_or_ambiguous: completed.length - checked,
      component_violations: completed.filter((r) => r.component_violation)
        .length,
      percent: completed.length ? (100 * checked) / completed.length : null,
    },
    chat_stream_usage_requests: rows.filter(
      (r) => r.chat_stream_usage_requested,
    ).length,
    unknown_usage_or_price: rows.filter(
      (r) => r.unknown_reservation_usd !== null,
    ).length,
    usage_rate_estimate_usd: rows.reduce(
      (s, r) => s + (r.usage_rate_estimate_usd ?? 0),
      0,
    ),
    unknown_full_reservation_usd: rows.reduce(
      (s, r) => s + (r.unknown_reservation_usd ?? 0),
      0,
    ),
    invoice_usd: null,
  };
}
function forecast(row: StageFreeze["worklist"][number] | undefined) {
  if (!row) return null;
  const f = row.forecast;
  const interval = (r: { min: number; max: number }) => {
    requireThat(
      count(r.min) && count(r.max) && r.max >= r.min,
      "STAGE_B_REPORT_FORECAST_INVALID",
    );
    return { min: r.min, max: r.max };
  };
  requireThat(
    [f.expected_usd, f.worst_usd].every(amount) &&
      [f.expected_sends, f.expected_seconds].every(count),
    "STAGE_B_REPORT_FORECAST_INVALID",
  );
  return {
    expected_sends: f.expected_sends,
    expected_seconds: f.expected_seconds,
    expected_usd: f.expected_usd,
    worst_usd: f.worst_usd,
    over_lane_limits: f.over_lane_limits === true,
    range: f.range
      ? {
          sends: interval(f.range.sends),
          seconds: interval(f.range.seconds),
          ordinary_jobs: interval(f.range.ordinary_jobs),
          context_compactions: interval(f.range.context_compactions),
          forced_band_compactions: interval(f.range.forced_band_compactions),
          send_cap: row.cap,
          seconds_cap: 3600,
        }
      : null,
    capacity_profile:
      row.profile === "DEP" ? "DEP_DEFAULT_UNVERIFIED" : "RC98304",
    input_sha256: row.input_sha256,
  };
}

/** Purely local projection. Free-form text, physical payloads, private paths and grading keys stay at source. */
export function buildStageBReport(root: string) {
  deploymentGuard(repository, root);
  const state = dispatchSnapshot(root);
  const campaign = fs.existsSync(path.join(root, "campaign/manifest.json"))
    ? loadCampaign(root)
    : null;
  const log = ledger(root);
  requireThat(
    !campaign || campaign.physical_policy,
    "STAGE_B_REPORT_LEGACY_CAMPAIGN",
  );
  const dossier = freezeFile(root);
  const freezeHash = fs.existsSync(dossier) ? sha(read(dossier)) : null;
  const freeze: StageFreeze | null = freezeHash ? readJSON(dossier) : null;
  const legacy = freeze?.schema === "issue122-stage-b-freeze-v2";
  const policySchema = legacy ? "issue122-physical-v2" : "issue122-physical-v3";
  requireThat(
    (!freeze || legacy || freeze.schema === "issue122-stage-b-freeze-v3") &&
      (!state || state.freeze_sha256 === freezeHash) &&
      (!campaign ||
        (campaign.physical_policy?.freeze_sha256 === freezeHash &&
          campaign.physical_policy.schema === policySchema)) &&
      (!log.sequence || campaign),
    "STAGE_B_REPORT_FREEZE_BINDING",
  );
  if (freeze) {
    requireThat(
      ["DISPATCH", "DEFERRED_BY_DECISION"].includes(freeze.inputs.c16_decision),
      "STAGE_B_REPORT_C16_DECISION",
    );
    validatePhysical(
      {
        schema: policySchema,
        freeze_sha256: freezeHash!,
        providers: freeze.inputs.providers,
      },
      true,
    );
    requireThat(
      amount(freeze.expected_usd) &&
        amount(freeze.worst_usd) &&
        (!campaign ||
          JSON.stringify(campaign.physical_policy!.providers) ===
            JSON.stringify(freeze.inputs.providers)),
      "STAGE_B_REPORT_PRICE_INVALID",
    );
  }
  const attempts = [...log.entries.values()].map((e, i) =>
    projectAttempt(
      e,
      freezeHash!,
      i + 1,
      freeze!.inputs.providers[e.attempt.model as (typeof stageModels)[number]]
        ?.allowed_returned_models ?? [],
      legacy,
    ),
  );
  const publications = publicationLog(root);
  const calibration = stageBCalibrationStatus(root);
  const cases = baselineCases(true);
  const slots = stageSlots.map((slot, i) => {
    const terminal = state?.terminals[slot.lane];
    const sends = attempts.filter((a) => a.lane === slot.lane);
    requireThat(
      !terminal?.episode ||
        sends.every((s) => s.episode_sha256 === sha(terminal.episode!)),
      "STAGE_B_REPORT_EPISODE_DRIFT",
    );
    const decisive = terminal ? safeTerminal(terminal) : null;
    const predecessor = sends
      .filter(
        (a) =>
          (a.settled_at !== null && a.outcome !== "RESPONSE_COMPLETE") ||
          a.component_violation,
      )
      .sort(
        (a, b) =>
          (a.settled_sequence ?? Infinity) - (b.settled_sequence ?? Infinity),
      )[0];
    const planned = cases.find((c) => c.id === slot.scenario)!.assertions;
    const identity = attributeLane(
      publications,
      slot.lane,
      slot.model,
      freeze?.inputs.providers[slot.model],
      sends,
      state?.end_checked === true,
    );
    const runs = new Set(
      [...log.entries.values()]
        .filter((row) => row.attempt.lane === slot.lane)
        .map((row) => row.attempt.run),
    );
    if (terminal?.run) runs.add(terminal.run);
    if (terminal?.evidence)
      requireThat(runs.size === 1, "STAGE_B_REPORT_RUN_DRIFT");
    const artifact = terminal?.evidence
      ? trialArtifact(root, {
          id: [...runs][0],
          lane: slot.lane,
          freeze: freezeHash!,
          episode: terminal.episode!,
          evidence: terminal.evidence,
        })
      : null;
    const host = artifact ? hostEvidence(artifact) : null;
    const grades = stageBGradeEvidence(
      root,
      slot.lane,
      planned,
      gradableIdentity(identity) &&
        calibration.status === "PASSED" &&
        calibration.receipt?.packet_sha256 ===
          freeze?.inputs.calibration_packet_sha256 &&
        calibration.receipt?.private_key_sha256 ===
          freeze?.inputs.calibration_key_sha256 &&
        ["COMPLETED", "INCOMPLETE"].includes(terminal?.status ?? ""),
      host,
    );

    const frozen = freeze?.worklist[i];
    requireThat(
      !freeze || (frozen?.lane === slot.lane && digest(frozen.input_sha256)),
      "STAGE_B_REPORT_WORKLIST_CHANGED",
    );
    return {
      slot: i + 1,
      lane: slot.lane,
      model: slot.model,
      scenario: slot.scenario,
      profile: slot.profile === "DEP" ? "DEP_DEFAULT_UNVERIFIED" : "RC98304",
      lane_cap: slot.cap,
      cap_disposition: slot.profile === "DEP" ? "STANDARD" : "LANE_CAP_REDUCED",
      terminal: decisive,
      status: decisive?.status ?? (sends.length ? "IN_PROGRESS" : "PLANNED"),
      forecast: forecast(frozen),
      first_reservation_at: sends[0]?.at ?? null,
      attempts: sends,
      cost: cost(sends),
      first_failed_attempt: predecessor ?? null,
      host,
      identity,
      scenario_evidence_sha256: terminal?.evidence ?? null,
      ...grades,
    };
  });
  const models = stageModels.map((model) => {
    const rule = freeze?.inputs.providers[model],
      estimate = freeze?.estimates.find((e) => e.model === model);
    requireThat(
      !freeze ||
        (rule &&
          digest(rule.provenance_sha256) &&
          amount(estimate?.expected_usd) &&
          amount(estimate?.worst_usd)),
      "STAGE_B_REPORT_PRICE_INVALID",
    );
    const modelAttempts = attempts.filter((a) => a.model === model);
    return {
      model,
      ...cost(modelAttempts),
      expected_usd: estimate?.expected_usd ?? null,
      worst_usd: estimate?.worst_usd ?? null,
      price_provenance: rule
        ? {
            schedule: legacy ? "LEGACY_PHYSICAL_V2" : "PHYSICAL_V3",
            verified_at: stamp(rule.checked_at),
            source_sha256: rule.provenance_sha256,
            official_origin: new URL(rule.publication_url).origin,
            input_usd_per_million: rule.input_rate,
            output_usd_per_million: rule.output_rate,
            tier: rule.tier,
            cache_retention: rule.cache_retention,
            context_band: rule.context_band,
            context_upper_tokens: rule.context_upper_tokens,
            cached_input_usd_per_million: rule.cache_input_rate,
            cache_write_usd_per_million: rule.cache_write_rate ?? null,
            missing_ttl_breakdown_basis:
              !legacy && model !== "deepseek-flash"
                ? "SERIALIZED_REQUEST_DEFAULT_RETENTION_GUARD"
                : null,
          }
        : null,
      published_version:
        rule &&
        /^(?:deepseek-|gpt-)[A-Za-z0-9.-]{1,64}$/i.test(rule.published_version)
          ? rule.published_version
          : null,
      published_version_sha256: rule ? sha(rule.published_version) : null,
      frozen_returned_models:
        rule?.allowed_returned_models.map((id) => ({
          identifier: publicModelId(id),
          sha256: sha(id),
        })) ?? null,
      identity: rule
        ? projectedIdentity(rule, model, modelAttempts)
        : "NO_RETURNED_IDENTIFIER",
    };
  });
  const report = {
    schema: "issue122-stage-b-report-v3",
    physical_policy_schema: freeze ? policySchema : null,
    expected_input_pricing_assumption:
      freeze && !legacy ? "ALL_ORDINARY_ZERO_CACHE_READS_OR_WRITES" : null,
    generation: "OFFLINE_LEDGER_REPLAY",
    c16_decision: freeze?.inputs.c16_decision ?? null,
    freeze_sha256: freezeHash,
    ledger_sha256: log.previous,
    ledger_sequence: log.sequence,
    planned_slots: slots.length,
    terminal_slots: slots.filter((s) => s.terminal).length,
    counts_by_disposition: Object.fromEntries(
      [...statuses, "PLANNED", "IN_PROGRESS"].map((status) => [
        status,
        slots.filter((s) => s.status === status).length,
      ]),
    ),
    slots,
    models,
    overall: {
      ...cost(attempts),
      expected_usd: freeze?.expected_usd ?? null,
      worst_usd: freeze?.worst_usd ?? null,
    },
    probes: attempts.filter((a) => a.lane.startsWith("probe--")),
    probe_dispositions: stageModels.map((model) => ({
      model,
      cost: cost(attempts.filter((a) => a.lane === "probe--" + model)),
      terminal: state?.probes?.["probe--" + model]
        ? safeTerminal(state.probes["probe--" + model])
        : null,
    })),
    calibration,
    c10: {
      variant: "RESOURCE_PRESENT",
      reserved_for_stage_c: [
        "typed_answer",
        "model_created_question_answer",
        "merely_discussed",
      ],
      coverage: "UNCOVERED_IN_PILOT",
      model_created_resource_present: "UNSUPPORTED",
    },
    historical_repeat_credit: 0,
    deployment_qualification: "NOT_TESTED",
  };
  writeJSON(path.join(root, "reports", "issue122-stage-b.json"), report);
  return report;
}
