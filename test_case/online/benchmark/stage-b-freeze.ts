import path from "node:path";
import fs from "node:fs";
import { read, readJSON, writeJSON, requireThat, sha } from "./io.ts";
import { b0Matrix } from "./baseline-b0.ts";
import { descriptor } from "./live-model.ts";
import {
  stageModels,
  stageSlots,
  validatePhysical,
  type StageModel,
  type PhysicalPolicy,
  type ProviderRule,
} from "./stage-b-policy.ts";
import { fingerprint } from "./source.ts";
import type { TimelineStep } from "./baseline-timeline.ts";
import { calibrationReceipt } from "./stage-b-report-calibration.ts";

type SourcePage = { url: string; sha256: string };
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
export function forecastLane(
  steps: TimelineStep[],
  rule: ProviderRule,
  factors: Forecast,
  cap: number,
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
  const turns = steps.reduce(
    (n, s) => n + (s.filler?.count ?? (s.action === "MASTER_MESSAGE" ? 1 : 0)),
    0,
  );
  const cycles = steps.filter((s) => s.action === "IDLE_WAIT").length;
  const tasks = steps.filter((s) => s.action === "MASTER_TASK").length;
  const expected_sends = Math.ceil(
    turns * factors.ordinary_sends_per_turn +
      tasks * factors.extra_task_sends +
      cycles * factors.sends_per_maintenance,
  );
  const expected_seconds = Math.ceil(
    expected_sends * factors.seconds_per_send +
      steps.filter((s) => s.action === "DIRECT_RESTART").length *
        factors.restart_seconds +
      steps.filter((s) => s.action === "OBSERVE").length *
        factors.observation_seconds +
      steps.reduce(
        (n, s) => n + (s.action === "IDLE_WAIT" ? (s.seconds ?? 0) : 0),
        0,
      ),
  );
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
    over_lane_limits: expected_sends > cap || expected_seconds > 3600,
    expected_usd:
      ((factors.expected_input_tokens * rule.input_rate +
        factors.expected_output_tokens * rule.output_rate) *
        Math.min(expected_sends, cap)) /
      1e6,
    worst_usd:
      ((rule.max_input_bytes * rule.input_rate +
        boundOutput * rule.output_rate) *
        cap) /
      1e6,
  };
}
export function buildFreeze(root: string) {
  const config = path.join(root, "configs");
  const inputs: Inputs = readJSON(path.join(config, "stage-b-inputs.json"));
  requireThat(
    Object.keys(inputs).sort().join(",") ===
      "calibration_key_sha256,calibration_packet_sha256,forecast,providers,sources" &&
      [inputs.forecast, inputs.sources].every(
        (group) =>
          Object.keys(group).sort().join(",") ===
          [...stageModels].sort().join(","),
      ),
    "STAGE_B_DOSSIER_KEYS",
  );
  const b0 = readJSON(path.join(config, "issue122-b0.json"));
  const b0_sha256 = sha(read(path.join(config, "issue122-b0.json")));
  requireThat(
    b0_sha256 ===
      "0a8b6acf24b449a5961987e3b82af17d0f5716edeff3639a0e651a2336af26a1",
    "STAGE_B_B0_RECEIPT_CHANGED",
  );
  const source = fingerprint();
  requireThat(
    b0.schema === "issue122-b0-v1" &&
      b0.source.sut.commit === source.sut.commit &&
      b0.slots.length === 12,
    "STAGE_B_B0_INVALID",
  );
  const providers = inputs.providers;
  validatePhysical({
    schema: "issue122-physical-v2",
    freeze_sha256: "f".repeat(64),
    providers,
  });
  for (const model of stageModels) {
    const pages = inputs.sources[model];
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
    if (model === "deepseek-flash")
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
      provider: model.provider,
      endpoint:
        model.baseUrl +
        (model.api === "openai-responses" ? "/responses" : "/chat/completions"),
      model: model.id,
    };
    return {
      ...slot,
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
    schema: "issue122-stage-b-freeze-v2",
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
export function prepareFreeze(root: string) {
  const freeze = buildFreeze(root),
    file = freezeFile(root);
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
    schema: "issue122-physical-v2",
    freeze_sha256: hash,
    providers: freeze.inputs.providers,
  };
  return { freeze, policy };
}
export async function checkPublication(pages: SourcePage[], transport = fetch) {
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
}
