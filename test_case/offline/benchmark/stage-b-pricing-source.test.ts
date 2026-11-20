import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { mkdir, repository, sha } from "../../online/benchmark/io.ts";
import { pricingEvidence } from "../../online/benchmark/stage-b-pricing-source.ts";
import type {
  ProviderRule,
  StageModel,
} from "../../online/benchmark/stage-b-policy.ts";

type Control = Exclude<StageModel, "deepseek-flash">;
const base = "https://developers.openai.com/api/docs/";
function modelPage(model: Control, rule: ProviderRule) {
  return [
    "# Synthetic model fixture",
    "Model ID: `" + model + "`",
    "- 1,050,000 context window",
    "- 128,000 max output tokens",
    "### Text tokens",
    "| Input | $" + rule.input_rate + " | 1M tokens |",
    "| Cached input | $" + rule.cache_input_rate + " | 1M tokens |",
    "| Cache writes | $" + rule.cache_write_rate + " | 1M tokens |",
    "| Output | $" + rule.output_rate + " | 1M tokens |",
    "- For requests with more than 272K input tokens, input and cache rates double and output costs 1.5 times the short-context rate for the full request.",
  ].join("\n");
}
const caching = [
  "# Synthetic cache fixture",
  '| `"30m"` (default) | 30 minutes | 1.25× the uncached input-token rate |',
  '| `"12h"` | 12 hours | 2.5× the uncached input-token rate |',
  'Omitting both settings preserves the default `"30m"` behavior.',
  [
    "`input_tokens_details.cache_write_tokens_details` breaks writes into `ttl_30m_tokens` and `ttl_12h_tokens`.",
    "These counts do not overlap and sum to `cache_write_tokens`.",
    "Both fields are returned, including when one is zero.",
    "`cached_tokens` counts billed reads and excludes tokens charged as writes.",
  ].join(" "),
  "const cachedTokens = usage.input_tokens_details.cached_tokens;",
  "const cacheWriteTokens = usage.input_tokens_details.cache_write_tokens;",
  "const ordinaryInputTokens = inputTokens - cachedTokens - cacheWriteTokens;",
].join("\n");
const reasoning = [
  "# Synthetic output fixture",
  "You can limit the total number of tokens the model generates, including reasoning tokens, visible output tokens, and non-visible formatting tokens, by using the [`max_output_tokens`](#fixture) parameter.",
  "Although reasoning tokens are not visible via the API, they are billed as [output tokens](#fixture).",
].join("\n");
function documents(t: TestContext, model: Control) {
  const root = fs.mkdtempSync(
    path.join(repository, ".local/benchmark/test-stage-b-source-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "inputs", "official");
  mkdir(dir);
  const rule: ProviderRule = {
    checked_at: new Date().toISOString(),
    published_version: model,
    allowed_returned_models: [model],
    publication_url: base + "models/" + model + ".md",
    tier: "default",
    cache_retention: "default",
    context_band: "all-admitted-input",
    context_upper_tokens: 272000,
    input_rate: model === "gpt-6.2-sol" ? 2 : 0.1,
    cache_input_rate: model === "gpt-6.2-sol" ? 0.1 : 0.01,
    cache_write_rate: model === "gpt-6.2-sol" ? 2.5 : 0.125,
    output_rate: model === "gpt-6.2-sol" ? 10 : 0.5,
    provenance_sha256: "",
    max_input_bytes: 16000,
    max_requested_output: 4096,
    billed_output: "REQUEST_CAP",
  };
  const texts = [modelPage(model, rule), caching, reasoning];
  const urls = [
    rule.publication_url,
    base + "guides/prompt-caching.md",
    base + "guides/reasoning.md",
  ];
  const pages = urls.map((url) => ({ url, sha256: "" }));
  function store(index: number, body: string) {
    const digest = sha(body);
    fs.writeFileSync(path.join(dir, digest + ".source"), body);
    pages[index].sha256 = digest;
    rule.provenance_sha256 = sha(JSON.stringify(pages));
  }
  texts.forEach((text, index) => store(index, text));
  const verify = () =>
    pricingEvidence(
      root,
      model,
      rule,
      {
        context_window: 1050000,
        max_output_tokens: 128000,
        source_sha256: pages[0].sha256,
      },
      pages,
    );
  return { root, dir, rule, pages, texts, verify, store };
}

for (const model of ["gpt-6-luna", "gpt-6.2-sol"] as const) {
  test(
    "binds the model and both guides to exact original bytes for " + model,
    (t) => {
      const f = documents(t, model);
      const evidence = f.verify();
      for (const [field, index] of [
        ["write", 0],
        ["default_ttl", 1],
        ["output_cap", 2],
      ] as const) {
        assert.equal(evidence[field].sha256, f.pages[index].sha256);
        assert.equal(evidence[field].url, f.pages[index].url);
        assert.ok(f.texts[index].includes(evidence[field].quote));
      }
      fs.appendFileSync(path.join(f.dir, f.pages[0].sha256 + ".source"), " ");
      assert.throws(f.verify);
    },
  );
}

test("rejects correctly hashed documents assigned to crossed or unapproved roles", (t) => {
  const f = documents(t, "gpt-6.2-sol");
  f.store(1, f.texts[2]);
  f.store(2, f.texts[1]);
  assert.throws(f.verify);
  f.store(1, f.texts[1]);
  f.store(2, f.texts[2]);
  f.pages[1].url = base + "models/gpt-6-luna.md";
  f.rule.provenance_sha256 = sha(JSON.stringify(f.pages));
  assert.throws(f.verify);
});

test("checks the named model, limits and each labeled price including decimal boundaries", (t) => {
  const f = documents(t, "gpt-6.2-sol");
  for (const [original, change] of [
    ["gpt-6.2-sol", "gpt-6-luna"],
    ["1,050,000", "1,050,001"],
    ["128,000", "127,999"],
    ["272K", "288K"],
    ["| Input | $2 |", "| Input | $2.5 |"],
    ["| Cached input | $0.1 |", "| Cached input | $0.11 |"],
    ["| Cache writes | $2.5 |", "| Cache reads | $2.5 |"],
    ["| Output | $10 |", "| Output | $100 |"],
  ]) {
    f.store(0, f.texts[0].replace(original, change));
    assert.throws(f.verify, /STAGE_B_SOURCE_/, original);
  }
});

test("requires positive source evidence of TTL, disjoint components and billed output semantics", (t) => {
  const f = documents(t, "gpt-6-luna");
  for (const field of [
    "ttl_12h_tokens",
    "sum to",
    "excludes",
    "inputTokens - cachedTokens - cacheWriteTokens",
  ]) {
    f.store(1, f.texts[1].replaceAll(field, "UNKNOWN"));
    assert.throws(f.verify, /STAGE_B_SOURCE_/, field);
  }
  f.store(1, f.texts[1]);
  f.store(
    2,
    f.texts[2].replace(
      "including reasoning tokens",
      "excluding reasoning tokens",
    ),
  );
  assert.throws(f.verify);
});

test("rejects an ambiguous price or a document shell without labeled evidence", (t) => {
  const f = documents(t, "gpt-6-luna");
  f.store(0, f.texts[0] + "\n| Input | $0.2 | 1M tokens |");
  assert.throws(f.verify, /STAGE_B_SOURCE_/);
  f.store(0, "<html><body>Empty app shell</body></html>");
  assert.throws(f.verify, /STAGE_B_SOURCE_/);
});
