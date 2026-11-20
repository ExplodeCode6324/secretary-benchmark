import { chatUsageRequest } from "./stage-b-policy.ts";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import {
  roleModel,
  type StreamFn,
} from "../../../sut/secretary/src/pi_secretary/src/model.ts";
import { baselineCases } from "./baseline-scenarios.ts";
import {
  timeline,
  fillerTexts,
  lintTimeline,
  visibleInputs,
} from "./baseline-timeline.ts";
import { Domains, configuration } from "./domain.ts";
import { baselineModels, descriptor } from "./live-model.ts";
import { read, readJSON, writeJSON, requireThat, sha, until } from "./io.ts";
import { fingerprint } from "./source.ts";
import type { capacityForecast } from "./capacity.ts";

type Capacity = ReturnType<typeof capacityForecast>[number];
const [flash, luna, sol] = baselineModels;
const order = [
  ["C05-W", [flash, sol, luna]],
  ["C08-inference", [sol, luna, flash]],
  ["C10-condition", [luna, flash, sol]],
  ["C16-combined", [flash, luna, sol]],
] as const;

export function fillerPlan(row: Capacity, cold: boolean) {
  const normal = Math.floor(
    row.budget.usable_input_tokens * row.effective_policy.normal,
  );
  const headroom = normal - row.budget.estimated_tokens;
  const bytes = Math.floor(
    Math.min(
      cold ? 8192 : 256,
      headroom / 8,
      row.recent_input_byte_allowance / (2 * row.window.count),
    ),
  );
  if (!Number.isSafeInteger(bytes) || bytes < 128) return null;
  const count = cold
    ? Math.max(8, row.window.count + 1, Math.ceil(headroom / bytes))
    : 8;
  return {
    count,
    bytes_each: bytes,
    headroom,
    estimated_normal_boundary: normal,
  };
}

export function b0Matrix(rows: Capacity[]) {
  requireThat(
    rows.length === 6 &&
      ["DEP", "RC98304_CANDIDATE"].every((profile) =>
        baselineModels.every(
          (model) =>
            rows.filter((row) => row.model === model && row.profile === profile)
              .length === 1,
        ),
      ),
    "B0_INCOMPLETE_COHORT",
  );
  const cases = baselineCases(true);
  return order.flatMap(([id, models]) =>
    models.map((model) => {
      const scenario = cases.find((candidate) => candidate.id === id)!;
      return {
        id,
        model,
        required: model === flash,
        quota_skip_allowed: model !== flash,
        oracle_sha256: sha(JSON.stringify(scenario.oracle)),
        profiles: rows
          .filter((row) => row.model === model)
          .map((row) => {
            const steps = timeline(scenario);
            const recipe = fillerPlan(row, scenario.requires_cold);
            const blocked = steps.some((step) => step.filler) && !recipe;
            if (!blocked && recipe)
              for (const step of steps) {
                if (!step.filler) continue;
                const filler = {
                  count: recipe.count,
                  bytes_each: recipe.bytes_each,
                  seed: step.filler.seed,
                };
                step.filler = {
                  ...filler,
                  sha256: sha(JSON.stringify(fillerTexts(filler))),
                };
              }
            if (!blocked) lintTimeline(steps);
            const turns = steps.reduce(
              (total, step) => total + (step.filler?.count ?? 0),
              0,
            );
            return {
              capacity: row,
              status: blocked
                ? "NO_INPUT_HEADROOM"
                : turns >= 160
                  ? "FILLER_ALONE_REACHES_REQUEST_CAP"
                  : "FORECAST_ONLY",
              recipe: steps.some((step) => step.filler) ? recipe : null,
              timeline: blocked ? null : steps,
              input_sha256: blocked
                ? null
                : sha(JSON.stringify(visibleInputs(steps))),
              ordinary_commits_required: scenario.maintenance_cycles,
              filler_turns: blocked ? null : turns,
              measured_exit: false,
              wire_bytes: null,
              live_dispatch: false,
            };
          }),
      };
    }),
  );
}

