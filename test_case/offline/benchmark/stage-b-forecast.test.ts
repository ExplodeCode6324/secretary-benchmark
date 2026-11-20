import test from "node:test";
import assert from "node:assert/strict";
import { forecastLane } from "../../online/benchmark/stage-b-freeze.ts";
import type { TimelineStep } from "../../online/benchmark/baseline-timeline.ts";
import type { ProviderRule } from "../../online/benchmark/stage-b-policy.ts";

// Only the four pricing/bound fields read by the estimate. No provider or campaign.
const rule = {
  input_rate: 1,
  output_rate: 2,
  max_input_bytes: 200000,
  billed_output: 4096,
} as ProviderRule;
const factors = {
  ordinary_sends_per_turn: 1,
  extra_task_sends: 6,
  sends_per_maintenance: 5,
  seconds_per_send: 1,
  restart_seconds: 15,
  observation_seconds: 3,
  expected_input_tokens: 12000,
  expected_output_tokens: 256,
};
const capacity = (usable = 85196) => ({
  budget: {
    usable_input_tokens: usable,
    estimated_tokens: 19336,
    occupancy: 19336 / usable,
  },
  effective_policy: { target: 0.3, normal: 0.6, forced: 0.8 },
});
const messages = (n: number): TimelineStep[] =>
  Array.from({ length: n }, () => ({
    action: "MASTER_MESSAGE",
    text: "Received",
  }));
const wait = (seconds: number): TimelineStep => ({
  action: "IDLE_WAIT",
  seconds,
});
const filler: TimelineStep = {
  action: "UNRELATED_ACTIVITY",
  filler: {
    count: 30,
    bytes_each: 1064,
    seed: 1220,
    sha256: "unused by forecast",
  },
};

test("Eight handled turns or the age of the oldest uncovered turn triggers ordinary work even without explicit waits", () => {
  function jobs(n: number, latency: number) {
    return forecastLane(
      messages(n),
      rule,
      { ...factors, seconds_per_send: latency },
      157,
      capacity(),
    ).cycles;
  }
  assert.equal(jobs(7, 1), 0);
  assert.equal(jobs(8, 1), 1);
  assert.equal(jobs(3, 29), 0);
  assert.equal(jobs(3, 30), 1);
  // Cooldown counts from the last committed update. Eight more turns alone are insufficient.
  assert.equal(jobs(16, 1), 1);
  const repeated = forecastLane(
    [...messages(8), wait(180), wait(180)],
    rule,
    factors,
    157,
    capacity(),
  );
  assert.equal(repeated.cycles, 1);
});
test("A coverage observation waits out remaining cooldown; maintenance may overlap an idle wait", () => {
  const start = [...messages(8), ...messages(1)];
  const ending = { action: "OBSERVE" };
  const short = forecastLane(
    [...start, wait(60), ending],
    rule,
    factors,
    157,
    capacity(),
  ).paths[0];
  const long = forecastLane(
    [...start, wait(180), ending],
    rule,
    factors,
    157,
    capacity(),
  ).paths[0];
  assert.equal(short.ordinary_jobs, 2);
  assert.equal(long.ordinary_jobs, 2);
  // At 13s the first summary completes, at 14s a new input is handled.
  // Next job can begin at 133s, finishes at 138s; the observation takes 3s.
  assert.equal(short.seconds, 141);
  assert.equal(short.boundary_wait_beyond_idle_seconds, 64);
  assert.equal(long.seconds, 197);
  assert.equal(long.boundary_wait_beyond_idle_seconds, 0);
  const exact = forecastLane(
    messages(1),
    rule,
    { ...factors, seconds_per_send: 3600 },
    1,
    capacity(),
  );
  assert.equal(exact.over_lane_limits, false);
});
test("B0 occupancy distinguishes normal from forced local crops and charges physical sends only for covering jobs", () => {
  const steps = [
    ...messages(3),
    filler,
    wait(60),
    { action: "OBSERVE" },
    filler,
    wait(120),
    { action: "OBSERVE" },
    { action: "OBSERVE" },
    { action: "DIRECT_RESTART" },
    ...messages(1),
  ];
  const posted = {
    ...factors,
    ordinary_sends_per_turn: 1.5,
    seconds_per_send: 20,
  };
  const rc = forecastLane(steps, rule, posted, 157, capacity());
  const dep = forecastLane(steps, rule, posted, 157, capacity(989308));
  assert.equal(rc.turns, 64);
  assert(
    rc.paths.every(
      (p) => p.cadence_jobs > 2 && p.sends === 96 + 5 * p.ordinary_jobs,
    ),
  );
  assert.equal(dep.range.context_compactions.max, 0);
  assert(rc.range.context_compactions.min > 0);
  assert.equal(rc.range.forced_band_compactions.min, 0);
  assert(rc.range.forced_band_compactions.max > 0);
  assert(
    rc.paths.every(
      (p) =>
        p.context_crop_sends === 0 &&
        p.forced_band_compactions <= p.context_compactions,
    ),
  );
  assert(
    rc.range.sends.min < rc.range.sends.max &&
      rc.range.seconds.min < rc.range.seconds.max,
  );
  assert.equal(rc.range.send_limit, "ABOVE");
  assert.equal(rc.range.time_limit, "ABOVE");
  assert.equal(
    forecastLane(steps, rule, posted, rc.range.sends.min, capacity()).range
      .send_limit,
    "STRADDLES",
  );
  assert.equal(rc.expected_sends, rc.paths[1].sends);
  assert.throws(() => forecastLane(steps, rule, posted, 157), /B0_REQUIRED/);
  assert.throws(
    () =>
      forecastLane(steps, rule, posted, 157, {
        ...capacity(),
        budget: { ...capacity().budget, occupancy: 0 },
      }),
    /CAPACITY_INVALID/,
  );
});
