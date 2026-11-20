import { requireThat } from "./io.ts";

export const stageModels = [
  "deepseek-flash",
  "gpt-6-luna",
  "gpt-6.2-sol",
] as const;
export type StageModel = (typeof stageModels)[number];
const [flash, luna, sol] = stageModels;
export const stageSlots = (
  [
    ["C05-W", [flash, sol, luna]],
    ["C08-inference", [sol, luna, flash]],
    ["C10-condition", [luna, flash, sol]],
    ["C16-combined", [flash, luna, sol]],
  ] as const
).flatMap(([scenario, models]) =>
  models.map((model) => ({
    lane: scenario + "--" + model,
    scenario,
    model,
    profile:
      scenario === "C16-combined" ? ("RC98304" as const) : ("DEP" as const),
    cap: scenario === "C16-combined" ? 157 : 160,
  })),
);
export function stageLane(id: string) {
  return (
    stageSlots.find((slot) => slot.lane === id) ??
    stageModels
      .map((model) => ({
        lane: "probe--" + model,
        model,
        profile: "DEP" as const,
        scenario: "probe",
        cap: 3,
      }))
      .find((slot) => slot.lane === id)
  );
}
export type ProviderRule = {
  checked_at: string;
  published_version: string;
  allowed_returned_models: string[];
  publication_url: string;
  tier: "default";
  cache_retention: "default";
  context_band: "all-admitted-input";
  context_upper_tokens: number;
  cache_input_rate: number;
  provenance_sha256: string;
  input_rate: number;
  output_rate: number;
  max_input_bytes: number;
  max_requested_output: number;
  billed_output: "REQUEST_CAP" | number;
};
export type PhysicalPolicy = {
  schema: "issue122-physical-v2";
  freeze_sha256: string;
  providers: Record<StageModel, ProviderRule>;
};
const keys = (value: object, names: string[]) =>
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const count = (value: number) => Number.isSafeInteger(value) && value > 0;
export function validatePhysical(policy: PhysicalPolicy) {
  requireThat(
    policy?.schema === "issue122-physical-v2" &&
      keys(policy, ["schema", "freeze_sha256", "providers"]) &&
      digest(policy.freeze_sha256) &&
      keys(policy.providers, [...stageModels]),
    "STAGE_B_POLICY_INVALID",
  );
  for (const model of stageModels) {
    const rule = policy.providers[model];
    const url = new URL(rule.publication_url);
    requireThat(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        (model === flash
          ? url.hostname === "api-docs.deepseek.com"
          : [
              "openai.com",
              "platform.openai.com",
              "developers.openai.com",
            ].includes(url.hostname)),
      "STAGE_B_PROVENANCE_ORIGIN",
    );
    requireThat(
      keys(rule, [
        "checked_at",
        "published_version",
        "allowed_returned_models",
        "publication_url",
        "tier",
        "cache_retention",
        "context_band",
        "context_upper_tokens",
        "cache_input_rate",
        "provenance_sha256",
        "input_rate",
        "output_rate",
        "max_input_bytes",
        "max_requested_output",
        "billed_output",
      ]) &&
        rule.tier === "default" &&
        rule.cache_retention === "default" &&
        rule.context_band === "all-admitted-input" &&
        Number.isFinite(Date.parse(rule.checked_at)) &&
        !!rule.published_version &&
        Array.isArray(rule.allowed_returned_models) &&
        rule.allowed_returned_models.length <= 4 &&
        rule.allowed_returned_models.includes(model) &&
        new Set(rule.allowed_returned_models).size ===
          rule.allowed_returned_models.length &&
        rule.allowed_returned_models.every(
          (id) =>
            typeof id === "string" &&
            !stageModels.some((other) => other !== model && other === id) &&
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id),
        ) &&
        digest(rule.provenance_sha256) &&
        [rule.input_rate, rule.output_rate].every(
          (rate) => Number.isFinite(rate) && rate > 0,
        ) &&
        count(rule.context_upper_tokens) &&
        rule.context_upper_tokens >= rule.max_input_bytes &&
        Number.isFinite(rule.cache_input_rate) &&
        rule.cache_input_rate >= 0 &&
        rule.cache_input_rate <= rule.input_rate &&
        count(rule.max_input_bytes) &&
        count(rule.max_requested_output) &&
        (rule.billed_output === "REQUEST_CAP" ||
          (count(rule.billed_output) &&
            rule.billed_output >= rule.max_requested_output)),
      "STAGE_B_PROVENANCE_INVALID",
    );
  }
}
export type PhysicalBound = {
  input_bytes: number;
  output_tokens: number;
  requested_output: number;
  role: string;
  freeze_sha256: string;
};
export function physicalBound(
  policy: PhysicalPolicy,
  model: StageModel,
  bytes: number,
  requested: number,
  role: string,
) {
  const rule = policy.providers[model];
  requireThat(
    rule &&
      count(bytes) &&
      bytes <= rule.max_input_bytes &&
      count(requested) &&
      requested <= rule.max_requested_output &&
      ["main", "task", "probe"].includes(role),
    "STAGE_B_BODY_BOUND",
  );
  return {
    input_bytes: bytes,
    output_tokens:
      rule.billed_output === "REQUEST_CAP" ? requested : rule.billed_output,
    requested_output: requested,
    role,
    freeze_sha256: policy.freeze_sha256,
  };
}
/** Exact provider identifiers in wire order. A stream may carry more than one identifier;
 * the first distinct pair is sufficient to decide a change. */
