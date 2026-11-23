import { baselineCases, type BaselineCase } from "./baseline-scenarios.ts";
import {
  timeline,
  visibleInputs,
  fillerTexts,
  type TimelineStep,
} from "./baseline-timeline.ts";
import { stageModels as baselineModels } from "./stage-b-policy.ts";
import { fixturePrefix } from "./stage-c-correction.ts";
import { delivery } from "./stage-c-fault.ts";
import { sha, requireThat } from "./io.ts";
export const version = "issue122-stage-c-offline-v2";
export const primaryModels: readonly (typeof baselineModels)[number][] = [
  "deepseek-flash",
];
export const sutCommit = "873b66f4b906ff53a62476ff5dd1466649c427f7";
export const piCommit = "16787ad5b2dc748047f314ca1bfe7708f30f54f3";
export const additionalControl = {
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
export function stageCases(): BaselineCase[] {
  return [...baselineCases(true), additionalControl].sort(
    (a, b) => Number(b.id === "C16-combined") - Number(a.id === "C16-combined"),
  );
}
export function caseDefinition(id: string) {
  const scenario = stageCases().find((c) => c.id === id);
  requireThat(
    scenario?.status === "READY_FOR_OFFLINE_VALIDATION",
    "STAGE_C_SCENARIO_EXCLUDED",
  );
  return scenario;
}
export function trialTimeline(
  c: BaselineCase,
  purpose: "OFFLINE_FIXTURE" | "BASELINE",
  recipe?: { count: number; bytes_each: number },
): TimelineStep[] {
  if (c.id === "C12b")
    return [
      { action: "ARM_FAULT", scripted: true },
      {
        action: "MASTER_TASK",
        route: "task-requests",
        scripted: true,
        payload: { goal: delivery.goal, acceptance: delivery.acceptance },
      },
      { action: "DIRECT_RESTART" },
      { action: "HOST_RECONCILE", scripted: true },
      {
        action: "MASTER_MESSAGE",
        route: "messages",
        text: c.probe,
        probe: true,
      },
    ];
  if (c.id === "C06-stale-cold") {
    const filler =
      purpose === "OFFLINE_FIXTURE"
        ? fixturePrefix
        : { ...recipe, seed: fixturePrefix.seed };
    requireThat(
      filler.count && filler.bytes_each,
      "STAGE_C_CAPACITY_RECIPE_REQUIRED",
    );
    const prefix = {
      count: filler.count,
      bytes_each: filler.bytes_each,
      seed: filler.seed,
    };
    return [
      ...c.setup.map((text) => ({
        action: "MASTER_MESSAGE",
        route: "messages",
        text,
      })),
      {
        action: "UNRELATED_ACTIVITY",
        filler: { ...prefix, sha256: sha(JSON.stringify(fillerTexts(prefix))) },
      },
      {
        action: "OBSERVE",
        requirement:
          "cover correction and capture first probe send before correction cutoff",
        seconds: 600,
      },
      {
        action: "MASTER_MESSAGE",
        route: "messages",
        probe: true,
        text: c.probe,
      },
    ];
  }
  return timeline(c).map((step) => {
    if (!step.filler) return step;
    requireThat(
      purpose === "OFFLINE_FIXTURE" || recipe,
      "STAGE_C_CAPACITY_RECIPE_REQUIRED",
    );
    const f = {
      ...(purpose === "OFFLINE_FIXTURE"
        ? { count: 8, bytes_each: 256 }
        : recipe!),
      seed: step.filler.seed,
    };
    requireThat(
      Number.isSafeInteger(f.count) &&
        f.count >= 1 &&
        f.count <= 160 &&
        Number.isSafeInteger(f.bytes_each) &&
        f.bytes_each >= 128 &&
        f.bytes_each <= 65536,
      "STAGE_C_FILLER_BOUND",
    );
    return {
      ...step,
      filler: { ...f, sha256: sha(JSON.stringify(fillerTexts(f))) },
    };
  });
}
export function describeTrial(
  id: string,
  repeat: number,
  model: (typeof baselineModels)[number],
  purpose: "OFFLINE_FIXTURE" | "BASELINE",
  recipe?: { count: number; bytes_each: number },
) {
  requireThat(
    Number.isSafeInteger(repeat) &&
      repeat >= 1 &&
      repeat <= 3 &&
      baselineModels.includes(model),
    "STAGE_C_TRIAL_ID",
  );
  const c = caseDefinition(id),
    steps = trialTimeline(c, purpose, recipe);
  const group = c.pair?.id ?? c.id;
  const seed = parseInt(
    sha(JSON.stringify(["issue122-external-input-v2", group, repeat])).slice(
      0,
      8,
    ),
    16,
  );
  return {
    purpose,
    scenario: id,
    repeat,
    model,
    architecture: "Secretary",
    sut: sutCommit,
    pi: piCommit,
    profile: c.id === "C16-combined" ? ("RC98304" as const) : ("DEP" as const),
    seed,
    seed_scope: "HOST_INPUT_ONLY",
    lineage_group: [group, model, repeat].join("/"),
    observation_id: [id, model, repeat].join("/"),
    steps,
    external_inputs_sha256: sha(JSON.stringify(visibleInputs(steps))),
    recipe_sha256: sha(JSON.stringify(steps)),
  };
}
export function prospectiveMatrix(
  measured: Record<string, BodySample[]> = {},
  models: readonly (typeof baselineModels)[number][] = primaryModels,
) {
  requireThat(
    models.length > 0 &&
      models.includes("deepseek-flash") &&
      new Set(models).size === models.length &&
      models.every((m) => baselineModels.includes(m)),
    "STAGE_C_MODEL_SELECTION",
  );
  const cases = stageCases();
  const rows = cases.flatMap((c) => {
    const disposition = c.status;
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
    return models.flatMap((model) =>
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
            profile: candidate
              ? c.id === "C16-combined"
                ? "RC98304"
                : "DEP"
              : null,
            architecture: "Secretary",
            sut_commit: sutCommit,
            pi_commit: piCommit,
            observation_id: candidate
              ? [c.id, model, index + 1].join("/")
              : null,
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
    models,
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
