import { admitGoSend, holdGo } from "./stage-c-go-quota.ts";
import {
  goAPI,
  goModel,
  goVersion,
  goTariff,
  goResponseMeter,
  targetedBillingHold,
} from "./stage-c-go-provider.ts";
import { snapshot } from "./snapshot.ts";
import { readJSON } from "./io.ts";
import {
  echoContract,
  echoScope,
  echoConflict,
  echoObservation,
  confirmedEchoTerminal,
  defaultCacheRequest,
  retentionFrame,
  retentionFinding,
  safeRetentionUsage,
  type RetentionFrame,
} from "./stage-b-retention.ts";
import {
  physicalTimes,
  activeFile,
  completionPolicy,
} from "./stage-b-policy.ts";
import { wireIdentity, flashBilling } from "./stage-c-identity.ts";
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
  recordLegacyEcho,
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
export function descriptor(
  id: ModelID | "gpt-6.2-sol",
  route?: "opencode-go",
): Model<Api> {
  requireThat(
    id === "gpt-6.2-sol" || modelIDs.includes(id),
    "MODEL_NOT_APPROVED",
  );
  requireThat(!route || id === "deepseek-flash", "STAGE_C_GO_MODEL");
  if (id === "deepseek-flash") {
    const m = structuredClone(
      route
        ? getModel("opencode-go", "deepseek-v4.1-flash")
        : getModel("deepseek", "deepseek-flash"),
    );
    requireThat(
      m &&
        (route
          ? m.provider === route && m.id === goModel
          : m.baseUrl === "https://api.deepseek.com") &&
        m.api === "openai-completions",
      "MODEL_REGISTRY_DRIFT",
    );
    // Peak uncached rates are conservative estimates, not a provider invoice.
    return {
      ...m,
      ...(route
        ? {
            provider: "opencode-go",
            id: goModel,
            name: goVersion,
            baseUrl: goAPI,
          }
        : {}),
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
  route?: "opencode-go",
) {
  const model = descriptor(id, route);
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
export function bindCorrectionProbe(
  records: ReturnType<typeof snapshot>["records"],
  request: string,
  digest: string,
  ctxHash: string | undefined,
) {
  const input = records.find(
    (r) => r.record_type === "Input" && r.dedupe_key === request,
  );

  const call = records.find(
    (r) =>
      r.record_type === "ModelCall" &&
      r.request.sha256 === ctxHash &&
      !r.completed_at,
  );
  const ctx =
    call?.record_type === "ModelCall" &&
    records.find(
      (r) => r.record_type === "Context" && r.id === call.context_id,
    );
  requireThat(
    input?.record_type === "Input" &&
      input.payload.sha256 === digest &&
      ctx &&
      ctx.record_type === "Context" &&
      ctx.purpose === "MAIN" &&
      ctx.input_ids.includes(input.id) &&
      ctx.loop_id === input.loop_id,
    "STAGE_C_PROBE_BINDING",
  );
}
export function meteredFetch(
  options: {
    root: string;
    run: string;
    episode?: string;
    lane?: string;
    evidence: string;
    model: ModelID | StageModel;
    stageFreeze?: string;
    route?: "opencode-go";
    key: string;
    maxSends: number;
    forbidden?: string[] | (() => string[]);
  },
  transport: typeof fetch = globalThis.fetch,
): typeof fetch {
  const model = descriptor(options.model, options.route),
    base = new URL(model.baseUrl);
  const endpoint = options.route
    ? goAPI + "/chat/completions"
    : base.origin +
      (model.api === "openai-responses"
        ? "/v1/responses"
        : "/chat/completions");
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
        payload.model === model.id && payload.stream === true,
        "PROVIDER_MODEL_PROTOCOL_MISMATCH",
      );
      if (options.route)
        requireThat(
          payload.thinking?.type === "enabled" &&
            payload.reasoning_effort === "low" &&
            !!request.headers.get("x-opencode-session") &&
            request.headers.get("user-agent") === "secretary-pi-demo/0.2",
          "GO_ROLE_SETTINGS_CHANGED",
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
        policy?.freeze_sha256 === options.stageFreeze &&
          policy?.providers[options.model]?.route === options.route,
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
            (options.model === "deepseek-flash"
              ? payload.prompt_cache_retention === undefined
              : defaultCacheRequest(payload)),
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
      let firstProbe = false,
        cutoff: number | undefined;
      if (policy && completionPolicy(policy)) {
        const active = readJSON(
          path.join(options.root, "campaign", activeFile(policy)),
        );
        if (
          active.probe_deadline &&
          role === "main" &&
          ![...ledger(options.root).entries.values()].some(
            (e) =>
              e.attempt.episode === options.episode &&
              e.attempt.correction_probe_first,
          )
        ) {
          const run = readJSON(
            path.join(options.root, "runs", options.run + ".json"),
          );
          const state = snapshot(path.join(run.active, "core"));
          bindCorrectionProbe(
            state.records,
            active.probe_request,
            active.probe_sha256,
            attribution.getStore()?.context_sha256,
          );
          firstProbe = true;
          cutoff = active.probe_deadline;
        }
      }
      phase = "CAMPAIGN_RESERVATION_REFUSED";
      const commitReservation = () =>
        reserve(
          options.root,
          {
            model: options.model,
            run: options.run,
            episode: options.episode ?? options.run,
            ...(options.lane ? { lane: options.lane } : {}),
            ...(physical ? { physical } : {}),
            ...(firstProbe ? { correction_probe_first: true as const } : {}),
            ...(requestedUsage
              ? { chat_stream_usage_requested: requestedUsage }
              : {}),
            request_sha256: bodyHash!,
            reserved_usd: worst,
          },
          options.maxSends,
        );
      const goAdmission = options.route
        ? await admitGoSend(
            options.root,
            options.stageFreeze!,
            options.key,
            worst,
            transport,
            commitReservation,
          )
        : null;
      const id = goAdmission ? goAdmission.result : await commitReservation();
      phase = "SENT_OR_RESERVED";
      const reservedAt = Date.now();
      writeJSON(path.join(options.evidence, `send-${id}.json`), {
        id,
        ...(goAdmission
          ? {
              go_usage_before: goAdmission.usage,
              unsettled_tariff_usd: goAdmission.unsettled,
              local_unreflected_usd: goAdmission.local,
            }
          : {}),
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
          const limits = physicalTimes(policy, options.lane!);
          const active = completionPolicy(policy)
            ? readJSON(path.join(options.root, "campaign", activeFile(policy)))
            : undefined;
          const expires = Math.min(
            limits.source,
            active?.deadline ?? Infinity,
            Date.parse(attempts[0].at) + limits.batch,
            Date.parse(laneStart.at) + limits.lane,
          );
          const remaining = expires - Date.now();
          requireThat(remaining > 0, "STAGE_B_LANE_TIME");
          signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
        }
        requireThat(
          cutoff === undefined || Date.now() < cutoff,
          "STAGE_C_PROBE_CUTOFF",
        );
        response = await transport(
          new Request(request, { redirect: "error", signal }),
        );
      } catch (error) {
        if (goAdmission?.targeted)
          holdGo(options.stageFreeze!, "GO_TARGETED_TRANSPORT_UNCERTAIN");
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
          outcome =
            options.route && [403, 429].includes(response.status)
              ? response.status === 403
                ? "GO_SUBSCRIPTION_UNAVAILABLE"
                : "GO_RATE_LIMIT"
              : observation.category;
          failure = observation;
        }
        if (options.route && [401, 402, 403, 429].includes(response.status))
          holdGo(options.stageFreeze!, outcome);
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
      const goMeter = options.route ? goResponseMeter() : undefined;
      const identity = wireIdentity(response.headers, options.key);
      const observedModels: string[] = [];
      const retention = physical?.cache_retention_contract;
      let failureFrameSeen = false;
      let frameIndex = 0,
        invalidLongWriteCount = false;
      let terminalCache: RetentionFrame | undefined;
      const allowEcho = retention === echoContract;
      let firstEcho: RetentionFrame | undefined,
        conflict: RetentionFrame | undefined,
        terminalUsage: unknown;
      let terminalTier: ObservedTier | undefined;
      let pending = "",
        usage: unknown = null,
        returnedModel: string | null = null,
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
            identity.observe(data);
            goMeter?.observe(data);
            if (
              goMeter &&
              (["balance", "byok"].includes(
                goMeter.receipt.billing_source ?? "",
              ) ||
                (goMeter.receipt.cash_debit_usd ?? 0) > 0)
            )
              holdGo(options.stageFreeze!, "GO_UNEXPECTED_BILLING_SOURCE");
            if (
              options.route &&
              options.lane === "r1-C04-nonexistent--deepseek-flash"
            )
              appendJSON(
                path.join(options.evidence, "go-native-" + id + ".jsonl"),
                data,
              );
            const mismatch = expectedTier && tierMismatch(data, expectedTier);
            const snapshot = retention
              ? retentionFrame(data, ++frameIndex)
              : null;
            const newEcho =
              allowEcho && snapshot && !firstEcho && echoScope(snapshot)
                ? snapshot
                : undefined;
            if (newEcho) firstEcho = newEcho;
            if (allowEcho && snapshot && !conflict && echoConflict(snapshot))
              conflict = snapshot;
            const finding = snapshot && retentionFinding(snapshot, allowEcho);
            if (
              snapshot &&
              (snapshot.frame.long_writes === "INVALID" ||
                snapshot.response.long_writes === "INVALID")
            )
              invalidLongWriteCount = true;
            const drift = mismatch
              ? "SERVICE_TIER"
              : snapshot
                ? finding?.reason
                : policy && pricingDrift(data, options.model as StageModel);
            if (data.type === "response.completed") {
              completed = true;
              if (snapshot) terminalCache = snapshot;
              if (allowEcho) terminalUsage = data.response?.usage;
              if (expectedTier)
                terminalTier = publicTier(data.response?.service_tier);
            }
            const failedFrame =
              data.type === "response.failed" ||
              data.type === "response.incomplete" ||
              data.type === "error";
            if (allowEcho && failedFrame) failureFrameSeen = true;
            if (drift && !tierChanged) {
              tierChanged = true;
              await recordPricingDrift(options.root, id, drift, {
                ...(newEcho ? { first_legacy_echo: newEcho } : {}),
                ...(expectedTier && mismatch
                  ? { requested_tier: expectedTier, observed_tier: mismatch }
                  : finding
                    ? { cache_retention: finding.observation }
                    : {}),
              });
            } else if (
              firstEcho &&
              !tierChanged &&
              (conflict ||
                failureFrameSeen ||
                (data.type === "response.completed" &&
                  !confirmedEchoTerminal(
                    snapshot ?? undefined,
                    data.response?.usage,
                  )))
            ) {
              await recordPricingDrift(options.root, id, "CACHE_RETENTION", {
                ...(newEcho ? { first_legacy_echo: newEcho } : {}),
                cache_retention: echoObservation(firstEcho),
                ...(conflict
                  ? {
                      echo_stop: "CONFLICTING_METADATA",
                      conflicting_frame: conflict,
                    }
                  : {
                      echo_stop: failureFrameSeen
                        ? "INCOMPLETE_STREAM"
                        : "TERMINAL_ZERO_UNCONFIRMED",
                    }),
              });
              tierChanged = true;
            } else if (newEcho)
              await recordLegacyEcho(options.root, id, newEcho);
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
      const commitSettlement = async (outcome: string) => {
        if (goAdmission?.targeted && goMeter) {
          const reason = targetedBillingHold(
            goMeter.receipt,
            completed && outcome === "RESPONSE_COMPLETE",
          );
          if (reason) holdGo(options.stageFreeze!, reason);
        }
        if (
          firstEcho &&
          !tierChanged &&
          (outcome !== "RESPONSE_COMPLETE" ||
            !confirmedEchoTerminal(terminalCache, terminalUsage) ||
            (terminalCache &&
              terminalCache.frame_index < firstEcho.frame_index) ||
            firstUsageViolation)
        ) {
          await recordPricingDrift(options.root, id, "CACHE_RETENTION", {
            cache_retention: echoObservation(firstEcho),
            echo_stop: firstUsageViolation
              ? "COMPONENT_OVERRUN"
              : !completed || outcome !== "RESPONSE_COMPLETE"
                ? "INCOMPLETE_STREAM"
                : "TERMINAL_ZERO_UNCONFIRMED",
          });
          tierChanged = true;
        }
        const accountingUsage =
          firstUsageViolation ??
          (firstEcho && !tierChanged ? terminalUsage : usage);
        const upper =
          policy &&
          completed &&
          !tierChanged &&
          !invalidLongWriteCount &&
          outcome === "RESPONSE_COMPLETE"
            ? measuredEstimate(
                policy.providers[options.model as StageModel],
                accountingUsage,
                options.model as StageModel,
              )
            : null;
        const flashSchedule =
          policy &&
          completionPolicy(policy) &&
          options.model === "deepseek-flash" &&
          upper !== null
            ? (options.route ? goTariff : flashBilling)(
                upper,
                reservedAt,
                Date.now(),
              )
            : null;
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
            provider: retention
              ? safeRetentionUsage(accountingUsage)
              : accountingUsage,
            ...(firstEcho && !tierChanged
              ? { legacy_echo_disposition: "COMPATIBILITY_ECHO" }
              : {}),
            ...(terminalCache
              ? { terminal_cache_retention: terminalCache }
              : {}),
            ...(invalidLongWriteCount
              ? { invalid_long_write_count: true }
              : {}),
            ...(options.route
              ? {
                  route: options.route,
                  billing_basis: "opencode_go_subscription_allowance",
                  cash_charge_usd: null,
                  go_meter: goMeter!.receipt,
                }
              : {}),
            returned_model: returnedModel,
            ...(flashSchedule ? { scheduled_cost_usd: flashSchedule } : {}),
            ...(policy
              ? {
                  response_complete:
                    completed && outcome === "RESPONSE_COMPLETE",
                  observed_models: observedModels,
                  wire_identity: identity.receipt(
                    completed && outcome === "RESPONSE_COMPLETE",
                  ),
                  ...(terminalTier
                    ? { returned_service_tier: terminalTier }
                    : {}),
                }
              : {}),
          },
          policy
            ? flashSchedule
              ? flashSchedule.exact
              : upper
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
      let observing: Promise<void> = Promise.resolve();
      let settlement: Promise<void> | undefined;
      let cancelling = false;
      // Cancel wakes an outstanding reader.read(). Both paths must await the
      // same commit, including a frame whose ledger write is still in flight.
      const finish = (outcome: string) =>
        (settlement ??= observing.then(
          () => commitSettlement(cancelling ? "CANCELLED_UNCERTAIN" : outcome),
          () => commitSettlement("STREAM_UNCERTAIN"),
        ));
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                await finish("RESPONSE_COMPLETE");
                if (!cancelling) controller.close();
              } else {
                observing = observe(chunk.value);
                await observing;
                if (!cancelling) controller.enqueue(chunk.value);
              }
            } catch (error) {
              await finish("STREAM_UNCERTAIN");
              await reader.cancel().catch(() => {});
              controller.error(safeTransportError(error));
            }
          },
          async cancel() {
            cancelling = true;
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
          request_sha256: bodyHash!,
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
