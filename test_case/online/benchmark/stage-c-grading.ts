import {
  goReaderResponse,
  sourceCalibrationBinding,
  calibrationAgeOK,
  verifyGoCalibrationReference,
  goCalibrationReportReference,
  goMetering,
  goCandidateUsage,
  goGradeGate,
} from "./stage-c-go-grading.ts";
import {
  archivedC04,
  originalC04Input,
  c04Freeze,
  c04Trial,
} from "./stage-c-remaining-series.ts";
import {
  visibilityV2,
  nativeVisibility,
  goReader,
  goVisibilityVersion,
  goReaderPolicy,
  visibilityRule,
  newVisibilityControls,
  officialReader,
  readerPolicy,
  renderReaderQuery,
  admittedReaderQuery,
  readerResponse,
  surfaces,
} from "./stage-c-visibility-rubric.ts";
import { familyResults } from "./stage-c-families.ts";
import { judgeCorrection } from "./stage-c-reader.ts";
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
export const hermesReaders = {
  "Hermes/opencode-go/deepseek-v4.1-flash/max": {
    provider: "opencode-go",
    model: "deepseek-v4.1-flash",
  },
  "Hermes/deepseek/deepseek-flash/max": {
    provider: "deepseek",
    model: "deepseek-flash",
  },
} as const;
export function scoringRubric(reader: string, version = rubric.version) {
  if (nativeVisibility(version)) {
    requireThat(
      reader === (version === goVisibilityVersion ? goReader : officialReader),
      "STAGE_C_UNKNOWN_READER",
    );
    return { ...rubric, reader, version, visibility: visibilityRule };
  }
  requireThat(version === rubric.version, "STAGE_C_GRADER_CHANGED");
  requireThat(
    reader === rubric.reader || Object.hasOwn(hermesReaders, reader),
    "STAGE_C_UNKNOWN_READER",
  );
  return { ...rubric, reader };
}
export function matchesReader(submission: any, digest: string, reader: string) {
  if (reader === rubric.reader) return boundJudge(submission, digest);
  if (!Object.hasOwn(hermesReaders, reader)) return false;
  const expected = hermesReaders[reader as keyof typeof hermesReaders];
  return (
    !!expected &&
    submission.packet_sha256 === digest &&
    submission.judge?.provider === expected.provider &&
    submission.judge?.model === expected.model &&
    submission.judge?.reasoning_effort === "max"
  );
}
const binding = (root: string, dir: string) =>
  sha(readOwnedGradeFile(root, dir + "/blind.json"));
