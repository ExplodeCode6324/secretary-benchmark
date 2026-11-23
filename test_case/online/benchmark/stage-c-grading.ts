import { ledger } from "./campaign.ts";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Domains } from "./domain.ts";
import {
  loadCompletion,
  completionApproval,
  freezeFile,
} from "./stage-c-freeze.ts";
import { caseDefinition, stageCases } from "./stage-c-plan.ts";
import { c16Disposition } from "./stage-c-observations.ts";
import { correctionControls } from "./stage-c-correction.ts";
import {
  gradeJSONBytes,
  commitGradeFiles,
  assertGradeStore,
  readOwnedGradeJSON,
  readOwnedGradeFile,
} from "./grading-transaction.ts";
import {
  attemptHistory,
  generateCalibration,
  boundJudge,
  reserveJudgeAttempt,
  settleJudgeAttempt,
  mechanicalReasons,
} from "./stage-b-report-calibration.ts";
import { read, readJSON, requireThat, sha } from "./io.ts";

const base = "oracles/completion";
const rubric = {
  version: "issue122-comparison-reader-v1",
  reader: "Opus 5.5 Extra",
  instructions:
    "Evaluate only supplied evidence. Preserve current versus historical claims, authority versus inference, and exact event and task identity. Grade each listed assertion PASS, FAIL, UNRESOLVED or NOT_TESTED. Cite the supplied evidence IDs. A correct answer alone cannot establish retrieval or a physical effect.",
  visibility:
    "Inspect the entire first eligible request across raw conversation, assistant and tool history, working memory, and the system profile and recall. Classify RESIDENT if the corrected fact is supported on a visible surface, COLD only with complete absence, and OPAQUE if inspection is incomplete. Grade maintenance independently of final use. A partial statement of the restriction alone does not establish the current day.",
};
const binding = (root: string, dir: string) =>
  sha(readOwnedGradeFile(root, dir + "/blind.json"));