export async function captureBodies(context: Parameters<StreamFn>[1]) {
  const original = globalThis.fetch;
  const samples = [];
  try {
    for (const id of baselineModels) {
      const model = descriptor(id);
      const captured: {
        bytes: number;
        sha256: string;
        output_cap: number;
        endpoint: string;
        chat_stream_usage_requested: true | null;
      }[] = [];
      globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const bytes = Buffer.from(await request.arrayBuffer());
        const payload = JSON.parse(bytes.toString());
        const cap =
          payload.max_output_tokens ??
          payload.max_completion_tokens ??
          payload.max_tokens;
        requireThat(
          request.method === "POST" &&
            payload.model === id &&
            payload.stream &&
            Number.isSafeInteger(cap) &&
            cap > 0,
          "B0_SERIALIZATION_INVALID",
        );
        captured.push({
          chat_stream_usage_requested: chatUsageRequest(model.api, payload),
          bytes: bytes.length,
          sha256: sha(bytes),
          output_cap: cap,
          endpoint: request.url,
        });
        return new Response("{}", {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      };
      const stream = roleModel(model, "offline-synthetic-key").stream;
      const result = await (
        await stream(model, context, { signal: AbortSignal.timeout(10000) })
      ).result();
      requireThat(
        captured.length === 1 && result.stopReason === "error",
        "B0_MISSING_SERIALIZED_BODY",
      );
      samples.push({ model: id, ...captured[0] });
    }
    return samples;
  } finally {
    globalThis.fetch = original;
  }
}

export async function prepareB0(root: string) {
  return Domains.use(root, async (domains) => {
    const run = await domains.create(configuration);
    try {
      const active = await domains.start(run.id);
      const capacity = readJSON(
        path.join(active.evidence, "issue122-b0-capacity.json"),
      );
      const first = baselineCases().find((row) => row.id === "C05-W")!.setup[0];
      const calls = path.join(active.evidence, "fixture-calls.jsonl");
      await new CoreClient(active.endpoint!).command("messages", {
        request_id: randomUUID(),
        text: first,
      });
      await until(
        () => fs.existsSync(calls) && read(calls).toString().includes(first),
      );
      const sample = read(calls)
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((call) =>
          call.context.messages.some(
            (message: { role: string; content: unknown }) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes(first),
          ),
        );
      requireThat(sample, "B0_FIXTURE_CONTEXT_MISSING");
      const samples = await captureBodies(sample.context);
      const report = {
        schema: "issue122-b0-v1",
        run: run.id,
        source: fingerprint(),
        spend_cap_usd: null,
        trial_request_limit: 160,
        trial_minutes: 60,
        campaign_hours: 12,
        served_version_source:
          "https://api-docs.deepseek.com/quick_start/pricing",
        documented_flash_backend: "DeepSeek-V4.1-Flash-1017",
        backend_observed_in_response: false,
        serialized_samples: {
          scope:
            "Actual SDK bodies intercepted before network; one C05-W fixture Main context, not lane totals or live outcomes",
          context_sha256: sha(JSON.stringify(sample.context)),
          requests: samples,
        },
        slots: b0Matrix(capacity),
        additional_m5_controls: baselineCases(true)
          .filter((row) =>
            [
              "C10-model-created",
              "C10-discussed",
              "C11-autonomous-invalidation",
            ].includes(row.id),
          )
          .map((row) => {
            const steps = timeline(row);
            lintTimeline(steps);
            return {
              id: row.id,
              steps,
              input_sha256: sha(JSON.stringify(visibleInputs(steps))),
              oracle_sha256: sha(JSON.stringify(row.oracle)),
              pilot_slot: false,
            };
          }),
        physical_provider_sends: 0,
      };
      const file = path.join(root, "reports", "issue122-b0.json");
      writeJSON(file, report);
      return { file, slots: report.slots.length, physical_provider_sends: 0 };
    } finally {
      if (["RUNNING", "STOPPED"].includes(domains.raw(run.id).state))
        await domains.seal(run.id);
    }
  });
}
