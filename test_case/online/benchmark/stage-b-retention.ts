import { requireThat } from "./io.ts";

export const retentionContract = "responses-ttl-30m-v1" as const;
export const echoContract = "responses-legacy-echo-v2" as const;
export const echoPriceBasis =
  "INFERRED_FROM_SEPARATE_LEGACY_CONTROL_AND_LIFETIME_WRITE_COUNTS" as const;
export type RetentionContract = typeof retentionContract | typeof echoContract;
const modern = ["30m", "12h"] as const;
const legacy = ["in_memory", "24h"] as const;
const modes = ["implicit", "explicit"] as const;
const frameTypes = [
  "response.created",
  "response.in_progress",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "response.output_item.added",
  "response.output_item.done",
  "response.output_text.delta",
  "response.output_text.done",
] as const;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function observed<T extends string>(
  v: unknown,
  values: readonly T[],
): T | "MISSING" | "UNRECOGNIZED" {
  return v == null
    ? "MISSING"
    : (values.find((item) => item === v) ?? "UNRECOGNIZED");
}
function scope(response: any) {
  const options = response?.prompt_cache_options;
  const details = response?.usage?.input_tokens_details;
  const breakdown = details?.cache_write_tokens_details;
  const count = breakdown?.ttl_12h_tokens;
  return {
    options:
      options == null
        ? ("MISSING" as const)
        : !object(options)
          ? ("INVALID" as const)
          : Object.keys(options).every((k) => k === "ttl" || k === "mode")
            ? ("OBJECT" as const)
            : ("UNDOCUMENTED_OPTION" as const),
    mode: observed(options?.mode, modes),
    modern_ttl: observed(options?.ttl, modern),
    legacy_retention: observed(response?.prompt_cache_retention, legacy),
    long_writes:
      !object(details) || !Object.hasOwn(details, "cache_write_tokens_details")
        ? ("MISSING" as const)
        : !object(breakdown) || !Number.isSafeInteger(count) || count < 0
          ? ("INVALID" as const)
          : count === 0
            ? ("ZERO" as const)
            : ("POSITIVE" as const),
  };
}
export function retentionFrame(event: any, index: number) {
  return {
    frame_type:
      frameTypes.find((v) => event?.type === v) ??
      (event?.type == null ? ("MISSING" as const) : ("OTHER" as const)),
    frame_index: index,
    frame: scope(event),
    response: scope(event?.response),
  };
}
export type RetentionFrame = ReturnType<typeof retentionFrame>;
const counterField =
  "usage.input_tokens_details.cache_write_tokens_details.ttl_12h_tokens" as const;
const checks = [
  ["long_writes", ["POSITIVE"], counterField],
  ["options", ["INVALID", "UNDOCUMENTED_OPTION"], "prompt_cache_options"],
  ["mode", ["UNRECOGNIZED"], "prompt_cache_options.mode"],
  ["modern_ttl", ["UNRECOGNIZED", "12h"], "prompt_cache_options.ttl"],
  ["legacy_retention", ["UNRECOGNIZED", "24h"], "prompt_cache_retention"],
] as const;
export function retentionFinding(snapshot: RetentionFrame, deferEcho = false) {
  for (const [key, failures, field] of checks)
    for (const scope of ["frame", "response"] as const)
      if (
        !(
          deferEcho &&
          key === "legacy_retention" &&
          snapshot[scope][key] === "24h"
        ) &&
        (failures as readonly string[]).includes(snapshot[scope][key])
      )
        return {
          reason:
            field === counterField
              ? ("CACHE_WRITE_12H" as const)
              : ("CACHE_RETENTION" as const),
          observation: { ...snapshot, scope, field },
        };
  return null;
}
export type CacheObservation = NonNullable<
  ReturnType<typeof retentionFinding>
