import { sha } from "./io.ts";
import { isDeepStrictEqual } from "node:util";
import { stableID } from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";

type Event = {
  event_type: string;
  event_id: string;
  scope: { session_id: string | null };
  sequence: number;
  payload: any;
};
type Call = {
  id: string;
  sequence: number;
  request: any;
  response: any;
  loop: string;
};
/** Positive read witnesses require original event bytes, the tool call, result and its subsequent delivery. */
export function sourceReads(
  session: string,
  input: string,
  text: string,
  events: Event[],
  calls: Call[],
  object: (r: any) => any,
) {
  const sourceHashes = new Map<string, string>();
  for (const e of events.filter((e) => e.scope.session_id === session)) {
    if (e.event_type === "input.accepted") {
      const accepted = object(e.payload);
      if (
        accepted.id === input &&
        accepted.producer === "MASTER" &&
        accepted.payload.sha256 === sha(text)
      )
        sourceHashes.set(e.event_id, accepted.payload.sha256);
    } else if (
      e.event_type === "main.message" &&
      e.event_id === stableID("main.input.message:" + input)
    ) {
      const body = object(e.payload);
      if (
        body.secretary_input?.input_id === input &&
        JSON.stringify(body).includes(text)
      )
        sourceHashes.set(e.event_id, e.payload.sha256);
    }
  }
  const reads = [];
  for (const c of calls)
    for (const part of c.response?.content ?? []) {
      const args = part.arguments;
      if (
        part.name !== "memory_read" ||
        part.type !== "toolCall" ||
        args?.source !== "log" ||
        !sourceHashes.has(args.event_id)
      )
        continue;
      const suffix =
        ":" + part.id + ":memory_read:" + sha(JSON.stringify(args));
      const event = events.find((e) => {
        if (
          e.scope.session_id !== session ||
          e.sequence <= c.sequence ||
          e.event_type !== "main.tool.result"
        )
          return false;
        const k = object(e.payload).key;
        return (
          typeof k === "string" &&
          k.startsWith(c.loop + ":") &&
          k.endsWith(suffix)
        );
      });
      if (!event) continue;
      const result = object(event.payload).result;
      if (result?.isError || !Array.isArray(result?.content)) continue;
      let parsed;
      try {
        parsed = JSON.parse(
          result.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n"),
        );
      } catch {
        continue;
      }
      if (
        parsed.event_id !== args.event_id ||
        parsed.body_hash !== sourceHashes.get(args.event_id) ||
        typeof parsed.body !== "string" ||
        !(
          parsed.body.includes(text) ||
          (parsed.body.length > 0 &&
            parsed.body_hash === sha(text) &&
            Number.isSafeInteger(parsed.offset) &&
            parsed.offset === (args.offset ?? 0) &&
            parsed.total_length === Array.from(text).length &&
            parsed.body ===
              Array.from(text)
                .slice(parsed.offset, parsed.offset + (args.length ?? 2000))
                .join(""))
        )
      )
        continue;
      const delivery = calls.find(
        (later) =>
          later.loop === c.loop &&
          later.sequence > event.sequence &&
          later.request.messages.some(
            (m: any) =>
              m.role === "toolResult" &&
              !m.isError &&
              m.toolName === "memory_read" &&
              m.toolCallId === part.id &&
              isDeepStrictEqual(m.content, result.content),
          ),
      );
      reads.push({
        event: args.event_id,
        request: c.id,
        tool_call_id: part.id,
        tool_text_sha256: sha(
          result.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("\n"),
        ),
        result_sha256: event.payload.sha256,
        delivered_to: delivery?.id ?? null,
      });
    }
  return reads;
}

export type CorrectionVerdict = {
  maintenance: "STALE_CURRENT" | "HEALTHY" | "UNKNOWN";
  visibility: "COLD" | "RESIDENT" | "UNKNOWN";
  resident_old: boolean | null;
  source_delivered: boolean;
  supported_use: boolean | null;
  reached: boolean;
};
export function judgeCorrection(observed: CorrectionVerdict) {
  const maintenance =
    observed.maintenance === "STALE_CURRENT"
      ? "FAIL"
      : observed.maintenance === "HEALTHY"
        ? "PASS"
        : "UNRESOLVED";
  let use = "UNRESOLVED";
  if (!observed.reached) use = "NOT_TESTED";
  else if (observed.visibility !== "UNKNOWN" && observed.supported_use !== null)
    use =
      observed.supported_use &&
      (observed.visibility === "RESIDENT" || observed.source_delivered)
        ? "PASS"
        : "FAIL";
  return {
    maintenance,
    use,
    stale_resident_and_cold:
      observed.visibility === "UNKNOWN" || observed.resident_old === null
        ? null
        : observed.visibility === "COLD" && observed.resident_old,
  };
}
