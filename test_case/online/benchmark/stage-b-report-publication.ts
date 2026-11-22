import { usesCapturedSchedule } from "./stage-b-capture.ts";
import fs from "node:fs";
import path from "node:path";
import { read, requireThat, sha } from "./io.ts";
import { type ProviderRule, type StageModel } from "./stage-b-policy.ts";

type Observation = {
  model: StageModel;
  point: string;
  at: string;
  status: "MATCH" | "CAPTURE_MATCH" | "CHANGED" | "UNAVAILABLE";
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
type IdentityAttempt = {
  outcome: string;
  returned_model_sha256: string | null;
  settled_sequence?: number | null;
};
/** Physical settlements carry model-wide transitions, including those first observed in a probe. */
export function projectedIdentity(
  rule: ProviderRule,
  model: StageModel,
  attempts: IdentityAttempt[],
) {
  const allowed = rule.allowed_returned_models.map((id) => sha(id));
  let matched: string | null = null;
  for (const row of [...attempts].sort(
    (a, b) =>
      (a.settled_sequence ?? Infinity) - (b.settled_sequence ?? Infinity),
  )) {
    if (row.outcome === "IDENTITY_MISMATCH_FIRST_CONTACT")
      return "SEGREGATED_IDENTITY_MISMATCH_FIRST_CONTACT";
    if (row.outcome === "VERSION_TRANSITION")
      return "SEGREGATED_VERSION_TRANSITION";
    if (row.outcome === "IDENTITY_UNKNOWN")
      return "SEGREGATED_IDENTITY_UNKNOWN";
    const id = row.returned_model_sha256;
    if (!id) continue;
    if (matched && matched !== id) return "SEGREGATED_VERSION_TRANSITION";
    if (!allowed.includes(id))
      return "SEGREGATED_IDENTITY_MISMATCH_FIRST_CONTACT";
    matched = id;
  }
  return !matched
    ? "NO_RETURNED_IDENTIFIER"
    : matched === sha(model)
      ? usesCapturedSchedule(rule)
        ? "BACKEND_UNVERIFIED_ALIAS_ONLY"
        : "SEE_PER_LANE_PUBLICATION_WINDOW"
      : "FROZEN_RETURNED_IDENTIFIER";
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
  const identity = projectedIdentity(rule, model, attempts);
  if (
    identity === "SEGREGATED_VERSION_TRANSITION" ||
    identity === "SEGREGATED_IDENTITY_MISMATCH_FIRST_CONTACT"
  )
    return identity;
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
  const captured = usesCapturedSchedule(rule);
  const expectedStatus = captured ? "CAPTURE_MATCH" : "MATCH";
  const match = (e: Observation) =>
    e?.status === expectedStatus &&
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
    return captured
      ? "SEGREGATED_CAPTURE_INTEGRITY_CHANGE"
      : "SEGREGATED_PUBLICATION_TRANSITION";
  if (
    !captured &&
    identity === "FROZEN_RETURNED_IDENTIFIER" &&
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
    return captured
      ? "SEGREGATED_CAPTURE_UNCERTAIN"
      : "SEGREGATED_PUBLICATION_UNCERTAIN";
  const final = entries.filter((e) => e.point === "campaign:end");
  if (
    !endChecked ||
    final.length !== 1 ||
    !match(final[0]) ||
    !(Date.parse(final[0].at) >= Date.parse(end[0].at))
  )
    return captured
      ? "HELD_CAMPAIGN_END_CAPTURE_CHECK"
      : "HELD_CAMPAIGN_END_PUBLICATION";
  return captured
    ? "BACKEND_UNVERIFIED_ALIAS_ONLY"
    : "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN";
}
export const gradableIdentity = (s: string) =>
  [
    "BACKEND_UNVERIFIED_ALIAS_ONLY",
    "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN",
    "FROZEN_RETURNED_IDENTIFIER",
  ].includes(s);
