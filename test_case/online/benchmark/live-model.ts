import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  stageModels,
  physicalBound,
  physicalViolation,
  chatUsageRequest,
  measuredEstimate,
  pricingDrift,
  tierMismatch,
  publicTier,
  type ObservedTier,
  reservationUSD,
  providerFailure,
  type StageModel,
} from "./stage-b-policy.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  roleModel,
  type StreamFn,
} from "../../../sut/secretary/src/pi_secretary/src/model.ts";
import {
  appendJSON,
  noLinks,
  read,
  repository,
  requireThat,
  sha,
  writeJSON,
} from "./io.ts";
import {
  reserve,
  settle,
  recordPricingDrift,
  loadCampaign,
  ledger,
} from "./campaign.ts";
import { baselineReservation } from "./baseline-budget.ts";
import { transportFailure } from "../../../sut/secretary/src/pi_secretary/src/model-retry.ts";

/** Preserve the product's retry class without retaining provider error text. */
export function safeTransportError(error: unknown) {
  const kind = transportFailure(error);
  return Error(
    kind === "TRANSIENT"
      ? "network error"
      : kind === "PERMANENT"
        ? "authentication failed"
        : "PROVIDER_LOCAL_FAILURE",
  );
}

export const modelIDs = [
  "gpt-6.1-sol",
  "deepseek-flash",
  "gpt-6-luna",
] as const;
export type ModelID = (typeof modelIDs)[number];
export type Profile = "RC" | "DEP";
export const baselineModels = stageModels;
export function descriptor(id: ModelID | "gpt-6.2-sol"): Model<Api> {
  requireThat(
    id === "gpt-6.2-sol" || modelIDs.includes(id),
    "MODEL_NOT_APPROVED",
  );
  if (id === "deepseek-flash") {
    const m = structuredClone(getModel("deepseek", "deepseek-flash"));
    requireThat(
      m &&
        m.baseUrl === "https://api.deepseek.com" &&
        m.api === "openai-completions",
      "MODEL_REGISTRY_DRIFT",
    );
    // Peak uncached rates are conservative estimates, not a provider invoice.
    return {
      ...m,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 },
    };
  }
  const input = id === "gpt-6-luna" ? 0.1 : 2,
    output = id === "gpt-6-luna" ? 0.5 : 10;
  return {
    id,
    name: id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input, output, cacheRead: input, cacheWrite: input },
  };
}
export function credential(id: ModelID | StageModel, stageB = false) {
  const owner = stageB
    ? path.join(path.dirname(repository), "secretary-core")
    : repository;
  const root = path.join(owner, ".local/test-credentials");
  const file = path.join(
    root,
    id === "deepseek-flash"
      ? ".env.Secretary_test_deepseek"
      : ".env.secretary_test_openai",
  );
  noLinks(file);
  if (stageB) {
    requireThat(
      execFileSync("git", ["-C", owner, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim() === owner,
      "CREDENTIAL_OWNER",
    );
    execFileSync(
      "git",
      ["-C", owner, "check-ignore", "-q", "--", path.relative(owner, file)],
      { stdio: "ignore" },
    );
    requireThat(
      execFileSync("git", [
        "-C",
        owner,
        "ls-files",
        "--",
        path.relative(owner, file),
      ]).length === 0,
      "CREDENTIAL_TRACKED",
    );
  }
  for (const [p, mode] of [
    [root, 0o700],
    [file, 0o600],
  ] as const) {
    const stat = fs.statSync(p);
    requireThat(
      stat.uid === process.getuid?.() &&
        (stat.mode & 0o777) === mode &&
        (p === root || stat.nlink === 1),
      "CREDENTIAL_PERMISSIONS",
    );
  }
  const keyName =
    id === "deepseek-flash" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
  const matches = read(file)
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.startsWith(keyName + "="));
  requireThat(matches.length === 1, "CREDENTIAL_MISSING");
  const key = matches[0]
    .slice(keyName.length + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/, "$2");
  requireThat(key.length > 10 && !/[\r\n]/.test(key), "CREDENTIAL_INVALID");
  return key;
}
export function configureProfile(profile: Profile | "RC98304") {
  requireThat(["RC", "RC98304", "DEP"].includes(profile), "UNKNOWN_PROFILE");
  if (profile !== "DEP")
    Object.assign(process.env, {
      SECRETARY_MAIN_CONTEXT_WINDOW: profile === "RC" ? "65536" : "98304",
      SECRETARY_TASK_CONTEXT_WINDOW: profile === "RC" ? "65536" : "98304",
      SECRETARY_RECENT_INPUT_MAX_COUNT: "2",
      SECRETARY_RECENT_INPUT_BUDGET_RATIO: "0.05",
    });
}
type Attribution = { role: string; context_sha256: string };
const attribution = new AsyncLocalStorage<Attribution>();
export function benchmarkRoleModel(
  model: Model<Api>,
  key: string,
  role: "main" | "task",
  tier?: "default",
) {
  const base = roleModel(model, key, role);
  if (!tier) return base;
  requireThat(
    model.api === "openai-responses" && model.provider === "openai",
    "STAGE_B_PRICING_TIER",
  );
  const stream: StreamFn = (m, context, opts) => {
    requireThat(
      !opts || !("serviceTier" in opts) || opts.serviceTier === tier,
      "STAGE_B_PRICING_TIER",
    );
    return base.stream(m, context, {
      ...opts,
      onPayload: async (payload, actualModel) => {
        requireThat(
          payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            (!("service_tier" in payload) || payload.service_tier === tier),
          "STAGE_B_PRICING_TIER",
        );
        const configured = { ...payload, service_tier: tier };
        const changed = await opts?.onPayload?.(configured, actualModel);
        const final = changed === undefined ? configured : changed;
        requireThat(
          final &&
            typeof final === "object" &&
            "service_tier" in final &&
            final.service_tier === tier,
          "STAGE_B_PRICING_TIER",
        );
        return final;
      },
    });
  };
  return { model, stream };
}
export function liveRoles(
  id: ModelID | StageModel,
  key: string,
  evidence: string,
  tier?: "default",
) {
  const model = descriptor(id);
  const role = (name: "main" | "task") => {
    const config = benchmarkRoleModel(model, key, name, tier);
    const stream: StreamFn = async (m, context, options) => {
      const raw = JSON.stringify(context);
      requireThat(!raw.includes(key), "CREDENTIAL_CONTEXT_LEAK");
      const hash = sha(raw);
      appendJSON(path.join(evidence, "live-contexts.jsonl"), {
        at: new Date().toISOString(),
        role: name,
        context_sha256: hash,
        context,
      });
      return attribution.run({ role: name, context_sha256: hash }, () =>
        config.stream(m, context, options),
      );
    };
    return { model, stream };
  };
  return { main: role("main"), task: role("task") };
}
export function usageCost(model: Model<Api>, usage: any): number | null {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const output = usage.output_tokens ?? usage.completion_tokens;
  if (![input, output].every((v) => Number.isSafeInteger(v) && v >= 0))
    return null;
  return (input * model.cost.input + output * model.cost.output) / 1e6;
}
async function failureEvidence(model: StageModel, response: Response) {
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let size = 0;
  if (response.body)
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      digest.update(chunk);
      if (size <= 65536) chunks.push(Buffer.from(chunk));
    }
  const category = providerFailure(
    model,
    response.status,
    size <= 65536 ? Buffer.concat(chunks) : Buffer.alloc(0),
  );
  return {
    status: response.status,
    error_sha256: digest.digest("hex"),
    category,
  };
}
function networkOutcome(error: unknown) {
  const failure = error as { code?: string; cause?: { code?: string } } | null;
  return /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_VERIFY_|DEPTH_ZERO_SELF_SIGNED_CERT)/.test(
    failure?.cause?.code ?? failure?.code ?? "",
  )
    ? "TLS"
    : "NETWORK_UNCERTAIN";
}
/** Enforce origin/method/body before sending; reserve and fsync in this process. */
export function meteredFetch(
  options: {
    root: string;
    run: string;
    episode?: string;
    lane?: string;
    evidence: string;
    model: ModelID | StageModel;
    stageFreeze?: string;
    key: string;
    maxSends: number;
    forbidden?: string[] | (() => string[]);
  },
  transport: typeof fetch = globalThis.fetch,
): typeof fetch {
  const model = descriptor(options.model),
    base = new URL(model.baseUrl);
  const endpoint =
    base.origin +
    (model.api === "openai-responses" ? "/v1/responses" : "/chat/completions");
  let sends = 0;
  return async (input, init) => {
    let phase = "PROVIDER_REQUEST_INVALID",
      bodyHash: string | null = null;
    try {
      const request = new Request(input, init);
      phase = "PROVIDER_ENDPOINT_NOT_APPROVED";
      requireThat(
        request.url === endpoint && request.method === "POST",
        "PROVIDER_ENDPOINT_NOT_APPROVED",
      );
      const serialized = Buffer.from(await request.clone().arrayBuffer());
      bodyHash = sha(serialized);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(serialized);
      requireThat(
        Buffer.from(body).equals(serialized),
        "PROVIDER_REQUEST_INVALID",
      );
      phase = "PROVIDER_PAYLOAD_LEAK";
      const forbidden =
        typeof options.forbidden === "function"
          ? options.forbidden()
          : (options.forbidden ?? []);
      requireThat(
        ![options.key, ...forbidden]
          .filter(Boolean)
          .some(
            (secret) =>
              body.includes(secret) ||
              body.includes(JSON.stringify(secret).slice(1, -1)),
          ),
        "PROVIDER_PAYLOAD_LEAK",
      );
      phase = "PROVIDER_REQUEST_INVALID";
      const payload = JSON.parse(body);
      phase = "PROVIDER_MODEL_PROTOCOL_MISMATCH";
      requireThat(
        payload.model === options.model && payload.stream === true,
        "PROVIDER_MODEL_PROTOCOL_MISMATCH",
      );
      phase = "EPISODE_SEND_LIMIT";
      requireThat(++sends <= options.maxSends, "EPISODE_SEND_LIMIT");
      const maxOutput =
        payload.max_output_tokens ??
        payload.max_completion_tokens ??
        payload.max_tokens;
      phase = "PROVIDER_OUTPUT_CAP_MISSING";
      requireThat(
        Number.isSafeInteger(maxOutput) &&
          maxOutput > 0 &&
          maxOutput <= model.maxTokens,
        "PROVIDER_OUTPUT_CAP_MISSING",
      );
      const campaign = loadCampaign(options.root),
        limits = campaign.baseline_limits,
        policy = campaign.physical_policy;
      requireThat(
        policy?.freeze_sha256 === options.stageFreeze,
        "STAGE_B_FREEZE_BINDING",
      );
      const expectedTier =
        policy?.providers[options.model as StageModel].request_service_tier;
      if (policy)
        requireThat(
          (expectedTier
            ? payload.service_tier === expectedTier
            : payload.service_tier === undefined ||
              payload.service_tier === "default") &&
            payload.prompt_cache_retention === undefined &&
            (options.model === "deepseek-flash" ||
              (!Object.hasOwn(payload, "prompt_cache_options") &&
                !(
                  Array.isArray(payload.input) &&
                  payload.input.some(
                    (item: any) =>
                      Array.isArray(item?.content) &&
                      item.content.some(
                        (part: any) =>
                          part &&
                          typeof part === "object" &&
                          Object.hasOwn(part, "prompt_cache_breakpoint"),
                      ),
                  )
                ))),
          "STAGE_B_PRICING_TIER",
        );
      const requestedUsage = policy
        ? chatUsageRequest(model.api, payload)
        : null;
      const role =
        attribution.getStore()?.role ??
        (options.lane?.startsWith("probe--") ? "probe" : "");
      const physical = policy
        ? physicalBound(
            policy,
            options.model as StageModel,
            serialized.length,
            maxOutput,
            role,
          )
        : undefined;
      const rates =
        policy?.providers[options.model as StageModel] ??
        limits?.models[options.model];
      const worst =
        physical && policy
          ? reservationUSD(
              policy.providers[options.model as StageModel],
              physical.input_bytes,
              physical.output_tokens,
            )
          : limits
            ? baselineReservation(body, maxOutput, limits.models[options.model])
            : (Buffer.byteLength(body) * model.cost.input +
                maxOutput * model.cost.output) /
              1e6;
      phase = "CAMPAIGN_RESERVATION_REFUSED";
      const id = await reserve(
        options.root,
        {
          model: options.model,
          run: options.run,
          episode: options.episode ?? options.run,
          ...(options.lane ? { lane: options.lane } : {}),
          ...(physical ? { physical } : {}),
          ...(requestedUsage
            ? { chat_stream_usage_requested: requestedUsage }
            : {}),
          request_sha256: bodyHash,
          reserved_usd: worst,
        },
        options.maxSends,
      );
      phase = "SENT_OR_RESERVED";
      writeJSON(path.join(options.evidence, `send-${id}.json`), {
        id,
        attribution: attribution.getStore() ?? { role: "component-or-probe" },
        payload,
        at: new Date().toISOString(),
      });
      let response: Response;
      try {
        let signal = request.signal;
        if (policy) {
          const attempts = [...ledger(options.root).entries.values()].map(
            (row) => row.attempt,
          );
          const laneStart = attempts.find((row) => row.lane === options.lane)!;
          const expires = Math.min(
            Date.parse(attempts[0].at) + 43200000,
            Date.parse(laneStart.at) + 3600000,
          );
          const remaining = expires - Date.now();
          requireThat(remaining > 0, "STAGE_B_LANE_TIME");
          signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
        }
        response = await transport(
          new Request(request, { redirect: "error", signal }),
        );
      } catch (error) {
        await settle(
          options.root,
          id,
          policy ? networkOutcome(error) : "NETWORK_UNCERTAIN",
          null,
          null,
        );
        // Never propagate a provider exception that might contain request headers.
        throw safeTransportError(error);
      }
      appendJSON(path.join(options.evidence, "http.jsonl"), {
        id,
        status: response.status,
        at: new Date().toISOString(),
      });
      if (!response.ok || !response.body) {
        let outcome = `HTTP_${response.status}`;
        let failure: unknown = null;
        if (policy) {
          const observation = await failureEvidence(
            options.model as StageModel,
            response,
          );
          outcome = observation.category;
          failure = observation;
        }
        await settle(options.root, id, outcome, failure, null);
        // Error bodies can echo input/headers; SDK only needs the category and status.
        return new Response(
          JSON.stringify({
            error: {
              message: `HTTP_${response.status}`,
              type: "benchmark_provider_error",
            },
          }),
          {
            status: response.status >= 400 ? response.status : 502,
            headers: {
              "content-type": "application/json",
              ...(response.headers.get("retry-after")
                ? { "retry-after": response.headers.get("retry-after")! }
                : {}),
            },
          },
        );
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      const observedModels: string[] = [];
      let terminalTier: ObservedTier | undefined;
      let pending = "",
        usage: unknown = null,
        returnedModel: string | null = null,
        done = false,
        firstUsageViolation: unknown = null,
        completed = false,
        tierChanged = false;
      const observe = async (chunk: Uint8Array) => {
        const text = decoder.decode(chunk, { stream: true });
        requireThat(!text.includes(options.key), "CREDENTIAL_RESPONSE_LEAK");
        pending += text;
        requireThat(
          pending.length < 8 * 1024 * 1024,
          "PROVIDER_FRAME_TOO_LARGE",
        );
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const rawLine of lines) {
          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line === "data: [DONE]") {
            if (!expectedTier) completed = true;
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            const mismatch = expectedTier && tierMismatch(data, expectedTier);
            const drift = mismatch
              ? "SERVICE_TIER"
              : policy && pricingDrift(data, options.model as StageModel);
            if (drift && !tierChanged) {
              tierChanged = true;
              await recordPricingDrift(
                options.root,
                id,
                drift,
                expectedTier && mismatch
                  ? { requested_tier: expectedTier, observed_tier: mismatch }
                  : undefined,
              );
            }
            if (data.type === "response.completed") {
              completed = true;
              if (expectedTier)
                terminalTier = publicTier(data.response?.service_tier);
            }
            usage = data.usage ?? data.response?.usage ?? usage;
            if (physical && physicalViolation(physical, usage))
              firstUsageViolation ??= usage;
            const modelID = data.model ?? data.response?.model;
            if (typeof modelID === "string" && modelID.length) {
              returnedModel = modelID;
              if (
                policy &&
                observedModels.length < 2 &&
                !observedModels.includes(modelID)
              )
                observedModels.push(modelID);
            }
          }
        }
      };
      const finish = async (outcome: string) => {
        if (done) return;
        done = true;
        await settle(
          options.root,
          id,
          !policy
            ? outcome
            : tierChanged
              ? "PROVENANCE_CHANGE"
              : outcome === "RESPONSE_COMPLETE" && !completed
                ? "STREAM_UNCERTAIN"
                : outcome,
          {
            provider: firstUsageViolation ?? usage,
            returned_model: returnedModel,
            ...(policy
              ? {
                  response_complete:
                    completed && outcome === "RESPONSE_COMPLETE",
                  observed_models: observedModels,
                  ...(terminalTier
                    ? { returned_service_tier: terminalTier }
                    : {}),
                }
              : {}),
          },
          policy
            ? completed && !tierChanged && outcome === "RESPONSE_COMPLETE"
              ? measuredEstimate(
                  policy.providers[options.model as StageModel],
                  firstUsageViolation ?? usage,
                  options.model as StageModel,
                )
              : null
            : usageCost(
                rates
                  ? {
                      ...model,
                      cost: {
                        ...model.cost,
                        input: rates.input_rate,
                        output: rates.output_rate,
                      },
                    }
                  : model,
                usage,
              ),
        );
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                await finish("RESPONSE_COMPLETE");
                controller.close();
              } else {
                await observe(chunk.value);
                controller.enqueue(chunk.value);
              }
            } catch (error) {
              await finish("STREAM_UNCERTAIN");
              await reader.cancel().catch(() => {});
              controller.error(safeTransportError(error));
            }
          },
          async cancel() {
            try {
              await reader.cancel();
            } finally {
              await finish("CANCELLED_UNCERTAIN");
            }
          },
        }),
        { status: response.status, headers: response.headers },
      );
    } catch (error) {
      if (phase !== "SENT_OR_RESERVED") {
        const known = [
          "CAMPAIGN_CLOSED",
          "CAMPAIGN_SOURCE_CHANGED",
          "EPISODE_SEND_LIMIT",
          "CAMPAIGN_BUDGET_EXHAUSTED",
        ];
        const reason =
          error instanceof Error &&
          (known.includes(error.message) ||
            /^STAGE_B_[A-Z_]+$/.test(error.message))
            ? error.message
            : phase;
        writeJSON(path.join(options.evidence, `refused-${randomUUID()}.json`), {
          at: new Date().toISOString(),
          phase: "BEFORE_PROVIDER_SEND",
          reason,
          request_sha256: bodyHash,
          physical_send: false,
        });
        if (
          options.stageFreeze &&
          [
            "EPISODE_SEND_LIMIT",
            "STAGE_B_REQUEST_LIMIT",
            "STAGE_B_BODY_BOUND",
            "STAGE_B_LANE_TIME",
            "STAGE_B_CAMPAIGN_TIME",
          ].includes(reason)
        ) {
          appendJSON(
            path.join(options.root, "campaign", "physical-refusals.jsonl"),
            {
              at: new Date().toISOString(),
              freeze_sha256: options.stageFreeze,
              lane: options.lane,
              episode: options.episode,
              reason,
            },
          );
        }
        throw Error(reason);
      }
      throw error;
    }
  };
}
