import { isDeepStrictEqual } from "node:util";
import { requireThat, sha } from "./io.ts";
import type { ProviderRule } from "./stage-b-policy.ts";

export const goAPI = "https://opencode.ai/inference/go/openai/v1";
export const goCatalogue = "https://opencode.ai/inference/go/v1/models";
export const goUsage = "https://opencode.ai/inference/go/v1/usage";
export const goModel = "deepseek-v4.1-flash";
export const goCanonicalModel = "deepseek/deepseek-v4.1-flash-1017";
export const goVersion = "DeepSeek V4.1 Flash 1017";
const multiplier = [
  {
    when: {
      utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
      any: [
        {
          all: [
            { utc_hours: { gte: "01:00" } },
            { utc_hours: { lt: "04:00" } },
          ],
        },
        {
          all: [
            { utc_hours: { gte: "06:00" } },
            { utc_hours: { lt: "10:00" } },
          ],
        },
      ],
    },
    factor: 2,
  },
];

export function goModelRule(model: any, checked: string): ProviderRule {
  requireThat(
    model?.id === goModel &&
      model.canonical_id === goCanonicalModel &&
      model.name === goVersion &&
      model.api?.["chat-completions"]?.base_url === goAPI &&
      model.go?.monthly_usage?.go === 100 &&
      model.go?.monthly_usage?.["go-plus"] === 200 &&
      model.go?.monthly_usage?.["go-teams"] === 105 &&
      model.go.training === false &&
      model.go.zdr === true &&
      model.capabilities?.tools?.supported === true &&
      model.capabilities?.reasoning?.effort?.includes("max") &&
      model.limit?.context === 1_000_000 &&
      model.limit?.output === 384_000 &&
      model.cost?.text?.input?.price === 0.15 &&
      model.cost.text.input.cache?.read === 0.003 &&
      model.cost.text.output?.price === 0.6 &&
      isDeepStrictEqual(model.cost.multipliers, multiplier),
    "STAGE_C_GO_MODEL_OR_PRICE_CHANGED",
  );
  const source = {
    id: goModel,
    canonical: model.canonical_id,
    name: model.name,
    api: goAPI,
    limit: model.limit,
    cost: model.cost,
    capabilities: model.capabilities,
    go: model.go,
  };
  return {
    route: "opencode-go",
    checked_at: checked,
    published_version: goVersion,
    allowed_returned_models: [goModel, goCanonicalModel],
    publication_url: goCatalogue,
    tier: "default",
    cache_retention: "default",
    context_band: "all-admitted-input",
    context_upper_tokens: model.limit.context,
    provenance_sha256: sha(JSON.stringify(source)),
    input_rate: 0.3,
    cache_write_rate: 0.3,
    cache_input_rate: 0.006,
    output_rate: 1.2,
    max_input_bytes: 1_000_000,
    max_requested_output: 384000,
    billed_output: 393216,
  };
}
export function goCredential() {
  const key = process.env.SECRETARY_BENCHMARK_GO_API_KEY;
  requireThat(
    typeof key === "string" && key.length > 10 && !/[\r\n]/.test(key),
    "STAGE_C_GO_CREDENTIAL_UNAVAILABLE",
  );
  return key;
}
export async function checkGoProvider(
  rule: ProviderRule,
  transport: typeof fetch = fetch,
) {
  const read = async (url: string) => {
    const r = await transport(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    requireThat(
      r.ok,
      r.status === 401
        ? "GO_CREDENTIAL_INVALID"
        : r.status === 403
          ? "GO_SUBSCRIPTION_UNAVAILABLE"
          : "GO_METADATA_UNAVAILABLE",
    );
    return r.json();
  };
  const catalogue = await read(goCatalogue);
  const models = catalogue.data?.filter((m: any) => m.id === goModel);
  requireThat(
    models?.length === 1 &&
      goModelRule(models[0], rule.checked_at).provenance_sha256 ===
        rule.provenance_sha256,
    "GO_PUBLICATION_CHANGED",
  );
  return checkGoUsage(goCredential(), transport);
}
export async function checkGoUsage(
  key: string,
  transport: typeof fetch,
  signal = AbortSignal.timeout(15000),
) {
  const r = await transport(goUsage, {
    headers: { authorization: "Bearer " + key },
    redirect: "error",
    signal,
  });
  requireThat(
    r.ok,
    r.status === 401
      ? "GO_CREDENTIAL_INVALID"
      : r.status === 403
        ? "GO_SUBSCRIPTION_UNAVAILABLE"
        : "GO_METADATA_UNAVAILABLE",
  );
  const usage = await r.json();
  requireThat(
    ["rolling", "weekly", "monthly"].every(
      (k) =>
        usage.usage?.[k]?.status === "ok" &&
        Number.isFinite(usage.usage[k].percent) &&
        usage.usage[k].percent >= 0 &&
        usage.usage[k].percent <= 100 &&
        Number.isFinite(Date.parse(usage.usage[k].resetsAt)),
    ),
    "GO_SUBSCRIPTION_QUOTA_HOLD",
  );
  return usage.usage;
}

// The subscription publishes UTC weekdays and hours. A request crossing a price
// boundary retains its range because the provider does not identify its pricing instant.
export function goTariff(peak: number, from: number, to: number) {
  const factor = (ms: number) => {
    const d = new Date(ms),
      h = d.getUTCHours();
    return d.getUTCDay() > 0 &&
      d.getUTCDay() < 6 &&
      ((h >= 1 && h < 4) || (h >= 6 && h < 10))
      ? 1
      : 0.5;
  };
  let low = factor(from),
    high = low;
  for (
    let t = (Math.floor(from / 3600000) + 1) * 3600000;
    t <= to;
    t += 3600000
  ) {
    const f = factor(t);
    low = Math.min(low, f);
    high = Math.max(high, f);
  }
  return {
    minimum: peak * low,
    maximum: peak * high,
    exact: low === high ? peak * low : null,
    basis: "OpenCode Go subscription tariff equivalent",
  };
}

export function goResponseMeter() {
  const receipt: {
    allowance: unknown;
    reported_cost: unknown;
    list_cost: number | null;
    cash_debit_usd: number | null;
    billing_source: string | null;
    identity: Record<string, string>;
  } = {
    allowance: null,
    reported_cost: null,
    list_cost: null,
    cash_debit_usd: null,
    billing_source: null,
    identity: {},
  };
  function amount(v: unknown): boolean {
    return (
      (typeof v === "number" && Number.isFinite(v) && v >= 0) ||
      (typeof v === "string" &&
        /^[0-9]+(?:\.[0-9]+)?$/.test(v) &&
        v.length <= 40)
    );
  }
  return {
    receipt,
    observe(frame: any) {
      if (amount(frame.usage?.cost))
        receipt.cash_debit_usd = Number(frame.usage.cost);
      for (const data of [frame?.opencode, frame?.usage?.opencode]) {
        if (!data || typeof data !== "object") continue;
        if (amount(data.list_cost)) receipt.list_cost = Number(data.list_cost);
        if (
          ["free", "balance", "go", "go-plus", "go-teams", "byok"].includes(
            data.billing_source,
          )
        )
          receipt.billing_source = data.billing_source;
        if (amount(data.cost)) receipt.reported_cost = data.cost;
        if (amount(data.allowance)) receipt.allowance = data.allowance;
        else if (data.allowance && typeof data.allowance === "object")
          receipt.allowance = Object.fromEntries(
            Object.entries(data.allowance).filter(
              ([k, v]) => /^[A-Za-z_]{1,50}$/.test(k) && amount(v),
            ),
          );
        for (const k of ["model", "provider", "version"])
          if (
            typeof data[k] === "string" &&
            /^[A-Za-z0-9_.:/-]{1,150}$/.test(data[k])
          )
            receipt.identity[k] = data[k];
      }
    },
  };
}

export function targetedBillingHold(
  receipt: ReturnType<typeof goResponseMeter>["receipt"],
  complete: boolean,
) {
  if (!complete) return "GO_TARGETED_TRANSPORT_UNCERTAIN";
  if (
    !["free", "go", "go-plus", "go-teams"].includes(
      receipt.billing_source ?? "",
    ) ||
    receipt.cash_debit_usd !== 0
  )
    return "GO_UNCONFIRMED_SUBSCRIPTION_BILLING";
  return null;
}