export function returnedIdentity(
  allowed: readonly string[],
  previous: string | undefined,
  observed: readonly string[],
) {
  let matched = previous;
  for (const id of observed) {
    if (matched !== undefined && matched !== id) return "VERSION_TRANSITION";
    if (!allowed.includes(id)) return "IDENTITY_MISMATCH_FIRST_CONTACT";
    matched = id;
  }
  return observed.length ? "MATCH" : "IDENTITY_UNKNOWN";
}
export function chatUsageRequest(
  api: string,
  payload: { stream_options?: { include_usage?: unknown } },
) {
  if (api !== "openai-completions") return null;
  requireThat(
    payload.stream_options?.include_usage === true,
    "STAGE_B_STREAM_USAGE_REQUIRED",
  );
  return true;
}
export function ambiguousReasoning(usage: any) {
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  const reasoning =
    usage?.output_tokens_details?.reasoning_tokens ??
    usage?.completion_tokens_details?.reasoning_tokens;
  return (
    Number.isSafeInteger(reasoning) &&
    Number.isSafeInteger(output) &&
    reasoning > output
  );
}
export function physicalViolation(bound: PhysicalBound, usage: any) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  const reasoning =
    usage?.completion_tokens_details?.reasoning_tokens ??
    usage?.output_tokens_details?.reasoning_tokens;
  return (
    input > bound.input_bytes ||
    output > bound.output_tokens ||
    reasoning > bound.output_tokens ||
    ambiguousReasoning(usage)
  );
}
export function physicalUsageKnown(usage: any) {
  const input = usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.output_tokens ?? usage?.completion_tokens;
  const reasoning =
    usage?.completion_tokens_details?.reasoning_tokens ??
    usage?.output_tokens_details?.reasoning_tokens ??
    0;
  return (
    [input, output, reasoning].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) && reasoning <= output
  );
}
export function measuredEstimate(rule: ProviderRule, usage: any) {
  if (!physicalUsageKnown(usage)) return null;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  const cached =
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    (rule.input_rate === rule.cache_input_rate ? 0 : undefined);
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > input)
    return null;
  return (
    ((input - cached) * rule.input_rate +
      cached * rule.cache_input_rate +
      output * rule.output_rate) /
    1e6
  );
}
export function providerFailure(
  model: StageModel,
  status: number,
  raw: Uint8Array,
) {
  let error;
  try {
    error = JSON.parse(Buffer.from(raw).toString()).error;
  } catch {}
  const code = error?.code ?? error?.type;
  if (
    (model === flash && status === 402) ||
    (model !== flash && status === 429 && code === "insufficient_quota")
  )
    return "EXHAUSTED_QUOTA";
  if (status === 401) return "AUTH";
  if (status === 429 && (model === flash || code === "rate_limit_exceeded"))
    return "RATE_LIMITED";
  if ([502, 503, 504].includes(status)) return "TRANSIENT";
  return "UNKNOWN";
}
export type PhysicalAttempt = {
  model: string;
  lane?: string;
  episode?: string;
  at: string;
};
export function checkAdmission(
  policy: PhysicalPolicy,
  prior: PhysicalAttempt[],
  laneID: string,
  model: StageModel,
  episode: string,
  now: number,
) {
  const lane = stageLane(laneID);
  requireThat(lane && lane.model === model && episode, "STAGE_B_LANE_BINDING");
  const forModel = prior.filter((attempt) => attempt.model === model);
  const forLane = forModel.filter((attempt) => attempt.lane === laneID);
  requireThat(
    forLane.every((attempt) => attempt.episode === episode) &&
      !prior.some(
        (attempt) => attempt.episode === episode && attempt.lane !== laneID,
      ),
    "STAGE_B_LINEAGE_CHANGED",
  );
  const remaining = forLane.length ? 1 : lane.cap;
  requireThat(
    forLane.length < lane.cap &&
      forModel.length + remaining <= 640 &&
      prior.length + remaining <= 1920,
    "STAGE_B_REQUEST_LIMIT",
  );
  const start = prior.length ? Date.parse(prior[0].at) : now;
  const checked = Date.parse(policy.providers[model].checked_at);
  requireThat(
    checked <= start && start - checked <= 86400000,
    "STAGE_B_STALE_PROVENANCE",
  );
  requireThat(
    now >= start && now - start < 12 * 3600000,
    "STAGE_B_CAMPAIGN_TIME",
  );
  if (forLane.length)
    requireThat(
      now >= Date.parse(forLane[0].at) &&
        now - Date.parse(forLane[0].at) < 3600000,
      "STAGE_B_LANE_TIME",
    );
}