export function calibrationInputs(root: string) {
  const dir = base + "/calibration";
  return {
    reader: rubric.reader,
    version: rubric.version,
    rubric_sha256: sha(gradeJSONBytes(rubric)),
    packet_sha256: binding(root, dir),
    key_sha256: sha(readOwnedGradeFile(root, dir + "/key.json")),
    max_attempts: 3,
  };
}
export async function prepareCompletionCalibration(root: string) {
  return Domains.use(root, async (d) => {
    const dir = base + "/calibration",
      store = assertGradeStore(root);
    if (!store.has(dir + "/blind.json")) {
      const semantic = generateCalibration(),
        visibility = correctionControls();
      const packet = {
        rubric,
        controls: [
          ...semantic.packet.controls,
          ...visibility.reader.map((v) => ({ ...v, assertion: "visibility" })),
        ].sort((a, b) => a.id.localeCompare(b.id)),
      };
      const key = [...semantic.key, ...visibility.key];
      commitGradeFiles(
        root,
        d.assertControllerLease(),
        "completion-calibration",
        [
          { name: dir + "/blind.json", content: gradeJSONBytes(packet) },
          { name: dir + "/key.json", content: gradeJSONBytes(key) },
        ],
      );
    }
    return calibrationInputs(root);
  });
}
function safeExcerpt(text: string) {
  // Scoring packets contain synthetic task material. Never pass filesystem locations, model identities, endpoints or credential-like strings to the reader.
  const redacted = text
    .replace(
      /(?:\/Users\/|\/home\/|\/private\/|\/Volumes\/|\/tmp\/)[^\s"<>]+/g,
      "[host path]",
    )
    .replace(/https?:\/\/[^\s"<>]+/gi, "[endpoint]")
    .replace(/\b(?:deepseek[\w.-]*|gpt-[\w.-]+|openai)\b/gi, "[provider]")
    .replace(
      /\b(?:RC98304|DEP_DEFAULT_UNVERIFIED|C\d\d[a-z]?(?:-[\w-]+)?)\b/g,
      "[case]",
    );
  requireThat(
    !/(?:\b(?:sk-[A-Za-z0-9_-]{12,}|bearer\s+[\w.+/-]{8,})|postgres(?:ql)?:\/\/|\.local\/|[A-Za-z]:\\|-----BEGIN .*PRIVATE KEY)/i.test(
      redacted,
    ),
    "STAGE_C_BLIND_DISCLOSURE",
  );
  return redacted;
}
function trialPacket(root: string, lane: string, scenario: string) {
  const state = readJSON(path.join(root, "campaign/stage-c-dispatch.json")),
    terminal = state.terminals[lane];
  requireThat(
    terminal?.run && terminal.report_sha256,
    "STAGE_C_TRIAL_UNAVAILABLE",
  );
  const file = path.join(root, "evidence", terminal.run, "stage-c-trial.json");
  requireThat(
    sha(read(file)) === terminal.report_sha256,
    "STAGE_C_REPORT_CHANGED",
  );
  const trial = readJSON(file),
    p = trial.observations.find(
      (o: any) =>
        o.physical && (o.case_id ?? trial.descriptor.scenario) === scenario,
    );
  requireThat(p?.physical?.journal_digest, "STAGE_C_NO_SEALED_PROOF");
  const c = caseDefinition(scenario),
    rows: { id: string; text: string }[] = [];
  const add = (kind: string, text: string) =>
    rows.push({ id: randomUUID(), text: safeExcerpt(kind + "\n" + text) });
  c.setup.forEach((s) => add("Master setup", s));
  add("Probe", c.probe);
  for (const e of p.physical.excerpts) add(e.kind, e.text);
  const { assertions: hostVerdicts, ...observed } = p.witness;
  add(
    "Host observation",
    JSON.stringify({
      requirements: p.physical.requirements,
      witness: observed,
      world: p.physical.world,
      task: p.physical.task,
      maintenance: p.physical.maintenance,
      cold: p.physical.cold,
    }),
  );
  let surfaceComplete = false;
  if (p.physical.outcome.probe_send) {
    const wire = readJSON(
      path.join(
        root,
        "evidence",
        p.run,
        "send-" + p.physical.outcome.probe_send + ".json",
      ),
    );
    requireThat(
      sha(JSON.stringify(wire.payload)) === p.physical.outcome.probe_payload,
      "STAGE_C_GRADING_WIRE_CHANGED",
    );
    const messages = wire.payload.messages ?? wire.payload.input;
    if (Array.isArray(messages)) {
      const opaque =
        !!wire.payload.previous_response_id ||
        /"encrypted_content"|"item_reference"|"input_image"|"image_url"/.test(
          JSON.stringify(wire.payload),
        );
      if (wire.payload.instructions)
        add("Request instructions", wire.payload.instructions);
      for (const m of messages) add("First request message", JSON.stringify(m));
      surfaceComplete = !opaque;
    }
  }
  const special = trial.observations.find(
    (o: any) => o.host_assisted || (o.inputs && o.status),
  );
  if (special)
    add(
      "Specialized observation",
      JSON.stringify({
        effects: special.effects,
        physical_writes: special.physical_writes,
        status: special.status,
        boundary: special.boundary,
        reads: special.reads,
        visibility: special.visibility,
      }),
    );
  return {
    packet: { rubric, assertions: c.assertions, evidence: rows },
    private: {
      run: p.run,
      lane,
      scenario,
      report_sha256: terminal.report_sha256,
      surfaceComplete,
    },
  };
}
export async function completionJudge(
  root: string,
  mode: "begin" | "finish",
  hash: string,
  approval: string,
  observation: string,
  submission?: any,
) {
  const { inputs, batch } = loadCompletion(root, hash, approval);
  requireThat(
    JSON.stringify(inputs.calibration) ===
      JSON.stringify(calibrationInputs(root)),
    "STAGE_C_GRADER_CHANGED",
  );
  const calibration = observation === "calibration";
  const idx = batch.findIndex(
    (v) => v.lane.lane === observation || v.lane.lane + "-B" === observation,
  );
  requireThat(calibration || idx >= 0, "STAGE_C_GRADE_LANE");
  const dir = base + "/" + observation;
  return Domains.use(root, async (d) => {
    const grade = assertGradeStore(root);
    if (!calibration) {
      requireThat(
        attemptHistory(root, base + "/calibration").at(-1)?.result?.status ===
          "PASSED",
        "STAGE_C_CALIBRATION_REQUIRED",
      );
      const row = batch[idx],
        c = caseDefinition(row.lane.scenario);
      const s =
        observation === row.lane.lane
          ? c
          : stageCases().find(
              (v) =>
                c.pair && v.pair?.id === c.pair.id && v.pair.position === "B",
            );
      requireThat(s, "STAGE_C_GRADE_PAIR");
      if (!grade.has(dir + "/blind.json")) {
        requireThat(mode === "begin", "STAGE_C_GRADE_UNPREPARED");
        const b = trialPacket(root, row.lane.lane, s.id);
        commitGradeFiles(
          root,
          d.assertControllerLease(),
          "completion-reader-packet",
          [
            { name: dir + "/blind.json", content: gradeJSONBytes(b.packet) },
            { name: dir + "/binding.json", content: gradeJSONBytes(b.private) },
          ],
        );
      }
    }
    const packet = readOwnedGradeJSON(root, dir + "/blind.json"),
      digest = binding(root, dir);
    if (mode === "begin") {
      const a = reserveJudgeAttempt(d, dir, digest, 1, calibration);
      return { ...a, packet };
    }
    const attempt = attemptHistory(root, dir).at(-1);
    requireThat(attempt && !attempt.result, "STAGE_C_NO_READER_RESERVATION");
    let status = "REJECTED",
      kind = "SEMANTIC";
    if (
      submission?.mechanical &&
      mechanicalReasons.includes(submission.mechanical) &&
      /^[a-f0-9]{64}$/.test(submission.evidence_sha256)
    ) {
      kind = "MECHANICAL";
      status = "MECHANICAL";
    } else if (submission && boundJudge(submission, digest)) {
      if (calibration) {
        const key = readOwnedGradeJSON(root, dir + "/key.json");
        const rows = submission.labels;
        status =
          Array.isArray(rows) &&
          rows.length === key.length &&
          key.every(
            (k: any) =>
              rows.filter((r: any) => r.id === k.id && r.verdict === k.expected)
                .length === 1,
          )
            ? "PASSED"
            : "FAILED";
      } else {
        const rows = submission.assertions;
        const valid =
          Array.isArray(rows) &&
          rows.length === packet.assertions.length &&
          packet.assertions.every(
            (a: string) =>
              rows.filter(
                (r: any) =>
                  r.assertion === a &&
                  ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].includes(
                    r.verdict,
                  ) &&
                  typeof r.rationale === "string" &&
                  r.rationale.trim() &&
                  Array.isArray(r.evidence) &&
                  (r.verdict === "NOT_TESTED" || r.evidence.length > 0) &&
                  r.evidence.every((id: string) =>
                    packet.evidence.some((e: any) => e.id === id),
                  ),
              ).length === 1,
          );
        const b = readOwnedGradeJSON(root, dir + "/binding.json");
        const visibility = submission.visibility;
        status =
          valid &&
          (!["C16-combined", "C06-stale-cold"].includes(b.scenario) ||
            ["RESIDENT", "COLD", "OPAQUE"].includes(visibility))
            ? "ACCEPTED"
            : "REJECTED";
      }
    }
    settleJudgeAttempt(d, dir, attempt.number, digest, {
      kind,
      status,
      submission,
      response_sha256: sha(gradeJSONBytes(submission)),
    });
    return { status, attempt: attempt.number, packet_sha256: digest };
  });
}

export function completedBatchReport(root: string, hash: string) {
  const { batch, policy } = loadCompletion(
    root,
    hash,
    completionApproval(
      hash,
      readJSON(freezeFile(root)).evidence_class === "OFFLINE_SSE",
    ),
  );
  const state = readJSON(path.join(root, "campaign/stage-c-dispatch.json"));
  requireThat(state.freeze_sha256 === hash, "STAGE_C_REPORT_FREEZE");
  const counts = ledger(root);
  const rows = batch.flatMap((row) => {
    const lane = row.lane,
      c = caseDefinition(lane.scenario);
    const cases = c.pair
      ? stageCases().filter((v) => v.pair?.id === c.pair!.id)
      : [c];
    const terminal = state.terminals[lane.lane];
    const charged = [...counts.entries.values()].filter(
      (e) => e.attempt.lane === lane.lane,
    );
    return cases.map((s) => {
      const observation = lane.lane + (s.pair?.position === "B" ? "-B" : "");
      const dir = base + "/" + observation,
        history = attemptHistory(root, dir);
      const end = history.at(-1)?.result;
      const grades: Record<string, string> = Object.fromEntries(
        s.assertions.map((a) => [a, "NOT_TESTED"]),
      );
      let c16 = null,
        protocol: string[] = [];
      if (terminal?.report_sha256 && terminal.run) {
        const file = path.join(
          root,
          "evidence",
          terminal.run,
          "stage-c-trial.json",
        );
        requireThat(
          sha(read(file)) === terminal.report_sha256,
          "STAGE_C_REPORT_CHANGED",
        );
        const trial = readJSON(file),
          obs = trial.observations.find(
            (x: any) =>
              x.physical && (x.case_id ?? trial.descriptor.scenario) === s.id,
          );
        if (obs) {
          protocol = [
            ...obs.physical.requirements,
            ...obs.witness.structural_gaps,
          ];
          for (const a of s.assertions)
            grades[a] = obs.witness.assertions[a] ?? "UNRESOLVED";
          if (end?.status === "ACCEPTED") {
            requireThat(
              attemptHistory(root, base + "/calibration").at(-1)?.result
                ?.status === "PASSED" &&
                binding(root, dir) === history.at(-1)?.packet_sha256,
              "STAGE_C_GRADE_BINDING",
            );
            const b = readOwnedGradeJSON(root, dir + "/binding.json");
            requireThat(
              b.report_sha256 === terminal.report_sha256 &&
                b.scenario === s.id &&
                b.run === obs.run,
              "STAGE_C_GRADE_BINDING",
            );
            for (const g of end.submission.assertions) {
              if (
                grades[g.assertion] !== "PASS" &&
                grades[g.assertion] !== "FAIL"
              )
                grades[g.assertion] = g.verdict;
            }
          }
          if (s.id === "C16-combined") {
            const ref = trial.observations.find(
              (x: any) => x.mechanism === "HOST_PRODUCT_READ_LOG",
            );
            const grade =
              end?.status === "ACCEPTED"
                ? {
                    visibility: end.submission.visibility,
                    maintenance: grades.maintenance_current,
                    use: grades.use_current,
                    audited_surfaces: !!readOwnedGradeJSON(
                      root,
                      dir + "/binding.json",
                    ).surfaceComplete,
                  }
                : undefined;
            const verdict = (value: string): "PASS" | "FAIL" | "UNRESOLVED" =>
              value === "PASS" || value === "FAIL" ? value : "UNRESOLVED";
            c16 = c16Disposition(
              obs.physical,
              ref,
              grade
                ? {
                    ...grade,
                    maintenance: verdict(grade.maintenance),
                    use: verdict(grade.use),
                  }
                : undefined,
              obs.witness.probe_chain,
              true,
            );
          }
          if (s.id === "C12b") {
            const recovery = trial.observations.find(
              (o: any) => o.host_assisted,
            );
            grades.effects = recovery?.effects ?? "UNRESOLVED";
          }
          if (
            obs.physical.maintenance?.item_lineage === "NOT_TESTED" &&
            "item_lineage" in grades
          )
            grades.item_lineage = "NOT_TESTED";
        }
      }
      const identities = charged.map((e) => {
        const usage = e.usage as {
          returned_model?: string;
          wire_identity?: {
            fingerprint_status?: string;
            system_fingerprints?: string[];
          };
        } | null;
        return {
          at: e.attempt.at,
          outcome: e.outcome ?? "UNSETTLED",
          returned_model: usage?.returned_model ?? null,
          fingerprint_status:
            usage?.wire_identity?.fingerprint_status ?? "UNKNOWN",
          fingerprint_digests: (
            usage?.wire_identity?.system_fingerprints ?? []
          ).map((v) => sha(v)),
        };
      });
      return {
        scenario: s.id,
        family: s.family,
        repeat: lane.repeat,
        model: lane.model,
        architecture: "Secretary",
        profile: lane.profile,
        source_lineage: lane.lane,
        pair_position: s.pair?.position ?? null,
        identities,
        spans_observed_identity_strata:
          new Set(
            identities.map((v) =>
              JSON.stringify([
                v.returned_model,
                v.fingerprint_status,
                v.fingerprint_digests,
              ]),
            ),
          ).size > 1,
        external_recipe_sha256:
          s.pair?.position === "B" ? row.pair : row.trial.timeline,
        published_version: policy.providers[lane.model].published_version,
        identity_scope: "PUBLICATION_WINDOW_IMMUTABLE_BACKEND_UNKNOWN",
        physical_attempts_on_shared_lineage: charged.length,
        status: terminal?.status ?? "NOT_RUN",
        protocol_gaps: protocol,
        grades,
        c16,
        assessment_attempts: history.length,
        assessment_status: end?.status ?? "NOT_TESTED",
        first_assessment_failure:
          history.find(
            (h) =>
              h.result && !["ACCEPTED", "PASSED"].includes(h.result.status),
          )?.result.status ?? null,
      };
    });
  });
  return {
    schema: "issue122-completion-results-v1",
    freeze_sha256: hash,
    batch_closed: state.ended,
    rows,
    observations: rows.length,
    lineages: batch.length,
    completed_c16: rows.filter((r) => r.c16?.gate === "CLOSED").length,
    required_c16_in_batch: rows.filter((r) => r.scenario === "C16-combined")
      .length,
    evidence_class:
      "rehearsal" in policy && policy.rehearsal ? "OFFLINE_SSE" : "LIVE",
    physical_sends:
      "rehearsal" in policy && policy.rehearsal ? 0 : counts.entries.size,
    metered_attempts: counts.entries.size,
    charged_usd: counts.charged_usd,
    known_usd: [...counts.entries.values()].reduce(
      (sum, e) => sum + (e.actual_usd ?? 0),
      0,
    ),
    unresolved_cost_reservation_usd: [...counts.entries.values()].reduce(
      (sum, e) => sum + (e.actual_usd == null ? e.attempt.reserved_usd : 0),
      0,
    ),
  };
}
