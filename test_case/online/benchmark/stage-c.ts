import fs from "node:fs";
import path from "node:path";
import { baselineCases } from "./baseline-scenarios.ts";
import { Domains, type Run } from "./domain.ts";
import {
  correctionControls,
  exerciseCorrection,
  fixtureMessage,
} from "./stage-c-correction.ts";
import { delivery } from "./stage-c-fault.ts";
import { exerciseRecovery } from "./stage-c-recovery.ts";
import {
  mkdir,
  read,
  readJSON,
  requireThat,
  deploymentGuard,
  repository,
  sha,
  writeJSON,
} from "./io.ts";
import { fingerprint } from "./source.ts";
import { captureBodies } from "./baseline-b0.ts";
import { lines } from "./stage-b-scenarios-evidence.ts";

import {
  version,
  additionalControl,
  primaryModels,
  sutCommit,
  piCommit,
  prospectiveMatrix,
} from "./stage-c-plan.ts";
export { prospectiveMatrix } from "./stage-c-plan.ts";
const reportName = "issue122-stage-c-offline.json";
async function fixture<T>(
  d: Domains,
  id: Extract<Run["config"], { version: 3 }>["case_id"],
  body: (r: Run) => Promise<T>,
) {
  const run = await d.create({
    version: 3,
    mode: "fixture",
    track: "issue122",
    case_id: id,
    seed: 122,
  });
  try {
    const observations = await body(await d.start(run.id));
    requireThat(
      !fs.existsSync(path.join(run.evidence, "unexpected-network.jsonl")),
      "STAGE_C_UNEXPECTED_NETWORK",
    );
    return { run: run.id, observations };
  } catch (error) {
    writeJSON(path.join(run.evidence, "stage-c-first-failure.json"), {
      error: String(error),
    });
    throw error;
  } finally {
    try {
      await d.seal(run.id);
    } catch (e) {
      writeJSON(path.join(run.evidence, "stage-c-seal-failure.json"), {
        error: String(e),
      });
      if (!fs.existsSync(path.join(run.evidence, "stage-c-first-failure.json")))
        throw e;
    }
  }
}
export function legacyLayout(row: Record<string, unknown>) {
  const has = (name: string) => Object.hasOwn(row, name);
  const digest = (name: string) =>
    typeof row[name] === "string" && /^[a-f0-9]{64}$/.test(row[name] as string);
  if (
    digest("source_inputs_sha256") &&
    digest("oracle_sha256") &&
    !has("template_inputs_sha256") &&
    !has("offline_fixture_inputs_sha256")
  )
    return "R35_TEMPLATE";
  if (
    digest("template_inputs_sha256") &&
    digest("template_oracle_sha256") &&
    !has("source_inputs_sha256") &&
    !has("oracle_sha256") &&
    has("offline_fixture_inputs_sha256") &&
    (row.offline_fixture_inputs_sha256 === null ||
      digest("offline_fixture_inputs_sha256"))
  )
    return "R36_TEMPLATE_AND_FIXTURE";
  throw Error("STAGE_C_UNKNOWN_LEGACY_LAYOUT");
}
export function readStageCReport(root: string) {
  const report = read(path.join(root, "reports", reportName));
  const parsed = JSON.parse(report.toString());
  const receipt = readJSON(path.join(root, "reports", "stage-c-receipt.json"));
  requireThat(
    sha(report) === receipt.sha256 &&
      [version, "issue122-stage-c-offline-v1"].includes(parsed.schema),
    "STAGE_C_REPORT_CHANGED",
  );
  if (parsed.schema === "issue122-stage-c-offline-v1") {
    const layouts = new Set(parsed.matrix.rows.map(legacyLayout));
    requireThat(layouts.size === 1, "STAGE_C_MIXED_LEGACY_LAYOUT");
  }
  return parsed;
}
export async function prepareStageC(root: string) {
  // This offline entry owns one fresh facility. Existing or failed facilities are evidence.
  deploymentGuard(repository, root);
  mkdir(path.dirname(root));
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw Error("STAGE_C_FRESH_FACILITY_REQUIRED");
    throw error;
  }
  return Domains.use(root, async (d) => {
    requireThat(
      !fs.existsSync(path.join(root, "reports", "stage-c-start.json")) &&
        !fs.existsSync(path.join(root, "runs")) &&
        !fs.existsSync(path.join(root, "campaign")),
      "STAGE_C_FRESH_FACILITY_REQUIRED",
    );
    const source = fingerprint();
    requireThat(
      source.sut.commit === sutCommit &&
        source.sut.submodules["src/pi_resource"] === piCommit,
      "STAGE_C_SUT_PIN",
    );
    writeJSON(path.join(root, "reports", "stage-c-start.json"), {
      schema: version,
      source,
      at: new Date().toISOString(),
    });
    const recovery = await fixture(d, "C12b", async (run) => {
      const result = await exerciseRecovery(d, run);
      const call = lines(path.join(run.evidence, "fixture-calls.jsonl")).find(
        (c) =>
          c.context.messages.some(
            (m: any) =>
              m.role === "user" &&
              JSON.stringify(m.content).includes("secretary.agent-task.v1") &&
              JSON.stringify(m.content).includes(delivery.name),
          ),
      );
      requireThat(call, "C12B_TASK_SAMPLE_MISSING");
      return {
        ...result,
        samples: await captureBodies(call.context, undefined, primaryModels),
      };
    });
    const correction = await fixture(d, "C06-stale-cold", exerciseCorrection);
    const controls = [];
    for (const c of [
      additionalControl,
      ...baselineCases(true).filter((c) =>
        ["C04-irrelevant", "C04-nonexistent"].includes(c.id),
      ),
    ]) {
      const control = c.id;
      requireThat(
        control === "C06-resident-B" ||
          control === "C04-irrelevant" ||
          control === "C04-nonexistent",
        "C06_CONTROL_UNKNOWN",
      );
      controls.push(
        await fixture(d, control, async (run) => {
          for (const line of c.setup)
            await fixtureMessage(run, line, Date.now() + 30000);
          const probe = await fixtureMessage(run, c.probe, Date.now() + 30000);
          const calls = lines(path.join(run.evidence, "fixture-calls.jsonl"));
          const call = calls.find(
            (s) =>
              s.context.messages.at(-1)?.role === "user" &&
              JSON.stringify(s.context.messages.at(-1)?.content).includes(
                c.probe,
              ),
          );
          requireThat(call, "C06_CONTROL_CONTEXT_MISSING");
          return {
            id: c.id,
            probe,
            samples: await captureBodies(
              call.context,
              undefined,
              primaryModels,
            ),
            semantic: "NOT_TESTED",
          };
        }),
      );
    }
    const calibration = correctionControls();
    writeJSON(
      path.join(root, "oracles", "stage-c-reader-key.json"),
      calibration.key,
    );
    writeJSON(
      path.join(root, "reports", "stage-c-reader-controls.json"),
      calibration.reader,
    );
    const report = {
      schema: version,
      source,
      evidence_class: "SCRIPTED_PROTOCOL",
      physical_provider_sends: 0,
      memory_performance: "NOT_TESTED",
      reader_packet_sha256: sha(JSON.stringify(calibration.reader)),
      recovery,
      correction,
      controls,
      matrix: prospectiveMatrix(
        Object.fromEntries([
          ["C12b", recovery.observations.samples],
          [
            "C06-stale-cold",
            "samples" in correction.observations
              ? correction.observations.samples
              : [],
          ],
          ...controls.map((c) => [c.observations.id, c.observations.samples]),
        ]),
      ),
    };
    const p = path.join(root, "reports", reportName);
    writeJSON(p, report);
    writeJSON(path.join(root, "reports", "stage-c-receipt.json"), {
      sha256: sha(read(p)),
    });
    return {
      report: p,
      physical_provider_sends: 0,
      recovery: recovery.observations.effects,
      correction: correction.observations.status ?? "CAPTURED",
      candidate_observations: report.matrix.candidate_observations,
      source_lineages: report.matrix.source_lineages,
    };
  });
}
