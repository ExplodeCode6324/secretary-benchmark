import fs from "node:fs";
import path from "node:path";
import { baselineCases } from "./baseline-scenarios.ts";
import { fillerTexts, timeline, visibleInputs } from "./baseline-timeline.ts";
import { baselineModels } from "./live-model.ts";
import { Domains, type Run } from "./domain.ts";
import {
  correctionControls,
  fixturePrefix,
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

const version = "issue122-stage-c-offline-v1";
const additionalControl = {
  ...baselineCases(true).find((c) => c.id === "C04-resident")!,
  id: "C06-resident-B",
  setup: [
    "The current pickup day for Fern is Saturday. Only redacted copies may be collected.",
  ],
  probe: "What pickup instructions currently apply to Fern?",
  oracle: {
    required: ["Saturday; redacted only"],
    forbidden: ["unsupported authority"],
  },
};
type BodySample = {
  model: string;
  bytes: number;
  sha256: string;
  output_cap: number;
};
export function prospectiveMatrix(measured: Record<string, BodySample[]> = {}) {
  const cases = [...baselineCases(true), additionalControl];
  const rows = cases.flatMap((c) => {
    const disposition =
      c.id === "C16-combined" ? "DEFERRED_BY_DECISION" : c.status;
    const steps = timeline(c);
    const fixtureInputs =
      c.id === "C12b"
        ? [
            {
              route: "task-requests",
              goal: delivery.goal,
              acceptance: delivery.acceptance,
            },
          ]
        : c.id === "C06-stale-cold"
          ? [...c.setup, ...fillerTexts(fixturePrefix), c.probe]
          : [
                additionalControl.id,
                "C04-irrelevant",
                "C04-nonexistent",
              ].includes(c.id)
            ? [...c.setup, c.probe]
            : null;
    return baselineModels.flatMap((model) =>
      Array.from(
        { length: disposition === "READY_FOR_OFFLINE_VALIDATION" ? 3 : 1 },
        (_, index) => {
          const sample = measured[c.id]?.find((s) => s.model === model);
          const candidate = disposition === "READY_FOR_OFFLINE_VALIDATION";
          return {
            scenario: c.id,
            family: c.family,
            route: c.route,
            model,
            disposition,
            profile: candidate ? "SINGLE_PROFILE_TO_BE_FROZEN" : null,
            repeat: candidate ? index + 1 : null,
            lineage_group: candidate
              ? [c.pair?.id ?? c.id, model, index + 1].join("/")
              : null,
            pair: c.pair,
            assertions: c.assertions,
            template_inputs_sha256: sha(JSON.stringify(visibleInputs(steps))),
            template_timeline_sha256: sha(JSON.stringify(steps)),
            template_oracle_sha256: sha(JSON.stringify(c.oracle)),
            offline_fixture_inputs_sha256: fixtureInputs
              ? sha(JSON.stringify(fixtureInputs))
              : null,
            offline_fixture_inputs: fixtureInputs?.length ?? null,
            template_inputs: visibleInputs(steps).length,
            restart: c.restart,
            maintenance_cycles: c.maintenance_cycles,
            measured_fixture_request: sample
              ? {
                  bytes: sample.bytes,
                  body_sha256: sample.sha256,
                  output_cap: sample.output_cap,
                }
              : null,
            forecast: candidate
              ? sample
                ? "SINGLE_BODY_MEASURED_LANE_TOTAL_UNKNOWN"
                : "UNKNOWN_UNTIL_MEASURED_PREFLIGHT"
              : null,
            request_cap: null,
            retry_cap: null,
            token_cap: null,
            time_cap_seconds: null,
            estimated_usd: null,
            reservation_usd: null,
            eligible_to_dispatch: false,
          };
        },
      ),
    );
  });
  const candidates = rows.filter((r) => r.lineage_group);
  return {
    schema: version,
    models: baselineModels,
    repeats: 3,
    source_cases: cases.length - 1,
    additional_controls: [additionalControl.id],
    reused_controls: ["C04-irrelevant", "C04-nonexistent"],
    candidate_observations: candidates.length,
    source_lineages: new Set(candidates.map((r) => r.lineage_group)).size,
    prior_pilot: {
      C05_W: [7, 7],
      C08: [26, 27],
      C10_condition: [9, 11],
      workload: 121,
      probes: 3,
      known_usd: "0.377460353",
      uncertain_reservation_usd: "0.4784286",
    },
    freeze_status: "UNFROZEN",
    rows,
  };
}
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
    await d.seal(run.id);
  }
}
export function readStageCReport(root: string) {
  const report = read(path.join(root, "reports", reportName));
  const receipt = readJSON(path.join(root, "reports", "stage-c-receipt.json"));
  requireThat(
    sha(report) === receipt.sha256 &&
      JSON.parse(report.toString()).schema === version,
    "STAGE_C_REPORT_CHANGED",
  );
  return JSON.parse(report.toString());
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
      return { ...result, samples: await captureBodies(call.context) };
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
            samples: await captureBodies(call.context),
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
