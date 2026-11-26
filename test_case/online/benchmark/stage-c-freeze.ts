import { continuationWorkload, isRetest } from "./stage-c-targeted-policy.ts";
import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
import {
  retestWorkload,
  type TargetedPolicy,
  targetedLanes,
  checkTargetedInputs,
} from "./stage-c-targeted-policy.ts";
import { verifyTargetedCarry } from "./stage-c-targeted-account.ts";
import { accountFor } from "./stage-c-go-local-usage.ts";
import { nativeWriteRecipe } from "./stage-c-fault.ts";
import {
  checkGoResidualFiles,
  residualDefinition,
} from "./stage-c-go-residual.ts";
import {
  selectGoBatch,
  type GoContinuation,
} from "./stage-c-go-continuation.ts";
import { goModelRule } from "./stage-c-go-provider.ts";
import {
  goVisibilityVersion,
  goReader,
  goReaderPolicy,
} from "./stage-c-visibility-rubric.ts";
import {
  validateSeries,
  type RemainingSeries,
} from "./stage-c-remaining-series.ts";
import {
  visibilityV2,
  readerPolicy,
  officialReader,
} from "./stage-c-visibility-rubric.ts";
import { rehearsalCases } from "./stage-c-rehearsal.ts";
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
  evidence_class?: "OFFLINE_SSE";
  c16_dedicated_batch?: true;
  remaining_series?: RemainingSeries;
  go_continuation?: GoContinuation;
  targeted_supplement?: TargetedPolicy;
  first_contact?: {
    ledger_sha256: string;
    first_bytes: number;
    last_bytes: number;
    turns: number;
    main_sends: number;
    rc_capture_sha256: string;
    rc_mean_bytes: number;
    rc_peak_bytes: number;
  };
  rehearsal_go?:
    | "NORMAL"
    | "INTERRUPT_C16"
    | "EXHAUST_C16"
    | "CONTINUATION_CONTROLS"
    | "SYSTEM_C16"
    | "IDENTITY_C16";
  rehearsal_read?: "ORIGINAL_OFFSET" | "OTHER_EVENT";
  rehearsal_scenario?: "C16-combined" | "C06-stale-cold" | "C12b";
  models: StageModel[];
  reader_timing: {
    manifest_sha256: string;
    calibration: { n: number; median_seconds: number; max_seconds: number };
    batch: { n: number; median_seconds: number; max_seconds: number };
  };
  measured_tokens: Record<
    string,
    {
      tokens_per_byte: number;
      mean_output_tokens: number;
      median_seconds: number;
      longest_seconds: number;
      workload_responses: number;
      ledger_sha256: string;
    }
  >;
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
    transport?: typeof readerPolicy | typeof goReaderPolicy;
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
  requireThat(
    !inputs.rehearsal_read ||
      (inputs.evidence_class === "OFFLINE_SSE" &&
        (inputs.rehearsal_scenario === "C16-combined" ||
          !!inputs.rehearsal_go) &&
        ["ORIGINAL_OFFSET", "OTHER_EVENT"].includes(inputs.rehearsal_read)),
    "STAGE_C_REHEARSAL_READ_MODE",
  );
  requireThat(
    !inputs.rehearsal_go ||
      (inputs.evidence_class === "OFFLINE_SSE" &&
        isRetest(inputs.targeted_supplement?.series) &&
        [
          "NORMAL",
          "INTERRUPT_C16",
          "EXHAUST_C16",
          ...(inputs.targeted_supplement?.series === continuationWorkload.series
            ? ["CONTINUATION_CONTROLS", "SYSTEM_C16", "IDENTITY_C16"]
            : []),
        ].includes(inputs.rehearsal_go)),
    "RETEST_REHEARSAL_MODE",
  );
  const models = inputs.models;
  const rehearsal = inputs.evidence_class === "OFFLINE_SSE";
  const goRehearsal = rehearsal && isRetest(inputs.targeted_supplement?.series);
  requireThat(
    (inputs.evidence_class === undefined || rehearsal) &&
      (!inputs.rehearsal_scenario ||
        (rehearsal &&
          ["C16-combined", "C06-stale-cold", "C12b"].includes(
            inputs.rehearsal_scenario,
          ))),
    "STAGE_C_TRANSPORT",
  );
  requireThat(
    models.includes("deepseek-flash") &&
      new Set(models).size === models.length &&
      models.length === Object.keys(providers).length,
    "STAGE_C_MODELS",
  );
  if (inputs.c16_dedicated_batch) {
    const contact = inputs.first_contact;
    requireThat(
      contact &&
        digest(contact.ledger_sha256) &&
        [
          contact.first_bytes,
          contact.last_bytes,
          contact.turns,
          contact.main_sends,
        ].every((n) => Number.isSafeInteger(n) && n > 0) &&
        digest(contact.rc_capture_sha256) &&
        contact.rc_mean_bytes > 0 &&
        contact.rc_peak_bytes >= contact.rc_mean_bytes &&
        contact.last_bytes >= contact.first_bytes &&
        inputs.forecast["deepseek-flash"]?.ordinary_sends_per_turn ===
          contact.main_sends / contact.turns,
      "STAGE_C_FIRST_CONTACT_MEASUREMENTS",
    );
  }
  const grade = inputs.calibration;
  const pending = inputs.go_continuation?.pending_calibration;
  requireThat(
    !pending ||
      (pending.packet_sha256 === grade.packet_sha256 &&
        pending.key_sha256 === grade.key_sha256 &&
        pending.rubric_sha256 === grade.rubric_sha256),
    "GO_PENDING_TEMPLATE_BINDING",
  );
  const supplement = inputs.targeted_supplement;
  requireThat(
    goRehearsal
      ? [
          "NORMAL",
          "INTERRUPT_C16",
          "EXHAUST_C16",
          ...(inputs.targeted_supplement?.series === continuationWorkload.series
            ? ["CONTINUATION_CONTROLS", "SYSTEM_C16", "IDENTITY_C16"]
            : []),
        ].includes(inputs.rehearsal_go ?? "") && !inputs.rehearsal_scenario
      : inputs.rehearsal_go === undefined,
    "GO_REHEARSAL_MODE",
  );
  if (supplement) {
    checkTargetedInputs(supplement);
    requireThat(
      !inputs.go_continuation &&
        !inputs.remaining_series &&
        inputs.c16_dedicated_batch &&
        (!rehearsal || goRehearsal) &&
        models.length === 1,
      "TARGETED_WORKLOAD_SCOPE",
    );
  }
  const go = Boolean(inputs.go_continuation || supplement);
  requireThat(
    go === (providers["deepseek-flash"]?.route === "opencode-go") &&
      go === (grade.version === goVisibilityVersion) &&
      (!go ||
        ((inputs.remaining_series || supplement) &&
          inputs.c16_dedicated_batch &&
          (!rehearsal || goRehearsal))),
    "STAGE_C_GO_FREEZE_BINDING",
  );
  const transport = go ? goReaderPolicy : readerPolicy;
  requireThat(
    grade.reader &&
      grade.version &&
      [grade.rubric_sha256, grade.packet_sha256, grade.key_sha256].every(
        digest,
      ) &&
      grade.packet_sha256 !== grade.key_sha256 &&
      Number.isSafeInteger(grade.max_attempts) &&
      (go || grade.version === visibilityV2
        ? grade.reader === (go ? goReader : officialReader) &&
          grade.max_attempts === 1 &&
          JSON.stringify(grade.transport) === JSON.stringify(transport)
        : grade.max_attempts === 3),
    "STAGE_C_GRADER_FREEZE",
  );
  const sources = stageCases().filter(
    (c) =>
      c.status === "READY_FOR_OFFLINE_VALIDATION" &&
      c.pair?.position !== "B" &&
      (!supplement || targetedLanes.some((l) => l.scenario === c.id)) &&
      (!rehearsal ||
        goRehearsal ||
        (inputs.rehearsal_scenario
          ? c.id === inputs.rehearsal_scenario
          : rehearsalCases.some((id) => c.id === id))),
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
      const recipe =
        rehearsal && !goRehearsal && !inputs.rehearsal_scenario
          ? { count: 8, bytes_each: 256 }
          : plan
            ? {
                count:
                  c.id === "C06-stale-cold"
                    ? Math.min(8, plan.count)
                    : plan.count,
                bytes_each: plan.bytes_each,
              }
            : undefined;
      for (
        let repeat = 1;
        repeat <= (rehearsal || supplement ? 1 : 3);
        repeat++
      ) {
        const taskRecipe =
          supplement && c.id === "C12b" ? nativeWriteRecipe : undefined;
        const spec = describeTrial(
          c.id,
          repeat,
          model,
          "BASELINE",
          recipe,
          taskRecipe,
        );
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
        const metered = inputs.measured_tokens?.[model];
        requireThat(
          metered &&
            digest(metered.ledger_sha256) &&
            metered.workload_responses > 0 &&
            metered.tokens_per_byte > 0 &&
            metered.tokens_per_byte <= 1 &&
            metered.mean_output_tokens > 0 &&
            metered.median_seconds > 0 &&
            metered.longest_seconds >= metered.median_seconds,
          "STAGE_C_METERED_BASIS",
        );
        const nativeMean =
          samples.reduce((n, s) => n + s.bytes, 0) / samples.length;
        const liveFillerBytes = steps.reduce(
          (n, s) => n + (s.filler ? s.filler.count * s.filler.bytes_each : 0),
          0,
        );
        const shortFillerBytes = describeTrial(
          c.id,
          repeat,
          model,
          "OFFLINE_FIXTURE",
        ).steps.reduce(
          (n, s) => n + (s.filler ? s.filler.count * s.filler.bytes_each : 0),
          0,
        );
        const projectedBytes =
          nativeMean + Math.max(0, liveFillerBytes - shortFillerBytes) / 2;
        const targeted = inputs.c16_dedicated_batch && c.id === "C16-combined";
        const estimate = targeted
          ? Math.max(
              projectedBytes,
              inputs.first_contact!.rc_mean_bytes,
              inputs.first_contact!.rc_peak_bytes,
            )
          : projectedBytes;
        const estimatedBytes = Math.min(
          providers[model].max_input_bytes,
          estimate,
        );
        const sendsByTurn = targeted
          ? { ordinary: 5, filler: 2, probe: 6 }
          : undefined;
        const factors = {
          ...inputs.forecast[model],
          expected_input_tokens: Math.ceil(
            estimatedBytes * metered.tokens_per_byte,
          ),
          expected_output_tokens: Math.ceil(metered.mean_output_tokens),
          seconds_per_send: Math.max(
            inputs.forecast[model].seconds_per_send,
            metered.longest_seconds,
          ),
        };

        const unbounded = forecastLane(
          steps,
          providers[model],
          factors,
          1,
          capacity,
          3600,
          sendsByTurn,
        );
        const observed = samples.length;
        const cap = Math.max(
          targeted ? 609 : 0,
          Math.ceil(Math.max(observed, unbounded.range.sends.max) * 1.35) + 12,
        );
        const passive = steps
          .filter(
            (s) =>
              s.action === "OBSERVE" &&
              (s.requirement?.startsWith("bounded") ||
                s.requirement?.includes("ten-minute")),
          )
          .reduce((n, s) => n + (s.seconds ?? 0), 0);
        const seconds = Math.max(
          targeted ? 12090 : 0,
          Math.ceil(
            (Math.max(
              unbounded.range.seconds.max,
              observed * factors.seconds_per_send,
            ) +
              passive +
              (c.id === "C12b" ? 180 : 0)) *
              1.3,
          ) + 180,
        );
        requireThat(seconds <= 43200, "STAGE_C_LINEAGE_EXCEEDS_BATCH");
        const forecast = forecastLane(
          steps,
          providers[model],
          factors,
          cap,
          capacity,
          seconds,
          sendsByTurn,
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
          ...(supplement ? { targeted_supplement: true as const } : {}),
          ...(taskRecipe ? { task_recipe: taskRecipe } : {}),
          rehearsal,
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
          metered_basis: {
            source: metered.ledger_sha256,
            sample_count: metered.workload_responses,
            median_seconds: metered.median_seconds,
            longest_seconds: metered.longest_seconds,
            forecast_seconds_per_send: factors.seconds_per_send,
            expected_input_tokens: factors.expected_input_tokens,
            expected_output_tokens: factors.expected_output_tokens,
            native_mean_serialized_bytes: nativeMean,
            projected_mean_bytes: estimatedBytes,
            ...(targeted
              ? {
                  sends_by_turn: sendsByTurn,
                  rc_capture_sha256: inputs.first_contact!.rc_capture_sha256,
                  rc_peak_bytes: inputs.first_contact!.rc_peak_bytes,
                  rc_mean_bytes: inputs.first_contact!.rc_mean_bytes,
                  contact_ledger_sha256: inputs.first_contact!.ledger_sha256,
                }
              : {}),
            assumption:
              "Half of the additional live filler remains resident on an average request. Historical metered tokens per serialized byte; uncached peak-rate estimate.",
          },
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
  if (rehearsal)
    lanes.sort(
      (a, b) =>
        rehearsalCases.findIndex((id) => id === a.lane.scenario) -
        rehearsalCases.findIndex((id) => id === b.lane.scenario),
    );
  const batches: (typeof lanes)[] = [];
  // The first-contact batch uses an existing short control. The comparison denominator stays fixed.
  const firstContact =
    !rehearsal &&
    lanes.find(
      (r) => r.lane.scenario === "C04-resident" && r.lane.repeat === 1,
    );
  if (firstContact) batches.push([firstContact]);
  const dedicated = inputs.c16_dedicated_batch
    ? lanes.filter((r) => r.lane.scenario === "C16-combined")
    : [];
  if (supplement) {
    requireThat(
      lanes.length === 2 &&
        lanes.every((row) => {
          const bound = targetedLanes.find(
            (l) => l.scenario === row.lane.scenario,
          );
          return (
            bound &&
            row.lane.seed === bound.seed &&
            row.lane.profile === bound.profile &&
            row.lane.repeat === 1 &&
            row.lane.cap <= bound.cap &&
            row.lane.seconds <= bound.seconds
          );
        }),
      "TARGETED_PROJECTED_LANES",
    );
    batches.push(
      isRetest(supplement.series)
        ? [...lanes].sort(
            (a, b) =>
              Number(b.lane.scenario === "C12b") -
              Number(a.lane.scenario === "C12b"),
          )
        : lanes,
    );
  } else if (inputs.c16_dedicated_batch) {
    requireThat(
      !rehearsal &&
        firstContact &&
        (go || grade.version === visibilityV2) &&
        dedicated.length === 3 &&
        dedicated.reduce((n, r) => n + r.lane.seconds, 0) <= 43200,
      "STAGE_C_DEDICATED_C16",
    );
    batches.push(dedicated);
  }
  let cost = firstContact ? 43200 : 0;
  for (const row of lanes) {
    if (supplement || row === firstContact || dedicated.includes(row)) continue;
    if (!batches.length || cost + row.lane.seconds > 43200) {
      batches.push([]);
      cost = 0;
    }
    batches.at(-1)!.push(row);
    cost += row.lane.seconds;
  }
  const timing = inputs.reader_timing;
  requireThat(
    timing &&
      digest(timing.manifest_sha256) &&
      [timing.batch, timing.calibration].every(
        (t) =>
          Number.isSafeInteger(t.n) &&
          t.n > 0 &&
          t.median_seconds > 0 &&
          t.max_seconds >= t.median_seconds,
      ),
    "STAGE_C_READER_TIMING",
  );
  const observationCount = supplement
    ? supplement.candidate_limit
    : lanes.length + lanes.filter((l) => l.pair).length;
  const expectedReader =
    batches.length * timing.calibration.median_seconds +
    observationCount * timing.batch.median_seconds;
  const readerEnvelope =
    grade.max_attempts *
    (batches.length * timing.calibration.max_seconds +
      observationCount * timing.batch.max_seconds);
  return {
    schema: "issue122-completion-projection-v1",
    reader_wall: {
      historical_source: timing.manifest_sha256,
      semantic_observations: observationCount,
      calibrations: batches.length,
      historical_attempts: timing,
      expected_seconds: Math.ceil(expectedReader),
      three_attempts_at_historical_max_seconds: Math.ceil(readerEnvelope),
      source_recheck_timeout_seconds: 20,
      source_checks: batches.length + lanes.length,
      operator_approval_wait: "UNBOUNDED",
      reader_latency: "ESTIMATE_ONLY",
      ...(go || grade.version === visibilityV2
        ? {
            reader: grade.reader,
            transport: grade.transport,
            limits_at_peak_usd: {
              calibration:
                (transport.calibration_wire_bytes *
                  providers["deepseek-flash"].input_rate +
                  transport.max_output_tokens *
                    providers["deepseek-flash"].output_rate) /
                1e6,
              candidate:
                (transport.candidate_wire_bytes *
                  providers["deepseek-flash"].input_rate +
                  transport.max_output_tokens *
                    providers["deepseek-flash"].output_rate) /
                1e6,
            },
            candidate_time_evidence: "NO_LIVE_SAMPLE; calibration timing proxy",
          }
        : {}),
    },
    models,
    estimated_lineages: lanes.length,
    candidate_observations: observationCount,
    ...(supplement
      ? {
          archived_reader_only: supplement.candidate_limit - 2,
          workload_equivalent_cap: supplement.workload_equivalent_cap,
          reader_equivalent_cap: supplement.reader_equivalent_cap,
        }
      : {}),
    scheduled_seconds: lanes.reduce((s, l) => s + l.lane.seconds, 0),
    maximum_physical_requests:
      supplement?.series === continuationWorkload.series
        ? null
        : lanes.reduce((s, l) => s + l.lane.cap, 0),
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
export function completionApproval(hash: string, rehearsal: boolean) {
  return (
    (rehearsal ? "issue122-rehearsal-" : "issue122-completion-") +
    hash.slice(0, 40)
  );
}
function validateC16Limits(
  index: number,
  batch: FrozenBatch,
  projection: ReturnType<typeof projectCampaign>,
) {
  const reader = projection.reader_wall.limits_at_peak_usd;
  requireThat(
    reader && reader.calibration + 3 * reader.candidate <= 0.7176192 + 1e-12,
    "STAGE_C_C16_READER_LIMIT",
  );
  requireThat(
    index === 2 &&
      batch.length === 3 &&
      batch.every(
        (r, i) =>
          r.lane.repeat === i + 1 &&
          r.lane.scenario === "C16-combined" &&
          r.lane.cap <= 609 &&
          r.lane.seconds <= 12090,
      ) &&
      batch.reduce((n, r) => n + r.forecast.worst_usd, 0) <=
        1410.1867584 + 1e-9,
    "STAGE_C_C16_AUTHORIZED_SCOPE",
  );
}

export function loadCompletion(root: string, hash: string, approval: string) {
  requireThat(
    digest(hash) &&
      ["issue122-completion-", "issue122-rehearsal-"].some(
        (p) => approval === p + hash.slice(0, 40),
      ),
    "STAGE_C_APPROVAL_BINDING",
  );
  const bytes = read(freezeFile(root));
  requireThat(sha(bytes) === hash, "STAGE_C_FREEZE_CHANGED");
  const frozen = JSON.parse(bytes.toString());
  const source = fingerprint();
  const rehearsal = frozen.evidence_class === "OFFLINE_SSE";
  requireThat(
    isGoRehearsal(root) === (rehearsal && !!frozen.targeted_supplement),
    "GO_REHEARSAL_ROOT",
  );
  requireThat(
    approval === completionApproval(hash, rehearsal) &&
      (rehearsal
        ? root.startsWith(
            path.join(repository, ".local/benchmark/tests") + path.sep,
          )
        : frozen.evidence_class === "LIVE"),
    "STAGE_C_TRANSPORT_BINDING",
  );
  requireThat(
    frozen.schema === "issue122-completion-freeze-v1" &&
      source.dirty === sha("") &&
      JSON.stringify(source) === JSON.stringify(frozen.source) &&
      source.sut.commit === sutCommit &&
      source.sut.submodules["src/pi_resource"] === piCommit,
    "STAGE_C_SOURCE_CHANGED",
  );
  const inputsFile = path.join(root, "inputs", "stage-c-preflight.json"),
    inputs = readJSON<Preflight>(inputsFile);
  requireThat(
    (inputs.evidence_class === "OFFLINE_SSE") === rehearsal &&
      sha(read(inputsFile)) === frozen.inputs_sha256 &&
      inputs.models.length === 1 &&
      inputs.models[0] === primaryModels[0],
    "STAGE_C_INPUT_CHANGED",
  );
  if (inputs.targeted_supplement)
    checkTargetedInputs(inputs.targeted_supplement, root);
  const residual = residualDefinition(inputs.go_continuation);
  if (residual) checkGoResidualFiles(root, residual);
  const rule = frozenProvider(root, inputs, frozen.checked_at);
  requireThat(
    JSON.stringify(rule) === JSON.stringify(frozen.providers["deepseek-flash"]),
    "STAGE_C_PUBLICATION_CHANGED",
  );
  const projection = projectCampaign(inputs, { "deepseek-flash": rule });
  requireThat(
    JSON.stringify(roleSettings(inputs)) ===
      JSON.stringify(frozen.role_model) &&
      frozen.identity_stratum ===
        "PER_SEND_RETURNED_MODEL_AND_PROVIDER_FINGERPRINT" &&
      JSON.stringify(inputs.source) === JSON.stringify(source) &&
      JSON.stringify(frozen.grade) === JSON.stringify(inputs.calibration) &&
      Number.isSafeInteger(frozen.batch_index) &&
      frozen.batch_index >= 1 &&
      JSON.stringify(
        selected(projection.batches, inputs, frozen.batch_index),
      ) === JSON.stringify(frozen.batch) &&
      frozen.projection_sha256 === sha(JSON.stringify(projection)) &&
      sha(
        JSON.stringify(
          readJSON(path.join(root, "reports", "stage-c-projection.json")),
        ),
      ) === frozen.projection_sha256,
    "STAGE_C_PROJECTION_CHANGED",
  );
  requireThat(
    JSON.stringify(inputs.targeted_supplement) ===
      JSON.stringify(frozen.targeted_supplement) &&
      JSON.stringify(inputs.go_continuation) ===
        JSON.stringify(frozen.go_continuation) &&
      JSON.stringify(inputs.remaining_series) ===
        JSON.stringify(frozen.remaining_series),
    "STAGE_C_SERIES_BINDING",
  );
  if (inputs.remaining_series) {
    requireThat(
      inputs.c16_dedicated_batch && !rehearsal,
      "STAGE_C_SERIES_TRANSPORT",
    );
    validateSeries(
      inputs.remaining_series,
      frozen.batch_index,
      projection.batches,
    );
  }
  if (
    inputs.c16_dedicated_batch &&
    !inputs.targeted_supplement &&
    (!inputs.remaining_series || frozen.batch_index === 2)
  )
    validateC16Limits(frozen.batch_index, frozen.batch, projection);
  const policy: PhysicalPolicy = {
    schema: "issue122-completion-physical-v1",
    ...(inputs.targeted_supplement?.series === continuationWorkload.series
      ? { continuation: true as const }
      : {}),
    ...(rehearsal ? { rehearsal: true as const } : {}),
    freeze_sha256: hash,
    providers: frozen.providers,
    batch_seconds: 43200,
    lanes: frozen.batch.map((row: FrozenBatch[number]) => row.lane),
  };
  validatePhysical(policy);
  return { frozen, inputs, policy, batch: frozen.batch as FrozenBatch };
}
function roleSettings(inputs: Preflight) {
  const model = descriptor(
    "deepseek-flash",
    inputs.go_continuation || inputs.targeted_supplement
      ? "opencode-go"
      : undefined,
  );
  return {
    main: model.id,
    task: model.id,
    provider: model.provider,
    api: model.api,
    base_url: model.baseUrl,
    ...(inputs.go_continuation || inputs.targeted_supplement
      ? {
          thinking_type: "enabled",
          reasoning_effort: "low",
          session_header: "x-opencode-session",
          ...(inputs.targeted_supplement
            ? {}
            : { first_contact_lane: "r1-C04-nonexistent--deepseek-flash" }),
        }
      : {}),
    effective_limits_by_profile: inputs.capacities.map((c) => ({
      profile: c.profile,
      main: c.budget,
      task: c.task_budget,
      window: c.window,
    })),
    reasoning_capable: model.reasoning,
    temperature: "ADAPTER_DEFAULT",
    max_requested_output: model.maxTokens,
    sdk_retries: 0,
    output_policy:
      "roleModel resolves the requested output against the role budget on every send",
    experiment_seed:
      "Host lineage and recipe identifier; the paired branches share it",
    provider_seed: "UNAVAILABLE",
  };
}
function selected(batches: FrozenBatch[], inputs: Preflight, index: number) {
  return inputs.go_continuation
    ? selectGoBatch(
        batches,
        inputs.remaining_series!,
        inputs.go_continuation,
        index,
      )
    : batches[index - 1];
}
function frozenProvider(root: string, inputs: Preflight, checked: string) {
  const dir = path.join(root, "inputs/official");
  return inputs.go_continuation || inputs.targeted_supplement
    ? goModelRule(
        readJSON(path.join(dir, "go-model.json")),
        checked,
        inputs.targeted_supplement?.series === continuationWorkload.series,
      )
    : flashRule(read(path.join(dir, "flash-pricing.md")), checked);
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
  requireThat(
    isGoRehearsal(root) ===
      (inputs.evidence_class === "OFFLINE_SSE" && !!inputs.targeted_supplement),
    "GO_REHEARSAL_ROOT",
  );
  const age = Date.now() - Date.parse(checked);
  requireThat(
    age >= 0 &&
      age < 86400000 &&
      inputs.models.length === 1 &&
      inputs.models[0] === "deepseek-flash",
    "STAGE_C_CURRENT_FLASH_SOURCE_REQUIRED",
  );
  if (inputs.targeted_supplement) {
    checkTargetedInputs(inputs.targeted_supplement, root);
    verifyTargetedCarry(accountFor(root), root, inputs.targeted_supplement);
  }
  const residual = residualDefinition(inputs.go_continuation);
  if (residual) checkGoResidualFiles(root, residual);
  const providers = {
    "deepseek-flash": frozenProvider(root, inputs, checked),
  };
  const projection = projectCampaign(inputs, providers),
    batch = selected(projection.batches, inputs, index);
  requireThat(batch, "STAGE_C_BATCH_INDEX");
  if (inputs.remaining_series)
    validateSeries(inputs.remaining_series, index, projection.batches);
  if (
    inputs.c16_dedicated_batch &&
    !inputs.targeted_supplement &&
    (!inputs.remaining_series || index === 2)
  )
    validateC16Limits(index, batch, projection);
  const document = {
    schema: "issue122-completion-freeze-v1",
    evidence_class: inputs.evidence_class ?? "LIVE",
    source,
    ...(inputs.remaining_series
      ? { remaining_series: inputs.remaining_series }
      : {}),
    checked_at: checked,
    ...(inputs.targeted_supplement
      ? { targeted_supplement: inputs.targeted_supplement }
      : {}),
    ...(inputs.go_continuation
      ? { go_continuation: inputs.go_continuation }
      : {}),
    providers,
    inputs_sha256: sha(read(inputFile)),
    batch_index: index,
    batch,
    role_model: roleSettings(inputs),
    identity_stratum: "PER_SEND_RETURNED_MODEL_AND_PROVIDER_FINGERPRINT",
    grade: inputs.calibration,
    projection_sha256: sha(JSON.stringify(projection)),
  };
  writeJSON(path.join(root, "reports", "stage-c-projection.json"), projection);
  writeJSON(freezeFile(root), document);
  const hash = sha(read(freezeFile(root)));
  loadCompletion(
    root,
    hash,
    completionApproval(hash, inputs.evidence_class === "OFFLINE_SSE"),
  );
  return {
    hash,
    index,
    batches: projection.batches.length,
    lanes: batch.length,
    physical_provider_sends: 0,
  };
}
