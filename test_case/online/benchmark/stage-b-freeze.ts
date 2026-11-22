import { echoContract, echoPriceBasis } from "./stage-b-retention.ts";
import path from "node:path";
import fs from "node:fs";
import { read, readJSON, writeJSON, requireThat, sha } from "./io.ts";
import { pricingEvidence } from "./stage-b-pricing-source.ts";
import { b0Matrix } from "./baseline-b0.ts";
import {
  prepareTierSamples,
  verifyTierSamples,
} from "./stage-b-tier-samples.ts";
import { descriptor } from "./live-model.ts";
import {
  stageModels,
  stageSlots,
  validatePhysical,
  physicalBound,
  reservationUSD,
  type StageModel,
  type PhysicalPolicy,
  type ProviderRule,
} from "./stage-b-policy.ts";
import { fingerprint } from "./source.ts";
import { fillerTexts, type TimelineStep } from "./baseline-timeline.ts";
import { maintenancePolicy } from "./baseline.ts";
import { calibrationReceipt } from "./stage-b-report-calibration.ts";

import {
  checkCaptureFile,
  usesCapturedSchedule,
  retentionEvidence,
  requireCapturedRetention,
  type SourcePage,
} from "./stage-b-capture.ts";
type Forecast = {
  ordinary_sends_per_turn: number;
  extra_task_sends: number;
  sends_per_maintenance: number;
  seconds_per_send: number;
  restart_seconds: number;
  observation_seconds: number;
  expected_input_tokens: number;
  expected_output_tokens: number;
};
type Inputs = {
  c16_decision: "DISPATCH" | "DEFERRED_BY_DECISION";
  descriptors: Record<
    StageModel,
    { context_window: number; max_output_tokens: number; source_sha256: string }
  >;
  providers: Record<StageModel, ProviderRule>;
  sources: Record<StageModel, SourcePage[]>;
  forecast: Record<StageModel, Forecast>;
  calibration_packet_sha256: string;
  calibration_key_sha256: string;
};
const digest = (value: unknown) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const freezeFile = (root: string) =>
  path.join(root, "configs", "stage-b-freeze.json");
type ForecastCapacity = {
  budget: {
    estimated_tokens: number;
    usable_input_tokens: number;
    occupancy: number;
  };
  effective_policy: { target: number; normal: number; forced: number };
};
type Retention = "BRIEF_INDEXED" | "ECHO_INDEXED" | "ECHO_ANCHORED";

/** Conditional workload through the last step, even when admission would stop it earlier.
 * 873b66f memory-maintenance.ts:memoryDue uses the last job UPDATE (completion on this
 * successful path). A job cannot generate new handled turns while it runs.
 * main-loop.ts:prepare and maintainIfNeeded also check pressure independently of that
 * interval. context-assembly.ts:crop itself commits a local projection without a send. */
