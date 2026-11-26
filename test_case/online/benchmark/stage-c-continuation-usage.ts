import path from "node:path";
import { ledger } from "./campaign.ts";
import { readJSON } from "./io.ts";
import { lines } from "./stage-b-scenarios-evidence.ts";
export function continuationUsage(root: string) {
  const forecast = readJSON(path.join(root, "reports/stage-c-projection.json"));
  const entries = [...ledger(root).entries.values()];
  const sends = entries.filter((e) => e.outcome !== "RETEST_CONFIRMED_NO_POST");
  const metrics = (get: (u: any) => unknown) => {
    let known = 0,
      unknown = 0;
    for (const e of sends) {
      const value = get(e.usage);
      if (typeof value === "number" && Number.isFinite(value)) known += value;
      else unknown++;
    }
    return { known, unknown_requests: unknown };
  };
  const cash = metrics((u) => u?.go_meter?.cash_debit_usd),
    list = metrics((u) => u?.go_meter?.list_cost);
  const runs = [...new Set(entries.map((e) => e.attempt.run))];
  const evidenceRows = (name: string) =>
    runs.flatMap((run) => lines(path.join(root, "evidence", run, name)));
  const httpCount = new Set(evidenceRows("http.jsonl").map((r) => r.id)).size;
  const workloadForecast = forecast.batches.flat().map((row: any) => ({
    lane: row.lane.lane,
    expected_sends: row.forecast.expected_sends,
    range_sends: row.forecast.range.sends,
    input_tokens:
      row.forecast.expected_sends * row.metered_basis.expected_input_tokens,
    output_tokens:
      row.forecast.expected_sends * row.metered_basis.expected_output_tokens,
    seconds: row.forecast.expected_seconds,
    peak_rate_equivalent_usd: row.forecast.expected_usd,
  }));
  const allowance = sends.map((e) => (e.usage as any)?.go_meter?.allowance);
  const earliest = entries.map((e) => Date.parse(e.attempt.at)),
    last = entries.map((e) => Date.parse(e.settled_at ?? e.attempt.at));
  return {
    forecast: workloadForecast,
    actual: {
      model_transport_retries: evidenceRows("stage-c-model-retries.jsonl")
        .length,
      reservations: entries.length,
      measured_send_span_seconds: entries.length
        ? (Math.max(...last) - Math.min(...earliest)) / 1000
        : 0,
      subscription_allowance: {
        known_receipts: allowance.filter((v) => v != null),
        unknown_requests: allowance.filter((v) => v == null).length,
      },
      possible_provider_sends: sends.length,
      confirmed_http_responses: httpCount,
      refused_before_post: lines(
        path.join(root, "campaign/facility-refusals.jsonl"),
      ).length,
      unknown_delivery: sends.filter(
        (e) => !e.settled || /UNCERTAIN|INTERRUPT/.test(e.outcome ?? ""),
      ).length,
      input_tokens: metrics(
        (u) => u?.provider?.prompt_tokens ?? u?.provider?.input_tokens,
      ),
      output_tokens: metrics(
        (u) => u?.provider?.completion_tokens ?? u?.provider?.output_tokens,
      ),
      list_usd: list,
      cash_usd: cash,
    },
    list_difference_from_peak_estimate_usd:
      list.unknown_requests === 0
        ? list.known - forecast.expected_usd_at_peak_rates
        : null,
  };
}
