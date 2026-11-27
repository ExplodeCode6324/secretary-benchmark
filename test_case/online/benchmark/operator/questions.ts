import fs from "node:fs";
import path from "node:path";
import { gradeJSONBytes } from "../grading-transaction.ts";
import { repository, requireThat, sha } from "../io.ts";

import {
  atomicItem,
  atomicPacket,
  atomicPolicy,
  atomicWirePolicy,
  atomicInstructions,
  validateAtomicReference,
  parseAtomic,
  rawAtomic,
  certifiedResult,
  type AtomicReference,
  type AtomicItem,
  type AtomicControl,
} from "./atomic.ts";

export const factPolicy = "secretary-answer-facts-v1";
export const factInstructions = fs
  .readFileSync(
    path.join(
      repository,
      "test_case/online/benchmark/operator/fact-grading-v1.txt",
    ),
    "utf8",
  )
  .trimEnd();
const nonempty = (s: unknown): s is string =>
  typeof s === "string" && s.trim().length > 0;
type Note = { type: "information"; text: string };
type Reference = {
  required: string[];
  forbidden: string[];
  abstention: "REQUIRED" | "ACCEPTABLE" | "NOT_ACCEPTABLE";
};
type Question = {
  type: "question";
  id: string;
  text: string;
  reference: Reference | AtomicReference;
};
export type Timeline = (Note | Question)[];
export function validateTimeline(
  value: unknown,
  atomic = false,
): asserts value is Timeline {
  requireThat(
    Array.isArray(value) && value.length > 0,
    "Supply an ordered timeline with information and questions",
  );
  const ids = new Set<string>();
  const delivered = new Set<string>();
  for (const event of value) {
    requireThat(event && nonempty(event.text), "Missing timeline event text");
    requireThat(
      (event.text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 6,
      "Use distinctive event text with at least six letters or numbers for the future-event guard",
    );
    requireThat(
      ![...delivered].some(
        (prior) => prior !== event.text && prior.includes(event.text),
      ),
      "A future event is contained in earlier input; use the full repeated wording or a distinct event",
    );
    delivered.add(event.text);
    if (event.type === "information") {
      requireThat(
        Object.keys(event).every((k) => ["type", "text"].includes(k)),
        "Unknown information event field",
      );
      continue;
    }
    const ref = event.reference;
    if (atomic) {
      requireThat(
        event.type === "question" &&
          typeof event.id === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(event.id) &&
          !ids.has(event.id) &&
          Object.keys(event).every((k) =>
            ["type", "text", "id", "reference"].includes(k),
          ),
        "Invalid atomic question",
      );
      validateAtomicReference(ref);
      ids.add(event.id);
      continue;
    }
    requireThat(
      event.type === "question" &&
        typeof event.id === "string" &&
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(event.id) &&
        !ids.has(event.id) &&
        ref &&
        Object.keys(ref).every((k) =>
          ["required", "forbidden", "abstention"].includes(k),
        ) &&
        ["REQUIRED", "ACCEPTABLE", "NOT_ACCEPTABLE"].includes(ref.abstention) &&
        [ref.required, ref.forbidden].every(
          (a) =>
            Array.isArray(a) &&
            a.every(nonempty) &&
            new Set(a).size === a.length,
        ) &&
        !ref.required.some((f: string) => ref.forbidden.includes(f)) &&
        (ref.abstention === "REQUIRED" || ref.required.length > 0) &&
        Object.keys(event).every((k) =>
          ["type", "text", "id", "reference"].includes(k),
        ),
      "Each question requires a unique ID and valid reference facts",
    );
    ids.add(event.id);
  }
  requireThat(ids.size > 0, "The timeline has no questions");
}
export function eventTexts(suite: any): string[] {
  return suite.timeline
    ? suite.timeline.map((event: Note | Question) => event.text)
    : [...suite.setup, suite.probe];
}
export function itemFor(
  id: string,
  text: string,
  ref: Reference,
  answer: string,
) {
  return {
    question_id: id,
    question: text,
    abstention_policy: ref.abstention,
    reference_facts: [
      ...ref.required.map((text, i) => ({
        id: "r" + (i + 1),
        kind: "required",
        text,
      })),
      ...ref.forbidden.map((text, i) => ({
        id: "x" + (i + 1),
        kind: "forbidden",
        text,
      })),
    ],
    answer,
  };
}
export type Item = ReturnType<typeof itemFor> & { atomic?: AtomicReference };
export function questions(suite: { timeline: Timeline }, events: any[]) {
  return suite.timeline.flatMap((event, index) => {
    if (event.type !== "question") return [];
    const observed = events[index];
    if (observed)
      requireThat(
        observed.sequence === index + 1 && typeof observed.inputId === "string",
        "Question evidence is out of sequence",
      );
    const answer = observed
      ? observed.messages.map((m: any) => m.text).join("\n")
      : "";
    const item: Item =
      "facts" in event.reference
        ? atomicItem(event.id, event.text, event.reference, answer)
        : itemFor(event.id, event.text, event.reference, answer);
    return [{ item, sequence: index + 1, inputId: observed?.inputId ?? null }];
  });
}
export function factPacket(items: Item[]) {
  return { policy: factPolicy, items };
}
export function factQuery(packet: ReturnType<typeof factPacket>) {
  const bytes = gradeJSONBytes(packet);
  return (
    factInstructions +
    "\n\npacket_sha256=" +
    sha(bytes) +
    "\n" +
    bytes.toString()
  );
}
export function wirePacket(items: Item[]): any {
  return items[0]?.atomic
    ? atomicPacket(items as AtomicItem[])
    : factPacket(items);
}
export function wireQuery(packet: any) {
  if (packet.policy === factPolicy) return factQuery(packet);
  requireThat(packet.policy === atomicWirePolicy, "Unknown fact protocol");
  const bytes = gradeJSONBytes(packet);
  return (
    atomicInstructions +
    "\n\npacket_sha256=" +
    sha(bytes) +
    "\n" +
    bytes.toString()
  );
}
export function seriesResults(
  raw: string,
  packet: any,
  hostItems?: Item[],
): any[] {
  if (packet.policy === factPolicy) return factResults(raw, packet);
  requireThat(
    packet.policy === atomicWirePolicy &&
      hostItems &&
      sha(gradeJSONBytes(atomicPacket(hostItems as AtomicItem[]))) ===
        sha(gradeJSONBytes(packet)),
    "Invalid atomic packet projection",
  );
  return parseAtomic(raw, hostItems as AtomicItem[]);
}
export function deterministicRaw(items: Item[]): string | null {
  if (!items[0]?.atomic) return null;
  const results = items.map((i) => certifiedResult(i as AtomicItem));
  return results.every((r) => r !== null)
    ? rawAtomic(atomicPacket(items as AtomicItem[]), results)
    : null;
}
export function packetLimits(items: Item[]) {
  const query = wireQuery(wirePacket(items));
  // The Hermes adapter emits exactly this compact UTF-8 wire (checked again at dispatch).
  const body = {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: query }],
    max_tokens: 49152,
    reasoning_effort: "max",
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: "enabled" },
  };
  return {
    items: items.length,
    facts: items.reduce((n, i) => n + i.reference_facts.length, 0),
    bytes: Buffer.byteLength(JSON.stringify(body)),
  };
}
type Control = {
  question_id: string;
  question: string;
  reference: Reference;
  answer: string;
  expected: { required: string[]; forbidden: string[]; abstained: boolean };
};
export function calibrationBatches(width: number, rotate = true) {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(
        repository,
        "test_case/online/benchmark/operator/fact-controls.json",
      ),
      "utf8",
    ),
  );
  const controls: Control[] = source.items;
  requireThat(
    source.version === 1 && controls.length === 12,
    "Invalid frozen fact controls",
  );
  const batches: { items: Item[]; key: Control["expected"][] }[] = [];
  for (let start = 0; start < controls.length; start += rotate ? 1 : width) {
    // Cycle through the fixed set to qualify a full final packet at every width.
    const slice = Array.from(
      { length: width },
      (_, i) => controls[(start + i) % controls.length],
    );
    batches.push({
      items: slice.map((c) =>
        itemFor(c.question_id, c.question, c.reference, c.answer),
      ),
      key: slice.map((c) => c.expected),
    });
  }
  return batches;
}
export function factPlan(execution: any, rotate = true) {
  const observations = questions(execution.manifest.suite, execution.events);
  const eligible = observations.filter(
    (q) => q.inputId && q.item.answer.trim(),
  );
  if (execution.manifest.config.suite === "question-series-v2") {
    const m = execution.manifest,
      suite = m.config.controlSuite;
    requireThat(
      m.judgePolicy === atomicPolicy &&
        m.config.judgeProtocol === atomicPolicy &&
        m.config.questionsPerRequest === 1 &&
        typeof suite.sourceBytes === "string" &&
        sha(suite.sourceBytes) === suite.sha256,
      "Invalid frozen atomic suite",
    );
    const { sourceBytes, sha256, ...content } = suite;
    requireThat(
      sha(gradeJSONBytes(JSON.parse(sourceBytes))) ===
        sha(gradeJSONBytes(content)) &&
        m.implementation["fact-grading-v2.txt"] ===
          sha(atomicInstructions + "\n"),
      "Atomic evidence and contract differ",
    );
    const controls = execution.manifest.config.controlSuite.items.map(
      (c: AtomicControl) => ({
        items: [atomicItem(c.id, c.question, c.reference, c.answer)],
        key: [c.expected],
      }),
    ) as { items: Item[]; key: any[] }[];
    const fits = (item: Item) => {
      const l = packetLimits([item]);
      return l.facts <= 64 && l.bytes <= 524288;
    };
    requireThat(
      controls.every((c) => fits(c.items[0])),
      "Atomic control exceeds singleton wire limits",
    );
    return {
      controls,
      batches: eligible.filter((q) => fits(q.item)).map((q) => [q.item]),
      oversize: eligible
        .filter((q) => !fits(q.item))
        .map((q) => q.item.question_id),
      observations,
    };
  }
  const controls = calibrationBatches(
    Math.max(
      1,
      Math.min(eligible.length, execution.manifest.config.questionsPerRequest),
    ),
    rotate,
  );
  const envelopes = controls.map((c) => packetLimits(c.items));
  requireThat(
    envelopes.every((l) => l.bytes <= 524288 && l.facts <= 64),
    "Calibration exceeds reader limits",
  );
  const fits = (items: Item[]) => {
    const l = packetLimits(items);
    return envelopes.some(
      (e) => l.items <= e.items && l.facts <= e.facts && l.bytes <= e.bytes,
    );
  };
  const oversize: string[] = [],
    batches: Item[][] = [];
  let batch: Item[] = [];
  for (const { item } of eligible) {
    if (!fits([item])) {
      oversize.push(item.question_id);
      continue;
    }
    if (batch.length && !fits([...batch, item])) {
      batches.push(batch);
      batch = [];
    }
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return { controls, batches, oversize, observations };
}
export function factResults(
  raw: string,
  packet: ReturnType<typeof factPacket>,
) {
  const reply = JSON.parse(
    raw
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, "$1"),
  );
  requireThat(
    reply.packet_sha256 === sha(gradeJSONBytes(packet)) &&
      Array.isArray(reply.results) &&
      reply.results.length === packet.items.length,
    "Fact response digest or question count mismatch",
  );
  return packet.items.map((item) => {
    const matches = reply.results.filter(
      (r: any) => r?.question_id === item.question_id,
    );
    const facts = matches[0]?.facts,
      abstained = matches[0]?.abstained;
    requireThat(
      matches.length === 1 &&
        typeof abstained === "boolean" &&
        Array.isArray(facts) &&
        facts.length === item.reference_facts.length,
      "Missing or duplicate question or fact: " + item.question_id,
    );
    const ordered = item.reference_facts.map((ref) => {
      const hits = facts.filter((f: any) => f?.id === ref.id);
      const allowed =
        ref.kind === "required"
          ? ["SUPPORTED", "ABSENT", "CONTRADICTED"]
          : ["ASSERTED", "NOT_ASSERTED"];
      requireThat(
        hits.length === 1 &&
          allowed.includes(hits[0].verdict) &&
          nonempty(hits[0].reason),
        "Invalid verdict or fact ID: " + item.question_id + "/" + ref.id,
      );
      return {
        ...ref,
        verdict: String(hits[0].verdict),
        reason: String(hits[0].reason),
      };
    });
    const matched = ordered.filter((f) => f.verdict === "SUPPORTED").length;
    const fail =
      ordered.some((f) => ["CONTRADICTED", "ASSERTED"].includes(f.verdict)) ||
      (abstained && item.abstention_policy === "NOT_ACCEPTABLE") ||
      (!abstained && item.abstention_policy === "REQUIRED");
    const required = ordered.filter((f) => f.kind === "required").length;
    const verdict = fail
      ? "FAIL"
      : abstained || (matched > 0 && matched === required)
        ? "PASS"
        : matched
          ? "PARTIAL"
          : "FAIL";
    return {
      question_id: item.question_id,
      abstained,
      facts: ordered,
      verdict,
    };
  });
}
export function fixtureFacts(
  packet: ReturnType<typeof factPacket>,
  key?: Control["expected"][],
) {
  return JSON.stringify({
    packet_sha256: sha(gradeJSONBytes(packet)),
    results: packet.items.map((item, i) => ({
      question_id: item.question_id,
      abstained: key?.[i].abstained ?? false,
      facts: item.reference_facts.map((f) => {
        const present = item.answer
          .toLowerCase()
          .includes(f.text.toLowerCase());
        const labels =
          f.kind === "required" ? key?.[i].required : key?.[i].forbidden;
        return {
          id: f.id,
          reason: "Scripted fixture",
          verdict:
            labels?.[Number(f.id.slice(1)) - 1] ??
            (f.kind === "required"
              ? present
                ? "SUPPORTED"
                : "ABSENT"
              : present
                ? "ASSERTED"
                : "NOT_ASSERTED"),
        };
      }),
    })),
  });
}
