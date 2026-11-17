import { requireThat } from "./io.ts";

export type BaselineLimits = {
  schema: "issue122-budget-v1";
  models: Record<
    string,
    {
      usd: number;
      reservations: number;
      input_rate: number;
      output_rate: number;
      price_source: string;
      output_bound_source: string;
      requested_cap_bounds_billed_output: boolean;
      verified_max_output: number | null;
    }
  >;
  lanes: Record<
    string,
    { model: string; usd: number; reservations: number; connectivity: boolean }
  >;
  reservations: number;
};
const positive = (n: number) => Number.isFinite(n) && n > 0;
export function validateBaselineLimits(
  p: BaselineLimits,
  total: number | null,
) {
  requireThat(
    p.schema === "issue122-budget-v1" &&
      total !== null &&
      positive(total) &&
      total <= 15 &&
      Number.isSafeInteger(p.reservations) &&
      p.reservations > 0 &&
      p.reservations <= 1920,
    "BASELINE_BUDGET_INVALID",
  );
  const models = Object.entries(p.models);
  requireThat(
    models.length === 3 &&
      ["gpt-6.1-sol", "deepseek-flash", "gpt-6-luna"].every(
        (m) => m in p.models,
      ),
    "BASELINE_MODEL_COVERAGE",
  );
  requireThat(
    models.reduce((s, [, m]) => s + m.usd, 0) <= total,
    "BASELINE_MODEL_ALLOCATION",
  );
  for (const [id, m] of models) {
    requireThat(
      positive(m.usd) &&
        m.usd <= 5 &&
        Number.isSafeInteger(m.reservations) &&
        m.reservations > 0 &&
        m.reservations <= 640 &&
        positive(m.input_rate) &&
        positive(m.output_rate) &&
        !!m.price_source &&
        !!m.output_bound_source &&
        typeof m.requested_cap_bounds_billed_output === "boolean" &&
        (m.requested_cap_bounds_billed_output ||
          (Number.isSafeInteger(m.verified_max_output) &&
            m.verified_max_output! > 0)),
      "BASELINE_PROVIDER_BOUND_REQUIRED",
    );
    const lanes = Object.values(p.lanes).filter((l) => l.model === id);
    requireThat(
      lanes.length > 0 &&
        lanes.reduce((s, l) => s + l.usd, 0) <= m.usd &&
        lanes.reduce((s, l) => s + l.reservations, 0) <= m.reservations &&
        lanes
          .filter((l) => l.connectivity)
          .reduce((s, l) => s + l.reservations, 0) <= 3,
      "BASELINE_LANE_ALLOCATION",
    );
  }
  for (const [id, l] of Object.entries(p.lanes))
    requireThat(
      /^[A-Za-z0-9_-]+$/.test(id) &&
        l.model in p.models &&
        positive(l.usd) &&
        Number.isSafeInteger(l.reservations) &&
        l.reservations > 0 &&
        l.reservations <= (l.connectivity ? 3 : 160),
      "BASELINE_LANE_INVALID",
    );
}
export function baselineReservation(
  body: string,
  cap: number,
  p: BaselineLimits["models"][string],
) {
  requireThat(
    Number.isSafeInteger(cap) &&
      cap > 0 &&
      positive(p.input_rate) &&
      positive(p.output_rate) &&
      !!p.price_source &&
      !!p.output_bound_source,
    "BASELINE_PROVIDER_BOUND_REQUIRED",
  );
  const output = p.requested_cap_bounds_billed_output
    ? cap
    : p.verified_max_output;
  requireThat(
    Number.isSafeInteger(output) && output! >= cap,
    "BASELINE_OUTPUT_BOUND_UNKNOWN",
  );
  return (
    (Buffer.byteLength(body) * p.input_rate + output! * p.output_rate) / 1e6
  );
}
export type BudgetEntry = {
  attempt: {
    model: string;
    lane?: string;
    episode?: string;
    run: string;
    at: string;
  };
  charged_usd: number;
};
export function assertBaselineReservation(
  p: BaselineLimits,
  entries: BudgetEntry[],
  next: {
    model: string;
    lane?: string;
    episode?: string;
    run: string;
    reserved_usd: number;
  },
  now: number,
) {
  const lane = next.lane && p.lanes[next.lane],
    model = p.models[next.model];
  requireThat(
    lane && model && lane.model === next.model && next.episode,
    "BASELINE_LANE_BINDING",
  );
  const modelEntries = entries.filter((e) => e.attempt.model === next.model);
  const laneEntries = entries.filter((e) => e.attempt.lane === next.lane);
  requireThat(
    !entries.some(
      (e) => e.attempt.episode === next.episode && e.attempt.lane !== next.lane,
    ) && laneEntries.every((e) => e.attempt.episode === next.episode),
    "BASELINE_LANE_REBIND",
  );
  const used = (rows: BudgetEntry[]) =>
    rows.reduce((s, e) => s + e.charged_usd, 0);
  requireThat(
    entries.length < p.reservations &&
      modelEntries.length < model.reservations &&
      laneEntries.length < lane.reservations,
    "BASELINE_RESERVATION_LIMIT",
  );
  requireThat(
    used(laneEntries) + next.reserved_usd <= lane.usd &&
      used(modelEntries) + next.reserved_usd <= model.usd,
    "BASELINE_BUDGET_EXHAUSTED",
  );
  if (!laneEntries.length)
    requireThat(
      used(modelEntries) + lane.usd <= model.usd,
      "BASELINE_FULL_LANE_ADMISSION",
    );
  // Conservative wall time inside dispatch is stricter than active time; review/offline work occurs before dispatch.
  if (laneEntries.length)
    requireThat(
      now - Date.parse(laneEntries[0].attempt.at) <= 60 * 60_000,
      "BASELINE_LANE_TIME_LIMIT",
    );
  if (entries.length)
    requireThat(
      now - Date.parse(entries[0].attempt.at) <= 12 * 60 * 60_000,
      "BASELINE_CAMPAIGN_TIME_LIMIT",
    );
}
