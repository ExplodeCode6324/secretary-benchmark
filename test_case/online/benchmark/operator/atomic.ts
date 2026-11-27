import fs from "node:fs";
import path from "node:path";
import { gradeJSONBytes } from "../grading-transaction.ts";
import { repository, requireThat, sha } from "../io.ts";

export const atomicPolicy = "secretary-answer-atomic-facts-v2";
export const atomicWirePolicy = "atomic-facts-v2";
export const atomicRules = {
  scoring: "atomic-score-v2",
  normalization: "whole-answer-nfc-v1",
  probes: "anchor-status-v1",
};
export const atomicInstructions = fs
  .readFileSync(
    path.join(
      repository,
      "test_case/online/benchmark/operator/fact-grading-v2.txt",
    ),
    "utf8",
  )
  .trimEnd();
const severities = ["ignore", "minor", "major"] as const;
type Severity = (typeof severities)[number];
const labels = ["SUPPORTED", "ABSENT", "CONTRADICTED"] as const;
type Label = (typeof labels)[number];
const statuses = [
  "SUPPORTED_BY",
  "CONTRADICTS",
  "UNSUPPORTED_BY_REFERENCE",
  "NOT_CHECKABLE",
] as const;
type Status = (typeof statuses)[number];
export type AtomicFact = {
  id: string;
  text: string;
  role: "REQUIRED" | "MUST_NOT_CONTRADICT" | "OPTIONAL";
  group: string;
  missing: Severity;
  contradicted: Severity;
  exclusive?: boolean;
  equivalents?: string[];
};
type SetRule = {
  group?: string;
  id: string;
  mode: "ANY_OF" | "ALL_OF";
  members: string[];
  k?: number;
  missing?: Severity;
  multipleValid?: boolean;
};
type Assertion = {
  quote: string;
  claim: string;
  status: Status;
  fact_ids: string[];
};
type Mark = { id: string; verdict: Label; quote: string; reason: string };
type Reply = { facts: Mark[]; abstained: boolean; assertions: Assertion[] };
type Variant = { answer: string; attesters: string[]; result: Reply };
export type AtomicReference = {
  abstention: "REQUIRED" | "ACCEPTABLE" | "NOT_ACCEPTABLE";
  facts: AtomicFact[];
  sets?: SetRule[];
  variants?: Variant[];
  abstentionSeverity?: Exclude<Severity, "ignore">;
};
export type Probe = { anchor: string; status: Status; present: boolean };
export type AtomicKey = {
  labels: Label[];
  abstained: boolean;
  probes: Probe[];
};
export type AtomicControl = {
  id: string;
  question: string;
  answer: string;
  reference: AtomicReference;
  expected: AtomicKey;
};
const string = (x: unknown): x is string => typeof x === "string" && !!x.trim();
const id = (x: unknown): x is string =>
  string(x) && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(x);
const unique = (a: unknown[]) => new Set(a).size === a.length;
const fields = (v: unknown, keys: string[]) =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).every((k) => keys.includes(k));
const check = (ok: unknown, why: string) =>
  requireThat(!!ok, "Invalid atomic evaluation: " + why);