export function calibrationInputs(root: string) {
  const dir = base + "/calibration";
  const saved = readOwnedGradeJSON(root, dir + "/blind.json").rubric;
  const policy = scoringRubric(saved.reader, saved.version);
  requireThat(
    sha(gradeJSONBytes(policy)) === sha(gradeJSONBytes(saved)),
    "STAGE_C_GRADER_CHANGED",
  );
  return {
    reader: policy.reader,
    version: policy.version,
    rubric_sha256: sha(gradeJSONBytes(policy)),
    packet_sha256: binding(root, dir),
    key_sha256: sha(readOwnedGradeFile(root, dir + "/key.json")),
    max_attempts: nativeVisibility(policy.version) ? 1 : 3,
    ...(nativeVisibility(policy.version)
      ? {
          transport:
            policy.version === goVisibilityVersion
              ? goReaderPolicy
              : readerPolicy,
        }
      : {}),
  };
}
export async function prepareCompletionCalibration(
  root: string,
  reader = rubric.reader,
  version = rubric.version,
) {
  const policy = scoringRubric(reader, version);
  return Domains.use(root, async (d) => {
    const dir = base + "/calibration",
      store = assertGradeStore(root);
    if (!store.has(dir + "/blind.json")) {
      const semantic = generateCalibration(),
        visibility = nativeVisibility(version)
          ? newVisibilityControls()
          : correctionControls();
      const packet = {
        rubric: policy,
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
    const frozen = calibrationInputs(root);
    requireThat(
      frozen.reader === reader && frozen.version === version,
      "STAGE_C_GRADER_CHANGED",
    );
    return frozen;
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
export function trialPacket(
  root: string,
  lane: string,
  scenario: string,
  reader = rubric.reader,
  version = rubric.version,
) {
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
  if (!nativeVisibility(version))
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
  const flags = surfaces.map(() => ({
    measured: false,
    truncated: false,
    opaque: false,
  }));

  const members: string[][] = surfaces.map(() => []);
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
      if (wire.payload.instructions) {
        add("Request instructions", wire.payload.instructions);
        members[3].push(rows.at(-1)!.id);
        if (
          rows.at(-1)!.text !==
          "Request instructions\n" + wire.payload.instructions
        )
          flags[3].truncated = true;
      }
      let parsed = messages.length > 0;
      for (const f of flags) {
        f.measured = parsed;
        f.opaque = !!wire.payload.previous_response_id;
      }

      for (const m of messages) {
        add("First request message", JSON.stringify(m));
        const id = rows.at(-1)!.id;
        if (m.role === "system" || m.role === "developer") members[3].push(id);
        else if (m.role === "assistant" || m.role === "tool")
          members[1].push(id);
        else if (m.role === "user") {
          const content =
            typeof m.content === "string"
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((v: any) => v.text ?? "").join("")
                : "";
          members[
            content.startsWith(
              "Working memory (source history remains queryable):",
            )
              ? 2
              : 0
          ].push(id);
        } else {
          parsed = false;
          for (const f of flags) f.opaque = true;
        }
        const ix = members.findIndex((ids) => ids.includes(id));
        if (
          ix >= 0 &&
          rows.at(-1)!.text !== "First request message\n" + JSON.stringify(m)
        )
          flags[ix].truncated = true;
        if (
          ix >= 0 &&
          /"encrypted_content"|"item_reference"|"input_image"|"image_url"/.test(
            JSON.stringify(m),
          )
        )
          flags[ix].opaque = true;
        if (
          Array.isArray(m.content) &&
          m.content.some(
            (part: any) =>
              !["text", "input_text", "output_text"].includes(part?.type),
          )
        ) {
          parsed = false;
          if (ix >= 0) flags[ix].opaque = true;
        }
      }
      surfaceComplete =
        !opaque &&
        (!nativeVisibility(version) ||
          (parsed &&
            flags.every((f) => f.measured && !f.truncated && !f.opaque)));
    }
  }
  if (nativeVisibility(version))
    add(
      "First eligible request capture coverage",
      JSON.stringify(
        surfaces.map((surface, index) => ({
          surface,
          captured_evidence: members[index],
          ...flags[index],
        })),
      ),
    );
  if (nativeVisibility(version) && p.witness.source_reads?.length)
    add(
      "Post-probe tool activity (outside the visibility window)",
      JSON.stringify(
        p.witness.source_reads.map((r: any) => ({
          source_event: r.event,
          tool_call: r.tool_call_id,
          returned_bytes_sha256: r.tool_text_sha256,
          delivered_to: r.delivered_to,
        })),
      ),
    );
  const special = trial.observations.find(
    (o: any) => o.host_assisted || (o.inputs && o.status),
  );
  if (special?.boundary) {
    const v = readJSON(
      path.join(root, "evidence", p.run, "stage-c-boundary-items.json"),
    );
    requireThat(
      v.job === special.boundary.job &&
        v.revision === special.boundary.revision &&
        sha(JSON.stringify(v.items)) === special.boundary.items_sha256,
      "STAGE_C_PRIVATE_ITEMS_CHANGED",
    );
    add(
      "Working memory at the committed correction boundary",
      JSON.stringify(v.items),
    );
  }
  if (special && !nativeVisibility(version))
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
    packet: {
      rubric: scoringRubric(reader, version),
      assertions: c.assertions,
      evidence: rows,
    },
    private: {
      run: p.run,
      lane,
      scenario,
      report_sha256: terminal.report_sha256,
      surfaceComplete,
      ...(nativeVisibility(version)
        ? {
            wire_ids: members.flat(),
            coverage_id: rows.find((r) =>
              r.text.startsWith("First eligible request capture coverage\n"),
            )?.id,
          }
        : {}),
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
  const { inputs, batch, policy } = loadCompletion(root, hash, approval);
  requireThat(
    JSON.stringify(inputs.calibration) ===
      JSON.stringify(calibrationInputs(root)),
    "STAGE_C_GRADER_CHANGED",
  );
  const calibration = observation === "calibration";
  const goVersion = inputs.calibration.version === goVisibilityVersion;
  const continuation = (inputs as any).go_continuation;
  const shared = goVersion && goGradeGate(continuation, calibration);
  if (shared) verifyGoCalibrationReference(root, inputs);
  const idx = batch.findIndex(
    (v) => v.lane.lane === observation || v.lane.lane + "-B" === observation,
  );
  const historic =
    observation === archivedC04 && inputs.remaining_series?.partition === 2;
  requireThat(calibration || idx >= 0 || historic, "STAGE_C_GRADE_LANE");
  const dir = base + "/" + observation;
  return Domains.use(root, async (d) => {
    const grade = assertGradeStore(root);
    let sourceIdentity: ReturnType<typeof sourceCalibrationBinding> | undefined;
    if (!calibration) {
      requireThat(
        shared ||
          attemptHistory(root, base + "/calibration").at(-1)?.result?.status ===
            "PASSED",
        "STAGE_C_CALIBRATION_REQUIRED",
      );
      if (goVersion) {
        const sourceTransport = shared
          ? readOwnedGradeJSON(
              root,
              base + "/calibration/go-origin-transport.json",
            )
          : attemptHistory(root, base + "/calibration").at(-1)?.result
              ?.reader_evidence?.transport;
        sourceIdentity = sourceCalibrationBinding(sourceTransport);
        if (mode === "begin")
          requireThat(
            calibrationAgeOK(
              sourceIdentity.calibration_native_at,
              new Date().toISOString(),
            ),
            "STAGE_C_GO_CALIBRATION_EXPIRED",
          );
      }
      const lane = historic ? archivedC04 : batch[idx].lane.lane,
        c = caseDefinition(
          historic ? "C04-resident" : batch[idx].lane.scenario,
        );
      const s =
        observation === lane
          ? c
          : stageCases().find(
              (v) =>
                c.pair && v.pair?.id === c.pair.id && v.pair.position === "B",
            );
      requireThat(s, "STAGE_C_GRADE_PAIR");
      if (!grade.has(dir + "/blind.json")) {
        requireThat(mode === "begin", "STAGE_C_GRADE_UNPREPARED");
        const b = trialPacket(
          historic ? originalC04Input(root) : root,
          lane,
          s.id,
          inputs.calibration.reader,
          inputs.calibration.version,
        );
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
      requireThat(
        attemptHistory(root, dir).length < inputs.calibration.max_attempts,
        "STAGE_C_JUDGE_ATTEMPT_LIMIT",
      );
      const query = nativeVisibility(inputs.calibration.version)
        ? admittedReaderQuery(packet)
        : undefined;
      const a = reserveJudgeAttempt(d, dir, digest, 1, calibration);
      return {
        ...a,
        ...(sourceIdentity ?? {}),
        packet,
        ...(query === undefined ? {} : { query }),
      };
    }
    const attempt = attemptHistory(root, dir).at(-1);
    requireThat(attempt && !attempt.result, "STAGE_C_NO_READER_RESERVATION");
    const nativeEvidence = nativeVisibility(inputs.calibration.version)
      ? submission
      : undefined;
    if (goVersion) {
      requireThat(
        nativeEvidence?.transport?.batch === continuation.partition - 1 &&
          (!sourceIdentity ||
            (nativeEvidence.transport.calibration_returned_model ===
              sourceIdentity.calibration_returned_model &&
              nativeEvidence.transport.calibration_native_at ===
                sourceIdentity.calibration_native_at)),
        "STAGE_C_GO_CALIBRATION_REFERENCE_TRANSPORT",
      );
      submission = goReaderResponse(nativeEvidence, packet, hash);
    } else if (nativeVisibility(inputs.calibration.version))
      submission = readerResponse(
        nativeEvidence,
        packet,
        hash,
        policy.providers["deepseek-flash"],
      );
    let status = "REJECTED",
      kind = "SEMANTIC";
    if (
      submission?.mechanical &&
      (mechanicalReasons.includes(submission.mechanical) ||
        (nativeEvidence && submission.mechanical === "UNEXPECTED_FINISH")) &&
      /^[a-f0-9]{64}$/.test(submission.evidence_sha256)
    ) {
      kind = "MECHANICAL";
      status = "MECHANICAL";
    } else if (
      submission &&
      matchesReader(submission, digest, inputs.calibration.reader)
    ) {
      if (calibration) {
        const key = readOwnedGradeJSON(root, dir + "/key.json");
        const rows = submission.labels;
        status =
          Array.isArray(rows) &&
          rows.length === key.length &&
          key.every(
            (k: any) =>
              rows.filter(
                (r: any) => r?.id === k.id && r?.verdict === k.expected,
              ).length === 1,
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
                  r?.assertion === a &&
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
        const v2Visibility =
          nativeVisibility(inputs.calibration.version) &&
          ["C16-combined", "C06-stale-cold"].includes(b.scenario);
        const refs = submission.visibility_evidence;
        const visibilityBound =
          !v2Visibility ||
          (Array.isArray(refs) &&
            refs.length > 0 &&
            refs.every((id) => packet.evidence.some((e: any) => e.id === id)) &&
            (visibility === "RESIDENT"
              ? refs.every((id) => b.wire_ids.includes(id))
              : refs.includes(b.coverage_id)));
        if (
          v2Visibility &&
          visibilityBound &&
          visibility === "COLD" &&
          !b.surfaceComplete
        )
          submission = {
            ...submission,
            reader_visibility: visibility,
            visibility: "OPAQUE",
          };
        status =
          valid &&
          visibilityBound &&
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
      ...(nativeEvidence
        ? {
            reader_evidence: nativeEvidence,
            reader_query_sha256: sha(renderReaderQuery(packet)),
          }
        : {}),
    });
    return { status, attempt: attempt.number, packet_sha256: digest };
  });
}

export function completedBatchReport(root: string, hash: string) {
  const { batch, policy, inputs } = loadCompletion(
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
  const continuation = (inputs as any).go_continuation;
  const goVersion = inputs.calibration.version === goVisibilityVersion;
  const shared =
    goVersion &&
    continuation &&
    !continuation.calibration_withheld &&
    continuation.partition !== continuation.source_partition
      ? goCalibrationReportReference(root, inputs)
      : null;
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
              (shared?.status === "PASSED" ||
                attemptHistory(root, base + "/calibration").at(-1)?.result
                  ?.status === "PASSED") &&
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
          if (s.id === "C06-stale-cold") {
            const correction = trial.observations.find(
              (x: any) => x.inputs && x.status,
            );
            if (correction?.status !== "CAPTURED")
              grades.use_current = correction?.probe
                ? "UNRESOLVED"
                : "NOT_TESTED";
            else if (end?.status === "ACCEPTED") {
              const side = readOwnedGradeJSON(root, dir + "/binding.json");
              const g = judgeCorrection({
                maintenance: "UNKNOWN",
                visibility:
                  (side.surfaceComplete ||
                    (end.reader_evidence &&
                      end.submission.visibility === "RESIDENT")) &&
                  ["COLD", "RESIDENT"].includes(end.submission.visibility)
                    ? end.submission.visibility
                    : "UNKNOWN",
                resident_old: null,
                source_delivered: obs.witness.probe_chain.original_delivered,
                supported_use:
                  grades.use_current === "PASS"
                    ? true
                    : grades.use_current === "FAIL"
                      ? false
                      : null,
                reached: true,
              });
              grades.use_current = g.use;
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
                    audited_surfaces:
                      (Boolean(end.reader_evidence) &&
                        end.submission.visibility === "RESIDENT") ||
                      !!readOwnedGradeJSON(root, dir + "/binding.json")
                        .surfaceComplete,
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
              charged.some(
                (e) =>
                  e.attempt.id === obs.physical.outcome.probe_send &&
                  e.outcome === "RESPONSE_COMPLETE",
              ),
            );
          }
          if (obs.witness.structural_gaps.length) {
            for (const a of s.assertions)
              if (!["PASS", "FAIL"].includes(obs.witness.assertions[a]))
                grades[a] = "UNRESOLVED";
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
          go_meter?: unknown;
          returned_model?: string;
          wire_identity?: {
            fingerprint_status?: string;
            system_fingerprints?: string[];
          };
        } | null;
        return {
          send: e.attempt.id,
          at: e.attempt.at,
          outcome: e.outcome ?? "UNSETTLED",
          ...(goVersion
            ? { route: "opencode-go", go_meter: usage?.go_meter ?? null }
            : {}),
          returned_model: usage?.returned_model ?? null,
          fingerprint_status:
            usage?.wire_identity?.fingerprint_status ?? "UNKNOWN",
          fingerprint_digests: (
            usage?.wire_identity?.system_fingerprints ?? []
          ).map((v) => sha(v)),
        };
      });
      const readerCost: {
        reader_metered_usd?: number;
        reader_disputed_usd?: number;
        go_reader_metering?: ReturnType<typeof goMetering>;
      } = {};
      if (end?.reader_evidence) {
        const transport = end.reader_evidence.transport;
        const amount = transport.calculated_charge_usd ?? transport.charged_usd;
        if (goVersion) readerCost.go_reader_metering = goMetering(transport);
        else if (end.submission?.rejected === "DISPUTED_CHARGE")
          readerCost.reader_disputed_usd = amount;
        else readerCost.reader_metered_usd = amount;
      }
      return {
        scenario: s.id,
        family: s.family,
        repeat: lane.repeat,
        model: lane.model,
        architecture: "Secretary",
        ...(goVersion
          ? {
              workload_provider: "opencode-go",
              workload_model:
                policy.providers[lane.model].allowed_returned_models[0],
              workload_thinking_type: "enabled",
              workload_reasoning_effort: "low",
            }
          : {}),
        profile: lane.profile,
        source_lineage: lane.lane,
        pair_position: s.pair?.position ?? null,
        identities,
        spans_observed_identity_strata:
          new Set(
            identities
              .filter(
                (v) =>
                  v.returned_model &&
                  ["PRESENT", "ABSENT", "NULL"].includes(v.fingerprint_status),
              )
              .map((v) =>
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
        reason: terminal?.reason ?? null,
        protocol_gaps: protocol,
        grades,
        c16,
        ...readerCost,
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
  const historicGrade =
    policy.lanes.every((l) => l.scenario === "C16-combined") &&
    readJSON(freezeFile(root)).remaining_series?.partition === 2
      ? attemptHistory(root, base + "/" + archivedC04).at(-1)
      : undefined;
  let archived_control;
  if (historicGrade?.result) {
    const result = historicGrade.result,
      dir = base + "/" + archivedC04,
      b = readOwnedGradeJSON(root, dir + "/binding.json");
    requireThat(
      b.report_sha256 === c04Trial &&
        b.lane === archivedC04 &&
        b.scenario === "C04-resident" &&
        binding(root, dir) === historicGrade.packet_sha256 &&
        attemptHistory(root, base + "/calibration").at(-1)?.result?.status ===
          "PASSED",
      "STAGE_C_ARCHIVED_C04_GRADE",
    );
    const t = result.reader_evidence.transport;
    archived_control = {
      source_freeze: c04Freeze,
      trial_sha256: c04Trial,
      packet_sha256: historicGrade.packet_sha256,
      status: result.status,
      verdict:
        result.status === "ACCEPTED"
          ? result.submission.assertions.find(
              (a: any) => a.assertion === "natural_access",
            )?.verdict
          : null,
      metered_usd:
        result.submission?.rejected === "DISPUTED_CHARGE"
          ? 0
          : (t.calculated_charge_usd ?? t.charged_usd ?? 0),
      disputed_usd:
        result.submission?.rejected === "DISPUTED_CHARGE"
          ? (t.calculated_charge_usd ?? t.charged_usd)
          : 0,
    };
  }
  const known = [...counts.entries.values()].reduce(
    (sum, e) => sum + (e.actual_usd ?? 0),
    0,
  );
  const unresolved = [...counts.entries.values()].reduce(
    (sum, e) => sum + (e.actual_usd == null ? e.attempt.reserved_usd : 0),
    0,
  );
  return {
    schema: "issue122-completion-results-v1",
    ...familyResults(rows),
    ...(archived_control ? { archived_control } : {}),
    ...(goVersion
      ? {
          candidate_reader_metered_usd: null,
          candidate_reader_go: goCandidateUsage(rows),
          ...(shared ? { go_calibration_reference: shared } : {}),
        }
      : {
          candidate_reader_disputed_usd:
            (archived_control?.disputed_usd ?? 0) +
            rows.reduce(
              (sum, row) => sum + Number(row.reader_disputed_usd ?? 0),
              0,
            ),
          candidate_reader_metered_usd:
            (archived_control?.metered_usd ?? 0) +
            rows.reduce((n, r) => n + Number(r.reader_metered_usd ?? 0), 0),
        }),
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
    ...(goVersion
      ? {
          billing_basis: goReaderPolicy.billing_basis,
          cash_charge_usd: null,
          provider_cash_known_usd: [...counts.entries.values()].reduce(
            (n, e) =>
              n + Number((e.usage as any)?.go_meter?.cash_debit_usd ?? 0),
            0,
          ),
          provider_cash_unknown_requests: [...counts.entries.values()].filter(
            (e) =>
              typeof (e.usage as any)?.go_meter?.cash_debit_usd !== "number",
          ).length,
          tariff_estimate_usd: known,
          tariff_guard_usd: counts.charged_usd,
          unresolved_tariff_reservation_usd: unresolved,
          charged_usd: null,
          known_usd: null,
          unresolved_cost_reservation_usd: null,
        }
      : {
          charged_usd: counts.charged_usd,
          known_usd: known,
          unresolved_cost_reservation_usd: unresolved,
        }),
  };
}
