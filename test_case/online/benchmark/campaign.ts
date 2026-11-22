import {
  echoContract,
  echoScope,
  echoObservation,
  echoConflict,
  confirmedEchoTerminal,
  validateRetentionFrame,
  retentionFinding,
  type CacheObservation,
  type RetentionFrame,
} from "./stage-b-retention.ts";
import { fingerprint } from "./source.ts";
import {
  validatePhysical,
  publicTier,
  type ObservedTier,
  physicalBound,
  physicalViolation,
  returnedIdentity,
  checkAdmission,
  type PhysicalBound,
  type PhysicalPolicy,
  type StageModel,
} from "./stage-b-policy.ts";
import {
  validateBaselineLimits,
  assertBaselineReservation,
  type BaselineLimits,
} from "./baseline-budget.ts";
// Durable accounting belongs to each sender, not to the short-lived CLI or a checkpoint.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  appendJSON,
  lease,
  read,
  readJSON,
  repository,
  requireThat,
  sha,
  writeJSON,
} from "./io.ts";

type FinalLedger = {
  hash: string;
  sequence: number;
  attempts: number;
  unsettled: number;
  charged_usd: number;
};
export type Campaign = {
  version: 1;
  approval_id: string;
  facility: string;
  state: "OPEN" | "CLOSED";
  ceiling_usd?: number | null;
  physical_policy?: PhysicalPolicy;
  created_at: string;
  source?: ReturnType<typeof fingerprint>;
  closed_at?: string;
  final_ledger?: FinalLedger;
  baseline_limits?: BaselineLimits;
};
type ClosedCampaign = Campaign & {
  state: "CLOSED";
  closed_at: string;
  final_ledger: FinalLedger;
};
export type Attempt = {
  id: string;
  model: string;
  run: string;
  episode?: string;
  lane?: string;
  request_sha256: string;
  reserved_usd: number;
  physical?: PhysicalBound;
  chat_stream_usage_requested?: true;
  at: string;
  pid: number;
};
type TierObservation = {
  requested_tier: "default";
  observed_tier: ObservedTier;
};
type EchoStop =
  | "CONFLICTING_METADATA"
  | "TERMINAL_ZERO_UNCONFIRMED"
  | "INCOMPLETE_STREAM"
  | "ORPHANED_AT_BOUNDARY"
  | "COMPONENT_OVERRUN";
