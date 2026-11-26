import { goAPI, goUsage } from "./stage-c-go-provider.ts";
// A rehearsal has an immutable, in-memory transport and a non-secret test credential.
// Only the three protocol trajectories below enter this separate measurement class.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendJSON, readJSON, requireThat } from "./io.ts";
export const rehearsalCases = [
  "C04-irrelevant",
  "C04-resident",
  "C02-incidental",
  "C16-combined",
] as const;
export const rehearsalKey = "offline-completion-sse";
export function rehearsalFetch(
  reader?: {
    evidence: string;
    probe: string;
    correction: string;
    mode: "ORIGINAL_OFFSET" | "OTHER_EVENT";
  },
  go?: { evidence?: string; mode: "NORMAL" | "TRANSIENT" | "INTERRUPT" },
): typeof fetch {
  let reads = 0;
  let number = 0;
  let pendingProposals = 0;
  return async (input, init) => {
    const req = new Request(input, init);
    if (go && req.method === "GET") {
      requireThat(
        req.url === goUsage &&
          req.headers.get("authorization") === "Bearer " + rehearsalKey,
        "REHEARSAL_USAGE",
      );
      const transient = ++reads === 1 && go.mode === "TRANSIENT";
      if (go.evidence)
        appendJSON(path.join(go.evidence, "offline-go-transport.jsonl"), {
          method: "GET",
          status: transient ? 503 : 200,
          at: new Date().toISOString(),
        });
      if (transient) return new Response(null, { status: 503 });
      return Response.json({
        usage: Object.fromEntries(
          ["rolling", "weekly", "monthly"].map((k) => [
            k,
            {
              status: "ok",
              percent: 0,
              resetsAt: new Date(Date.now() + 86400000).toISOString(),
            },
          ]),
        ),
      });
    }
    if (go) {
      requireThat(
        req.url === goAPI + "/chat/completions",
        "REHEARSAL_DESTINATION",
      );
      if (go.evidence)
        appendJSON(path.join(go.evidence, "offline-go-transport.jsonl"), {
          method: "POST",
          response: go.mode === "INTERRUPT" ? "INTERRUPTED" : "SCRIPTED",
          at: new Date().toISOString(),
        });
      if (go.mode === "INTERRUPT") throw new TypeError("offline interruption");
    }
    requireThat(
      req.method === "POST" &&
        req.headers.get("authorization") === "Bearer " + rehearsalKey,
      "REHEARSAL_PERMIT",
    );
    const body = await req.json();
    const sys = body.messages
      .filter((m: any) => ["system", "developer"].includes(m.role))
      .map((m: any) => m.content)
      .join("\n");
    const message = sys.includes("COMMITMENT_EXTRACTION:")
      ? '{"quotes":[]}'
      : sys.includes("CONSCIOUSNESS")
        ? JSON.stringify({
            items: [
              {
                tier: "ACTIVE",
                summary: "Synthetic rehearsal context",
                goals: [],
                constraints: [],
                decisions: [],
                open_questions: [],
                unfulfilled_commitments: [],
                task_refs: [],
                pending_owner: "MAIN",
              },
            ],
          })
        : "Synthetic rehearsal response.";
    const common = {
      id: "stub-" + randomUUID(),
      model: body.model,
      created: Math.floor(Date.now() / 1000),
      object: "chat.completion.chunk",
      system_fingerprint: "stub-" + (++number % 2),
    };
    const textOf = (content: unknown) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : "";
    const packet = body.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => textOf(m.content))
      .findLast((text: string) => text.includes('"secretary.agent-task.v1"'));
    const task = packet && sys.includes("TASK_EXECUTOR");
    const hasWrite = body.messages.some((m: any) =>
      m.tool_calls?.some(
        (c: any) =>
          c.function?.name === "tool_write" || c.function?.name === "write",
      ),
    );
    const choose = (name: string) =>
      body.tools.find((t: any) =>
        [name, "tool_" + name].includes(t.function?.name),
      )?.function?.name;
    let name = task && choose(hasWrite ? "submit_result" : "write");
    let args =
      name &&
      (hasWrite
        ? {
            outcome: "SUCCEEDED",
            summary: "Synthetic write observed",
            criteria: JSON.parse(packet).assignment.acceptance_criteria.map(
              (c: any) => ({
                id: c.id,
                met: true,
                evidence: "synthetic",
              }),
            ),
            artifacts: [],
            limitations: [],
          }
        : { path: "continuity.txt", content: "alpha" });
    const latest = body.messages.at(-1);
    if (
      reader &&
      ((latest?.role === "user" &&
        textOf(latest.content) === reader.correction) ||
        (reader.mode === "OTHER_EVENT" &&
          pendingProposals === 1 &&
          latest?.role === "tool" &&
          body.messages.findLast((m: any) => m.role === "user")?.content ===
            reader.correction))
    ) {
      pendingProposals++;
      const original = readJSON(
        path.join(reader.evidence, "stage-c-trail.json"),
      ).inputs[0].source_event;
      requireThat(typeof original === "string", "REHEARSAL_SOURCE_MISSING");
      name = choose("memory_propose_change");
      requireThat(name, "REHEARSAL_PROPOSAL_TOOL_MISSING");
      args = {
        changes: [
          {
            intent: "CREATE_ENTITY",
            local_ref: "$fern",
            entity_kind: "PROJECT",
            display_name: "Fern",
            source_event_ids: [original],
          },
        ],
      };
    }
    if (
      reader &&
      latest?.role === "user" &&
      textOf(latest.content) === reader.probe
    ) {
      const source = readJSON(
        path.join(reader.evidence, "stage-c-original.json"),
      );
      const event =
        reader.mode === "ORIGINAL_OFFSET"
          ? source.event
          : readJSON(
              path.join(reader.evidence, "stage-c-trail.json"),
            ).inputs.find(
              (i: any) => i.source_event && i.source_event !== source.event,
            )?.source_event;
      requireThat(event, "REHEARSAL_EVENT_MISSING");
      name = choose("memory_read");
      requireThat(name, "REHEARSAL_READ_TOOL_MISSING");
      args = { source: "log", event_id: event, offset: 4, length: 30 };
    }
    const frames = [
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: name
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_" + randomUUID().replaceAll("-", ""),
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                }
              : { role: "assistant", content: message },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [
          { index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" },
        ],
      },
      {
        ...common,
        choices: [],
        usage: {
          ...(go
            ? {
                cost: 0,
                opencode: {
                  billing_source: "go",
                  list_cost: 0.0001,
                  provider: "offline-fixture",
                },
              }
            : {}),
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 100,
        },
      },
    ];
    return new Response(
      frames.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") +
        "data: [DONE]\n\n",
      {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": common.id,
        },
      },
    );
  };
}
