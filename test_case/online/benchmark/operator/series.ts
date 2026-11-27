import fs from "node:fs";
import path from "node:path";
import { bound, dir, load, openSeal, save, seal } from "./files.ts";
import { requireThat, sha } from "../io.ts";
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

export class TerminalFactTransport extends Error {}

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
function description(
  p: ReturnType<typeof factPlan>,
  execution: any,
  schema = 3,
) {
  const describe = (items: Item[]) => ({
    packet: factPacket(items),
    queryDigest: bound(factQuery(factPacket(items))),
    ids: items.map((i) => i.question_id),
    digest: bound(factPacket(items)),
    wire: packetLimits(items),
  });
  return {
    schema,
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
  const schema = openSeal(path.join(folder, "plan.json")).schema;
  requireThat([1, 2, 3].includes(schema), "Unknown series plan");
  const expected = description(
    factPlan(execution, schema >= 2),
    execution,
    schema,
  );
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
function qualificationLabels(results: ReturnType<typeof factResults>) {
  return results.map((row) => ({
    required: row.facts
      .filter((f) => f.kind === "required")
      .map((f) => f.verdict),
    forbidden: row.facts
      .filter((f) => f.kind === "forbidden")
      .map((f) => f.verdict),
    abstained: row.abstained,
  }));
}

// Recover only decisions accepted before interruption. This path cannot start a reader.
export function recoveredOutcomes(execution: any, folder: string) {
  const rows = initialOutcomes(execution);
  if (!fs.existsSync(path.join(folder, "plan.json"))) return rows;
  const plan = openSeal(path.join(folder, "plan.json"));
  requireThat(
    plan.execution === bound(execution),
    "Interrupted plan execution mismatch",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of plan.oversize) byId.get(id)!.reason = "OVERSIZE";
  function savedResults(sub: string, spec: any) {
    const input = load(path.join(sub, "input.json"));
    requireThat(
      bound(input.packet) === spec.digest &&
        bound(input.query) === spec.queryDigest,
      "Interrupted packet mismatch",
    );
    const results = factResults(
      load(path.join(sub, "response.json")).raw,
      input.packet,
    );
    requireThat(
      bound(results) === bound(openSeal(path.join(sub, "results.json"))),
      "Interrupted decision mismatch",
    );
    return results;
  }
  const hasFormal = fs.existsSync(path.join(folder, "packets"));
  const keyFile = path.join(folder, "qualification-key.json");
  const keys = fs.existsSync(keyFile) ? openSeal(keyFile) : [];
  const failureFile = path.join(folder, "qualification-failure.json");
  const recoveryFile = path.join(folder, "qualification-interruption.json");
  const interrupted = fs.existsSync(recoveryFile);
  if (interrupted)
    requireThat(
      openSeal(recoveryFile).plan === bound(plan),
      "Qualification interruption belongs to a different plan",
    );
  let qualificationFailure = interrupted ? "INTERRUPTED" : "";
  if (fs.existsSync(failureFile)) {
    const failure = openSeal(failureFile);
    requireThat(
      failure.plan === bound(plan) &&
        ["CALIBRATION_FAILED", "INSUFFICIENT_CALLS"].includes(failure.reason),
      "Invalid qualification failure",
    );
    if (failure.reason === "INSUFFICIENT_CALLS")
      requireThat(
        Number.isSafeInteger(failure.remaining) &&
          failure.remaining < plan.controls.length + plan.batches.length,
        "Invalid qualification capacity",
      );
    qualificationFailure = failure.reason;
  }
  for (const [i, c] of plan.controls.entries()) {
    const sub = path.join(folder, "qualification", String(i + 1));
    const failure = path.join(sub, "attempt-failure.json");
    if (
      fs.existsSync(failure) &&
      (!interrupted || openSeal(failure).error !== "INTERRUPTED")
    )
      qualificationFailure = "CALIBRATION_FAILED";
    if (!fs.existsSync(path.join(sub, "results.json"))) {
      requireThat(!hasFormal, "Formal grading without complete qualification");
      continue;
    }
    const labels = qualificationLabels(savedResults(sub, c));
    requireThat(
      keys[i] && bound(keys[i]) === c.keyDigest,
      "Qualification key mismatch",
    );
    const expected = keys[i].map(({ required, forbidden, abstained }: any) => ({
      required,
      forbidden,
      abstained,
    }));
    if (bound(labels) !== bound(expected))
      qualificationFailure = "CALIBRATION_FAILED";
  }
  requireThat(
    !hasFormal || !qualificationFailure,
    "Formal grading after a failed qualification",
  );
  if (qualificationFailure)
    for (const batch of plan.batches)
      for (const id of batch.ids) byId.get(id)!.reason = qualificationFailure;
  for (const [i, batch] of plan.batches.entries()) {
    const sub = path.join(folder, "packets", String(i + 1));
    for (const id of batch.ids) byId.get(id)!.batch = i + 1;
    if (fs.existsSync(path.join(sub, "results.json"))) {
      for (const result of savedResults(sub, batch)) {
        const row = byId.get(result.question_id)!;
        delete row.reason;
        Object.assign(row, {
          verdict: result.verdict,
          facts: result.facts,
          abstained: result.abstained,
        });
      }
    } else if (fs.existsSync(path.join(sub, "input.json"))) {
      const failure = path.join(sub, "attempt-failure.json");
      const why = fs.existsSync(failure)
        ? openSeal(failure).error
        : "INTERRUPTED";
      for (const id of batch.ids) byId.get(id)!.reason = why;
    }
  }
  return rows;
}
export function sealInterruptedGrade(execution: any, folder: string) {
  const plan = openSeal(path.join(folder, "plan.json"));
  verifySeriesPlan(folder, execution);
  // The controller may disappear after persisting provider bytes and before the
  // native reader delivers its receipt or the attempt's catch block can run.
  for (const [kind, specs] of [
    ["qualification", plan.controls],
    ["packets", plan.batches],
  ] as const) {
    for (const [i, spec] of specs.entries()) {
      const sub = path.join(folder, kind, String(i + 1));
      if (
        fs.existsSync(path.join(sub, "provider-content.json")) &&
        !fs.existsSync(path.join(sub, "response.json")) &&
        !fs.existsSync(path.join(sub, "attempt-failure.json"))
      ) {
        requireThat(
          !fs.existsSync(path.join(sub, "results.json")) &&
            bound(load(path.join(sub, "input.json")).packet) === spec.digest,
          "Interrupted reader evidence mismatch",
        );
        seal(path.join(sub, "attempt-failure.json"), {
          packet: spec.digest,
          responseReceived: false,
          error: "INTERRUPTED",
        });
      }
    }
  }
  const recoveryFile = path.join(folder, "qualification-interruption.json");
  if (
    plan.batches.length &&
    !fs.existsSync(path.join(folder, "packets")) &&
    !fs.existsSync(path.join(folder, "qualification-failure.json")) &&
    plan.controls.some(
      (_: unknown, i: number) =>
        !fs.existsSync(
          path.join(folder, "qualification", String(i + 1), "results.json"),
        ),
    ) &&
    !fs.existsSync(recoveryFile)
  ) {
    seal(recoveryFile, { plan: bound(plan) });
  }
  const outcomes = recoveredOutcomes(execution, folder);
  const evidence: Record<string, string> = {};
  for (const name of fs.readdirSync(folder, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (
      /^(qualification-key|qualification-failure|qualification-interruption|native-precheck)\.json$|^(qualification|packets)\/[1-9][0-9]*\/(input|response|wire|provider-content|results|attempt-failure)\.json$/.test(
        name,
      )
    )
      evidence[name] = bound(load(path.join(folder, name)));
  }
  seal(path.join(folder, "grade.json"), {
    id: "original",
    canonical: true,
    execution: bound(execution),
    policy: execution.manifest.judgePolicy,
    plan: bound(plan),
    evidence,
    outcomes,
    failures: [
      {
        stage: "recovery",
        error:
          "Controller interrupted during original grading; no packet was resent",
      },
    ],
  });
}
export function verifyFactGrade(execution: any, g: any, folder: string) {
  verifySeriesPlan(folder, execution);
  const plan = openSeal(path.join(folder, "plan.json"));
  for (const [kind, specs] of [
    ["qualification", plan.controls],
    ["packets", plan.batches],
  ] as const) {
    for (const [i, spec] of specs.entries()) {
      const sub = path.join(folder, kind, String(i + 1));
      if (!fs.existsSync(path.join(sub, "input.json"))) continue;
      const input = load(path.join(sub, "input.json"));
      requireThat(
        bound(input.packet) === spec.digest &&
          bound(input.query) === spec.queryDigest,
        "Grading input differs from planned packet",
      );
      const wirePath = path.join(sub, "wire.json");
      if (
        execution.manifest.config.judge === "hermes-go" &&
        (fs.existsSync(path.join(sub, "response.json")) ||
          fs.existsSync(path.join(sub, "provider-content.json")))
      )
        requireThat(
          fs.existsSync(wirePath),
          "Missing native factual reader wire",
        );
      if (fs.existsSync(wirePath)) {
        const wire = load(wirePath);
        const failure = path.join(sub, "attempt-failure.json");
        const refusedBeforeSend =
          fs.existsSync(failure) &&
          openSeal(failure).error ===
            "Native judge wire length differs from qualification plan" &&
          !fs.existsSync(path.join(sub, "response.json")) &&
          !fs.existsSync(path.join(sub, "provider-content.json"));
        requireThat(
          sha(wire.body) === wire.sha256 &&
            bound(JSON.parse(wire.body).messages) ===
              bound([{ role: "user", content: input.query }]) &&
            (Buffer.byteLength(wire.body) === spec.wire.bytes ||
              refusedBeforeSend),
          "Native wire differs from sealed grading packet",
        );
      }
      if (fs.existsSync(path.join(sub, "results.json"))) {
        const result = factResults(
          load(path.join(sub, "response.json")).raw,
          input.packet,
        );
        requireThat(
          bound(result) === bound(openSeal(path.join(sub, "results.json"))),
          "Saved factual labels differ from reader response",
        );
      }
    }
  }
  const rows = recoveredOutcomes(execution, folder);
  requireThat(
    rows.length === g.outcomes.length &&
      rows.every((row, i) => {
        const v = g.outcomes[i];
        return (
          row.id === v.id &&
          row.verdict === v.verdict &&
          (plan.schema < 3 || row.reason === v.reason) &&
          bound(row.facts ?? null) === bound(v.facts ?? null) &&
          row.abstained === v.abstained
        );
      }),
    "Sealed factual verdict differs from accepted reader evidence",
  );
}
export async function gradeSeries(
  root: string,
  folder: string,
  id: string,
  execution: any,
  read: Reader,
  precheck?: () => Promise<unknown>,
) {
  const p = factPlan(execution),
    m = execution.manifest,
    plan = description(p, execution);
  // No model output exists at this point. A local reader fault may be fixed and
  // retried on the same execution without consuming its canonical grade.
  const nativeCheck =
    p.batches.length && m.config.judge === "hermes-go" && precheck
      ? await precheck()
      : null;
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
  if (nativeCheck) {
    seal(path.join(folder, "native-precheck.json"), nativeCheck);
    record(path.join(folder, "native-precheck.json"));
  }
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
    let remaining: number | null = null;
    try {
      if (m.config.judge === "hermes-go")
        remaining = await remainingJudgeCalls(m, execution.id);
      if (remaining !== null && remaining < required) {
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
        requireThat(
          bound(qualificationLabels(results)) ===
            bound(
              c.key.map(({ required, forbidden, abstained }) => ({
                required,
                forbidden,
                abstained,
              })),
            ),
          "Factual qualification labels disagree with preregistered key",
        );
      }
    } catch (error: any) {
      stopReason ||= "CALIBRATION_FAILED";
      seal(path.join(folder, "qualification-failure.json"), {
        plan: bound(plan),
        reason: stopReason,
        remaining,
        error: error.message,
      });
      record(path.join(folder, "qualification-failure.json"));
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
      if (error instanceof TerminalFactTransport) stopReason = "UNSENT";
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
// Count provider dispatches by their actual native session and wire receipt.
export function qualificationSummary(root: string, folder: string) {
  const plan = openSeal(path.join(folder, "plan.json"));
  const keyPath = path.join(folder, "qualification-key.json");
  const keys = fs.existsSync(keyPath) ? openSeal(keyPath) : [];
  const transport = path.join(root, "transport");
  const sent = new Set(
    (fs.existsSync(transport) ? fs.readdirSync(transport) : [])
      .filter((n) => n.endsWith(".request.json"))
      .map((n) => load(path.join(transport, n)))
      .filter((r) => r.kind === "judge")
      .map((r) => r.routing?.session + ":" + r.digest),
  );
  let sentPackets = 0,
    returnedPackets = 0,
    checkedFacts = 0,
    matchedFacts = 0,
    checkedAbstentions = 0,
    matchedAbstentions = 0;
  const disagreements = [];
  for (const [i, spec] of plan.controls.entries()) {
    const sub = path.join(folder, "qualification", String(i + 1));
    const wirePath = path.join(sub, "wire.json");
    if (fs.existsSync(wirePath)) {
      const w = load(wirePath);
      if (sent.has(w.session + ":" + w.sha256)) sentPackets++;
    }
    if (!fs.existsSync(path.join(sub, "results.json"))) continue;
    requireThat(
      keys[i] && bound(keys[i]) === spec.keyDigest,
      "Qualification summary key differs",
    );
    const results = openSeal(path.join(sub, "results.json"));
    returnedPackets++;
    for (const [j, item] of spec.packet.items.entries()) {
      const result = results.find(
        (r: any) => r.question_id === item.question_id,
      );
      const expected = keys[i][j];
      const key = [...expected.required, ...expected.forbidden];
      const facts = item.reference_facts.map((fact: any, k: number) => {
        const answer = result.facts.find((f: any) => f.id === fact.id);
        checkedFacts++;
        if (answer.verdict === key[k]) matchedFacts++;
        return {
          id: fact.id,
          reference: fact.text,
          expected: key[k],
          returned: answer.verdict,
          reason: answer.reason,
        };
      });
      checkedAbstentions++;
      if (expected.abstained === result.abstained) matchedAbstentions++;
      if (
        expected.abstained !== result.abstained ||
        facts.some((f: any) => f.expected !== f.returned)
      )
        disagreements.push({
          packet: i + 1,
          question: item.question_id,
          facts,
          abstention: {
            expected: expected.abstained,
            returned: result.abstained,
          },
        });
    }
  }
  return {
    plannedPackets: plan.controls.length,
    sentPackets,
    returnedPackets,
    checkedFacts,
    matchedFacts,
    checkedAbstentions,
    matchedAbstentions,
    disagreements,
  };
}
export function verifyQualificationAccounting(
  root: string,
  folder: string,
  accounting: any,
) {
  if (
    accounting.publisher !== undefined ||
    accounting.qualification !== undefined
  ) {
    requireThat(
      typeof accounting.publisher === "string" &&
        /^[a-f0-9]{40}$/.test(accounting.publisher) &&
        accounting.qualification &&
        bound(accounting.qualification) ===
          bound(qualificationSummary(root, folder)),
      "Published qualification differs from sealed packet evidence",
    );
  }
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
  verifyFactGrade(execution, g, folder);
  verifyQualificationAccounting(
    path.dirname(path.dirname(folder)),
    folder,
    summary,
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
    ...(typeof summary.publisherTrackedDirty === "boolean"
      ? { publisherTrackedDirty: summary.publisherTrackedDirty }
      : {}),
    ...(summary.publisher
      ? { publisher: summary.publisher, qualification: summary.qualification }
      : {}),
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
    ...(openSeal(path.join(folder, "plan.json")).schema >= 2
      ? {
          otherMessages: execution.events.map((event: any) => ({
            sequence: event.sequence,
            inputId: event.inputId,
            count: (event.otherMessages ?? []).length,
          })),
          otherMessageCount: execution.events.reduce(
            (n: number, event: any) => n + (event.otherMessages ?? []).length,
            0,
          ),
        }
      : {}),
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
    ...(record.otherMessageCount === undefined
      ? []
      : [
          "Other visible messages excluded from answers: " +
            record.otherMessageCount,
          "",
        ]),
    ...(record.qualification
      ? [
          "Accounting published by " +
            record.publisher +
            (record.publisherTrackedDirty === undefined
              ? ""
              : record.publisherTrackedDirty
                ? " (tracked changes present)"
                : " (clean tracked files)"),
          "Qualification packets sent: " +
            record.qualification.sentPackets +
            "/" +
            record.qualification.plannedPackets +
            "; usable replies: " +
            record.qualification.returnedPackets,
          ...record.qualification.disagreements.map(
            (q: any) =>
              "Packet " +
              q.packet +
              ", " +
              q.question +
              ": " +
              q.facts
                .map(
                  (f: any) =>
                    f.id +
                    " expected " +
                    f.expected +
                    ", returned " +
                    f.returned,
                )
                .join(" / ") +
              " / abstained expected " +
              q.abstention.expected +
              ", returned " +
              q.abstention.returned,
          ),
          "",
        ]
      : []),
    ...Object.entries(record.counts).map(([k, n]) => k + " " + n),
    "",
  ].join("\n");
}
