import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  mkdir,
  read,
  readJSON,
  repository,
  sha,
  writeJSON,
} from "../../online/benchmark/io.ts";
import { stageCommand } from "../../online/benchmark/stage-b-cli.ts";
import {
  freezeFile,
  reviewedB0Receipt,
} from "../../online/benchmark/stage-b-freeze.ts";
import { prepareStageBCalibration } from "../../online/benchmark/stage-b-report-calibration.ts";
import { stageModels } from "../../online/benchmark/stage-b-policy.ts";
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
function sourceRoot(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(repository, ".local/benchmark/test-stage-b-source-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function documents(t: TestContext, model: Control, root = sourceRoot(t)) {
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

test("Stage B prepare seals a dossier only after local evidence, wire bounds and fresh publication bytes match", async (t) => {
  const root = sourceRoot(t);
  const receipt = await prepareStageBCalibration(root);
  const sol = documents(t, "gpt-6.2-sol", root);
  const luna = documents(t, "gpt-6-luna", root);
  const bodies = new Map<string, string>();
  for (const control of [sol, luna])
    control.pages.forEach((page, index) =>
      bodies.set(page.url, control.texts[index]),
    );
  const flashPages = ["pricing", "model"].map((label) => {
    const url = "https://api-docs.deepseek.com/fixture/" + label;
    const body = "Synthetic Flash " + label;
    bodies.set(url, body);
    return { url, sha256: sha(body) };
  });
  const flash: ProviderRule = {
    ...luna.rule,
    published_version: "deepseek-flash",
    allowed_returned_models: ["deepseek-flash"],
    publication_url: flashPages[0].url,
    provenance_sha256: sha(JSON.stringify(flashPages)),
    input_rate: 1,
    cache_input_rate: 0.1,
    cache_write_rate: 1,
    output_rate: 2,
    billed_output: 393216,
  };
  const providers = {
    "gpt-6-luna": luna.rule,
    "gpt-6.2-sol": sol.rule,
    "deepseek-flash": flash,
  };
  const sources = {
    "gpt-6-luna": luna.pages,
    "gpt-6.2-sol": sol.pages,
    "deepseek-flash": flashPages,
  };
  const inputs = {
    c16_decision: "DEFERRED_BY_DECISION",
    providers,
    sources,
    descriptors: Object.fromEntries(
      stageModels.map((model) => [
        model,
        {
          context_window: model === "deepseek-flash" ? 1000000 : 1050000,
          max_output_tokens: model === "deepseek-flash" ? 393216 : 128000,
          source_sha256: sources[model][0].sha256,
        },
      ]),
    ),
    forecast: Object.fromEntries(
      stageModels.map((model) => [
        model,
        {
          ordinary_sends_per_turn: 1,
          extra_task_sends: 1,
          sends_per_maintenance: 1,
          seconds_per_send: 1,
          restart_seconds: 2,
          observation_seconds: 1,
          expected_input_tokens: 50,
          expected_output_tokens: 10,
        },
      ]),
    ),
    calibration_packet_sha256: receipt.packet_sha256,
    calibration_key_sha256: receipt.private_key_sha256,
  };
  const samples = stageModels.map((model) => ({
    model,
    bytes: 350 + model.length,
    output_cap: 128,
    sha256: sha(model + " sample"),
    endpoint:
      model === "deepseek-flash"
        ? "https://api.deepseek.com/chat/completions"
        : "https://api.openai.com/v1/responses",
  }));
  const fixtureB0 = {
    schema: "issue122-b0-v1",
    source: { sut: { commit: "873b66f4b906ff53a62476ff5dd1466649c427f7" } },
    serialized_samples: { requests: samples },
    slots: Array.from({ length: 12 }, (_, index) => ({
      profiles: ["DEP", "RC98304_CANDIDATE"].map((profile) => ({
        capacity: {
          profile,
          model: stageModels[index % 3],
          recent_input_byte_allowance: 4259.8,
          budget: {
            estimated_tokens: 19336,
            usable_input_tokens: 85196,
            occupancy: 19336 / 85196,
          },
          effective_policy: { target: 0.3, normal: 0.6, forced: 0.8 },
          window: { count: 2 },
        },
      })),
    })),
  };
  const inputFile = path.join(root, "configs/stage-b-inputs.json");
  const b0File = path.join(root, "configs/issue122-b0.json");
  writeJSON(inputFile, inputs);
  writeJSON(b0File, fixtureB0);
  const file = freezeFile(root);
  const prepare = () =>
    stageCommand("baseline-stage-b-prepare", root, { "--root": root });
  const noFreeze = () => assert.equal(fs.existsSync(file), false);

  let latestModelPage: "MATCH" | "CHANGED" | "UNAVAILABLE" = "MATCH";
  const fetched = new Set<string>();
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      const original = bodies.get(url);
      assert.notEqual(original, undefined, "unexpected network target " + url);
      fetched.add(url);
      if (url === sol.rule.publication_url) {
        if (latestModelPage === "UNAVAILABLE")
          return new Response(null, { status: 503 });
        if (latestModelPage === "CHANGED") return new Response(original + "\n");
      }
      return new Response(original);
    },
  );
  await assert.rejects(prepare, /STAGE_B_B0_RECEIPT_CHANGED/);
  noFreeze();
  assert.equal(fetched.size, 0);
  // Only the private historic B0 receipt is substituted. The command still
  // acquires its facility lease, verifies calibration, rebuilds the matrix and
  // reads original source files through the same code as a live preparation.
  t.mock.method(reviewedB0Receipt, "read", (facility: string) => {
    assert.equal(facility, root);
    const bytes = read(b0File);
    return { b0: JSON.parse(bytes.toString("utf8")), b0_sha256: sha(bytes) };
  });

  const checked = flash.checked_at;
  flash.checked_at = new Date(Date.now() - 25 * 3600000).toISOString();
  writeJSON(inputFile, inputs);
  await assert.rejects(prepare, /STAGE_B_STALE_PROVENANCE/);
  noFreeze();
  assert.equal(fetched.size, 0);
  flash.checked_at = checked;
  const validCap = luna.rule.max_input_bytes;
  luna.rule.max_input_bytes =
    samples.find((s) => s.model === "gpt-6-luna")!.bytes - 1;
  writeJSON(inputFile, inputs);
  await assert.rejects(prepare, /STAGE_B_BODY_BOUND/);
  noFreeze();
  assert.equal(fetched.size, 0);
  luna.rule.max_input_bytes = validCap;
  writeJSON(inputFile, inputs);
  for (const [state, reason] of [
    ["CHANGED", /STAGE_B_PROVENANCE_CHANGE/],
    ["UNAVAILABLE", /STAGE_B_PUBLICATION_UNAVAILABLE/],
  ] as const) {
    latestModelPage = state;
    fetched.clear();
    await assert.rejects(prepare, reason);
    noFreeze();
    assert.ok(fetched.has(sol.rule.publication_url));
  }
  latestModelPage = "MATCH";
  fetched.clear();
  const result = await prepare();
  assert.ok(result && "sha256" in result);
  assert.equal(result.sha256, sha(read(file)));
  assert.deepEqual(fetched, new Set(bodies.keys()));
  const frozen = readJSON(file);
  assert.equal(frozen.worklist.length, 12);
  for (const row of frozen.worklist) {
    assert.deepEqual(row.representative_body, {
      source: "B0 C05-W Main",
      ...samples.find((s) => s.model === row.model),
      max_input_bytes: validCap,
      future_body_sizes: "UNKNOWN",
    });
  }
  for (const control of [sol, luna]) {
    const facts = frozen.verified_facts[control.rule.published_version];
    for (const [key, i] of [
      ["write", 0],
      ["usage_split", 1],
      ["output_cap", 2],
    ] as const) {
      assert.equal(facts[key].sha256, control.pages[i].sha256);
      assert.equal(facts[key].url, control.pages[i].url);
      assert.ok(control.texts[i].includes(facts[key].quote));
    }
  }
});
