import { randomUUID } from "node:crypto";
import { requireThat, sha } from "./io.ts";
import { safeExcerpt, scoringRubric } from "./stage-c-grading.ts";
import { generateCalibration } from "./stage-b-report-calibration.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import {
  goReader,
  goVisibilityVersion,
  newVisibilityControls,
  admittedReaderQuery,
} from "./stage-c-visibility-rubric.ts";

type Coverage = "complete" | "missing" | "truncated" | "redacted";
type Source = {
  id: string | null;
  role?: "user" | "assistant" | "system" | "developer";
  text: string | null;
};
type Phase = "commit-1" | "commit-2" | "first-request";
export type TargetedC16Capture = {
  schema: "issue122-c16-capture-v1";
  first_request_sequence: number | null;
  snapshots: {
    phase: Phase;
    sequence: number | null;
    capture: Coverage;
    items: {
      id: string | null;
      contents: string | null;
      sources: Source[];
      complete: boolean;
    }[];
  }[];
  proposals: {
    id: string;
    sequence: number;
    state: string;
    effect: string;
    contents: string | null;
    sources: Source[];
    operation_matches: boolean;
    receipt_matches: boolean;
    fact_revision_matches: boolean;
    committed: boolean;
  }[];
  proposal_capture: Coverage;
};
const coverage = ["complete", "missing", "truncated", "redacted"];
const phases = ["commit-1", "commit-2", "first-request"];
type BlindRow = { id: string; text: string };
export function projectTargetedC16(
  packet: { rubric: any; assertions: string[]; evidence: BlindRow[] },
  binding: any,
  capture: TargetedC16Capture,
) {
  requireThat(
    capture.schema === "issue122-c16-capture-v1" &&
      binding.scenario === "C16-combined" &&
      packet.rubric.reader === goReader &&
      packet.rubric.version === goVisibilityVersion &&
      packet.assertions.includes("maintenance_current") &&
      packet.assertions.includes("use_current") &&
      Array.isArray(capture.snapshots) &&
      capture.snapshots.length === 3 &&
      Array.isArray(capture.proposals) &&
      (capture.first_request_sequence === null ||
        (Number.isSafeInteger(capture.first_request_sequence) &&
          capture.first_request_sequence > 0)) &&
      coverage.includes(capture.proposal_capture),
    "TARGETED_C16_CAPTURE",
  );
  requireThat(
    Array.isArray(binding.wire_ids) &&
      typeof binding.surfaceComplete === "boolean" &&
      packet.evidence.some((r) => r.id === binding.coverage_id) &&
      binding.wire_ids.every((id: string) =>
        packet.evidence.some((r) => r.id === id),
      ),
    "TARGETED_VISIBILITY_BINDING",
  );
  const rows: BlindRow[] = [],
    gaps = new Set<string>(),
    aliases = new Map<string, string>();
  function alias(type: string, id: string) {
    requireThat(
      typeof id === "string" && id.trim().length > 0,
      "TARGETED_EMPTY_ID",
    );
    const key = type + ":" + id;
    if (!aliases.has(key)) aliases.set(key, randomUUID());
    return aliases.get(key)!;
  }
  function contents(text: string | null) {
    requireThat(
      text === null || typeof text === "string",
      "TARGETED_CAPTURE_TEXT",
    );
    if (text === null || !text.trim()) {
      gaps.add("ITEM_OR_SOURCE_UNAVAILABLE");
      return null;
    }
    const filtered = safeExcerpt(text);
    const blind = filtered.replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{64}\b/gi,
      (id) => alias("embedded", id),
    );
    if (filtered !== text || /\[(?:redacted|truncated|omitted)\]/i.test(blind))
      gaps.add("REDACTED_OR_TRUNCATED");
    return blind;
  }
  const sourceById = new Map<string, Source>();
  const catalog = new Map<
    string,
    { id: string; role: string | null; observation: string | null }
  >();
  function sources(items: Source[]) {
    requireThat(Array.isArray(items), "TARGETED_CAPTURE_SOURCE");
    if (!items.length) gaps.add("SOURCE_UNAVAILABLE");
    const references = new Set<string | null>();
    for (const entry of items) {
      if (entry.id === null) {
        gaps.add("SOURCE_UNAVAILABLE");
        references.add(null);
        continue;
      }
      requireThat(
        entry.role === undefined ||
          ["user", "assistant", "system", "developer"].includes(entry.role),
        "TARGETED_SOURCE_ROLE",
      );
      const previous = sourceById.get(entry.id);
      requireThat(
        !previous ||
          (previous.role === entry.role && previous.text === entry.text),
        "TARGETED_CONFLICTING_SOURCE",
      );
      sourceById.set(entry.id, entry);
      const id = alias("source", entry.id);
      references.add(id);
      if (!catalog.has(id))
        catalog.set(id, {
          id,
          role: entry.role ?? null,
          observation: contents(entry.text),
        });
    }
    return [...references];
  }
  function add(label: string, observation: unknown) {
    const row = {
      id: randomUUID(),
      text: label + "\n" + JSON.stringify(observation),
    };
    rows.push(row);
    return row.id;
  }
  let last = 0;
  for (const [i, s] of capture.snapshots.entries()) {
    requireThat(
      s.phase === phases[i] &&
        (s.sequence === null
          ? s.capture !== "complete"
          : Number.isSafeInteger(s.sequence) && s.sequence > last) &&
        (i === 2
          ? s.sequence === capture.first_request_sequence
          : capture.first_request_sequence === null ||
            s.sequence === null ||
            s.sequence < capture.first_request_sequence) &&
        coverage.includes(s.capture) &&
        Array.isArray(s.items),
      "TARGETED_CAPTURE_CHRONOLOGY",
    );
    if (s.sequence !== null) last = s.sequence;
    if (s.capture !== "complete" || !s.items.length)
      gaps.add("MAINTENANCE_CAPTURE_INCOMPLETE");
    const seen = new Set<string>();
    const items = s.items.map((item) => {
      requireThat(
        typeof item.complete === "boolean" &&
          (item.id === null || !seen.has(item.id)),
        "TARGETED_ITEM_ID",
      );
      if (!item.complete || item.id === null)
        gaps.add("MAINTENANCE_CAPTURE_INCOMPLETE");
      if (item.id !== null) seen.add(item.id);
      return {
        id: item.id === null ? null : alias("item", item.id),
        contents: contents(item.contents),
        sources: sources(item.sources),
        complete: item.complete,
      };
    });
    add(
      [
        "First maintenance commit",
        "Second maintenance commit",
        "At the first eligible request",
      ][i],
      { capture: s.capture, items },
    );
  }
  if (capture.proposal_capture !== "complete")
    gaps.add("PROPOSAL_HISTORY_INCOMPLETE");
  last = 0;
  const proposals = capture.proposals.flatMap((v) => {
    requireThat(
      Number.isSafeInteger(v.sequence) && v.sequence >= last && v.sequence > 0,
      "TARGETED_PROPOSAL_CHRONOLOGY",
    );
    last = v.sequence;
    if (capture.first_request_sequence === null) {
      gaps.add("PROPOSAL_BOUNDARY_UNAVAILABLE");
      return [];
    }
    if (v.sequence >= capture.first_request_sequence) return [];
    requireThat(
      /^[A-Z_]{1,40}$/.test(v.state) &&
        /^[A-Z_]{1,40}$/.test(v.effect) &&
        [
          v.operation_matches,
          v.receipt_matches,
          v.fact_revision_matches,
          v.committed,
        ].every((x) => typeof x === "boolean"),
      "TARGETED_PROPOSAL_STATE",
    );
    const applied =
      v.effect === "APPLIED" &&
      v.committed &&
      v.operation_matches &&
      v.receipt_matches &&
      v.fact_revision_matches;
    if (
      !v.operation_matches ||
      (v.effect === "APPLIED" && !applied) ||
      !["NOT_STARTED", "APPLIED"].includes(v.effect)
    )
      gaps.add("PROPOSAL_EFFECT_UNVERIFIED");
    return [
      {
        id: alias("proposal", v.id),
        state: v.state,
        effect: v.effect,
        contents: contents(v.contents),
        sources: sources(v.sources),
        committed_effect_verified: applied,
      },
    ];
  });
  add("Proposal history before the first eligible request", {
    capture: capture.proposal_capture,
    proposals,
  });
  add("Source observations", [...catalog.values()]);
  const projected = { ...packet, evidence: [...packet.evidence, ...rows] };
  admittedReaderQuery(projected);
  return {
    packet: projected,
    binding: {
      ...binding,
      capture_sha256: sha(gradeJSONBytes(capture)),
      capture_gaps: [...gaps],
      maintenance_evidence_ids: rows.map((r) => r.id),
      aliases: Object.fromEntries(aliases),
    },
  };
}

