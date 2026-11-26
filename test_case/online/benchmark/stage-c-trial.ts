import { resumeModelBlock } from "./stage-c-continuation.ts";
import { continuationWorkload, isRetest } from "./stage-c-targeted-policy.ts";
import { trialWitness, c16Disposition } from "./stage-c-observations.ts";
import type { FrozenBatch } from "./stage-c-freeze.ts";
import { ledger } from "./campaign.ts";
import { visibleInputs } from "./baseline-timeline.ts";
import fs from "node:fs";
import path from "node:path";
import { Domains, type Run } from "./domain.ts";
import {
  sha,
  requireThat,
  read,
  writeJSON,
  appendJSON,
  readJSON,
  deploymentGuard,
  repository,
  mkdir,
} from "./io.ts";
import {
  caseDefinition,
  describeTrial,
  primaryModels,
  piCommit,
  sutCommit,
  stageCases,
} from "./stage-c-plan.ts";
import { fingerprint } from "./source.ts";
import { initializeGuard, setFutureInputs } from "./payload-guard.ts";
import {
  emptyTrail,
  playCurrentScenario,
  type ScenarioTrail,
} from "./stage-b-scenarios-protocol.ts";
import { secretaryHost } from "./stage-b-scenarios.ts";
import { bindOriginal, inspectOriginal } from "./stage-c-reference.ts";
import { baselinePair } from "./baseline-pair.ts";
import { captureBodies } from "./baseline-b0.ts";
import {
  cas,
  casBytes,
  inspectStageEvidence,
  auditStageRun,
  lines,
} from "./stage-b-scenarios-evidence.ts";
import { exerciseCorrection } from "./stage-c-correction.ts";
import {
  nativeWriteRecipe,
  type C12bFixtureResponse,
} from "./stage-c-fault.ts";
import { exerciseRecovery } from "./stage-c-recovery.ts";
import { targetedC16Capture } from "./stage-c-targeted-capture.ts";
import { snapshot } from "./snapshot.ts";