function forecastPath(
  steps: TimelineStep[],
  factors: Forecast,
  capacity: ForecastCapacity | undefined,
  retention: Retention,
) {
  const { turn_trigger, oldest_uncovered_seconds, min_interval_seconds } =
    maintenancePolicy;
  const base = capacity?.budget.estimated_tokens ?? 0,
    usable = capacity?.budget.usable_input_tokens ?? Infinity;
  let resident = base,
    anchors = base,
    peak = base;
  let seconds = 0,
    turns = 0,
    pending = 0,
    oldest = 0,
    lastCommit = -Infinity;
  let scheduled = 0,
    pressureJobs = 0,
    crops = 0,
    forcedCrops = 0,
    pressureChecks = 0;
  let boundaryWait = 0;
  function summarize(pressure: boolean) {
    if (!pending) return;
    if (pressure) pressureJobs++;
    else scheduled++;
    seconds += factors.sends_per_maintenance * factors.seconds_per_send;
    lastCommit = seconds;
    pending = 0;
  }
  function pressure() {
    peak = Math.max(peak, resident);
    if (!capacity || resident < usable * capacity.effective_policy.normal)
      return;
    pressureChecks++;
    summarize(true);
    // Indexed replay can drop covered inputs. When search is behind, mandatory
    // original inputs without an earlier projection receipt remain resident.
    const after = Math.max(usable * capacity.effective_policy.target, anchors);
    if (after >= resident) return;
    if (resident >= usable * capacity.effective_policy.forced) forcedCrops++;
    crops++;
    resident = after;
    seconds += factors.observation_seconds; // local work latency proxy only
  }
  function dueAt() {
    return Math.max(
      lastCommit + min_interval_seconds,
      pending >= turn_trigger ? seconds : oldest + oldest_uncovered_seconds,
    );
  }
  function turn(text: string) {
    const bytes = Buffer.byteLength(JSON.stringify(text));
    // budget.ts:requestBudget counts serialized UTF-8 plus 32 per message.
    // Shapes, tool messages and generated content are unknown at freeze.
    const userBytes = bytes + 32;
    resident += userBytes;
    if (retention === "ECHO_ANCHORED") anchors += userBytes;
    pressure(); // before request: only earlier HANDLED inputs can be covered
    const sends =
      Math.ceil((turns + 1) * factors.ordinary_sends_per_turn) -
      Math.ceil(turns * factors.ordinary_sends_per_turn);
    turns++;
    seconds += sends * factors.seconds_per_send;
    resident +=
      32 * sends +
      (retention === "BRIEF_INDEXED" ? Buffer.byteLength("Received.") : bytes);
    if (!pending) oldest = seconds;
    pending++;
    // At an idle opportunity pressure and the ordinary predicate coalesce into
    // one covering job. A later poll with no new work cannot create another.
    if (seconds >= dueAt()) summarize(false);
    pressure();
  }
  for (const [index, step] of steps.entries()) {
    if (step.filler) for (const text of fillerTexts(step.filler)) turn(text);
    else if (step.action === "MASTER_MESSAGE") turn(step.text ?? "");
    else if (step.action === "MASTER_TASK")
      seconds += factors.extra_task_sends * factors.seconds_per_send;
    else if (step.action === "DIRECT_RESTART")
      seconds += factors.restart_seconds;
    else if (step.action === "OBSERVE") seconds += factors.observation_seconds;
    else if (step.action === "IDLE_WAIT") {
      const end = seconds + (step.seconds ?? 0);
      // The following OBSERVE waits for coverage of the last filler. A commit
      // already covering it satisfies the boundary without a second job.
      const needed = steps[index + 1]?.action === "OBSERVE";
      if (pending && (dueAt() <= end || needed)) {
        seconds = Math.max(seconds, dueAt());
        summarize(false);
        boundaryWait += Math.max(0, seconds - end);
      }
      seconds = Math.max(seconds, end);
    }
  }
  const jobs = scheduled + pressureJobs;
  const tasks = steps.filter((s) => s.action === "MASTER_TASK").length;
  return {
    retention,
    turns,
    tasks,
    ordinary_jobs: jobs,
    cadence_jobs: scheduled,
    pressure_jobs: pressureJobs,
    context_compactions: crops,
    forced_band_compactions: forcedCrops,
    pressure_checks: pressureChecks,
    context_crop_sends: 0,
    peak_occupancy: capacity ? peak / usable : null,
    capacity_risk: capacity ? peak >= usable : null,
    boundary_wait_beyond_idle_seconds: Math.ceil(boundaryWait),
    sends: Math.ceil(
      turns * factors.ordinary_sends_per_turn +
        tasks * factors.extra_task_sends +
        jobs * factors.sends_per_maintenance,
    ),
    seconds: Math.ceil(seconds),
  };
}
export function forecastLane(
  steps: TimelineStep[],
  rule: ProviderRule,
  factors: Forecast,
  cap: number,
  capacity?: ForecastCapacity,
) {
  requireThat(
    Object.keys(factors).sort().join(",") ===
      "expected_input_tokens,expected_output_tokens,extra_task_sends,observation_seconds,ordinary_sends_per_turn,restart_seconds,seconds_per_send,sends_per_maintenance" &&
      Object.values(factors).every(
        (value) => Number.isFinite(value) && value >= 0,
      ) &&
      factors.ordinary_sends_per_turn >= 1 &&
      factors.sends_per_maintenance >= 1 &&
      factors.seconds_per_send > 0 &&
      factors.expected_input_tokens <= rule.max_input_bytes &&
      factors.expected_output_tokens <=
        (rule.billed_output === "REQUEST_CAP"
          ? rule.max_requested_output
          : rule.billed_output),
    "STAGE_B_FORECAST_INVALID",
  );
  requireThat(
    !steps.some((s) => s.filler) || capacity,
    "STAGE_B_FORECAST_B0_REQUIRED",
  );
  if (capacity) {
    const { budget, effective_policy: p } = capacity;
    requireThat(
      Number.isSafeInteger(budget.estimated_tokens) &&
        budget.estimated_tokens > 0 &&
        Number.isSafeInteger(budget.usable_input_tokens) &&
        budget.usable_input_tokens > 0 &&
        Math.abs(
          budget.estimated_tokens / budget.usable_input_tokens -
            budget.occupancy,
        ) < 1e-8 &&
        p.target > 0 &&
        p.target < p.normal &&
        p.normal < p.forced &&
        p.forced <= 1,
      "STAGE_B_FORECAST_CAPACITY_INVALID",
    );
  }
  const paths = (
    ["BRIEF_INDEXED", "ECHO_INDEXED", "ECHO_ANCHORED"] as const
  ).map((retention) => forecastPath(steps, factors, capacity, retention));
  const interval = (
    key:
      | "sends"
      | "seconds"
      | "ordinary_jobs"
      | "context_compactions"
      | "forced_band_compactions",
  ) => {
    const values = paths.map((p) => p[key]);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const limit = (r: { min: number; max: number }, cap: number) =>
    r.min > cap ? "ABOVE" : r.max > cap ? "STRADDLES" : "WITHIN";
  const sends = interval("sends"),
    seconds = interval("seconds");
  const range = {
    sends,
    seconds,
    ordinary_jobs: interval("ordinary_jobs"),
    context_compactions: interval("context_compactions"),
    forced_band_compactions: interval("forced_band_compactions"),
    send_cap: cap,
    seconds_cap: 3600,
    send_limit: limit(sends, cap),
    time_limit: limit(seconds, 3600),
  };
  const {
    turns,
    tasks,
    ordinary_jobs: cycles,
    sends: expected_sends,
    seconds: expected_seconds,
  } = paths[1];
  const boundOutput =
    rule.billed_output === "REQUEST_CAP"
      ? rule.max_requested_output
      : rule.billed_output;
  return {
    turns,
    cycles,
    tasks,
    expected_sends,
    expected_seconds,
    paths,
    range,
    basis: {
      pricing:
        "Expected cost assumes ordinary input with zero cache reads or writes.",
      source:
        "873b66f memory-maintenance.ts:memoryDue/maintainIfNeeded; main-loop.ts:prepare; context-projection.ts:buildCompaction; input-projection.ts:selectInputProjection",
      turn_trigger: maintenancePolicy.turn_trigger,
      oldest_seconds: maintenancePolicy.oldest_uncovered_seconds,
      interval_after_commit_seconds: maintenancePolicy.min_interval_seconds,
      b0_initial_occupancy: capacity?.budget.occupancy ?? null,
      projection:
        "One handled input per ordinary turn. Indexed cases assume a successful crop to target and either a brief acknowledgement or one input-sized reply. Anchored stress keeps original inputs when search lags. Peak demand can exceed capacity.",
      timing:
        "Serial send latency, one observation-latency allowance per local crop, overlap during explicit idle waits. The per-job send factor includes summary segments and extraction. Task traffic uses the task allowance.",
      limitation:
        "Illustrative paths, not probability or completion bounds. Tool traffic, critical feedback, retries, coverage/search readiness, protected tails, stalls and provider latency can change counts or prevent completion.",
    },
    over_lane_limits:
      range.send_limit !== "WITHIN" || range.time_limit !== "WITHIN",
    expected_usd:
      ((factors.expected_input_tokens * rule.input_rate +
        factors.expected_output_tokens * rule.output_rate) *
        Math.min(expected_sends, cap)) /
      1e6,
    worst_usd: reservationUSD(rule, rule.max_input_bytes, boundOutput, cap),
  };
}
export function validateDescriptor(
  model: StageModel,
  limits: Inputs["descriptors"][StageModel],
  rule: ProviderRule,
  pages: SourcePage[],
) {
  const actual = descriptor(model);
  requireThat(
    limits.context_window === actual.contextWindow &&
      Number.isSafeInteger(limits.max_output_tokens) &&
      actual.maxTokens <= limits.max_output_tokens &&
      rule.max_requested_output <= actual.maxTokens &&
      rule.context_upper_tokens <= limits.context_window &&
      (model !== "deepseek-flash" ||
        (typeof rule.billed_output === "number" &&
          rule.billed_output >= limits.max_output_tokens)) &&
      digest(limits.source_sha256) &&
      pages.some((page) => page.sha256 === limits.source_sha256),
    "STAGE_B_DESCRIPTOR_DRIFT",
  );
}
/** The approved B0 archive is private. Authenticate its bytes before parsing them. */
export const reviewedB0Receipt = {
  read(root: string) {
    const bytes = read(path.join(root, "configs", "issue122-b0.json"));
    const b0_sha256 = sha(bytes);
    requireThat(
      b0_sha256 ===
        "0a8b6acf24b449a5961987e3b82af17d0f5716edeff3639a0e651a2336af26a1",
      "STAGE_B_B0_RECEIPT_CHANGED",
    );
    return { b0: JSON.parse(bytes.toString("utf8")), b0_sha256 };
  },
};
export function buildFreeze(root: string) {
  const config = path.join(root, "configs");
  const inputs: Inputs = readJSON(path.join(config, "stage-b-inputs.json"));
  requireThat(
    Object.keys(inputs).sort().join(",") ===
      "c16_decision,calibration_key_sha256,calibration_packet_sha256,descriptors,forecast,providers,sources" &&
      ["DISPATCH", "DEFERRED_BY_DECISION"].includes(inputs.c16_decision) &&
      [inputs.descriptors, inputs.forecast, inputs.sources].every(
        (group) =>
          Object.keys(group).sort().join(",") ===
          [...stageModels].sort().join(","),
      ),
    "STAGE_B_DOSSIER_KEYS",
  );
  const { b0, b0_sha256 } = reviewedB0Receipt.read(root);
  const source = fingerprint();
  requireThat(
    b0.schema === "issue122-b0-v1" &&
      b0.source.sut.commit === source.sut.commit &&
      b0.slots.length === 12,
    "STAGE_B_B0_INVALID",
  );
  const providers = inputs.providers;
  const policy: PhysicalPolicy = {
    schema: "issue122-physical-v3",
    freeze_sha256: "f".repeat(64),
    providers,
  };
  validatePhysical(policy);
  const retentionDigest = retentionEvidence(root, providers["gpt-6-luna"]);
  const explicit = !!providers["gpt-6-luna"].request_service_tier;
  const tierSamples = explicit
    ? verifyTierSamples(root, policy, source)
    : undefined;
  const captured = stageModels.filter((model) =>
    inputs.sources[model]?.some(
      (page) =>
        page.representation !== undefined || page.review_sha256 !== undefined,
    ),
  );
  requireThat(
    !captured.length ||
      (captured.length === 2 && !captured.includes("deepseek-flash")),
    "STAGE_B_SOURCE_CAPTURE_SCOPE",
  );
  const verifiedFacts: Partial<
    Record<StageModel, ReturnType<typeof pricingEvidence>>
  > = {};
  for (const model of stageModels) {
    const pages = inputs.sources[model];
    validateDescriptor(
      model,
      inputs.descriptors[model],
      inputs.providers[model],
      pages,
    );
    requireThat(
      Array.isArray(pages) &&
        pages.length >= 2 &&
        pages.some((page) => page.url === providers[model].publication_url) &&
        pages.every(
          (page) =>
            digest(page.sha256) &&
            new Set([
              "api-docs.deepseek.com",
              "openai.com",
              "developers.openai.com",
              "platform.openai.com",
            ]).has(new URL(page.url).hostname) &&
            new URL(page.url).protocol === "https:" &&
            !new URL(page.url).username &&
            !new URL(page.url).password &&
            !new URL(page.url).port &&
            (new URL(page.url).hostname === "api-docs.deepseek.com") ===
              (model === "deepseek-flash"),
        ) &&
        sha(JSON.stringify(pages)) === providers[model].provenance_sha256,
      "STAGE_B_SOURCE_DOSSIER",
    );
    if (model !== "deepseek-flash")
      verifiedFacts[model] = pricingEvidence(
        root,
        model,
        providers[model],
        inputs.descriptors[model],
        pages,
      );
    else
      requireThat(
        typeof providers[model].billed_output === "number",
        "STAGE_B_REASONING_BOUND_REQUIRED",
      );
  }
  requireThat(
    digest(inputs.calibration_packet_sha256) &&
      digest(inputs.calibration_key_sha256) &&
      inputs.calibration_key_sha256 !== inputs.calibration_packet_sha256,
    "STAGE_B_CALIBRATION_REQUIRED",
  );
  const calibration = calibrationReceipt(root);
  requireThat(
    calibration?.packet_sha256 === inputs.calibration_packet_sha256 &&
      calibration?.private_key_sha256 === inputs.calibration_key_sha256,
    "STAGE_B_CALIBRATION_CHANGED",
  );
  const capacities = b0.slots
    .slice(0, 3)
    .flatMap((slot: any) =>
      slot.profiles.map((profile: any) => profile.capacity),
    );
  const matrix = b0Matrix(capacities);
  const worklist = stageSlots.map((slot, index) => {
    const row = matrix[index];
    const profile = row.profiles.find(
      (p) =>
        p.capacity.profile ===
        (slot.profile === "DEP" ? "DEP" : "RC98304_CANDIDATE"),
    );
    requireThat(
      profile?.timeline &&
        profile.input_sha256 &&
        row.model === slot.model &&
        row.id === slot.scenario,
      "STAGE_B_FROZEN_SLOT_MISSING",
    );
    if (slot.profile === "RC98304")
      requireThat(
        profile.input_sha256 ===
          "b168c74ec201d218840d89894bfc8a1dd53e97bd1f0b64eeb235435b34b87f2a" &&
          sha(JSON.stringify(profile.timeline)) ===
            "07351d6bff4e8bdd40f13348b1cff892835cad8c71acc62bca7ddcdf67ec7662" &&
          row.oracle_sha256 ===
            "445e9ef740dad7ea8d7b2625d4e161be19ab5996606443dca9883e7dc24e0d19",
        "STAGE_B_C16_CANDIDATE_DRIFT",
      );
    const model = descriptor(slot.model);
    const role = {
      adapter_output_cap: model.maxTokens,
      provider: model.provider,
      endpoint:
        model.baseUrl +
        (model.api === "openai-responses" ? "/responses" : "/chat/completions"),
      model: model.id,
      ...(providers[slot.model].request_service_tier
        ? { request_service_tier: providers[slot.model].request_service_tier }
        : {}),
    };
    const sample = b0.serialized_samples.requests.find(
      (r: { model: string }) => r.model === slot.model,
    );
    requireThat(
      sample && sample.endpoint === role.endpoint && digest(sample.sha256),
      "STAGE_B_B0_BODY_SAMPLE",
    );
    physicalBound(policy, slot.model, sample.bytes, sample.output_cap, "main");
    return {
      ...slot,
      representative_body: {
        source: explicit ? "Historical B0 C05-W Main" : "B0 C05-W Main",
        ...sample,
        max_input_bytes: providers[slot.model].max_input_bytes,
        future_body_sizes: "UNKNOWN",
      },
      input_sha256: profile.input_sha256,
      oracle_sha256: row.oracle_sha256,
      timeline: profile.timeline,
      timeline_sha256: sha(JSON.stringify(profile.timeline)),
      capacity: profile.capacity,
      roles: { main: role, task: role },
      forecast: forecastLane(
        profile.timeline,
        providers[slot.model],
        inputs.forecast[slot.model],
        slot.cap,
        profile.capacity,
      ),
    };
  });
  const estimates = stageModels.map((model) => {
    const rows = worklist.filter((slot) => slot.model === model);
    const probe = forecastLane(
      [{ action: "MASTER_MESSAGE" }],
      providers[model],
      inputs.forecast[model],
      3,
    );
    return {
      model,
      expected_usd:
        probe.expected_usd +
        rows.reduce((n, row) => n + row.forecast.expected_usd, 0),
      worst_usd:
        probe.worst_usd +
        rows.reduce((n, row) => n + row.forecast.worst_usd, 0),
    };
  });
  return {
    schema: "issue122-stage-b-freeze-v3",
    verified_facts: verifiedFacts,
    ...(retentionDigest ? { retention_evidence_sha256: retentionDigest } : {}),
    ...(providers["gpt-6-luna"].cache_retention_contract === echoContract
      ? { legacy_echo_price_basis: echoPriceBasis }
      : {}),
    ...(tierSamples
      ? {
          explicit_tier_samples: tierSamples,
          standard_rate_attribution: "ASSUMED_FROM_CAPTURED_BASE_RATES",
        }
      : {}),
    source,
    worklist,
    inputs,
    b0_sha256,
    calendar: {
      start: "first physical reservation",
      lane_seconds: 3600,
      campaign_seconds: 43200,
      probe_cap: 3,
      model_cap: 640,
      campaign_cap: 1920,
      harness_retransmissions: 0,
    },
    estimates,
    expected_usd: estimates.reduce((n, r) => n + r.expected_usd, 0),
    worst_usd: estimates.reduce((n, r) => n + r.worst_usd, 0),
  };
}
export type StageFreeze = ReturnType<typeof buildFreeze>;
export async function prepareFreeze(root: string) {
  const { providers } = readJSON<Inputs>(
    path.join(root, "configs", "stage-b-inputs.json"),
  );
  const policy: PhysicalPolicy = {
    schema: "issue122-physical-v3",
    freeze_sha256: "f".repeat(64),
    providers,
  };
  validatePhysical(policy);
  requireThat(
    stageModels.every(
      (model) =>
        !usesCapturedSchedule(providers[model]) ||
        providers[model].request_service_tier === "default",
    ),
    "STAGE_B_EXPLICIT_TIER_REQUIRED",
  );
  Object.values(providers).forEach(requireCapturedRetention);
  if (providers["gpt-6-luna"].request_service_tier)
    await prepareTierSamples(root, policy);
  const freeze = buildFreeze(root),
    file = freezeFile(root);
  for (const model of stageModels) {
    const age =
      Date.now() - Date.parse(freeze.inputs.providers[model].checked_at);
    requireThat(age >= 0 && age <= 86400000, "STAGE_B_STALE_PROVENANCE");
    await checkPublication(freeze.inputs.sources[model], fetch, root);
  }
  if (fs.existsSync(file))
    requireThat(
      JSON.stringify(readJSON(file)) === JSON.stringify(freeze),
      "STAGE_B_DOSSIER_EXISTS",
    );
  else writeJSON(file, freeze);
  return {
    file,
    sha256: sha(read(file)),
    slots: freeze.worklist.length,
    physical_provider_sends: 0,
  };
}
export function loadFreeze(root: string, hash: string) {
  const file = freezeFile(root);
  requireThat(
    digest(hash) && sha(read(file)) === hash,
    "STAGE_B_FREEZE_BINDING",
  );
  const freeze = buildFreeze(root);
  requireThat(
    JSON.stringify(readJSON(file)) === JSON.stringify(freeze),
    "STAGE_B_FROZEN_INPUT_DRIFT",
  );
  const policy: PhysicalPolicy = {
    schema: "issue122-physical-v3",
    freeze_sha256: hash,
    providers: freeze.inputs.providers,
  };
  return { freeze, policy };
}
export async function checkPublication(
  pages: SourcePage[],
  transport = fetch,
  root?: string,
) {
  if (
    pages.some(
      (p) => p.representation !== undefined || p.review_sha256 !== undefined,
    )
  ) {
    for (const page of pages) checkCaptureFile(root, page);
    return "CAPTURE_MATCH" as const;
  }
  for (const page of pages) {
    const response = await transport(page.url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    requireThat(response.ok, "STAGE_B_PUBLICATION_UNAVAILABLE");
    requireThat(
      sha(Buffer.from(await response.arrayBuffer())) === page.sha256,
      "STAGE_B_PROVENANCE_CHANGE",
    );
  }
  return "MATCH" as const;
}
