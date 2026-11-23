import fs from "node:fs";
import path from "node:path";
import {
  describeTrial,
  stageCases,
  primaryModels,
  sutCommit,
  piCommit,
} from "./stage-c-plan.ts";
import { forecastLane } from "./stage-b-freeze.ts";
import { fillerPlan } from "./baseline-b0.ts";
import { descriptor } from "./live-model.ts";
import { fingerprint } from "./source.ts";
import {
  validatePhysical,
  type PhysicalPolicy,
  type ProviderRule,
  type ScheduledLane,
  type StageModel,
} from "./stage-b-policy.ts";
import {
  deploymentGuard,
  repository,
  read,
  readJSON,
  requireThat,
  sha,
  writeJSON,
} from "./io.ts";
import { type capacityForecast } from "./capacity.ts";

export const officialFlash =
  "https://api-docs.deepseek.com/quick_start/pricing.md";
type Capacity = ReturnType<typeof capacityForecast>[number];
type Sample = { bytes: number; output_cap: number; sha256: string };
export type Preflight = {
  models: StageModel[];
  capacities: Capacity[];
  samples: Record<string, Record<string, Sample[]>>;
  forecast: Record<string, Parameters<typeof forecastLane>[2]>;
  calibration: {
    reader: string;
    version: string;
    rubric_sha256: string;
    packet_sha256: string;
    key_sha256: string;
    max_attempts: number;
  };
  source: ReturnType<typeof fingerprint>;
};
export const freezeFile = (root: string) =>
  path.join(root, "configs", "stage-c-freeze.json");
const digest = (v: string) => /^[a-f0-9]{64}$/.test(v);
export function flashRule(raw: Buffer, checked: string): ProviderRule {
  const rows = raw
    .toString()
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) =>
      l
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  const field = (match: (c: string[]) => boolean) => {
    const values = rows.filter(match);
    requireThat(
      values.length === 1 && values[0].length === 5,
      "STAGE_C_PRICE_SOURCE_SHAPE",
    );
    return values[0][3];
  };
  const rate = (column: string) => {
    const value = field((r) => r[1] === column && r[2] === "PEAK");
    requireThat(
      /^\$[0-9]+(\.[0-9]+)?$/.test(value),
      "STAGE_C_PRICE_SOURCE_RATE",
    );
    const off = field((r) => r[1] === column && r[2] === "OFF-PEAK");
    requireThat(
      /^\$[0-9]+(\.[0-9]+)?$/.test(off) &&
        Number(off.slice(1)) * 2 === Number(value.slice(1)),
      "STAGE_C_PRICE_SCHEDULE",
    );
    return Number(value.slice(1));
  };
  const model = descriptor("deepseek-flash"),
    version = field((r) => r[0] === "MODEL VERSION");
  requireThat(
    field((r) => r[0] === "MODEL").startsWith(model.id) &&
      field((r) => r[0] === "BASE URL (OpenAI Format)") ===
        "<" + model.baseUrl + ">" &&
      /^DeepSeek-[\w.-]*Flash[\w.-]*$/i.test(version) &&
      field((r) => r[0] === "CONTEXT LENGTH") === "1M" &&
      field((r) => r[0] === "MAX OUTPUT") === "MAXIMUM: 384K" &&
      model.contextWindow === 1000000,
    "STAGE_C_FLASH_SOURCE_CHANGED",
  );
  const ordinary = rate("1M INPUT TOKENS / (CACHE MISS)");
  return {
    checked_at: checked,
    published_version: version,
    allowed_returned_models: [model.id],
    publication_url: officialFlash,
    tier: "default",
    cache_retention: "default",
    context_band: "all-admitted-input",
    context_upper_tokens: model.contextWindow,
    provenance_sha256: sha(raw),
    input_rate: ordinary,
    cache_write_rate: ordinary,
    cache_input_rate: rate("1M INPUT TOKENS / (CACHE HIT)"),
    output_rate: rate("1M OUTPUT TOKENS"),
    max_input_bytes: model.contextWindow,
    max_requested_output: model.maxTokens,
    billed_output: 384 * 1024,
  };
}