type DriftObservation = Partial<TierObservation> & {
  cache_retention?: CacheObservation;
  echo_stop?: EchoStop;
  conflicting_frame?: RetentionFrame;
  first_legacy_echo?: RetentionFrame;
};
type PricingDrift = { reason: string; at: string } & DriftObservation;
function validateCacheDrift(
  contract: PhysicalBound["cache_retention_contract"],
  reason: string,
  observation: DriftObservation,
  firstEcho?: RetentionFrame,
) {
  if (observation.echo_stop !== undefined) {
    requireThat(
      contract === echoContract &&
        firstEcho &&
        reason === "CACHE_RETENTION" &&
        JSON.stringify(observation.cache_retention) ===
          JSON.stringify(echoObservation(firstEcho)) &&
        [
          "CONFLICTING_METADATA",
          "TERMINAL_ZERO_UNCONFIRMED",
          "INCOMPLETE_STREAM",
          "ORPHANED_AT_BOUNDARY",
          "COMPONENT_OVERRUN",
        ].includes(observation.echo_stop),
      "STAGE_B_ECHO_STOP_INVALID",
    );
    if (observation.echo_stop === "CONFLICTING_METADATA") {
      requireThat(
        observation.conflicting_frame,
        "STAGE_B_ECHO_CONFLICT_MISSING",
      );
      validateRetentionFrame(observation.conflicting_frame, "WITNESS");
      requireThat(
        echoConflict(observation.conflicting_frame),
        "STAGE_B_ECHO_CONFLICT_INVALID",
      );
    } else
      requireThat(
        observation.conflicting_frame === undefined,
        "STAGE_B_ECHO_CONFLICT_INVALID",
      );
    return;
  }
  requireThat(
    observation.conflicting_frame === undefined,
    "STAGE_B_ECHO_CONFLICT_INVALID",
  );
  if (contract && ["CACHE_RETENTION", "CACHE_WRITE_12H"].includes(reason)) {
    requireThat(observation.cache_retention, "STAGE_B_CACHE_DRIFT_MISSING");
    validateRetentionFrame(
      observation.cache_retention,
      reason,
      contract === echoContract,
    );
  } else
    requireThat(
      observation.cache_retention === undefined,
      "STAGE_B_CACHE_DRIFT_INVALID",
    );
}
function validateTerminalCache(
  physical: PhysicalBound | undefined,
  usage: unknown,
  price: number | null,
  drift: PricingDrift | undefined,
  firstEcho?: RetentionFrame,
) {
  const details = usage as {
    terminal_cache_retention?: RetentionFrame;
    invalid_long_write_count?: true;
    response_complete?: boolean;
    legacy_echo_disposition?: "COMPATIBILITY_ECHO";
    returned_service_tier?: unknown;
    provider?: unknown;
  } | null;
  if (details?.terminal_cache_retention !== undefined) {
    requireThat(
      physical?.cache_retention_contract,
      "STAGE_B_CACHE_TERMINAL_INVALID",
    );
    const terminal = details.terminal_cache_retention;
    validateRetentionFrame(terminal);
    if (
      physical.cache_retention_contract === echoContract &&
      echoScope(terminal)
    )
      requireThat(firstEcho, "STAGE_B_ECHO_WITNESS_MISSING");
    requireThat(
      !retentionFinding(
        terminal,
        physical.cache_retention_contract === echoContract,
      ) || drift,
      "STAGE_B_CACHE_DRIFT_MISSING",
    );
    if (
      terminal.frame.long_writes === "INVALID" ||
      terminal.response.long_writes === "INVALID"
    )
      requireThat(
        details.invalid_long_write_count,
        "STAGE_B_CACHE_USAGE_INVALID",
      );
  }
  if (firstEcho && !drift) {
    requireThat(
      physical?.cache_retention_contract === echoContract &&
        details?.legacy_echo_disposition === "COMPATIBILITY_ECHO" &&
        details.response_complete === true &&
        details.returned_service_tier === "default" &&
        !details.invalid_long_write_count &&
        !echoConflict(firstEcho) &&
        !retentionFinding(firstEcho, true) &&
        details.terminal_cache_retention &&
        details.terminal_cache_retention.frame_index >= firstEcho.frame_index &&
        !echoConflict(details.terminal_cache_retention) &&
        confirmedEchoTerminal(
          details.terminal_cache_retention,
          details.provider,
        ),
      "STAGE_B_ECHO_CONFIRMATION_INVALID",
    );
  } else
    requireThat(
      details?.legacy_echo_disposition === undefined,
      "STAGE_B_ECHO_DISPOSITION_INVALID",
    );
  if (physical?.cache_retention_contract && details?.response_complete)
    requireThat(
      details.terminal_cache_retention,
      "STAGE_B_CACHE_TERMINAL_MISSING",
    );
  if (details?.invalid_long_write_count !== undefined)
    requireThat(
      physical?.cache_retention_contract &&
        details.invalid_long_write_count === true &&
        price === null,
      "STAGE_B_CACHE_USAGE_INVALID",
    );
}
function validateTierDrift(
  reason: string,
  expected: "default" | undefined,
  observed: Partial<TierObservation>,
) {
  if (reason === "SERVICE_TIER" && expected) {
    const value = observed.observed_tier;
    requireThat(
      observed.requested_tier === expected &&
        value !== expected &&
        (value === "MISSING" ||
          value === "UNRECOGNIZED" ||
          (typeof value === "string" && publicTier(value) === value)),
      "STAGE_B_DRIFT_EVENT_INVALID",
    );
  } else
    requireThat(
      observed.requested_tier === undefined &&
        observed.observed_tier === undefined,
      "STAGE_B_DRIFT_EVENT_INVALID",
    );
}
type Event =
  | { type: "RESERVE"; attempt: Attempt }
  | { type: "LEGACY_ECHO"; id: string; at: string; witness: RetentionFrame }
  | ({ type: "PRICING_DRIFT"; id: string } & PricingDrift)
  | {
      type: "SETTLE";
      id: string;
      at: string;
      actual_usd: number | null;
      outcome: string;
      usage: unknown;
      bound_violation?: { reserved_usd: number; actual_usd: number };
    };

