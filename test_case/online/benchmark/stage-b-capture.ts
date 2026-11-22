import path from "node:path";
import { read, requireThat, sha } from "./io.ts";
import type { ProviderRule, StageModel } from "./stage-b-policy.ts";

type Control = Exclude<StageModel, "deepseek-flash">;
export type SourcePage = {
  url: string;
  sha256: string;
  representation?: "CLAUDE_WEBFETCH_FILE";
  review_sha256?: string;
};

const base = "https://developers.openai.com/api/docs/";
const reviewHash =
  "ddbabe153a23849efd36d1aeff4a8edd95154b7f7ada6ead77c439d2894d9f99";
const capturedAt = "2026-11-22T17:00:32.283Z";
const roles = {
  sol: [
    "models/gpt-6.2-sol",
    "5879adc26f8e257e594aabead9848965a4fa2c6ed7839cc6be310687d90d9049",
  ],
  luna: [
    "models/gpt-6-luna",
    "df376caeac4b19920ca4cac682947c954daef21e2014af891eb6340970b97b94",
  ],
  cache: [
    "guides/prompt-caching",
    "141f0739d81b13da41f802f81d8f60764511e7894583f46a6657ed23b813c7a5",
  ],
  reasoning: [
    "guides/reasoning",
    "f1a181f2be78927ac766a5979a3aba3aa4354dc478c7a11e145b8e520be12ae8",
  ],
} as const;
type Role = keyof typeof roles;
const sourceRoles = (model: Control): Role[] => [
  model === "gpt-6.2-sol" ? "sol" : "luna",
  "cache",
  "reasoning",
];
function acceptedPage(role: Role): SourcePage {
  const [route, sha256] = roles[role];
  return {
    url: base + route + ".md",
    sha256,
    representation: "CLAUDE_WEBFETCH_FILE",
    review_sha256: reviewHash,
  };
}
export const acceptedPages = (model: Control) =>
  sourceRoles(model).map(acceptedPage);
const controlHashes = new Set(
  (["gpt-6.2-sol", "gpt-6-luna"] as const).map((model) =>
    sha(JSON.stringify(acceptedPages(model))),
  ),
);
export const usesCapturedSchedule = (rule?: ProviderRule) =>
  !!rule && controlHashes.has(rule.provenance_sha256);

function evidenceBytes(root: string, hash: string) {
  requireThat(/^[0-9a-f]{64}$/.test(hash), "STAGE_B_SOURCE_DIGEST");
  const raw = read(path.join(root, "inputs", "official", hash + ".source"));
  requireThat(sha(raw) === hash, "STAGE_B_PROVENANCE_CHANGE");
  return raw;
}
export function checkCaptureFile(root: string | undefined, page: SourcePage) {
  requireThat(
    root &&
      Object.values(roles).some(
        ([route, hash]) =>
          page.url === base + route + ".md" && page.sha256 === hash,
      ) &&
      page.representation === "CLAUDE_WEBFETCH_FILE" &&
      page.review_sha256 === reviewHash,
    "STAGE_B_SOURCE_CAPTURE",
  );
  return evidenceBytes(root, page.sha256);
}

type ReviewedPage = {
  url: string;
  sha256: string;
  corroboration: { url: string; sha256: string };
  facts: Record<
    string,
    { status: string; quote: string; official_text: string }
  >;
  numbers: Record<string, number>;
  supplemental_max_input?: { status: string; tokens: number };
};
const modelFacts = [
  "model",
  "endpoint",
  "context_window",
  "max_output_tokens",
  "band",
  "ordinary",
  "read",
  "write",
  "output",
];
const fields: Record<Role, string[]> = {
  sol: modelFacts,
  luna: modelFacts,
  cache: [
    "default_ttl",
    "extended_ttl",
    "usage_split",
    "ordinary_input",
    "read_counter",
    "write_counter",
  ],
  reasoning: ["output_cap", "reasoning_billed"],
};