export function targetedControls() {
  const baseline = generateCalibration(),
    visibility = newVisibilityControls();
  const label = new Map(baseline.key.map((k) => [k.id, k.expected]));
  const [current, old, source] = [randomUUID(), randomUUID(), randomUUID()];
  const prefix = `Source ${source} confirms ${current} as current and supersedes ${old}.`;
  const rows = baseline.packet.controls.map((c) => {
    const expected = label.get(c.id);
    if (c.assertion === "maintenance_current")
      return {
        ...c,
        text:
          expected === "PASS"
            ? `${prefix} Both maintenance commits retain ${current} from that source. An old-value proposal remains pending, unexecuted, without an applied effect before the request.`
            : `${prefix} The effective maintenance item still identifies ${old} as current. Later use correctly returns ${current}.`,
      };
    if (c.assertion === "natural_access" && expected === "UNRESOLVED")
      return {
        ...c,
        text: `The reply uses ${current}. One source is redacted; one first-request surface is missing. No conclusive evidence of the natural access path was captured.`,
      };
    return c;
  });
  const controls = [
    ...rows,
    ...visibility.reader.map((v) => ({ ...v, assertion: "visibility" })),
  ].sort((a, b) => a.id.localeCompare(b.id));
  const packet = {
    rubric: scoringRubric(goReader, goVisibilityVersion),
    controls,
  };
  requireThat(
    controls.length === 28 && new Set(controls.map((x) => x.id)).size === 28,
    "TARGETED_CONTROL_COUNT",
  );
  admittedReaderQuery(packet);
  return { packet, key: [...baseline.key, ...visibility.key] };
}
