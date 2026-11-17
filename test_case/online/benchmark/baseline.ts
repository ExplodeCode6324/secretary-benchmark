import path from "node:path";
import { Domains, configuration } from "./domain.ts";
import { baselineManifest } from "./baseline-scenarios.ts";
import { baselineVersion, routes } from "./baseline-evidence.ts";
import { readJSON, writeJSON, requireThat, sha } from "./io.ts";
import { verifySut } from "./source.ts";

export const maintenancePolicy = {
  turn_trigger: 8,
  oldest_uncovered_seconds: 60,
  min_interval_seconds: 120,
  critical_feedback_bypasses_interval: true,
  normal_occupancy: 0.6,
  idle_wait_schedule_seconds: [60, 120],
  max_observation_requests: 2,
  deadline_seconds: 600,
  source:
    "873b66f:memory-maintenance.ts:memoryDue / budget.ts / input-projection.ts",
};
export function baselinePlan() {
  const cases = baselineManifest();
  return {
    schema: "issue122-offline-plan-v1",
    sut: verifySut(),
    semantic_contract: baselineVersion,
    historical_reuse: {
      url: "https://github.com/ExplodeCode6324/Secretary/blob/af7077d5abab3529df2864be98a3edd9c5c6c1b8/docs/fix/evidence/issue122-historical-reuse.json",
      sha256:
        "1826bad893a62bcb30e53bc8c1c4f41a46fb51e4f95a37684528a2a6514d383a",
      rows: 30,
      labels: 168,
      fail_labels: 12,
      independent_no_shell_observations: 2,
      pooled_with_new_repeats: false,
    },
    cases,
    cases_sha256: sha(JSON.stringify(cases)),
    routes,
    maintenance: maintenancePolicy,
    live_dispatch: "NOT_AUTHORIZED",
    price_verification: "PENDING_LIVE_FREEZE",
    models_verified_online: false,
    order: {
      "C05-W": ["deepseek-flash", "gpt-6.1-sol", "gpt-6-luna"],
      "C08-inference": ["gpt-6.1-sol", "gpt-6-luna", "deepseek-flash"],
      "C10-condition": ["gpt-6-luna", "deepseek-flash", "gpt-6.1-sol"],
      "C16-combined": ["deepseek-flash", "gpt-6-luna", "gpt-6.1-sol"],
    },
    limits_proposal: {
      usd: 15,
      per_model_usd: 5,
      reservations: 1920,
      per_model_reservations: 640,
      per_trial_reservations: 160,
      connectivity_per_model: 3,
      trial_active_minutes: 60,
      campaign_active_hours: 12,
      judge_batches: 12,
      calibration_batches: 1,
      identical_mechanical_attempts: 3,
    },
    decisions_pending: [
      "model/provider IDs and endpoints online verification",
      "price and billed reasoning/output bounds",
      "RC98304 approval or C16 deferral",
      "exact live subcase/configuration freeze",
      "spending approval",
    ],
  };
}
/** Per-case forecast. Product counts UTF-8 bytes conservatively, not provider-exact tokens. */
export function baselineForecast(initial: any[]) {
  const cases = baselineManifest();
  return initial.flatMap((row) =>
    cases.map((c) => {
      const input_bytes = Buffer.byteLength(
        JSON.stringify([...c.setup, c.probe]),
      );
      const base = row.budget.estimated_tokens;
      const threshold =
        row.budget.usable_input_tokens * row.effective_policy.normal;
      const additional_to_crop = Math.max(
        0,
        Math.ceil(threshold - base - input_bytes),
      );
      return {
        case_id: c.id,
        model: row.model,
        profile: row.profile === "DEP" ? "DEP_DEFAULT_UNVERIFIED" : row.profile,
        deployment_capacity_verified: false,
        initial: row,
        scenario_input_bytes: input_bytes,
        raw_input_projection_exit: {
          status: c.requires_cold ? "REQUIRES_MEASURED_EXIT" : "NOT_REQUIRED",
          recent_count: row.window.count,
          recent_ratio: row.window.ratio,
        },
        assistant_tool_echo_exit: {
          status: c.requires_cold ? "NOT_PROVEN_OFFLINE" : "NOT_REQUIRED",
          additional_projected_bytes_to_crop: additional_to_crop,
        },
        maintenance: {
          required_commits: c.maintenance_cycles,
          forecast: "OPPORTUNITY_ONLY",
          policy: maintenancePolicy,
          earliest_ordinary_opportunity_seconds: c.maintenance_cycles
            ? 60 + (c.maintenance_cycles - 1) * 120
            : 0,
        },
        input_schema: {
          source:
            "api-v1.ts HTTP body limit / api/routes.ts / api/contracts.ts",
          http_body_max_bytes: 1024 * 1024,
          maximum_must_be_checked_in_live_manifest: true,
        },
        budget: {
          status: "NOT_DISPATCHED_UNFROZEN",
          pricing: "UNVERIFIED",
          physical_request_bytes: null,
          formula:
            "UTF8 serialized provider body bytes * verified input rate + bounded billed output * verified output rate, divided by 1e6",
          limitation:
            "Initial messages bytes are not physical wire bytes. No token-to-byte multiplier, complete-lane guarantee or live approval inferred.",
        },
        result:
          c.status === "READY_FOR_OFFLINE_VALIDATION"
            ? "NOT_REACHED_OFFLINE"
            : c.status,
      };
    }),
  );
}
/** Own fixture domain, product prompts and PG only; worker fetch is blocked and model is scripted. */
export async function prepareBaseline(root: string) {
  return Domains.use(root, async (d) => {
    const run = await d.create(configuration);
    let started = false;
    try {
      const active = await d.start(run.id);
      started = true;
      const forecast = readJSON(
        path.join(active.evidence, "issue122-capacity-candidates.json"),
      );
      requireThat(forecast.length === 6, "BASELINE_FORECAST_INCOMPLETE");
      const report = {
        ...baselinePlan(),
        fixture_run: run.id,
        physical_provider_sends: 0,
        forecast: baselineForecast(forecast),
        evidence_class: "OFFLINE_PRODUCT_CONFIGURATION_FORECAST",
      };
      writeJSON(path.join(root, "reports", "issue122-stage-a.json"), report);
      return report;
    } finally {
      if (started || d.raw(run.id).state === "STOPPED") await d.seal(run.id);
    }
  });
}
