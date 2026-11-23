// A rehearsal has an immutable, in-memory transport and a non-secret test credential.
// Only the three protocol trajectories below enter this separate measurement class.
import { randomUUID } from "node:crypto";
import { requireThat } from "./io.ts";
export const rehearsalCases = [
  "C04-irrelevant",
  "C04-resident",
  "C02-incidental",
  "C16-combined",
] as const;
export const rehearsalKey = "offline-completion-sse";
export function rehearsalFetch(): typeof fetch {
  let number = 0;
  return async (input, init) => {
    const req = new Request(input, init);
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
    const packet = body.messages.findLast(
      (m: any) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.includes('"secretary.agent-task.v1"'),
    );
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
    const name = task && choose(hasWrite ? "submit_result" : "write");
    const args =
      name &&
      (hasWrite
        ? {
            outcome: "SUCCEEDED",
            summary: "Synthetic write observed",
            criteria: JSON.parse(
              packet.content,
            ).assignment.acceptance_criteria.map((c: any) => ({
              id: c.id,
              met: true,
              evidence: "synthetic",
            })),
            artifacts: [],
            limitations: [],
          }
        : { path: "continuity.txt", content: "alpha" });
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