export function capturedPricingEvidence(
  root: string,
  model: Control,
  rule: ProviderRule,
  limits: {
    source_sha256: string;
    context_window: number;
    max_output_tokens: number;
  },
  pages: SourcePage[],
) {
  const orderedRoles = sourceRoles(model);
  const expected = acceptedPages(model);
  requireThat(
    JSON.stringify(pages) === JSON.stringify(expected) &&
      usesCapturedSchedule(rule) &&
      rule.checked_at === capturedAt &&
      rule.publication_url === expected[0].url &&
      limits.source_sha256 === expected[0].sha256 &&
      rule.published_version === model &&
      JSON.stringify(rule.allowed_returned_models) === JSON.stringify([model]),
    "STAGE_B_SOURCE_CAPTURE_DOSSIER",
  );
  const reviewed = JSON.parse(evidenceBytes(root, reviewHash).toString()) as {
    schema: string;
    captured_at: string;
    pages: Record<Role, ReviewedPage>;
  };
  requireThat(
    reviewed.schema === "issue122-accepted-claude-files-v1" &&
      reviewed.captured_at === capturedAt &&
      Object.keys(reviewed.pages).sort().join() ===
        Object.keys(roles).sort().join(),
    "STAGE_B_SOURCE_CAPTURE_REVIEW",
  );
  const spec = reviewed.pages[orderedRoles[0]];
  const n = spec.numbers;
  requireThat(
    n.context_window === limits.context_window &&
      n.max_output_tokens === limits.max_output_tokens &&
      n.ordinary === rule.input_rate &&
      n.read === rule.cache_input_rate &&
      n.write === rule.cache_write_rate &&
      n.output === rule.output_rate &&
      spec.supplemental_max_input?.status === "CONFIRMED" &&
      spec.supplemental_max_input.tokens === n.max_input_tokens &&
      rule.context_upper_tokens <= n.max_input_tokens &&
      rule.billed_output === "REQUEST_CAP",
    "STAGE_B_SOURCE_CAPTURE_RULE",
  );
  const labels = {
    ordinary: "Input",
    read: "Cached input",
    write: "Cache writes",
    output: "Output",
  };
  for (const [key, label] of Object.entries(labels)) {
    const fact = spec.facts[key];
    const captureRate = fact?.quote.match(
      /^\| ([^|]+) \| \$([0-9.]+) \| 1M tokens \|$/,
    );
    const browserRate = fact?.official_text.match(/^([^\n]+)\n\$([0-9.]+)$/);
    requireThat(
      captureRate?.[1] === label &&
        browserRate?.[1] === label &&
        Number(captureRate[2]) === n[key] &&
        Number(browserRate[2]) === n[key],
      "STAGE_B_SOURCE_CAPTURE_RATE",
    );
  }
  const facts: Record<
    string,
    { url: string; sha256: string; quote: string; representation: string }
  > = {};
  for (const [i, role] of orderedRoles.entries()) {
    const page = pages[i],
      reviewedPage = reviewed.pages[role];
    const capture = checkCaptureFile(root, page).toString("utf8"),
      browser = evidenceBytes(root, reviewedPage.corroboration.sha256).toString(
        "utf8",
      );
    requireThat(
      reviewedPage.url === page.url &&
        reviewedPage.sha256 === page.sha256 &&
        Object.keys(reviewedPage.facts).sort().join() ===
          [...fields[role]].sort().join(),
      "STAGE_B_SOURCE_CAPTURE_FACTS",
    );
    for (const [key, fact] of Object.entries(reviewedPage.facts)) {
      requireThat(
        fact.status === "CONFIRMED" &&
          fact.quote &&
          capture.indexOf(fact.quote) >= 0 &&
          capture.indexOf(fact.quote) === capture.lastIndexOf(fact.quote) &&
          fact.official_text &&
          browser.includes(fact.official_text),
        "STAGE_B_SOURCE_CAPTURE_UNCONFIRMED",
      );
      facts[key] = {
        ...page,
        representation: "CLAUDE_WEBFETCH_FILE",
        quote: fact.quote,
      };
      facts["corroborated_" + key] = {
        ...reviewedPage.corroboration,
        representation: "CHROME_RENDERED_TEXT",
        quote: fact.official_text,
      };
    }
  }
  facts.independent_review = {
    url: rule.publication_url,
    sha256: reviewHash,
    quote: capturedAt,
    representation: "INDEPENDENT_REVIEW_RECEIPT",
  };
  return facts;
}
