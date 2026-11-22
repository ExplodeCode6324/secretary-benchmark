import path from "node:path";
import { read, requireThat, sha } from "./io.ts";
import type { ProviderRule, StageModel } from "./stage-b-policy.ts";

import { capturedPricingEvidence, type SourcePage } from "./stage-b-capture.ts";
type Limits = {
  context_window: number;
  max_output_tokens: number;
  source_sha256: string;
};

export function pricingEvidence(
  root: string,
  model: Exclude<StageModel, "deepseek-flash">,
  rule: ProviderRule,
  limits: Limits,
  pages: SourcePage[],
) {
  if (
    pages.some(
      (p) => p.representation !== undefined || p.review_sha256 !== undefined,
    )
  )
    return capturedPricingEvidence(root, model, rule, limits, pages);
  const base = "https://developers.openai.com/api/docs/";
  const evidence: Record<
    string,
    { url: string; sha256: string; quote: string }
  > = {};
  function document(route: string) {
    const matches = pages.filter((p) => p.url === base + route + ".md");
    requireThat(
      matches.length === 1 && /^[a-f0-9]{64}$/.test(matches[0].sha256),
      "STAGE_B_SOURCE_ROLE",
    );
    const page = matches[0];
    const raw = read(
      path.join(root, "inputs", "official", page.sha256 + ".source"),
    );
    requireThat(sha(raw) === page.sha256, "STAGE_B_SOURCE_BYTES");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return { page, text };
  }
  function fact(
    doc: ReturnType<typeof document>,
    field: string,
    expression: RegExp,
  ) {
    const matches = [
      ...doc.text.matchAll(
        new RegExp(expression.source, expression.flags + "g"),
      ),
    ];
    requireThat(matches.length === 1, "STAGE_B_SOURCE_FACT_" + field);
    evidence[field] = { ...doc.page, quote: matches[0][0] };
    return matches[0];
  }
  const spec = document("models/" + model);
  requireThat(
    spec.page.sha256 === limits.source_sha256 &&
      rule.publication_url === spec.page.url,
    "STAGE_B_SOURCE_ROLE",
  );
  const id = fact(spec, "model", /^Model ID: `([\w.-]+)`\s*$/m)[1];
  requireThat(id === model, "STAGE_B_SOURCE_MODEL");
  for (const [name, re, expected] of [
    ["context_window", /^- ([\d,]+) context window$/m, limits.context_window],
    [
      "max_output_tokens",
      /^- ([\d,]+) max output tokens$/m,
      limits.max_output_tokens,
    ],
  ] as const) {
    requireThat(
      Number(fact(spec, name, re)[1].replaceAll(",", "")) === expected,
      "STAGE_B_SOURCE_LIMIT",
    );
  }
  const pricingSection = spec.text.match(
    /^### Text tokens\s*\n([\s\S]*?)(?=^#{1,3} |(?![\s\S]))/m,
  );
  requireThat(pricingSection, "STAGE_B_SOURCE_PRICING");
  const table = { ...spec, text: pricingSection[1] };
  for (const [name, label, rate] of [
    ["ordinary", "Input", rule.input_rate],
    ["read", "Cached input", rule.cache_input_rate],
    ["write", "Cache writes", rule.cache_write_rate],
    ["output", "Output", rule.output_rate],
  ] as const) {
    const row = new RegExp(
      "^\\|[ \\t]*" +
        label +
        "[ \\t]*\\|[ \\t]*\\$([0-9]+(?:\\.[0-9]+)?)[ \\t]*\\|[ \\t]*1M tokens[ \\t]*\\|[ \\t]*$",
      "m",
    );
    requireThat(
      Number(fact(table, name, row)[1]) === rate,
      "STAGE_B_SOURCE_RATE",
    );
  }
  fact(
    table,
    "band",
    /^- (?:For requests with more than 272K input tokens, input and cache rates double and output costs 1\.5 times the short-context rate|Prompts with more than 272K input tokens are priced at 2x input and cache rates and 1\.5x output) for the full request\./m,
  );
  const cache = document("guides/prompt-caching");
  fact(
    cache,
    "default_ttl",
    /^\|\s*`"30m"` \(default\)\s*\|\s*30 minutes\s*\|\s*1\.25× the uncached input-token rate\s*\|/m,
  );
  fact(
    cache,
    "extended_ttl",
    /^\|\s*`"12h"`\s*\|\s*12 hours\s*\|\s*2\.5× the uncached input-token rate\s*\|/m,
  );
  fact(
    cache,
    "usage_split",
    /`input_tokens_details\.cache_write_tokens_details` breaks writes into `ttl_30m_tokens` and `ttl_12h_tokens`\. These counts do not overlap and sum to `cache_write_tokens`\. Both fields are returned, including when one is zero\. `cached_tokens` counts billed reads and excludes tokens charged as writes/,
  );
  fact(
    cache,
    "ordinary_input",
    /ordinaryInputTokens\s*=\s*inputTokens\s*-\s*cachedTokens\s*-\s*cacheWriteTokens/,
  );
  fact(
    cache,
    "read_counter",
    /const cachedTokens = usage\.input_tokens_details\.cached_tokens/,
  );
  fact(
    cache,
    "write_counter",
    /const cacheWriteTokens = usage\.input_tokens_details\.cache_write_tokens/,
  );
  const reasoning = document("guides/reasoning");
  fact(
    reasoning,
    "output_cap",
    /limit the total number of tokens the\s+model generates, including reasoning tokens, visible output tokens, and non-visible\s+formatting tokens, by using the\s+\[`max_output_tokens`\]/,
  );
  fact(
    reasoning,
    "reasoning_billed",
    /reasoning tokens are not visible via the API, they (?:still occupy space in\s+the model.s context window and )?are billed as \[output\s+tokens\]/,
  );
  return evidence;
}