export function validateAtomicReference(r: AtomicReference) {
  check(
    fields(r, [
      "abstention",
      "facts",
      "sets",
      "variants",
      "abstentionSeverity",
    ]) &&
      ["REQUIRED", "ACCEPTABLE", "NOT_ACCEPTABLE"].includes(r.abstention) &&
      Array.isArray(r.facts) &&
      r.facts.length <= 64,
    "reference",
  );
  check(
    r.abstentionSeverity === undefined ||
      ["minor", "major"].includes(r.abstentionSeverity),
    "abstention severity",
  );
  const ids = new Set<string>();
  for (const f of r.facts) {
    check(
      fields(f, [
        "id",
        "text",
        "role",
        "group",
        "missing",
        "contradicted",
        "exclusive",
        "equivalents",
      ]) &&
        id(f.id) &&
        !ids.has(f.id) &&
        string(f.text) &&
        id(f.group),
      "fact identity",
    );
    ids.add(f.id);
    check(
      ["REQUIRED", "MUST_NOT_CONTRADICT", "OPTIONAL"].includes(f.role) &&
        severities.includes(f.missing) &&
        severities.includes(f.contradicted),
      "fact role/severity",
    );
    check(
      f.role === "REQUIRED"
        ? f.missing !== "ignore" && f.contradicted !== "ignore"
        : f.missing === "ignore",
      "severity for fact role",
    );
    check(
      f.exclusive === undefined || typeof f.exclusive === "boolean",
      "exclusive flag",
    );
    if (f.exclusive)
      check(
        f.role === "REQUIRED" &&
          /唯一|仅有|只有|\bonly\b|\bsole\b|\bunique\b/i.test(f.text),
        "exclusive wording",
      );
    if (f.equivalents !== undefined)
      check(
        Array.isArray(f.equivalents) &&
          f.equivalents.every(string) &&
          unique(f.equivalents),
        "equivalents",
      );
  }
  const members = new Set<string>(),
    setIds = new Set<string>();
  check(r.sets === undefined || Array.isArray(r.sets), "set list");
  for (const s of r.sets ?? []) {
    check(
      fields(s, [
        "id",
        "mode",
        "members",
        "k",
        "missing",
        "multipleValid",
        "group",
      ]) &&
        id(s.id) &&
        !setIds.has(s.id) &&
        ["ANY_OF", "ALL_OF"].includes(s.mode) &&
        Array.isArray(s.members) &&
        s.members.length > 0 &&
        unique(s.members),
      "set",
    );
    check(
      s.group === undefined || (s.mode === "ANY_OF" && id(s.group)),
      "set error group",
    );
    setIds.add(s.id);
    for (const k of s.members) {
      check(
        !members.has(k) &&
          r.facts.some(
            (f) => f.id === k && f.role === "REQUIRED" && !f.exclusive,
          ),
        "set member",
      );
      members.add(k);
    }
    check(
      s.multipleValid === undefined || typeof s.multipleValid === "boolean",
      "set multiplicity",
    );
    check(
      s.mode === "ANY_OF"
        ? Number.isSafeInteger(s.k) &&
            s.k! > 0 &&
            s.k! <= s.members.length &&
            ["minor", "major"].includes(s.missing!)
        : s.k === undefined && s.missing === undefined,
      "group obligation",
    );
  }
  check(
    r.facts.some((f) => f.role === "REQUIRED") || r.abstention === "REQUIRED",
    "no obligation",
  );
  check(r.variants === undefined || Array.isArray(r.variants), "variant list");
  const seen = new Set<string>();
  for (const v of r.variants ?? []) {
    check(
      fields(v, ["answer", "attesters", "result"]) &&
        string(v.answer) &&
        Array.isArray(v.attesters) &&
        v.attesters.length >= 2 &&
        v.attesters.every(string) &&
        unique(v.attesters),
      "variant attestation",
    );
    const key = normalize(v.answer);
    check(!seen.has(key), "duplicate normalized variant");
    seen.add(key);
    validateAtomicReply(v.result, r, v.answer);
  }
}
export function validateControlSuite(s: any) {
  check(
    fields(s, ["version", "identity", "visibility", "labelSource", "items"]) &&
      s.version === 2 &&
      string(s.identity) &&
      string(s.labelSource) &&
      ["DEVELOPMENT", "WITHHELD", "REVEALED"].includes(s.visibility) &&
      Array.isArray(s.items) &&
      s.items.length > 0,
    "control suite",
  );
  const ids = new Set<string>();
  for (const c of s.items as AtomicControl[]) {
    check(
      fields(c, ["id", "question", "answer", "reference", "expected"]) &&
        id(c.id) &&
        !ids.has(c.id) &&
        string(c.question) &&
        string(c.answer),
      "control identity",
    );
    ids.add(c.id);
    validateAtomicReference(c.reference);
    const k = c.expected;
    check(
      fields(k, ["labels", "abstained", "probes"]) &&
        Array.isArray(k.labels) &&
        k.labels.length === c.reference.facts.length &&
        k.labels.every((l) => labels.includes(l)) &&
        typeof k.abstained === "boolean" &&
        Array.isArray(k.probes),
      "key",
    );
    for (const p of k.probes)
      check(
        fields(p, ["anchor", "status", "present"]) &&
          string(p.anchor) &&
          c.answer.includes(p.anchor) &&
          statuses.includes(p.status) &&
          typeof p.present === "boolean",
        "probe",
      );
    check(
      !k.probes.some((a, i) =>
        k.probes.some((b, j) => i !== j && a.anchor.includes(b.anchor)),
      ),
      "nested or repeated probe anchors",
    );
  }
  return s;
}
export function atomicItem(
  question_id: string,
  question: string,
  r: AtomicReference,
  answer: string,
) {
  return {
    question_id,
    question,
    abstention_policy: r.abstention,
    reference_facts: r.facts.map((f) => ({
      id: f.id,
      kind: f.role,
      text: f.text,
    })),
    answer,
    atomic: r,
  };
}
export type AtomicItem = ReturnType<typeof atomicItem>;
export function atomicPacket(items: AtomicItem[]) {
  return {
    policy: atomicWirePolicy,
    items: items.map((x, i) => ({
      question_id: "q" + (i + 1),
      question: x.question,
      reference_facts: x.atomic.facts.map((f, j) => ({
        id: "f" + (j + 1),
        text: f.text,
        ...(f.equivalents?.length ? { equivalents: f.equivalents } : {}),
      })),
      answer: x.answer,
    })),
  };
}
const normalize = (s: string) => s.normalize("NFC").trim();
export function certifiedResult(i: AtomicItem) {
  const v = i.atomic.variants?.find(
    (v) => normalize(v.answer) === normalize(i.answer),
  );
  if (!v) return null;
  // Whitespace and Unicode normalization may move spans. Only use a certificate
  // whose observations still quote exact substrings of this actual answer.
  if (
    [...v.result.facts, ...v.result.assertions].some(
      (m) => m.quote && !i.answer.includes(m.quote),
    )
  )
    return null;
  return v.result;
}
function validateAtomicReply(row: Reply, r: AtomicReference, answer: string) {
  check(
    row &&
      typeof row.abstained === "boolean" &&
      Array.isArray(row.facts) &&
      Array.isArray(row.assertions) &&
      row.facts.length === r.facts.length,
    "response shape",
  );
  const ordered = r.facts.map((f, i) => {
    const matches = row.facts.filter((m) => m?.id === "f" + (i + 1)),
      m = matches[0];
    check(
      matches.length === 1 &&
        fields(m, ["id", "verdict", "quote", "reason"]) &&
        labels.includes(m.verdict) &&
        string(m.reason),
      "fact label or ID",
    );
    check(
      m.verdict === "ABSENT"
        ? m.quote === ""
        : string(m.quote) && answer.includes(m.quote),
      "fact quote",
    );
    return m;
  });
  const assertions = row.assertions;
  check(
    unique(assertions.map((a) => normalize(a.claim).toLowerCase())),
    "duplicate answer claim",
  );
  for (const a of assertions) {
    check(
      fields(a, ["quote", "claim", "status", "fact_ids"]) &&
        string(a.quote) &&
        answer.includes(a.quote) &&
        string(a.claim) &&
        statuses.includes(a.status) &&
        Array.isArray(a.fact_ids) &&
        unique(a.fact_ids),
      "assertion evidence",
    );
    const linked = a.status === "SUPPORTED_BY" || a.status === "CONTRADICTS";
    check(
      linked ? a.fact_ids.length > 0 : a.fact_ids.length === 0,
      "assertion references",
    );
    for (const f of a.fact_ids)
      check(
        ordered.some(
          (m) =>
            m.id === f &&
            m.verdict ===
              (a.status === "SUPPORTED_BY" ? "SUPPORTED" : "CONTRADICTED"),
        ),
        "assertion and fact disagree",
      );
  }
  for (const m of ordered)
    if (m.verdict === "CONTRADICTED")
      check(
        assertions.some(
          (a) => a.status === "CONTRADICTS" && a.fact_ids.includes(m.id),
        ),
        "missing contradiction evidence",
      );
  if (row.abstained)
    check(
      ordered.every((m) => m.verdict === "ABSENT") &&
        !assertions.some((a) => a.status !== "NOT_CHECKABLE"),
      "substantive abstention",
    );
  return ordered;
}
export function rawAtomic(
  packet: ReturnType<typeof atomicPacket>,
  rows: Reply[],
) {
  return JSON.stringify({
    packet_sha256: sha(gradeJSONBytes(packet)),
    results: rows.map((r, i) => ({
      question_id: packet.items[i].question_id,
      ...r,
    })),
  });
}
export function parseAtomic(raw: string, items: AtomicItem[]) {
  const p = atomicPacket(items),
    reply = JSON.parse(
      raw.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"),
    );
  check(
    reply.packet_sha256 === sha(gradeJSONBytes(p)) &&
      Array.isArray(reply.results) &&
      reply.results.length === items.length,
    "response digest or question count",
  );
  return items.map((it, i) => {
    const rows = reply.results.filter(
      (row: any) => row?.question_id === p.items[i].question_id,
    );
    check(rows.length === 1, "question identity");
    const row = rows[0] as Reply,
      marks = validateAtomicReply(row, it.atomic, it.answer);
    const facts = it.atomic.facts.map((f, j) => ({
      ...f,
      kind: f.role,
      verdict: marks[j].verdict,
      quote: marks[j].quote,
      reason: marks[j].reason,
    }));
    const assertions = row.assertions.map((a) => ({
      ...a,
      fact_ids: a.fact_ids.map(
        (fid) => it.atomic.facts[Number(fid.slice(1)) - 1].id,
      ),
    }));
    return {
      question_id: it.question_id,
      abstained: row.abstained,
      facts,
      assertions,
      ...scoreAtomic(
        it.atomic,
        marks.map((m) => m.verdict),
        row.abstained,
        assertions,
      ),
    };
  });
}
export function scoreAtomic(
  r: AtomicReference,
  marks: Label[],
  abstained: boolean,
  assertions: Assertion[],
  blank = false,
) {
  const penalties = new Map<string, Severity>(),
    contradictions = new Set<string>();
  const trigger = (g: string, s: Severity) => {
    if (
      s !== "ignore" &&
      severities.indexOf(s) > severities.indexOf(penalties.get(g) ?? "ignore")
    )
      penalties.set(g, s);
  };
  const anySets = (r.sets ?? []).filter((s) => s.mode === "ANY_OF");
  const indexes = new Map(r.facts.map((f, j) => [f.id, j]));
  const groupForSet = (s: SetRule) => {
    const groups = new Set(
      s.members.map((id) => r.facts[indexes.get(id)!].group),
    );
    return s.group ?? (groups.size === 1 ? [...groups][0] : s.id);
  };
  const alternatives = new Map(
    anySets.flatMap((s) =>
      s.members.map((id) => [id, groupForSet(s)] as const),
    ),
  );
  const refGroups = new Set(
    r.facts.map((f) => alternatives.get(f.id) ?? f.group),
  );
  const permitted = abstained && r.abstention !== "NOT_ACCEPTABLE" && !blank;
  let hits = 0,
    required = 0;
  for (const [index, f] of r.facts.entries()) {
    const v = marks[index];
    if (f.role === "REQUIRED" && !alternatives.has(f.id) && !permitted) {
      required++;
      if (v === "SUPPORTED") hits++;
      else trigger(f.group, f.missing);
    }
    if (v === "CONTRADICTED") {
      const group = alternatives.get(f.id) ?? f.group;
      contradictions.add(group);
      trigger(group, f.contradicted);
    }
  }
  for (const s of anySets)
    if (!permitted) {
      required++;
      if (
        s.members.filter((k) => marks[indexes.get(k)!] === "SUPPORTED")
          .length >= s.k!
      )
        hits++;
      else trigger(groupForSet(s), s.missing!);
    }
  if (
    !blank &&
    ((abstained && r.abstention === "NOT_ACCEPTABLE") ||
      (!abstained && r.abstention === "REQUIRED"))
  )
    trigger("abstention-policy", r.abstentionSeverity ?? "major");
  const substantive = !blank && !abstained;
  const metric = (n: number, d: number) => ({
    numerator: n,
    denominator: d,
    rate: d ? n / d : null,
  });
  return {
    penalties: [...penalties].map(([group, severity]) => ({ group, severity })),
    verdict: [...penalties.values()].includes("major")
      ? "FAIL"
      : penalties.size
        ? "PARTIAL"
        : "PASS",
    metrics: {
      requiredHit: metric(hits, required),
      contradiction: metric(
        substantive ? contradictions.size : 0,
        substantive ? refGroups.size : 0,
      ),
      unsupportedExtra: metric(
        substantive
          ? assertions.filter((a) => a.status === "UNSUPPORTED_BY_REFERENCE")
              .length
          : 0,
        substantive
          ? assertions.filter((a) => a.status !== "NOT_CHECKABLE").length
          : 0,
      ),
    },
  };
}
export function probeChecks(key: AtomicKey, row: { assertions: Assertion[] }) {
  return key.probes.map((p) => {
    const matches = row.assertions.filter(
      (a) => a.status === p.status && a.quote.includes(p.anchor),
    );
    const pass = p.present
      ? matches.some(
          (a) =>
            !key.probes.some(
              (other) =>
                other.anchor !== p.anchor && a.quote.includes(other.anchor),
            ),
        )
      : matches.length === 0;
    return { ...p, pass };
  });
}
// Local scripted transport for CI and native wire rehearsal. These marks do not
// constitute an independent semantic judgement.
export function fixtureAtomic(items: AtomicItem[], keys?: AtomicKey[]) {
  const rows = items.map((it, i) => {
    const k = keys?.[i],
      assertions: Assertion[] = [];
    const facts = it.atomic.facts.map((f, j) => {
      const literal = [f.text, ...(f.equivalents ?? [])].find((s) =>
        it.answer.includes(s),
      );
      const verdict = k?.labels[j] ?? (literal ? "SUPPORTED" : "ABSENT");
      const status =
        verdict === "CONTRADICTED" ? "CONTRADICTS" : "SUPPORTED_BY";
      const quote =
        verdict === "ABSENT"
          ? ""
          : (literal ??
            k?.probes.find((p) => p.present && p.status === status)?.anchor ??
            it.answer);
      const mark = {
        id: "f" + (j + 1),
        verdict,
        quote,
        reason: "Scripted transport",
      };
      if (verdict !== "ABSENT")
        assertions.push({ quote, claim: f.text, status, fact_ids: [mark.id] });
      return mark;
    });
    for (const probe of k?.probes ?? []) {
      if (
        !probe.present ||
        assertions.some(
          (a) => a.status === probe.status && a.quote === probe.anchor,
        )
      )
        continue;
      const linked = facts
        .filter((m) =>
          probe.status === "SUPPORTED_BY"
            ? m.verdict === "SUPPORTED"
            : probe.status === "CONTRADICTS" && m.verdict === "CONTRADICTED",
        )
        .slice(0, 1)
        .map((m) => m.id);
      assertions.push({
        quote: probe.anchor,
        claim: "Scripted probe " + probe.anchor,
        status: probe.status,
        fact_ids: linked,
      });
    }
    return { abstained: k?.abstained ?? false, facts, assertions };
  });
  return rawAtomic(atomicPacket(items), rows);
}
