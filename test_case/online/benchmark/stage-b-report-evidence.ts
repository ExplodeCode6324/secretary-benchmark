import { gradeUUID, readOwnedGradeFile } from "./grading-transaction.ts";
import { requireThat, sha } from "./io.ts";
import { stageSlots } from "./stage-b-policy.ts";
import { type Assertion } from "./stage-b-report-calibration.ts";

const digest = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const safeCount = (n: unknown) =>
  Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : null;
const label = (v: unknown) =>
  v === "PASS" || v === "FAIL" || v === "UNRESOLVED" ? v : "NOT_TESTED";
const requirements = [
  "PROBE_CAPTURE_MISSING",
  "WORLD_BOUNDARY_MISSING",
  "TWO_MAINTENANCE_COMMITS_MISSING",
  "COLD_OBSERVATION_MISSING",
  "TASK_ACTIVATION_MISSING",
];
export type TrialBinding = {
  id: string;
  episode: string;
  lane: string;
  freeze: string;
  evidence: string;
};
export function trialArtifact(root: string, b: TrialBinding) {
  requireThat(
    gradeUUID(b.id) &&
      gradeUUID(b.episode) &&
      digest(b.evidence) &&
      stageSlots.some((s) => s.lane === b.lane),
    "STAGE_B_EVIDENCE_BINDING",
  );
  const bytes = readOwnedGradeFile(
    root,
    "evidence/" + b.id + "/stage-b-evidence.json",
  );
  requireThat(sha(bytes) === b.evidence, "STAGE_B_EVIDENCE_CHANGED");
  const packet = JSON.parse(bytes.toString());
  requireThat(
    packet.schema === "issue122-stage-scenario-evidence-v1" &&
      packet.episode === b.episode &&
      packet.lane === b.lane &&
      packet.freeze_sha256 === b.freeze &&
      digest(packet.timeline_sha256) &&
      Array.isArray(packet.failures),
    "STAGE_B_EVIDENCE_BINDING",
  );
  return packet;
}
export function hostEvidence(packet: ReturnType<typeof trialArtifact>) {
  const proof = packet.proof,
    m = proof?.maintenance,
    t = proof?.task,
    w = proof?.world,
    c = proof?.cold;
  const failures = (packet.failures as string[]).map((v) => ({
    code: requirements.includes(v) ? v : "PRIVATE_FAILURE",
    sha256: sha(v),
  }));
  return {
    evidence_class: "HOST_OBSERVATIONS",
    first_failure: failures[0] ?? null,
    failures,
    probe_captured:
      digest(proof?.outcome?.probe_response) &&
      digest(proof?.outcome?.probe_payload),
    world: w
      ? {
          commit_sequence: safeCount(w.commit_sequence),
          first_eligible_sequence: safeCount(w.first_eligible_sequence),
          receipt_sha256: digest(w.receipt_sha256) ? w.receipt_sha256 : null,
          rejected_bound: !!w.rejected,
          approved_bound: !!w.approved,
          restart_observed: w.restart_observed === true,
        }
      : null,
    maintenance: m
      ? {
          samples: (m.samples as any[]).map((s) => ({
            revision: safeCount(s.revision),
            covered: safeCount(s.covered),
            items_bytes: safeCount(s.items_bytes),
            target_item_bytes: safeCount(s.target_item_bytes),
            target_item_share:
              typeof s.target_item_share === "number" &&
              s.target_item_share >= 0 &&
              s.target_item_share <= 1
                ? s.target_item_share
                : null,
          })),
          first_failure_sha256: m.first_failure
            ? sha(JSON.stringify(m.first_failure))
            : null,
          item_lineage:
            m.item_lineage === "REVIEW_REQUIRED"
              ? "REVIEW_REQUIRED"
              : "NOT_TESTED",
        }
      : null,
    cold: c
      ? {
          pre_restart_measured: c.pre_restart?.measured === true,
          probe_measured: c.probe?.measured === true,
          opaque: typeof c.probe?.opaque === "boolean" ? c.probe.opaque : null,
          original_reads: c.reads.length,
          uses: c.reads.filter((x: { use_call?: string }) => x.use_call).length,
          restart_observed: c.restart_observed === true,
          semantic_absence: "UNRESOLVED",
        }
      : null,
    task: t
      ? {
          condition_met_or_answered: t.condition_met_or_answered === true,
          window_complete: t.window_complete === true,
          physical_writes: safeCount(t.physical_writes),
          matching_writes: safeCount(t.matching_writes),
          unknown_writes: safeCount(t.unknown_writes),
          effects: label(t.effects),
        }
      : null,
  };
}

