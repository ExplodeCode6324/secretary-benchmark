import fs from "node:fs";
import path from "node:path";
import { Domains, type Run } from "./domain.ts";
import {
  sha,
  requireThat,
  read,
  writeJSON,
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
import { initializeGuard } from "./payload-guard.ts";
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
  inspectStageEvidence,
  lines,
} from "./stage-b-scenarios-evidence.ts";
import { exerciseCorrection } from "./stage-c-correction.ts";
import { exerciseRecovery } from "./stage-c-recovery.ts";
import { snapshot } from "./snapshot.ts";

export async function prepareTrial(root: string, id: string) {
  const c = caseDefinition(id),
    model = primaryModels[0];
  requireThat(c.pair?.position !== "B", "STAGE_C_START_WITH_PAIR_A");
  const descriptor = describeTrial(id, 1, model, "OFFLINE_FIXTURE"),
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
      profile: descriptor.profile,
      seed: descriptor.seed,
    });
    const trail = emptyTrail();
    const reportFile = path.join(root, "reports", "stage-c-trial.json");
    const report = {
      schema: "issue122-stage-c-native-fixture-v2",
      source,
      run: run.id,
      descriptor,
      memory_performance: "NOT_TESTED",
      physical_provider_sends: 0,
      trail,
      observations: [] as unknown[],
    };
    writeJSON(reportFile, report);
    const capture = async (r: Run, scenario = id, progress = trail) => {
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
      const session = readJSON(
        path.join(r.evidence, "observed.json"),
      ).session_id;
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
      };
    };
    let first: unknown;
    try {
      initializeGuard(root, run.lineage);
      const active = await d.start(run.id);
      const host = secretaryHost(d, active, "stage-c-trail.json");
      if (id === "C12b")
        report.observations.push(
          await exerciseRecovery(d, active, undefined, c.probe),
        );
      else if (id === "C06-stale-cold")
        report.observations.push(await exerciseCorrection(active));
      else if (c.pair) {
        const b = stageCases().find(
          (row) => row.pair?.id === c.pair!.id && row.pair.position === "B",
        )!;
        await playCurrentScenario(
          id,
          "OFFLINE_FIXTURE",
          undefined,
          host,
          trail,
          "PAIR_SOURCE",
        );
        const pair = await baselinePair(
          d,
          active,
          {
            id: c.pair.id,
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
              "OFFLINE_FIXTURE",
              undefined,
              branchHost,
              child,
              "PAIR_PROBE",
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
        let bound: ReturnType<typeof bindOriginal> | undefined;
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
          "OFFLINE_FIXTURE",
          undefined,
          host,
          trail,
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
      writeJSON(reportFile, report);
      return {
        run: run.id,
        scenario: id,
        physical_provider_sends: 0,
        report_sha256: sha(read(reportFile)),
      };
    } catch (e) {
      first = e;
      writeJSON(reportFile, { ...report, first_failure: String(e) });
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
  });
}