export async function prepareTrial(
  root: string,
  id: string,
  taskRecipe?: typeof nativeWriteRecipe,
  control?: C12bFixtureResponse,
) {
  const c = caseDefinition(id),
    model = primaryModels[0];
  requireThat(c.pair?.position !== "B", "STAGE_C_START_WITH_PAIR_A");
  requireThat(
    !control || (id === "C12b" && taskRecipe === nativeWriteRecipe),
    "C12B_FIXTURE_CONTROL_BINDING",
  );
  const descriptor = describeTrial(
      id,
      1,
      model,
      "OFFLINE_FIXTURE",
      undefined,
      taskRecipe,
    ),
    source = fingerprint();
  requireThat(
    source.sut.commit === sutCommit &&
      source.sut.submodules["src/pi_resource"] === piCommit,
    "STAGE_C_SUT_PIN",
  );
  deploymentGuard(repository, root);
  mkdir(path.dirname(root));
  fs.mkdirSync(root, { mode: 0o700 });
  return Domains.use(root, async (d) => {
    const run = await d.create({
      version: 4,
      mode: "fixture",
      track: "issue122",
      case_id: id,
      ...(control ? { fixture_c12b_response: control } : {}),
      profile: descriptor.profile,
      seed: descriptor.seed,
    });
    return executeTrial(d, run, descriptor);
  });
}
export async function executeTrial(
  d: Domains,
  run: Run,
  descriptor: ReturnType<typeof describeTrial>,
  entry?: FrozenBatch[number],
) {
  const root = d.root,
    id = descriptor.scenario,
    c = caseDefinition(id),
    model = descriptor.model,
    purpose = descriptor.purpose;
  const live = run.config.version === 5;
  requireThat(
    (run.config.version === 5 &&
      purpose === "BASELINE" &&
      entry?.lane.lane === run.config.lane) ||
      (!live &&
        run.config.version === 4 &&
        purpose === "OFFLINE_FIXTURE" &&
        !entry),
    "STAGE_C_TRIAL_MODE",
  );
  const recipe = entry?.recipe,
    source = run.frozen;
  const activeFile = path.join(root, "campaign", "active-stage-c.json");
  const activate = (r: Run) => {
    if (!live) return;
    const a = readJSON(activeFile);
    requireThat(
      a.episode === r.lineage &&
        a.lane === entry!.lane.lane &&
        a.state === "OPEN",
      "STAGE_C_LINEAGE",
    );
    writeJSON(activeFile, { ...a, run: r.id });
  };
  const sends = () =>
    live
      ? [...ledger(root).entries.values()].filter(
          (e) =>
            e.attempt.episode === run.lineage &&
            e.outcome !== "RETEST_CONFIRMED_NO_POST",
        ).length
      : 0;
  const rehearsal =
    live && entry && "rehearsal" in entry && entry.rehearsal === true;
  const signal = live
    ? AbortSignal.timeout(
        Math.max(1, readJSON(activeFile).deadline - Date.now()),
      )
    : undefined;
  const trail = emptyTrail();
  const reportFile = live
    ? path.join(run.evidence, "stage-c-trial.json")
    : path.join(root, "reports", "stage-c-trial.json");
  const report = {
    schema: live
      ? "issue122-completion-workload-v1"
      : "issue122-stage-c-native-fixture-v2",
    source,
    run: run.id,
    descriptor,
    evidence_class: rehearsal
      ? "OFFLINE_SSE"
      : live
        ? "LIVE"
        : "OFFLINE_FIXTURE",
    memory_performance:
      live && !rehearsal ? "AWAITING_ADJUDICATION" : "NOT_TESTED",
    physical_provider_sends: 0,
    trail,
    observations: [] as unknown[],
  };
  const writeEvidence = () => {
    if (
      !live ||
      !entry?.targeted_supplement ||
      id !== "C12b" ||
      !isRetest(
        readJSON(path.join(root, "configs/stage-c-freeze.json"))
          .targeted_supplement?.series,
      )
    )
      return {};
    const members: Record<string, string> = {};
    for (const name of [
      "stage-c-barrier.json",
      "stage-c-physical-writes.jsonl",
      "stage-c-write-attempts.jsonl",
      "stage-c-target-failure.json",
      "stage-c-recovery-receipt.json",
    ]) {
      const file = path.join(run.evidence, name);
      if (fs.existsSync(file)) members[name] = sha(read(file));
    }
    return { recovery_lineage: run.lineage, recovery_members: members };
  };
  const continuing =
    live &&
    entry?.targeted_supplement &&
    readJSON(path.join(root, "configs/stage-c-freeze.json")).targeted_supplement
      ?.series === "issue122-r77-continuation-v1";
  if (continuing && fs.existsSync(reportFile)) {
    const previous = read(reportFile);
    writeJSON(
      path.join(run.evidence, "stage-c-prior-" + sha(previous) + ".json"),
      JSON.parse(previous.toString()),
    );
  }
  writeJSON(reportFile, report);
  const capture = async (r: Run, scenario = id, progress = trail) => {
    if (live) {
      const core = path.join(r.active, "core"),
        state = snapshot(core);
      const sends = fs
        .readdirSync(r.evidence)
        .filter((f) => /^send-[a-f0-9-]+\.json$/.test(f))
        .map((f) => readJSON(path.join(r.evidence, f)));
      const proof = auditStageRun(root, r, progress, scenario),
        witness = trialWitness(
          scenario,
          progress,
          state,
          (ref) => cas(core, ref),
          sends,
          lines(path.join(r.evidence, "completed-file-writes.jsonl")),
        );
      const refFile = path.join(r.evidence, "stage-c-reference.json");
      const c16 =
        scenario === "C16-combined"
          ? c16Disposition(
              proof,
              fs.existsSync(refFile) ? readJSON(refFile) : undefined,
              undefined,
              witness.probe_chain,
              true,
            )
          : null;
      let targetedCapture;
      if (
        scenario === "C16-combined" &&
        (entry?.targeted_supplement === true || rehearsal)
      ) {
        const file = path.join(r.evidence, "stage-c-targeted-capture.json");
        try {
          const capture = targetedC16Capture(state, proof, sends, (ref) => {
            const bytes = casBytes(core, ref);
            return ref.media_type.includes("json")
              ? JSON.parse(bytes.toString())
              : bytes.toString();
          });
          writeJSON(file, capture);
          targetedCapture = { status: "CAPTURED", sha256: sha(read(file)) };
        } catch (error) {
          // A partial workload remains observable. An absent temporal boundary cannot qualify a packet.
          const reason = error instanceof Error ? error.message : "";
          if (!reason.startsWith("C16_CAPTURE_")) throw error;
          targetedCapture = { status: "MISSING", reason };
        }
      }
      return {
        run: r.id,
        lineage: r.lineage,
        physical: proof,
        witness,
        c16,
        ...(continuing && scenario === "C16-combined"
          ? {
              extra_restarts: lines(
                path.join(r.evidence, "stage-c-extra-restarts.jsonl"),
              ),
            }
          : {}),
        ...(targetedCapture ? { targeted_capture: targetedCapture } : {}),
      };
    }
    requireThat(
      !fs.existsSync(path.join(r.evidence, "unexpected-network.jsonl")),
      "STAGE_C_UNEXPECTED_NETWORK",
    );
    const calls = lines(path.join(r.evidence, "fixture-calls.jsonl"));
    requireThat(calls.length > 0, "STAGE_C_NO_FIXTURE_CALLS");
    const samples = [];
    const sends = [];
    for (const call of calls) {
      const role = call.context.messages.some(
        (m: any) =>
          m.role === "system" && JSON.stringify(m).includes("TASK_EXECUTOR"),
      )
        ? "task"
        : "main";
      const captureID = call.pid + "-" + call.number;
      let payload;
      const [sample] = await captureBodies(
        call.context,
        (_, bytes) => {
          payload = JSON.parse(bytes.toString());
          writeJSON(
            path.join(r.evidence, "serializer-" + captureID + ".json"),
            { encoded: bytes.toString("base64"), sha256: sha(bytes) },
          );
        },
        [model],
        role,
      );
      sends.push({
        id: captureID,
        at: call.at,
        attribution: {
          role,
          context_sha256: sha(JSON.stringify(call.context)),
        },
        payload,
      });
      samples.push({
        ...sample,
        context_sha256: sha(JSON.stringify(call.context)),
        pid: call.pid,
        number: call.number,
        at: call.at,
      });
    }
    const state = snapshot(path.join(r.active, "core"));
    const session = readJSON(path.join(r.evidence, "observed.json")).session_id;
    const proof = inspectStageEvidence(
      scenario,
      progress,
      state.transactions,
      (ref) => cas(path.join(r.active, "core"), ref),
      sends,
      lines(path.join(r.evidence, "completed-file-writes.jsonl")),
      session,
    );
    return {
      run: r.id,
      lineage: r.lineage,
      final_journal: state.digest,
      samples,
      scripted_protocol: proof,
      witness: trialWitness(
        scenario,
        progress,
        state,
        (ref) => cas(path.join(r.active, "core"), ref),
        sends,
        lines(path.join(r.evidence, "completed-file-writes.jsonl")),
      ),
    };
  };
  let first: unknown;
  try {
    if (!live) initializeGuard(root, run.lineage);
    activate(run);
    setFutureInputs(root, run.lineage, visibleInputs(descriptor.steps));
    const priorFault =
      continuing &&
      id === "C12b" &&
      fs.existsSync(path.join(run.evidence, "stage-c-barrier.json")) &&
      !fs.existsSync(
        path.join(run.evidence, "stage-c-restart-checkpoint.json"),
      );
    const active = priorFault
      ? run
      : await d.start(
          run.id,
          continuing && id === "C16-combined"
            ? run.endpoint?.data_domain_id
            : undefined,
        );
    if (continuing && id === "C16-combined" && run.endpoint) {
      const file = path.join(run.evidence, "stage-c-timeline-checkpoint.json");
      const checkpoint = fs.existsSync(file) ? readJSON(file) : null;
      const step = checkpoint?.step ?? 0;
      const firstMaintenance = descriptor.steps.findIndex(
        (s) => s.action === "UNRELATED_ACTIVITY",
      );
      appendJSON(path.join(run.evidence, "stage-c-extra-restarts.jsonl"), {
        step,
        next_action: descriptor.steps[step]?.action ?? null,
        maintenance_commits:
          checkpoint?.trail?.cycles?.map((c: any) => c.job) ?? [],
        planned_restart_completed: !!checkpoint?.trail?.restart,
        critical:
          firstMaintenance >= 0 &&
          step >= firstMaintenance &&
          step <= descriptor.steps.length,
      });
    }
    if (continuing && !priorFault) await resumeModelBlock(root, active);
    const host = secretaryHost(d, active, "stage-c-trail.json");
    if (id === "C16-combined" && continuing) {
      const checkpoint = path.join(
        run.evidence,
        "stage-c-timeline-checkpoint.json",
      );
      host.continuation = {
        run: run.id,
        load: () => (fs.existsSync(checkpoint) ? readJSON(checkpoint) : null),
        save: (step, boundary, trail) =>
          writeJSON(checkpoint, { step, boundary, trail }),
      };
    }
    if (id === "C12b" || id === "C06-stale-cold") {
      const special =
        id === "C12b"
          ? await exerciseRecovery(
              d,
              active,
              entry?.recovery_windows,
              c.probe,
              (future) => host.guard(future),
              descriptor.task_recipe,
              Boolean(continuing),
            )
          : await exerciseCorrection(
              active,
              recipe ? { ...recipe, seed: 1220 } : undefined,
              [model],
              {
                guard: (future) => host.guard(future),
                arm: (deadline, request) => {
                  if (live)
                    writeJSON(activeFile, {
                      ...readJSON<Record<string, unknown>>(activeFile),
                      probe_deadline: deadline,
                      probe_request: request,
                      probe_sha256: sha(c.probe),
                    });
                },
              },
            );
      report.observations.push(special);
      const core = path.join(active.active, "core"),
        state = snapshot(core);
      const wanted =
        "inputs" in special ? [special.inputs.a, special.inputs.b] : [];
      for (const value of [
        ...wanted,
        "probe_input" in special
          ? special.probe_input
          : "probe" in special
            ? special.probe
            : undefined,
      ]) {
        if (!value) continue;
        const input = state.records.find(
          (r) => r.record_type === "Input" && r.id === value,
        );
        const event = state.transactions
          .flatMap((f) => f.events)
          .find(
            (e) =>
              e.event_type === "input.accepted" &&
              cas(core, e.payload).id === value,
          );
        requireThat(
          input?.record_type === "Input" && input.loop_id && event,
          "STAGE_C_SPECIAL_INPUT",
        );
        trail.inputs.push({
          id: input.id,
          request: input.dedupe_key,
          text_sha256: input.payload.sha256,
          probe: !wanted.includes(value),
          source_event: event.event_id,
          loop: input.loop_id,
        });
      }
    } else if (c.pair) {
      const b = stageCases().find(
        (row) => row.pair?.id === c.pair!.id && row.pair.position === "B",
      )!;
      const original = host.guard;
      host.guard = (future) => original([...future, c.probe, b.probe]);
      await playCurrentScenario(
        id,
        purpose,
        recipe,
        host,
        trail,
        "PAIR_SOURCE",
        signal,
      );
      const pair = await baselinePair(
        d,
        active,
        {
          id: live ? entry!.lane.lane : c.pair.id,
          beforeStart: activate,
          a_effectful: c.effectful_probe,
          future_a: [b.probe],
          future_b: [c.probe],
          deadline: Date.now() + 600000,
        },
        async (r, position) => {
          const subcase = position === "A" ? c : b;
          const child: ScenarioTrail = structuredClone(trail);
          const branchHost = secretaryHost(d, r, "stage-c-trail.json");
          const guard = branchHost.guard;
          branchHost.guard = (future) =>
            guard([...future, position === "A" ? b.probe : c.probe]);
          await playCurrentScenario(
            subcase.id,
            purpose,
            recipe,
            branchHost,
            child,
            "PAIR_PROBE",
            signal,
          );
          report.observations.push({
            case_id: subcase.id,
            trail: child,
            ...(await capture(r, subcase.id, child)),
          });
        },
      );
      report.observations.push({ pair });
    } else {
      const originalPath = path.join(run.evidence, "stage-c-original.json");
      let bound: ReturnType<typeof bindOriginal> | undefined =
        continuing && fs.existsSync(originalPath)
          ? readJSON(originalPath)
          : undefined;
      if (id === "C16-combined") {
        const restart = host.restart;
        host.restart = async (signal) => {
          bound = bindOriginal(active, trail.inputs[0], c.setup[0]);
          writeJSON(path.join(run.evidence, "stage-c-original.json"), bound);
          return restart(signal);
        };
      }
      await playCurrentScenario(
        id,
        purpose,
        recipe,
        host,
        trail,
        "FULL",
        signal,
      );
      await d.stop(run.id);
      if (bound && trail.restart)
        report.observations.push(
          inspectOriginal(active, d.load(run.id), trail.restart, bound),
        );
    }
    if (!c.pair) {
      await d.stop(run.id);
      report.observations.push(await capture(run));
    }
    report.physical_provider_sends = rehearsal ? 0 : sends();
    writeJSON(reportFile, { ...report, ...writeEvidence() });
    return {
      run: run.id,
      scenario: id,
      physical_provider_sends: rehearsal ? 0 : sends(),
      report_sha256: sha(read(reportFile)),
    };
  } catch (e) {
    first = e;
    writeJSON(reportFile, {
      ...report,
      ...writeEvidence(),
      physical_provider_sends: rehearsal ? 0 : sends(),
      first_failure: String(e),
    });
    throw e;
  } finally {
    if (!["RETIRED", "CLEANED"].includes(d.raw(run.id).state)) {
      try {
        await d.seal(run.id);
      } catch (e) {
        writeJSON(path.join(run.evidence, "stage-c-seal-failure.json"), {
          error: String(e),
        });
        if (!first) throw e;
      }
    }
  }
}
