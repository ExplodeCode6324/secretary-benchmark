import fs from "node:fs";
import path from "node:path";
import { bound, dir, load, openSeal, save, seal } from "./files.ts";
import { requireThat, sha } from "../io.ts";
import {
  factPacket,
  factPlan,
  wireQuery,
  wirePacket,
  seriesResults,
  deterministicRaw,
  factResults,
  packetLimits,
  fixtureFacts,
  questions,
  type Item,
} from "./questions.ts";
import { remainingJudgeCalls } from "./transport.ts";

import {
  atomicPolicy,
  probeChecks,
  fixtureAtomic,
  scoreAtomic,
  type AtomicItem,
  type AtomicKey,
} from "./atomic.ts";
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
  assertions?: any[];
  penalties?: any[];
  metrics?: any;
  scoringPath?: string;
};
function description(
  p: ReturnType<typeof factPlan>,
  execution: any,
  schema = 3,
) {
  const describe = (items: Item[]) => ({
    packet: wirePacket(items),
    ...(items[0]?.atomic ? { hostItems: items } : {}),
    queryDigest: bound(wireQuery(wirePacket(items))),
    ids: items.map((i) => i.question_id),
    digest: bound(wirePacket(items)),
    wire: packetLimits(items),
  });
  return {
    schema,
    execution: bound(execution),
    order: p.observations.map(({ item, sequence, inputId }) => ({
      id: item.question_id,
      sequence,
      inputId,
      referenceDigest: bound(
        item.atomic ?? [item.abstention_policy, item.reference_facts],
      ),
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
      ...(item.atomic && inputId && !item.answer.trim()
        ? blankOutcome(item as AtomicItem)
        : {}),
    }),
  );
}
function blankOutcome(item: AtomicItem) {
  const score = scoreAtomic(
    item.atomic,
    item.atomic.facts.map(() => "ABSENT"),
    false,
    [],
    true,
  );
  return {
    penalties: score.penalties,
    metrics: score.metrics,
    scoringPath: "MISSING",
  };
}
function applyResults(row: Outcome, result: any, items?: Item[]) {
  delete row.reason;
  Object.assign(row, {
    verdict: result.verdict,
    facts: result.facts,
    abstained: result.abstained,
  });
  if (result.metrics)
    Object.assign(row, {
      metrics: result.metrics,
      assertions: result.assertions,
      penalties: result.penalties,
      scoringPath:
        items && deterministicRaw(items) !== null ? "DETERMINISTIC" : "JUDGE",
    });
}
function matchedControl(results: any[], keys: any[], atomic: boolean) {
  if (atomic)
    return (
      results.length === keys.length &&
      results.every((r, i) => {
        const k = keys[i] as AtomicKey;
        return (
          r.abstained === k.abstained &&
          bound(r.facts.map((f: any) => f.verdict)) === bound(k.labels) &&
          probeChecks(k, r).every((p) => p.pass)
        );
      })
    );
  return (
    bound(qualificationLabels(results)) ===
    bound(
      keys.map(({ required, forbidden, abstained }) => ({
        required,
        forbidden,
        abstained,
      })),
    )
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
    const results = seriesResults(
      load(path.join(sub, "response.json")).raw,
      input.packet,
      spec.hostItems,
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
    const accepted = savedResults(sub, c);
    requireThat(
      keys[i] && bound(keys[i]) === c.keyDigest,
      "Qualification key mismatch",
    );
    if (!matchedControl(accepted, keys[i], !!c.hostItems))
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
        applyResults(row, result, batch.hostItems);
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
        !(
          kind === "packets" &&
          spec.hostItems &&
          deterministicRaw(spec.hostItems) !== null
        ) &&
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
        const response = load(path.join(sub, "response.json"));
        const deterministic =
          kind === "packets" && spec.hostItems
            ? deterministicRaw(spec.hostItems)
            : null;
        if (deterministic !== null)
          requireThat(
            response.mode === "DETERMINISTIC" &&
              response.raw === deterministic &&
              !fs.existsSync(wirePath),
            "Deterministic evidence mismatch",
          );
        const result = seriesResults(
          response.raw,
          input.packet,
          spec.hostItems,
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
          row.abstained === v.abstained &&
          (!execution.manifest.config.judgeProtocol || bound(row) === bound(v))
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
    const packet = wirePacket(items),
      query = wireQuery(packet),
      sub = path.join(folder, where);
    dir(sub);
    const input = path.join(sub, "input.json");
    save(input, { packet, query });
    record(input);
    try {
      let raw: string;
      const certified = !key ? deterministicRaw(items) : null;
      if (certified !== null) {
        raw = certified;
        save(path.join(sub, "response.json"), { mode: "DETERMINISTIC", raw });
      } else if (m.config.judge === "fixture") {
        raw = items[0]?.atomic
          ? fixtureAtomic(items as AtomicItem[], key as AtomicKey[] | undefined)
          : fixtureFacts(packet, key);
        save(path.join(sub, "response.json"), { mode: "FIXTURE", raw });
      } else raw = await read(sub, query, packetLimits(items).bytes);
      const results = seriesResults(raw, packet, items);
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
  const required = p.batches.length
    ? p.controls.length +
      p.batches.filter((b) => deterministicRaw(b) === null).length
    : 0;
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
          matchedControl(results, c.key, !!c.items[0]?.atomic),
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
        applyResults(row, result, items);
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
  const allProbes: any[] = [];
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
      const host = spec.hostItems?.[j] ?? item;
      const result = results.find(
        (r: any) => r.question_id === host.question_id,
      );
      const expected = keys[i][j];
      const key = expected.labels ?? [
        ...expected.required,
        ...expected.forbidden,
      ];
      const facts = host.reference_facts.map((fact: any, k: number) => {
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
      const probes = spec.hostItems ? probeChecks(expected, result) : [];
      allProbes.push(
        ...probes.map((p) => ({
          packet: i + 1,
          question: host.question_id,
          ...p,
        })),
      );
      if (
        probes.some((p) => !p.pass) ||
        expected.abstained !== result.abstained ||
        facts.some((f: any) => f.expected !== f.returned)
      )
        disagreements.push({
          packet: i + 1,
          question: host.question_id,
          ...(spec.hostItems ? { probes } : {}),
          facts,
          abstention: {
            expected: expected.abstained,
            returned: result.abstained,
          },
        });
    }
  }
  return {
    ...(plan.controls[0]?.hostItems
      ? {
          probes: allProbes,
          matchedProbes: allProbes.filter((p) => p.pass).length,
          checkedProbes: allProbes.length,
        }
      : {}),
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
      ...(item.atomic ? { atomicReference: item.atomic } : {}),
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
    promptSha256:
      execution.manifest.implementation[
        g.policy === atomicPolicy
          ? "fact-grading-v2.txt"
          : "fact-grading-v1.txt"
      ],
    ...(g.policy === atomicPolicy ? atomicReport(execution, rows) : {}),
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
function atomicReport(execution: any, rows: Outcome[]) {
  const summary: Record<
    string,
    { numerator: number; denominator: number; rate: number | null }
  > = {};
  for (const key of ["requiredHit", "contradiction", "unsupportedExtra"]) {
    let numerator = 0,
      denominator = 0;
    for (const row of rows) {
      const metric = row.metrics?.[key];
      if (metric) {
        numerator += metric.numerator;
        denominator += metric.denominator;
      }
    }
    summary[key] = {
      numerator,
      denominator,
      rate: denominator ? numerator / denominator : null,
    };
  }
  const prior = new Map<string, string>();
  const operationChanges = execution.events.map((e: any) => {
    const changes = (e.effects ?? [])
      .filter((op: any) => prior.get(op.id) !== op.state)
      .map((op: any) => ({ ...op, previous: prior.get(op.id) ?? null }));
    for (const op of e.effects ?? []) prior.set(op.id, op.state);
    return {
      sequence: e.sequence,
      inputId: e.inputId,
      loop: e.loop ?? null,
      handledAt: e.handledAt ?? null,
      changes,
    };
  });
  const c = execution.manifest.config.controlSuite;
  return {
    atomicMetrics: summary,
    qualificationSuite: {
      qualificationScope:
        c.visibility === "WITHHELD"
          ? "AGREEMENT_WITH_WITHHELD_KEY"
          : "DEVELOPMENT_REGRESSION_ONLY",
      identity: c.identity,
      digest: c.sha256,
      visibility: c.visibility,
      labelSource: c.labelSource,
    },
    rules: execution.manifest.atomicRules,
    temperature: execution.manifest.temperature,
    taskEvidence: {
      operations: operationChanges,
      memoryWrites: "UNAVAILABLE",
      retrieval: "UNAVAILABLE",
      crossSession: "NOT_APPLICABLE",
      externalTask: "NOT_APPLICABLE",
    },
  };
}
export function seriesMarkdown(record: ReturnType<typeof seriesRecord>) {
  const clean = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  return [
    "# Secretary factual answer evaluation",
    "",
    ...(record.atomicMetrics
      ? [
          ...Object.entries(record.atomicMetrics).map(
            ([name, m]: [string, any]) =>
              name +
              " " +
              m.numerator +
              "/" +
              m.denominator +
              " · " +
              (m.rate === null ? "n/a" : (100 * m.rate).toFixed(1) + "%"),
          ),
          "",
        ]
      : []),
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
    ...(record.atomicMetrics ? atomicDetails(record) : []),
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

function atomicDetails(record: any): string[] {
  const lines = [
    "## Atomic fact evidence",
    "",
    "Each reference applies at the time of its question.",
    "",
  ];
  for (const q of record.questions) {
    lines.push(
      "### " + q.id,
      "",
      q.question,
      "",
      "Recorded answer",
      "",
      q.answer ?? "(not executed)",
      "",
      "Scoring path: " + (q.scoringPath ?? q.reason ?? q.verdict),
      "",
    );
    for (const f of q.facts ?? [])
      lines.push(
        "- " +
          f.id +
          " (" +
          f.role +
          ", " +
          f.group +
          "): " +
          f.verdict +
          " · " +
          f.text +
          " · " +
          (f.quote ? JSON.stringify(f.quote) : "(absent)") +
          " · " +
          f.reason,
      );
    for (const a of q.assertions ?? [])
      lines.push(
        "- " + a.status + " · " + JSON.stringify(a.quote) + " · " + a.claim,
      );
    for (const p of q.penalties ?? [])
      lines.push("- " + p.severity + " penalty · " + p.group);
    lines.push("");
  }
  const evidence = record.taskEvidence;
  lines.push(
    "## Task and memory evidence",
    "",
    "Memory writes: " +
      evidence.memoryWrites +
      " · retrieval: " +
      evidence.retrieval +
      " · cross-session: " +
      evidence.crossSession +
      " · external task: " +
      evidence.externalTask,
    "",
  );
  for (const e of evidence.operations)
    lines.push(
      "- Event " +
        e.sequence +
        " · " +
        (e.handledAt ?? "no native completion timestamp") +
        " · " +
        e.changes.length +
        " new or changed operations" +
        (e.changes.length
          ? ": " +
            e.changes
              .map(
                (o: any) =>
                  o.id +
                  " " +
                  o.kind +
                  " " +
                  (o.previous ?? "new") +
                  " → " +
                  o.state,
              )
              .join(", ")
          : ""),
    );
  lines.push(
    "",
    "Qualification suite: " +
      record.qualificationSuite.identity +
      " · " +
      record.qualificationSuite.digest +
      " · " +
      record.qualificationSuite.labelSource +
      " · " +
      record.qualificationSuite.qualificationScope,
    "Temperature requested: " +
      record.temperature.requested +
      " · effective: " +
      record.temperature.effective,
    "",
  );
  if (record.judgeRescoreAgreement)
    lines.push(
      "Independent regrade on the same recorded answers: " +
        record.judgeRescoreAgreement.fact.matched +
        "/" +
        record.judgeRescoreAgreement.fact.compared +
        " comparable fact labels, " +
        record.judgeRescoreAgreement.abstention.matched +
        "/" +
        record.judgeRescoreAgreement.abstention.compared +
        " comparable abstention labels.",
      "",
    );
  return lines;
}
export function rescoreAgreement(original: any[], diagnostic: any[]) {
  const fact = { matched: 0, compared: 0 },
    abstention = { matched: 0, compared: 0 };
  for (const b of diagnostic) {
    const a = original.find((r) => r.id === b.id);
    if (!a || a.scoringPath !== "JUDGE" || b.scoringPath !== "JUDGE") continue;
    abstention.compared++;
    if (a.abstained === b.abstained) abstention.matched++;
    for (const x of a.facts) {
      const y = b.facts.find((f: any) => f.id === x.id);
      if (y) {
        fact.compared++;
        if (x.verdict === y.verdict) fact.matched++;
      }
    }
  }
  return { fact, abstention };
}