>["observation"];
export function echoScope(frame: RetentionFrame) {
  return (["frame", "response"] as const).find(
    (scope) => frame[scope].legacy_retention === "24h",
  );
}
export function echoObservation(frame: RetentionFrame): CacheObservation {
  const scope = echoScope(frame);
  requireThat(scope, "STAGE_B_ECHO_WITNESS_INVALID");
  return { ...frame, scope, field: "prompt_cache_retention" };
}
export function echoConflict(frame: RetentionFrame) {
  for (const part of [frame.frame, frame.response]) {
    if (part.modern_ttl !== "MISSING") return "MODERN_TTL";
    if (part.legacy_retention === "in_memory") return "CONFLICTING_LEGACY";
    if (part.long_writes === "INVALID") return "INVALID_12H_COUNT";
  }
  return null;
}
export function confirmedEchoTerminal(
  frame: RetentionFrame | undefined,
  usage: any,
) {
  return (
    frame?.frame_type === "response.completed" &&
    frame.response.long_writes === "ZERO" &&
    usage?.input_tokens_details?.cache_write_tokens_details?.ttl_12h_tokens ===
      0
  );
}
const scopeValues = {
  options: ["MISSING", "INVALID", "OBJECT", "UNDOCUMENTED_OPTION"],
  mode: ["MISSING", "UNRECOGNIZED", ...modes],
  modern_ttl: ["MISSING", "UNRECOGNIZED", ...modern],
  legacy_retention: ["MISSING", "UNRECOGNIZED", ...legacy],
  long_writes: ["MISSING", "INVALID", "POSITIVE", "ZERO"],
};
export function validateRetentionFrame(
  snapshot: RetentionFrame,
  reason?: string,
  deferEcho = false,
) {
  const allowed = [
    "frame",
    "response",
    "frame_index",
    "frame_type",
    ...(reason && reason !== "WITNESS" ? ["scope", "field"] : []),
  ];
  requireThat(
    object(snapshot) &&
      Object.keys(snapshot).sort().join() === allowed.sort().join() &&
      Number.isSafeInteger(snapshot.frame_index) &&
      snapshot.frame_index > 0 &&
      [...frameTypes, "MISSING", "OTHER"].includes(snapshot.frame_type),
    "STAGE_B_CACHE_FRAME_INVALID",
  );
  for (const part of [snapshot.frame, snapshot.response]) {
    requireThat(
      object(part) &&
        Object.keys(part).length === Object.keys(scopeValues).length &&
        Object.entries(scopeValues).every(([k, values]) =>
          (values as readonly unknown[]).includes(part[k as keyof typeof part]),
        ) &&
        (!(part.options === "MISSING" || part.options === "INVALID") ||
          (part.mode === "MISSING" && part.modern_ttl === "MISSING")),
      "STAGE_B_CACHE_SCOPE_INVALID",
    );
  }
  if (reason === "WITNESS") return;
  if (reason) {
    const actual = snapshot as CacheObservation,
      finding = retentionFinding(snapshot, deferEcho);
    requireThat(
      finding?.reason === reason &&
        actual.scope === finding.observation.scope &&
        actual.field === finding.observation.field,
      "STAGE_B_CACHE_DRIFT_INVALID",
    );
  } else
    requireThat(
      snapshot.frame_type === "response.completed",
      "STAGE_B_CACHE_TERMINAL_INVALID",
    );
}

/** Wire guard shared by live sends and the ten offline serialized body samples. */
export function defaultCacheRequest(payload: any) {
  return (
    !Object.hasOwn(payload, "prompt_cache_retention") &&
    !Object.hasOwn(payload, "prompt_cache_options") &&
    !(
      Array.isArray(payload.input) &&
      payload.input.some(
        (item: any) =>
          Array.isArray(item?.content) &&
          item.content.some(
            (part: any) =>
              object(part) && Object.hasOwn(part, "prompt_cache_breakpoint"),
          ),
      )
    )
  );
}

/** Keep usage accounting numbers while never persisting unknown retention-counter values. */
export function safeRetentionUsage(usage: any) {
  const details = usage?.input_tokens_details;
  if (!object(details) || !Object.hasOwn(details, "cache_write_tokens_details"))
    return usage;
  const source = details.cache_write_tokens_details;
  const safe: Record<string, number | null> = {};
  for (const name of ["ttl_30m_tokens", "ttl_12h_tokens"])
    if (object(source) && Object.hasOwn(source, name)) {
      const v = source[name];
      safe[name] =
        typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
    }
  return {
    ...usage,
    input_tokens_details: { ...details, cache_write_tokens_details: safe },
  };
}
