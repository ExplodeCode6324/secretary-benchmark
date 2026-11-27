import fs from "node:fs";
import path from "node:path";
import { bound, dir, load, openSeal, save, seal } from "./files.ts";
import { requireThat } from "../io.ts";
import {
  factPacket,
  factPlan,
  factQuery,
  factResults,
  packetLimits,
  fixtureFacts,
  questions,
  type Item,
} from "./questions.ts";
import { remainingJudgeCalls } from "./transport.ts";

type Reader = (
  folder: string,
  query: string,
  expectedBytes: number,
) => Promise<string>;
type Outcome = {
  id: string;
  sequence: number;
  inputId: string | null;
  verdict: string;
  reason?: string;
  facts?: any[];
  abstained?: boolean;
  batch?: number;
};
function description(p: ReturnType<typeof factPlan>, execution: any) {
  const describe = (items: Item[]) => ({
    packet: factPacket(items),
    queryDigest: bound(factQuery(factPacket(items))),
    ids: items.map((i) => i.question_id),
    digest: bound(factPacket(items)),
    wire: packetLimits(items),
  });
  return {
    schema: 1,
    execution: bound(execution),
    order: p.observations.map(({ item, sequence, inputId }) => ({
      id: item.question_id,
      sequence,
      inputId,
      referenceDigest: bound([item.abstention_policy, item.reference_facts]),
      answerDigest: bound(item.answer),
    })),
    oversize: p.oversize,
    controls: p.controls.map((c) => ({
      ...describe(c.items),
      keyDigest: bound(c.key),
    })),
    batches: p.batches.map(describe),
  };
}
export function verifySeriesPlan(folder: string, execution: any) {
  const expected = description(factPlan(execution), execution);
  requireThat(
    bound(openSeal(path.join(folder, "plan.json"))) === bound(expected),
    "Series packet plan disagrees with sealed observations and references",
  );
}
export function initialOutcomes(execution: any): Outcome[] {
  return questions(execution.manifest.suite, execution.events).map(
    ({ item, sequence, inputId }) => ({
      id: item.question_id,
      sequence,
      inputId,
      verdict: !inputId
        ? "NOT_EXECUTED"
        : item.answer.trim()
          ? "JUDGE_FAILED"
          : "MISSING",
      ...(inputId && item.answer.trim() ? { reason: "UNSENT" } : {}),
    }),
  );
}
export async function gradeSeries(
  root: string,
  folder: string,
  id: string,
  execution: any,
  read: Reader,
) {
  const p = factPlan(execution),
    m = execution.manifest,
    plan = description(p, execution);
  seal(path.join(folder, "plan.json"), plan);
  const outcomes = initialOutcomes(execution),
    byID = new Map(outcomes.map((r) => [r.id, r]));
  for (const item of p.oversize) byID.get(item)!.reason = "OVERSIZE";
  for (const [index, batch] of p.batches.entries())
    for (const item of batch) byID.get(item.question_id)!.batch = index + 1;
  const failures: { stage: string; error: string }[] = [];
  const evidence: Record<string, string> = {};
  const record = (file: string) => {
    evidence[path.relative(folder, file)] = bound(load(file));
  };
  async function attempt(
    items: Item[],
    where: string,
    key?: (typeof p.controls)[number]["key"],
  ) {
    const packet = factPacket(items),
      query = factQuery(packet),
      sub = path.join(folder, where);
    dir(sub);
    const input = path.join(sub, "input.json");
    save(input, { packet, query });
    record(input);
    try {
      let raw: string;
      if (m.config.judge === "fixture") {
        raw = fixtureFacts(packet, key);
        save(path.join(sub, "response.json"), { mode: "FIXTURE", raw });
      } else raw = await read(sub, query, packetLimits(items).bytes);
      const results = factResults(raw, packet);
      seal(path.join(sub, "results.json"), results);
      record(path.join(sub, "results.json"));
      return results;
    } catch (error) {
      seal(path.join(sub, "attempt-failure.json"), {
        packet: bound(packet),
        responseReceived: fs.existsSync(path.join(sub, "response.json")),
        error: error instanceof Error ? error.message : String(error),
      });
      record(path.join(sub, "attempt-failure.json"));
      throw error;
    } finally {
      for (const name of [
        "wire.json",
        "provider-content.json",
        "response.json",
      ]) {
        const file = path.join(sub, name);
        if (fs.existsSync(file)) record(file);
      }
    }
  }
  const required = p.batches.length ? p.controls.length + p.batches.length : 0;
  let stopReason = "";
  // Freeze the entire prospective qualification key before the first possible send.
  seal(
    path.join(folder, "qualification-key.json"),
    p.controls.map((c) => c.key),
  );
  record(path.join(folder, "qualification-key.json"));
  if (required) {
    try {
      if (
        m.config.judge === "hermes-go" &&
        (await remainingJudgeCalls(m, execution.id)) < required
      ) {
        stopReason = "INSUFFICIENT_CALLS";
        throw Error(
          "Insufficient remaining judge calls for " +
            required +
            " planned packets",
        );
      }
      for (const [i, c] of p.controls.entries()) {
        const results = await attempt(
          c.items,
          "qualification/" + (i + 1),
          c.key,
        );
        const received = results.map((row) => ({
          required: row.facts
            .filter((f) => f.kind === "required")
            .map((f) => f.verdict),
          forbidden: row.facts
            .filter((f) => f.kind === "forbidden")
            .map((f) => f.verdict),
          abstained: row.abstained,
        }));
        requireThat(
          received.every(
            (x, j) =>
              x.abstained === c.key[j].abstained &&
              bound(x.required) === bound(c.key[j].required) &&
              bound(x.forbidden) === bound(c.key[j].forbidden),
          ),
          "Factual qualification labels disagree with preregistered key",
        );
      }
    } catch (error: any) {
      stopReason ||= "CALIBRATION_FAILED";
      failures.push({ stage: "calibration", error: error.message });
    }
  }
  for (const [index, items] of p.batches.entries()) {
    const where = "packets/" + (index + 1);
    if (stopReason) {
      for (const item of items) byID.get(item.question_id)!.reason = stopReason;
      continue;
    }
    try {
      for (const result of await attempt(items, where)) {
        const row = byID.get(result.question_id)!;
        delete row.reason;
        Object.assign(row, {
          verdict: result.verdict,
          facts: result.facts,
          abstained: result.abstained,
        });
      }
    } catch (error: any) {
      failures.push({ stage: where, error: error.message });
      for (const item of items)
        byID.get(item.question_id)!.reason = error.message;
      // Only a completed response can precede another independent packet.
      if (
        !fs.existsSync(path.join(folder, where, "response.json")) &&
        !String(error.message).startsWith("JUDGE_FINISH_REASON")
      )
        stopReason = "UNSENT";
    }
  }
  seal(path.join(folder, "grade.json"), {
    id,
    canonical: id === "original",
    execution: bound(execution),
    policy: m.judgePolicy,
    plan: bound(plan),
    evidence,
    outcomes,
    failures,
  });
  return id;
}
export function seriesRecord(
  execution: any,
  g: any,
  summary: any,
  folder: string,
) {
  requireThat(
    openSeal(path.join(folder, "plan.json")).execution === bound(execution),
    "Packet plan execution mismatch",
  );
  requireThat(
    g.plan === bound(openSeal(path.join(folder, "plan.json"))),
    "Grade is bound to a different packet plan",
  );
  for (const [name, digest] of Object.entries(g.evidence))
    requireThat(
      bound(load(path.join(folder, name))) === digest,
      "Changed fact-grading evidence: " + name,
    );
  const info = questions(execution.manifest.suite, execution.events);
  requireThat(
    info.length === g.outcomes.length,
    "Invalid question denominator",
  );
  const rows = g.outcomes.map((row: Outcome, i: number) => {
    const { item, inputId, sequence } = info[i];
    requireThat(
      row.id === item.question_id &&
        row.inputId === inputId &&
        row.sequence === sequence,
      "Question response bound to wrong observation",
    );
    return {
      ...row,
      question: item.question,
      reference: item.reference_facts,
      abstentionPolicy: item.abstention_policy,
      answer: inputId ? item.answer : null,
    };
  });
  const counts: Record<string, number> = {
    PASS: 0,
    PARTIAL: 0,
    FAIL: 0,
    MISSING: 0,
    JUDGE_FAILED: 0,
    NOT_EXECUTED: 0,
  };
  for (const row of rows) {
    requireThat(
      Object.hasOwn(counts, row.verdict),
      "Unexpected question verdict",
    );
    counts[row.verdict]++;
  }
  const status =
    counts.NOT_EXECUTED || execution.partial
      ? "INCOMPLETE"
      : counts.JUDGE_FAILED
        ? "UNGRADED"
        : "COMPLETE";
  return {
    schema: 2,
    run: execution.id,
    case: execution.manifest.config.case,
    execution: g.execution,
    harness: execution.manifest.source,
    policy: g.policy,
    grade: g.id,
    canonical: g.canonical,
    workload: execution.manifest.config.workload,
    judge: execution.manifest.config.judge,
    caseVersion: execution.manifest.config.caseVersion,
    workModel: execution.manifest.workModel,
    judgeModel: execution.manifest.judgeModel,
    promptSha256: execution.manifest.implementation["fact-grading-v1.txt"],
    status,
    counts,
    coverage: {
      planned: rows.length,
      executed: rows.length - counts.NOT_EXECUTED,
      graded: counts.PASS + counts.PARTIAL + counts.FAIL,
    },
    questions: rows,
    sequence: "One ordered workload; later questions share earlier state.",
    plan: g.plan,
    requests: summary.requests,
    claimHistory: summary.claimHistory,
    failures: [...(summary.failures ?? []), ...g.failures],
  };
}
export function seriesMarkdown(record: ReturnType<typeof seriesRecord>) {
  const clean = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  return [
    "# Secretary factual answer evaluation",
    "",
    record.status +
      " · workload " +
      record.workload +
      " · judge " +
      record.judge +
      " · " +
      record.sequence,
    "",
    "| Question | Result | Evidence |",
    "| --- | --- | --- |",
    ...record.questions.map(
      (q: any) =>
        "| " +
        q.id +
        " · " +
        clean(q.question) +
        " | " +
        q.verdict +
        " | " +
        clean(
          q.reason ??
            (q.facts ?? [])
              .map((f: any) => f.id + " " + f.verdict + ": " + f.reason)
              .join(" / "),
        ) +
        " |",
    ),
    "",
    "Planned " +
      record.coverage.planned +
      " · executed " +
      record.coverage.executed +
      " · model-graded " +
      record.coverage.graded,
    "",
    ...Object.entries(record.counts).map(([k, n]) => k + " " + n),
    "",
  ].join("\n");
}