export function projectCampaign(
  inputs: Preflight,
  providers: Record<string, ProviderRule>,
) {
  const models = inputs.models;
  requireThat(
    models.includes("deepseek-flash") &&
      new Set(models).size === models.length &&
      models.length === Object.keys(providers).length,
    "STAGE_C_MODELS",
  );
  const grade = inputs.calibration;
  requireThat(
    grade.reader &&
      grade.version &&
      [grade.rubric_sha256, grade.packet_sha256, grade.key_sha256].every(
        digest,
      ) &&
      grade.packet_sha256 !== grade.key_sha256 &&
      Number.isSafeInteger(grade.max_attempts) &&
      grade.max_attempts > 0,
    "STAGE_C_GRADER_FREEZE",
  );
  const sources = stageCases().filter(
    (c) =>
      c.status === "READY_FOR_OFFLINE_VALIDATION" && c.pair?.position !== "B",
  );
  const lanes = [];
  for (const c of sources)
    for (const model of models) {
      const capacity = inputs.capacities.find(
        (v) =>
          v.model === model &&
          v.profile === (c.id === "C16-combined" ? "RC98304_CANDIDATE" : "DEP"),
      );
      requireThat(capacity && providers[model], "STAGE_C_CAPACITY_REQUIRED");
      const plan = fillerPlan(capacity, c.requires_cold);
      const recipe = plan
        ? {
            count:
              c.id === "C06-stale-cold" ? Math.min(8, plan.count) : plan.count,
            bytes_each: plan.bytes_each,
          }
        : undefined;
      for (let repeat = 1; repeat <= 3; repeat++) {
        const spec = describeTrial(c.id, repeat, model, "BASELINE", recipe);
        const b =
          c.pair &&
          stageCases().find(
            (v) => v.pair?.id === c.pair!.id && v.pair.position === "B",
          );
        const steps = b
          ? [
              ...spec.steps.map((s) =>
                s.action === "PAIRED_RESTART"
                  ? { ...s, action: "DIRECT_RESTART" }
                  : s,
              ),
              { action: "DIRECT_RESTART" },
              { action: "MASTER_MESSAGE", text: b.probe, probe: true },
            ]
          : spec.steps;
        const samples = inputs.samples[c.id]?.[model];
        requireThat(
          samples?.length &&
            samples.every(
              (s) =>
                digest(s.sha256) &&
                Number.isSafeInteger(s.bytes) &&
                s.bytes > 0 &&
                s.bytes <= providers[model].max_input_bytes &&
                Number.isSafeInteger(s.output_cap) &&
                s.output_cap > 0 &&
                s.output_cap <= providers[model].max_requested_output,
            ),
          "STAGE_C_MEASURED_SAMPLE_REQUIRED",
        );
        const factors = inputs.forecast[model];
        const unbounded = forecastLane(
          steps,
          providers[model],
          factors,
          1,
          capacity,
        );
        const observed = samples.length;
        const cap =
          Math.ceil(Math.max(observed, unbounded.range.sends.max) * 1.35) + 12;
        const passive = steps
          .filter(
            (s) =>
              s.action === "OBSERVE" &&
              (s.requirement?.startsWith("bounded") ||
                s.requirement?.includes("ten-minute")),
          )
          .reduce((n, s) => n + (s.seconds ?? 0), 0);
        const seconds =
          Math.ceil(
            (Math.max(
              unbounded.range.seconds.max,
              observed * factors.seconds_per_send,
            ) +
              passive +
              (c.id === "C12b" ? 180 : 0)) *
              1.3,
          ) + 180;
        requireThat(seconds <= 43200, "STAGE_C_LINEAGE_EXCEEDS_BATCH");
        const forecast = forecastLane(
          steps,
          providers[model],
          factors,
          cap,
          capacity,
          seconds,
        );
        const lane: ScheduledLane = {
          lane: "r" + repeat + "-" + (c.pair?.id ?? c.id) + "--" + model,
          scenario: c.id,
          seed: spec.seed,
          profile: spec.profile,
          cap,
          seconds,
          repeat,
          model,
        };
        lanes.push({
          lane,
          recipe,
          trial: {
            inputs: spec.external_inputs_sha256,
            timeline: spec.recipe_sha256,
            oracle: sha(JSON.stringify(c.oracle)),
          },
          pair: b
            ? describeTrial(b.id, repeat, model, "BASELINE", recipe)
                .recipe_sha256
            : null,
          capacity,
          sample_count: observed,
          largest_measured_bytes: Math.max(...samples.map((s) => s.bytes)),
          samples_sha256: sha(JSON.stringify(samples)),
          forecast,
          passive_seconds: passive,
          retry_policy: "SDK_ZERO_RETRIES_ONE_TRAJECTORY",
          recovery_windows: {
            target_ms: 120000,
            exit_ms: 15000,
            recovery_ms: 60000,
            post_verify_ms: 60000,
          },
        });
      }
    }
  const batches: (typeof lanes)[] = [];
  let cost = 0;
  for (const row of lanes) {
    if (!batches.length || cost + row.lane.seconds > 43200) {
      batches.push([]);
      cost = 0;
    }
    batches.at(-1)!.push(row);
    cost += row.lane.seconds;
  }
  return {
    schema: "issue122-completion-projection-v1",
    models,
    estimated_lineages: lanes.length,
    candidate_observations: lanes.length + lanes.filter((l) => l.pair).length,
    scheduled_seconds: lanes.reduce((s, l) => s + l.lane.seconds, 0),
    maximum_physical_requests: lanes.reduce((s, l) => s + l.lane.cap, 0),
    expected_usd_at_peak_rates: lanes.reduce(
      (s, l) => s + l.forecast.expected_usd,
      0,
    ),
    reserved_usd_at_peak_rates: lanes.reduce(
      (s, l) => s + l.forecast.worst_usd,
      0,
    ),
    batches,
  };
}
export type FrozenBatch = ReturnType<typeof projectCampaign>["batches"][number];
export function loadCompletion(root: string, hash: string, approval: string) {
  requireThat(
    digest(hash) && approval === "issue122-completion-" + hash.slice(0, 40),
    "STAGE_C_APPROVAL_BINDING",
  );
  const bytes = read(freezeFile(root));
  requireThat(sha(bytes) === hash, "STAGE_C_FREEZE_CHANGED");
  const frozen = JSON.parse(bytes.toString());
  const source = fingerprint();
  requireThat(
    frozen.schema === "issue122-completion-freeze-v1" &&
      JSON.stringify(source) === JSON.stringify(frozen.source) &&
      source.sut.commit === sutCommit &&
      source.sut.submodules["src/pi_resource"] === piCommit,
    "STAGE_C_SOURCE_CHANGED",
  );
  const inputsFile = path.join(root, "inputs", "stage-c-preflight.json"),
    inputs = readJSON<Preflight>(inputsFile);
  requireThat(
    sha(read(inputsFile)) === frozen.inputs_sha256 &&
      inputs.models.length === 1 &&
      inputs.models[0] === primaryModels[0],
    "STAGE_C_INPUT_CHANGED",
  );
  const sourceBytes = read(
    path.join(root, "inputs", "official", "flash-pricing.md"),
  );
  const rule = flashRule(sourceBytes, frozen.checked_at);
  requireThat(
    JSON.stringify(rule) === JSON.stringify(frozen.providers["deepseek-flash"]),
    "STAGE_C_PUBLICATION_CHANGED",
  );
  const policy: PhysicalPolicy = {
    schema: "issue122-completion-physical-v1",
    freeze_sha256: hash,
    providers: frozen.providers,
    batch_seconds: 43200,
    lanes: frozen.batch.map((row: FrozenBatch[number]) => row.lane),
  };
  validatePhysical(policy);
  return { frozen, inputs, policy, batch: frozen.batch as FrozenBatch };
}
export function freezeBatch(root: string, index: number, checked: string) {
  deploymentGuard(repository, root);
  requireThat(
    Number.isSafeInteger(index) &&
      index >= 1 &&
      !fs.existsSync(freezeFile(root)),
    "STAGE_C_FREEZE_EXISTS_OR_BATCH_INVALID",
  );
  const source = fingerprint(),
    inputFile = path.join(root, "inputs", "stage-c-preflight.json"),
    inputs = readJSON<Preflight>(inputFile);
  requireThat(
    source.sut.commit === sutCommit &&
      source.sut.submodules["src/pi_resource"] === piCommit &&
      source.dirty === sha("") &&
      JSON.stringify(source) === JSON.stringify(inputs.source),
    "STAGE_C_CLEAN_PREFLIGHT_REQUIRED",
  );
  const age = Date.now() - Date.parse(checked);
  requireThat(
    age >= 0 &&
      age < 86400000 &&
      inputs.models.length === 1 &&
      inputs.models[0] === "deepseek-flash",
    "STAGE_C_CURRENT_FLASH_SOURCE_REQUIRED",
  );
  const providers = {
    "deepseek-flash": flashRule(
      read(path.join(root, "inputs", "official", "flash-pricing.md")),
      checked,
    ),
  };
  const projection = projectCampaign(inputs, providers),
    batch = projection.batches[index - 1];
  requireThat(batch, "STAGE_C_BATCH_INDEX");
  const model = descriptor("deepseek-flash");
  const document = {
    schema: "issue122-completion-freeze-v1",
    source,
    checked_at: checked,
    providers,
    inputs_sha256: sha(read(inputFile)),
    batch_index: index,
    batch,
    role_model: {
      main: model.id,
      task: model.id,
      provider: model.provider,
      api: model.api,
      base_url: model.baseUrl,
      temperature: "ADAPTER_DEFAULT",
      provider_seed: "UNAVAILABLE",
    },
    grade: inputs.calibration,
    projection_sha256: sha(JSON.stringify(projection)),
  };
  writeJSON(path.join(root, "reports", "stage-c-projection.json"), projection);
  writeJSON(freezeFile(root), document);
  const hash = sha(read(freezeFile(root)));
  loadCompletion(root, hash, "issue122-completion-" + hash.slice(0, 40));
  return {
    hash,
    index,
    batches: projection.batches.length,
    lanes: batch.length,
    physical_provider_sends: 0,
  };
}