export function blindExcerpts(
  root: string,
  b: TrialBinding,
  assertions: Assertion[],
) {
  const packet = trialArtifact(root, b),
    proof = packet.proof;
  requireThat(proof && digest(proof.journal_digest), "STAGE_B_GRADE_NO_PROOF");

  const rows: { assertion: Assertion; text: string; source_sha256: string }[] =
    [];
  function add(names: Assertion[], text: string, source_sha256 = b.evidence) {
    requireThat(
      Buffer.byteLength(text) <= 24000 &&
        !/(?:[\x00-\x08\x0b\x0c\x0e-\x1f]|\b(?:sk-|bearer\s|api[_-]?key|secret[_-]?key|authorization\s*:)|https?:\/\/|postgres(?:ql)?:|\/Users\/|\/home\/|[a-z]:\\|\.local\/|\bgpt-|deepseek|openai|\b(?:RC98304|DEP_DEFAULT_UNVERIFIED|C05-W|C08-inference|C10-condition|C16-combined)\b)/i.test(
          text,
        ),
      "STAGE_B_BLIND_DISCLOSURE",
    );
    for (const assertion of names.filter((a) => assertions.includes(a)))
      rows.push({ assertion, text, source_sha256 });
  }
  const excerptBytes = readOwnedGradeFile(
    root,
    "evidence/" + b.id + "/stage-b-semantic-evidence.json",
  );
  requireThat(
    digest(packet.excerpts_sha256) &&
      sha(excerptBytes) === packet.excerpts_sha256,
    "STAGE_B_GRADE_EXCERPTS_CHANGED",
  );
  const source = JSON.parse(excerptBytes.toString());
  requireThat(
    source.schema === "issue122-stage-excerpts-v1" &&
      Array.isArray(source.excerpts) &&
      JSON.stringify(source.excerpts) === JSON.stringify(proof.excerpts),
    "STAGE_B_GRADE_EXCERPTS_CHANGED",
  );
  const groups: Record<string, Assertion[]> = {
    probe_reply: [
      "current_vs_history",
      "source_identity",
      "use_current",
      "authority_chain",
      "natural_access",
      "obligation",
    ],
    setup_reply: ["current_vs_history", "source_identity", "authority_chain"],
    working_memory_item: [
      "text_survival",
      "authority_chain",
      "maintenance_current",
    ],
  };
  for (const e of source.excerpts) {
    requireThat(
      Object.hasOwn(groups, e.kind) &&
        digest(e.source_sha256) &&
        typeof e.text === "string",
      "STAGE_B_GRADE_EXCERPT_TYPE",
    );
    add(groups[e.kind], e.kind + " — " + e.text, e.source_sha256);
  }
  if (proof.world)
    add(
      ["current_vs_history", "source_identity"],
      JSON.stringify({
        ...hostEvidence(packet).world,
        decisions: packet.trail.decisions.map((d: any) => ({
          decision: d.decision === "APPROVE" ? "APPROVE" : "REJECT",
          source: gradeUUID(d.source) ? d.source : null,
        })),
      }),
    );
  if (proof.maintenance?.samples?.length) {
    for (const sample of proof.maintenance.samples) {
      add(
        ["text_survival"],
        JSON.stringify({
          revision: safeCount(sample.revision),
          total_bytes: safeCount(sample.items_bytes),
          target_bytes: safeCount(sample.target_item_bytes),
        }),
      );
      if (proof.maintenance.item_lineage === "REVIEW_REQUIRED")
        add(
          ["item_lineage"],
          JSON.stringify({
            revision: safeCount(sample.revision),
            items: sample.target_items.map((i: any) => ({
              id: sha(i.id),
              sources: i.source_hashes.filter(digest),
            })),
          }),
        );
    }
  }
  if (proof.task) {
    const t = hostEvidence(packet).task!;
    add(
      ["obligation", "effects"],
      JSON.stringify({
        activation_observed: t.condition_met_or_answered,
        window_complete: t.window_complete,
        writes: t.physical_writes,
        matching_writes: t.matching_writes,
        unknown_writes: t.unknown_writes,
      }),
    );
  }
  if (proof.cold) {
    const cold = hostEvidence(packet).cold!;
    add(
      ["natural_access"],
      JSON.stringify({
        pre_restart_measured: cold.pre_restart_measured,
        probe_measured: cold.probe_measured,
        opaque: cold.opaque,
        original_reads: cold.original_reads,
        uses: cold.uses,
        restart_observed: cold.restart_observed,
      }),
    );
  }
  requireThat(
    rows.length > 0 && Buffer.byteLength(JSON.stringify(rows)) <= 128 * 1024,
    "STAGE_B_GRADE_PACKET_SIZE",
  );
  return rows;
}