async function locked<T>(root: string, fn: () => Promise<T>) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      return await lease(root, fn, "campaign.lock");
    } catch (e) {
      if (
        !(e instanceof Error) ||
        e.message !== "CONTROLLER_BUSY" ||
        Date.now() >= deadline
      )
        throw e;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
}
const directory = (root: string) => path.join(root, "campaign");
export function loadCampaign(root: string): Campaign {
  const c = readJSON(path.join(directory(root), "manifest.json")) as Campaign;
  requireThat(
    c.version === 1 &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(c.approval_id) &&
      c.facility === root &&
      ["OPEN", "CLOSED"].includes(c.state),
    "CAMPAIGN_INVALID",
  );
  if (c.physical_policy) {
    validatePhysical(c.physical_policy, true);
    requireThat(
      !("ceiling_usd" in c) && !("baseline_limits" in c),
      "STAGE_B_MIXED_POLICY",
    );
  } else
    requireThat(
      c.ceiling_usd === null ||
        (typeof c.ceiling_usd === "number" &&
          Number.isFinite(c.ceiling_usd) &&
          c.ceiling_usd > 0),
      "CAMPAIGN_INVALID_CEILING",
    );
  if (c.baseline_limits)
    validateBaselineLimits(c.baseline_limits, c.ceiling_usd ?? null);
  return c;
}
export function ledger(root: string) {
  const file = path.join(directory(root), "attempts.jsonl");
  const entries = new Map<
    string,
    {
      attempt: Attempt;
      settled: boolean;
      charged_usd: number;
      outcome?: string;
      pricing_drift?: PricingDrift;
      legacy_echo?: RetentionFrame;
      legacy_echo_at?: string;
      component_violation?: boolean;
      returned_model?: string;
      actual_usd?: number | null;
      usage?: unknown;
      settled_at?: string;
      settled_sequence?: number;
      bound_violation?: { reserved_usd: number; actual_usd: number };
    }
  >();
  let previous = "0".repeat(64),
    sequence = 0;
  if (fs.existsSync(file)) {
    const bytes = read(file).toString();
    requireThat(bytes.endsWith("\n"), "CAMPAIGN_PARTIAL_LEDGER");
    for (const line of bytes.trimEnd().split("\n")) {
      const frame = JSON.parse(line);
      requireThat(
        frame.sequence === ++sequence &&
          frame.previous === previous &&
          frame.hash === sha(JSON.stringify(frame.event) + previous + sequence),
        "CAMPAIGN_CORRUPT_LEDGER",
      );
      previous = frame.hash;
      const event = frame.event as Event;
      if (event.type === "RESERVE") {
        requireThat(
          !entries.has(event.attempt.id) &&
            Number.isFinite(event.attempt.reserved_usd) &&
            event.attempt.reserved_usd >= 0,
          "CAMPAIGN_INVALID_RESERVATION",
        );
        entries.set(event.attempt.id, {
          attempt: event.attempt,
          settled: false,
          charged_usd: event.attempt.reserved_usd,
        });
      } else if (event.type === "LEGACY_ECHO") {
        const item = entries.get(event.id);
        requireThat(item, "STAGE_B_ECHO_BINDING");
        bindEcho(item, event.witness, event.at);
      } else if (event.type === "PRICING_DRIFT") {
        const item = entries.get(event.id);
        requireThat(
          item?.attempt.physical &&
            !item.settled &&
            !item.pricing_drift &&
            ["SERVICE_TIER", "CACHE_RETENTION", "CACHE_WRITE_12H"].includes(
              event.reason,
            ),
          "STAGE_B_DRIFT_EVENT_INVALID",
        );
        if (event.first_legacy_echo)
          bindEcho(item, event.first_legacy_echo, event.at);
        validateTierDrift(
          event.reason,
          item.attempt.physical.requested_service_tier,
          event,
        );
        validateCacheDrift(
          item.attempt.physical.cache_retention_contract,
          event.reason,
          event,
          item.legacy_echo,
        );
        item.pricing_drift = {
          ...(event.echo_stop ? { echo_stop: event.echo_stop } : {}),
          ...(event.conflicting_frame
            ? { conflicting_frame: event.conflicting_frame }
            : {}),
          ...(event.cache_retention
            ? { cache_retention: event.cache_retention }
            : {}),
          reason: event.reason,
          at: event.at,
          ...(event.requested_tier
            ? {
                requested_tier: event.requested_tier,
                observed_tier: event.observed_tier,
              }
            : {}),
        };
        item.outcome = "PROVENANCE_CHANGE";
      } else {
        requireThat(event.type === "SETTLE", "CAMPAIGN_UNKNOWN_EVENT");
        const item = entries.get(event.id);
        requireThat(item && !item.settled, "CAMPAIGN_INVALID_SETTLEMENT");
        requireThat(
          event.actual_usd === null ||
            (Number.isFinite(event.actual_usd) && event.actual_usd >= 0),
          "CAMPAIGN_INVALID_COST",
        );
        validateTerminalCache(
          item.attempt.physical,
          event.usage,
          event.actual_usd,
          item.pricing_drift,
          item.legacy_echo,
        );
        item.settled = true;
        item.charged_usd = event.actual_usd ?? item.attempt.reserved_usd;
        item.outcome = event.outcome;
        item.actual_usd = event.actual_usd;
        item.usage = event.usage;
        item.settled_at = event.at;
        item.settled_sequence = sequence;
        if (item.attempt.physical) {
          const details = event.usage as {
            provider?: unknown;
            returned_model?: string;
          } | null;
          item.component_violation = physicalViolation(
            item.attempt.physical,
            details?.provider,
          );
          item.returned_model = details?.returned_model;
        }
        if (
          event.actual_usd !== null &&
          event.actual_usd > item.attempt.reserved_usd
        )
          item.bound_violation = {
            reserved_usd: item.attempt.reserved_usd,
            actual_usd: event.actual_usd,
          };
      }
    }
  }
  return {
    entries,
    previous,
    sequence,
    charged_usd: [...entries.values()].reduce(
      (sum, v) => sum + v.charged_usd,
      0,
    ),
  };
}
function append(root: string, event: Event) {
  const { previous, sequence } = ledger(root);
  appendJSON(path.join(directory(root), "attempts.jsonl"), {
    sequence: sequence + 1,
    previous,
    event,
    hash: sha(JSON.stringify(event) + previous + (sequence + 1)),
  });
}
export async function createCampaign(
  root: string,
  approvalID: string,
  ceiling: number | null | undefined,
  baselineLimits?: BaselineLimits,
  physicalPolicy?: PhysicalPolicy,
) {
  if (baselineLimits) validateBaselineLimits(baselineLimits, ceiling ?? null);
  if (physicalPolicy) {
    validatePhysical(physicalPolicy);
    requireThat(
      ceiling === undefined && baselineLimits === undefined,
      "STAGE_B_MIXED_POLICY",
    );
  }
  requireThat(
    /^[a-zA-Z0-9_-]{1,100}$/.test(approvalID),
    "CAMPAIGN_APPROVAL_ID",
  );
  requireThat(
    (physicalPolicy && ceiling === undefined) ||
      ceiling === null ||
      (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling > 0),
    "CAMPAIGN_INVALID_CEILING",
  );
  const source = fingerprint();
  // A new facility cannot reset the same approval's ceiling.
  const registry = path.join(repository, ".local/benchmark/.campaign-registry");
  return locked(registry, async () => {
    const registration = path.join(registry, approvalID + ".json");
    requireThat(
      !fs.existsSync(registration),
      "CAMPAIGN_APPROVAL_ALREADY_BOUND",
    );
    requireThat(
      !fs.existsSync(path.join(directory(root), "manifest.json")),
      "CAMPAIGN_EXISTS",
    );
    const c: Campaign = {
      version: 1,
      source,
      approval_id: approvalID,
      facility: root,
      state: "OPEN",
      ...(physicalPolicy
        ? { physical_policy: physicalPolicy }
        : { ceiling_usd: ceiling }),
      created_at: new Date().toISOString(),
      ...(baselineLimits ? { baseline_limits: baselineLimits } : {}),
    };
    // A crash after binding fails closed; never silently rebind to a different root.
    writeJSON(registration, c);
    writeJSON(path.join(directory(root), "manifest.json"), c);
    return c;
  });
}
export function assertCampaignSource(root: string) {
  const c = loadCampaign(root);
  const registryFile = path.join(
    repository,
    ".local/benchmark/.campaign-registry",
    c.approval_id + ".json",
  );
  if (
    c.physical_policy ||
    fs.existsSync(path.join(directory(root), "stage-b-dispatch.json")) ||
    fs.existsSync(registryFile)
  ) {
    const registration = readJSON(registryFile);
    requireThat(
      registration.facility === root &&
        JSON.stringify(registration.physical_policy) ===
          JSON.stringify(c.physical_policy) &&
        (!fs.existsSync(path.join(directory(root), "stage-b-dispatch.json")) ||
          !!c.physical_policy),
      "CAMPAIGN_REGISTRY_MISMATCH",
    );
  }
  requireThat(c.state === "OPEN", "CAMPAIGN_CLOSED");
  requireThat(
    c.source && JSON.stringify(c.source) === JSON.stringify(fingerprint()),
    "CAMPAIGN_SOURCE_CHANGED",
  );
  return c;
}
export async function reserve(
  root: string,
  details: Omit<Attempt, "id" | "at" | "pid">,
  maxSends?: number,
) {
  return locked(directory(root), async () => {
    const campaign = assertCampaignSource(root),
      current = ledger(root);
    if (campaign.physical_policy || details.physical) {
      const policy = campaign.physical_policy,
        bound = details.physical;
      requireThat(
        policy && bound && details.lane && details.episode,
        "STAGE_B_PHYSICAL_REQUIRED",
      );
      const active = readJSON(
        path.join(directory(root), "active-stage-b.json"),
      );
      requireThat(
        active.lane === details.lane &&
          active.episode === details.episode &&
          active.model === details.model &&
          active.freeze_sha256 === policy.freeze_sha256 &&
          active.state === "OPEN",
        "STAGE_B_LANE_NOT_ACTIVE",
      );
      const model = details.model as StageModel;
      requireThat(
        JSON.stringify(
          physicalBound(
            policy,
            model,
            bound.input_bytes,
            bound.requested_output,
            bound.role,
          ),
        ) === JSON.stringify(bound),
        "STAGE_B_PHYSICAL_CHANGED",
      );
      const entries = [...current.entries.values()];
      requireThat(
        !entries.some((entry) => entry.component_violation),
        "STAGE_B_BOUND_VIOLATION",
      );
      requireThat(
        !entries.some(
          (entry) =>
            entry.outcome === "PROVENANCE_CHANGE" ||
            (entry.legacy_echo &&
              !entry.settled &&
              entry.attempt.lane !== details.lane),
        ),
        "STAGE_B_PROVENANCE_CHANGE",
      );
      requireThat(
        !entries.some(
          (entry) =>
            entry.attempt.model === model &&
            entry.outcome === "VERSION_TRANSITION",
        ),
        "STAGE_B_VERSION_HOLD",
      );
      requireThat(
        !entries.some(
          (entry) =>
            entry.attempt.model === model &&
            ["IDENTITY_MISMATCH_FIRST_CONTACT", "IDENTITY_UNKNOWN"].includes(
              entry.outcome ?? "",
            ),
        ),
        "STAGE_B_IDENTITY_HOLD",
      );
      const dispatch = readJSON(
        path.join(directory(root), "stage-b-dispatch.json"),
      );
      requireThat(
        !dispatch.ended &&
          dispatch.freeze_sha256 === policy.freeze_sha256 &&
          !dispatch.terminals[details.lane] &&
          !dispatch.probes[details.lane],
        "STAGE_B_LANE_NOT_ACTIVE",
      );
      requireThat(
        !entries.some(
          (entry) =>
            model !== "deepseek-flash" &&
            entry.attempt.model === model &&
            entry.outcome === "EXHAUSTED_QUOTA",
        ),
        "STAGE_B_ACCOUNT_BLOCKED",
      );
      requireThat(
        !entries.some(
          (entry) =>
            entry.attempt.model === "deepseek-flash" &&
            ["EXHAUSTED_QUOTA", "AUTH"].includes(entry.outcome ?? "") &&
            !dispatch.repairs[entry.attempt.id],
        ),
        "STAGE_B_PRIMARY_BLOCKED",
      );
      requireThat(
        !entries.some(
          (entry) =>
            entry.attempt.lane === details.lane &&
            ["EXHAUSTED_QUOTA", "AUTH"].includes(entry.outcome ?? ""),
        ),
        "STAGE_B_LANE_FAILED",
      );
      checkAdmission(
        policy,
        entries.map((entry) => entry.attempt),
        details.lane,
        model,
        details.episode,
        Date.now(),
      );
    }
    if (campaign.baseline_limits) {
      requireThat(
        ![...current.entries.values()].some((e) => e.bound_violation),
        "BASELINE_RESERVATION_BOUND_VIOLATED",
      );
      assertBaselineReservation(
        campaign.baseline_limits,
        [...current.entries.values()],
        details,
        Date.now(),
      );
    }
    requireThat(campaign.state === "OPEN", "CAMPAIGN_CLOSED");
    if (maxSends !== undefined)
      requireThat(
        [...current.entries.values()].filter(
          (v) =>
            (v.attempt.episode ?? v.attempt.run) ===
            (details.episode ?? details.run),
        ).length < maxSends,
        "EPISODE_SEND_LIMIT",
      );
    requireThat(
      Number.isFinite(details.reserved_usd) && details.reserved_usd >= 0,
      "CAMPAIGN_INVALID_RESERVATION",
    );
    requireThat(
      campaign.physical_policy ||
        campaign.ceiling_usd == null ||
        current.charged_usd + details.reserved_usd <= campaign.ceiling_usd,
      "CAMPAIGN_BUDGET_EXHAUSTED",
    );
    const attempt: Attempt = {
      ...details,
      id: randomUUID(),
      at: new Date().toISOString(),
      pid: process.pid,
    };
    append(root, { type: "RESERVE", attempt });
    return attempt.id;
  });
}
function bindEcho(
  item: {
    attempt: Attempt;
    settled: boolean;
    legacy_echo?: RetentionFrame;
    legacy_echo_at?: string;
  },
  witness: RetentionFrame,
  at: string,
) {
  requireThat(
    item.attempt.physical?.cache_retention_contract === echoContract &&
      !item.settled &&
      !item.legacy_echo &&
      Number.isFinite(Date.parse(at)),
    "STAGE_B_ECHO_BINDING",
  );
  validateRetentionFrame(witness, "WITNESS");
  requireThat(echoScope(witness), "STAGE_B_ECHO_WITNESS_INVALID");
  item.legacy_echo = witness;
  item.legacy_echo_at = at;
}
export async function recordLegacyEcho(
  root: string,
  id: string,
  witness: RetentionFrame,
) {
  await locked(directory(root), async () => {
    const item = ledger(root).entries.get(id);
    requireThat(item, "STAGE_B_ECHO_BINDING");
    const at = new Date().toISOString();
    bindEcho(item, witness, at);
    append(root, { type: "LEGACY_ECHO", id, at, witness });
  });
}
export async function closePendingEchoes(root: string, lane: string) {
  await locked(directory(root), async () => {
    for (const [id, item] of ledger(root).entries) {
      if (
        item.attempt.lane === lane &&
        item.legacy_echo &&
        !item.pricing_drift &&
        !item.settled
      )
        append(root, {
          type: "PRICING_DRIFT",
          id,
          reason: "CACHE_RETENTION",
          at: new Date().toISOString(),
          echo_stop: "ORPHANED_AT_BOUNDARY",
          cache_retention: echoObservation(item.legacy_echo),
        });
    }
  });
}
export async function recordPricingDrift(
  root: string,
  id: string,
  reason: string,
  observation?: DriftObservation,
) {
  await locked(directory(root), async () => {
    const item = ledger(root).entries.get(id);
    requireThat(
      item?.attempt.physical && !item.settled,
      "STAGE_B_DRIFT_EVENT_INVALID",
    );
    const at = new Date().toISOString();
    if (observation?.first_legacy_echo)
      bindEcho(item, observation.first_legacy_echo, at);
    validateTierDrift(
      reason,
      item.attempt.physical.requested_service_tier,
      observation ?? {},
    );
    validateCacheDrift(
      item.attempt.physical.cache_retention_contract,
      reason,
      observation ?? {},
      item.legacy_echo,
    );
    if (!item.pricing_drift)
      append(root, {
        type: "PRICING_DRIFT",
        id,
        reason,
        ...observation,
        at,
      });
  });
}
export async function settle(
  root: string,
  id: string,
  outcome: string,
  usage: unknown,
  actualUSD: number | null,
) {
  return locked(directory(root), async () => {
    const campaign = loadCampaign(root);
    requireThat(campaign.state === "OPEN", "CAMPAIGN_CLOSED");
    const { entries } = ledger(root);
    const item = entries.get(id);
    requireThat(item && !item.settled, "CAMPAIGN_INVALID_SETTLEMENT");
    requireThat(
      actualUSD === null || (Number.isFinite(actualUSD) && actualUSD >= 0),
      "CAMPAIGN_INVALID_COST",
    );
    if (item.pricing_drift) {
      if (
        usage &&
        typeof usage === "object" &&
        "legacy_echo_disposition" in usage
      ) {
        const { legacy_echo_disposition, ...rest } = usage;
        usage = rest;
      }
      outcome = "PROVENANCE_CHANGE";
      actualUSD = null;
    }
    // Compare under the same lease that commits SETTLE. Workers can finish in a
    // different order than they reserved, including Main/Task on the same lane.
    if (
      item.attempt.physical &&
      (outcome === "RESPONSE_COMPLETE" ||
        (usage && typeof usage === "object" && "returned_model" in usage))
    ) {
      const details = usage as {
        observed_models?: string[];
        returned_model?: string;
      } | null;
      const observedModels =
        details?.observed_models ??
        (details?.returned_model ? [details.returned_model] : []);
      const allow =
        campaign.physical_policy!.providers[item.attempt.model as StageModel]
          .allowed_returned_models;
      const prior = [...entries.values()]
        .filter(
          (e) =>
            e.attempt.model === item.attempt.model &&
            e.settled &&
            e.returned_model &&
            allow.includes(e.returned_model) &&
            e.outcome !== "IDENTITY_MISMATCH_FIRST_CONTACT" &&
            e.outcome !== "VERSION_TRANSITION",
        )
        .sort((a, b) => a.settled_sequence! - b.settled_sequence!)[0];
      const identity = returnedIdentity(
        allow,
        prior?.returned_model,
        observedModels,
      );
      usage = { ...(usage as object), identity_status: identity };
      if (
        outcome !== "PROVENANCE_CHANGE" &&
        (identity === "VERSION_TRANSITION" ||
          identity === "IDENTITY_MISMATCH_FIRST_CONTACT" ||
          (outcome === "RESPONSE_COMPLETE" && identity === "IDENTITY_UNKNOWN"))
      )
        outcome = identity;
    }
    validateTerminalCache(
      item.attempt.physical,
      usage,
      actualUSD,
      item.pricing_drift,
      item.legacy_echo,
    );
    append(root, {
      type: "SETTLE",
      id,
      at: new Date().toISOString(),
      actual_usd: actualUSD,
      outcome,
      usage,
      ...(actualUSD !== null && actualUSD > item.attempt.reserved_usd
        ? {
            bound_violation: {
              reserved_usd: item.attempt.reserved_usd,
              actual_usd: actualUSD,
            },
          }
        : {}),
    });
  });
}
export async function closeCampaign(root: string): Promise<ClosedCampaign> {
  return locked(directory(root), async () => {
    const c = loadCampaign(root);
    if (c.state === "CLOSED" && c.final_ledger) {
      assertCampaignClosed(root);
      requireThat(
        typeof c.closed_at === "string" &&
          Number.isFinite(Date.parse(c.closed_at)),
        "CAMPAIGN_CLOSURE_INVALID",
      );
      return c as ClosedCampaign;
    }
    // Never discard orphan reservations: uncertain sends remain charged at full cost.
    const current = ledger(root);
    const closed = {
      ...c,
      state: "CLOSED" as const,
      closed_at: new Date().toISOString(),
      final_ledger: {
        hash: current.previous,
        sequence: current.sequence,
        attempts: current.entries.size,
        unsettled: [...current.entries.values()].filter((e) => !e.settled)
          .length,
        charged_usd: current.charged_usd,
      },
    };
    const registry = path.join(
      repository,
      ".local/benchmark/.campaign-registry",
    );
    const registration = path.join(registry, c.approval_id + ".json");
    if (fs.existsSync(registration))
      await locked(registry, async () => {
        const registered = readJSON(registration);
        requireThat(
          registered.facility === root &&
            registered.approval_id === c.approval_id,
          "CAMPAIGN_REGISTRY_MISMATCH",
        );
        writeJSON(registration, closed);
      });
    writeJSON(path.join(directory(root), "manifest.json"), closed);
    return closed;
  });
}
export function assertCampaignClosed(root: string) {
  if (fs.existsSync(path.join(directory(root), "manifest.json"))) {
    const c = loadCampaign(root);
    requireThat(c.state === "CLOSED", "CAMPAIGN_OPEN");
    const current = ledger(root),
      final = c.final_ledger;
    if (final)
      requireThat(
        final.hash === current.previous &&
          final.sequence === current.sequence &&
          final.attempts === current.entries.size &&
          final.charged_usd === current.charged_usd &&
          final.unsettled ===
            [...current.entries.values()].filter((e) => !e.settled).length,
        "CAMPAIGN_FINAL_LEDGER_CHANGED",
      );
  }
}
