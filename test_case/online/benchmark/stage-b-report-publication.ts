import fs from "node:fs";
import path from "node:path";
import { read, requireThat, sha } from "./io.ts";
import { type ProviderRule, type StageModel } from "./stage-b-policy.ts";

type Observation = {
  model: StageModel;
  point: string;
  at: string;
  status: "MATCH" | "CHANGED" | "UNAVAILABLE";
  pages?: unknown;
};
export function publicationLog(root: string): Observation[] {
  const file = path.join(root, "campaign/publication.jsonl");
  if (!fs.existsSync(file)) return [];
  const bytes = read(file).toString();
  requireThat(bytes.endsWith("\n"), "STAGE_B_PARTIAL_PUBLICATION_LOG");
  return bytes
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}
export function attributeLane(
  log: Observation[],
  lane: string,
  model: StageModel,
  rule: ProviderRule | undefined,
  attempts: {
    at: string;
    settled_at: string | null;
    outcome: string;
    returned_model_sha256: string | null;
  }[],
  endChecked: boolean,
) {
  if (!rule || !attempts.length) return "UNEXERCISED";
  const entries = log.filter((e) => e.model === model);
  if (
    attempts.some(
      (a) =>
        a.outcome === "VERSION_TRANSITION" ||
        (a.returned_model_sha256 &&
          a.returned_model_sha256 !== sha(rule.allowed_returned_model)),
    )
  )
    return "SEGREGATED_VERSION_TRANSITION";
  if (
    !attempts.some((a) => a.outcome === "RESPONSE_COMPLETE") ||
    attempts.some(
      (a) =>
        (a.outcome === "RESPONSE_COMPLETE" && !a.returned_model_sha256) ||
        a.outcome === "IDENTITY_UNKNOWN" ||
        !a.settled_at,
    )
  )
    return "SEGREGATED_IDENTITY_UNKNOWN";
  const first = Math.min(...attempts.map((a) => Date.parse(a.at)));
  const last = Math.max(
    ...attempts.map((a) => Date.parse(a.settled_at ?? a.at)),
  );
  const match = (e: Observation) =>
    e?.status === "MATCH" &&
    Array.isArray(e.pages) &&
    sha(JSON.stringify(e.pages)) === rule.provenance_sha256;
  const start = entries.filter((e) => e.point === lane + ":start"),
    end = entries.filter((e) => e.point === lane + ":end");
  if (
    entries.some(
      (e) =>
        e.status === "CHANGED" &&
        ((Date.parse(e.at) >= first && Date.parse(e.at) <= last) ||
          e.point === lane + ":end"),
    )
  )
    return "SEGREGATED_PUBLICATION_TRANSITION";
  if (
    rule.allowed_returned_model !== model &&
    !entries.some((e) => e.status !== "MATCH")
  )
    return "FROZEN_RETURNED_IDENTIFIER";
  if (
    start.length !== 1 ||
    end.length !== 1 ||
    !match(start[0]) ||
    !match(end[0]) ||
    Date.parse(start[0].at) > first ||
    Date.parse(end[0].at) < last ||
    !Number.isFinite(Date.parse(start[0].at)) ||
    !Number.isFinite(Date.parse(end[0].at)) ||
    entries.some(
      (e) =>
        !match(e) &&
        Date.parse(e.at) >= Date.parse(start[0].at) &&
        Date.parse(e.at) <= Date.parse(end[0].at),
    )
  )
    return "SEGREGATED_PUBLICATION_UNCERTAIN";
  const final = entries.filter((e) => e.point === "campaign:end");
  if (
    !endChecked ||
    final.length !== 1 ||
    !match(final[0]) ||
    !(Date.parse(final[0].at) >= Date.parse(end[0].at))
  )
    return "HELD_CAMPAIGN_END_PUBLICATION";
  return "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN";
}
export const gradableIdentity = (s: string) =>
  [
    "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN",
    "FROZEN_RETURNED_IDENTIFIER",
  ].includes(s);
