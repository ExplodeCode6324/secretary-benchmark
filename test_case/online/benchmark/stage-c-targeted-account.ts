import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
import fs from "node:fs";
import path from "node:path";
import { read, readJSON, requireThat, sha, writeJSON } from "./io.ts";
import {
  checkTargetedInputs,
  targetedWorkload,
  targetedLanes,
  retestWorkload,
  type TargetedPolicy,
} from "./stage-c-targeted-policy.ts";
import type { ledger } from "./campaign.ts";

function facilityPolicy(root: string): TargetedPolicy {
  const scope = readJSON(
    path.join(root, "configs/stage-c-freeze.json"),
  ).targeted_supplement;
  checkTargetedInputs(scope, root);
  return scope;
}
function claimSeries(account: string, freeze?: string) {
  const file = path.join(account, retestWorkload.series + ".json");
  if (freeze && fs.existsSync(file) && readJSON(file).freeze === freeze)
    return retestWorkload.series;
  return targetedWorkload.series;
}
type Claim = { root: string; freeze: string; closed: boolean };
const reservationDir = (account: string) =>
  path.join(account, "usage-reservations");

export function targetedClaim(account: string, freeze?: string): Claim | null {
  const file = path.join(account, claimSeries(account, freeze) + ".json");
  return fs.existsSync(file) ? readJSON<Claim>(file) : null;
}

export function verifyTargetedCarry(
  account: string,
  root: string,
  scope: TargetedPolicy = facilityPolicy(root),
) {
  checkTargetedInputs(scope, root);
  const carry = readJSON(path.join(root, "inputs/targeted-carry.json"));
  for (const [name, expected] of [
    ["active.json", carry.account_active_sha256],
    ["hold.json", carry.hold_sha256],
    [
      "usage-reservations/reader-candidate-97.json",
      carry.unsettled_entry_sha256,
    ],
  ])
    requireThat(
      sha(read(path.join(account, name))) === expected,
      "TARGETED_ACCOUNT_CARRY_CHANGED",
    );
  if (scope.series === retestWorkload.series)
    for (const [name, digest] of Object.entries(carry.parent_records))
      requireThat(
        sha(read(path.join(account, name))) === digest,
        "RETEST_PARENT_CARRY_CHANGED",
      );
  const active = readJSON(path.join(account, "active.json")),
    held = readJSON(path.join(account, "hold.json"));
  const old = readJSON(
    path.join(reservationDir(account), "reader-candidate-97.json"),
  );
  requireThat(
    (isGoRehearsal(root)
      ? account === path.join(root, "fixture-account")
      : path.dirname(active.root) === path.dirname(account) &&
        path.dirname(root) === path.dirname(account)) &&
      root !== active.root &&
      active.closed === true &&
      held.freeze === carry.old_freeze &&
      active.freeze === carry.old_freeze &&
      old.freeze === carry.old_freeze &&
      old.settled === false &&
      old.amount === targetedWorkload.retained_old_reservation,
    "TARGETED_OLD_RESERVATION",
  );
}

// The parent account stays closed and on hold. One separately claimed child facility
// owns this series for its entire lifetime, including after a crash or archive.
export function claimTargetedAccount(
  account: string,
  root: string,
  freeze: string,
) {
  const scope = facilityPolicy(root);
  verifyTargetedCarry(account, root, scope);
  requireThat(
    !fs.existsSync(path.join(account, scope.series + "-hold.json")),
    "TARGETED_ACCOUNT_ON_HOLD",
  );
  const file = path.join(account, scope.series + ".json"),
    prior: Claim | null = fs.existsSync(file) ? readJSON(file) : null;
  if (prior)
    requireThat(
      prior.root === root && prior.freeze === freeze && !prior.closed,
      "TARGETED_SERIES_ALREADY_CLAIMED",
    );
  else {
    // An unrelated unsettled send must be disposed before sharing this account.
    for (const name of fs
      .readdirSync(reservationDir(account))
      .filter((n) => n.endsWith(".json") && n !== "reader-candidate-97.json")) {
      requireThat(
        readJSON(path.join(reservationDir(account), name)).settled === true,
        "TARGETED_OTHER_UNSETTLED",
      );
    }
    writeJSON(file, { root, freeze, closed: false });
  }
}

export function assertTargetedAccount(
  account: string,
  root: string,
  freeze: string,
) {
  const scope = facilityPolicy(root);
  verifyTargetedCarry(account, root, scope);
  const claim = targetedClaim(account, freeze);
  requireThat(
    claim?.root === root &&
      claim.freeze === freeze &&
      !claim.closed &&
      !fs.existsSync(path.join(account, scope.series + "-hold.json")),
    "TARGETED_ACCOUNT_NOT_AVAILABLE",
  );
}
export function holdTargetedAccount(
  account: string,
  freeze: string,
  reason: string,
) {
  const file = path.join(account, claimSeries(account, freeze) + "-hold.json");
  if (targetedClaim(account, freeze)?.freeze !== freeze) return false;
  if (!fs.existsSync(file))
    writeJSON(file, { freeze, reason, at: new Date().toISOString() });
  return true;
}
export function closeTargetedAccount(
  account: string,
  root: string,
  freeze: string,
) {
  const claim = targetedClaim(account, freeze);
  requireThat(
    claim?.root === root && claim.freeze === freeze,
    "TARGETED_ACCOUNT_BINDING",
  );
  writeJSON(path.join(account, claimSeries(account, freeze) + ".json"), {
    ...claim,
    closed: true,
  });
}
type WorkloadEntry =
  ReturnType<typeof ledger>["entries"] extends Map<string, infer E> ? E : never;

// Reconstruct the shared reservation book from a terminal campaign ledger when
// exporting from an archive. Ambiguous settlement retains its admission bound.
export function targetedAccountedAmount(
  e: WorkloadEntry,
  reservation?: number,
) {
  const usage = e.usage as {
    response_complete?: boolean;
    go_meter?: {
      list_cost?: number | null;
      cash_debit_usd?: number | null;
      billing_source?: string | null;
    };
  } | null;
  if (e.outcome === "RETEST_CONFIRMED_NO_POST") {
    requireThat(
      e.settled &&
        e.actual_usd === 0 &&
        (e.usage as { physical_send?: boolean })?.physical_send === false,
      "RETEST_UNSENT_PROOF",
    );
    return 0;
  }
  const meter = usage?.go_meter;
  const list = meter?.list_cost;
  requireThat(
    list == null || (Number.isFinite(list) && list >= 0),
    "TARGETED_WORKLOAD_METER",
  );
  const confirmed =
    e.settled &&
    e.outcome === "RESPONSE_COMPLETE" &&
    e.actual_usd != null &&
    usage?.response_complete === true &&
    list != null &&
    meter?.cash_debit_usd === 0 &&
    ["go", "go-plus", "go-teams", "free"].includes(meter.billing_source ?? "");
  return Math.max(
    reservation ?? 0,
    confirmed ? 0 : e.attempt.reserved_usd,
    e.charged_usd,
    list ?? 0,
  );
}

export function checkTargetedSpend(
  account: string,
  freeze: string,
  current: ReturnType<typeof ledger>,
  worst: number,
) {
  let spent = 0;
  for (const [id, e] of current.entries) {
    requireThat(e.settled, "TARGETED_WORKLOAD_REQUEST_OUTSTANDING");
    const f = path.join(reservationDir(account), id + ".json");
    // An interrupted settlement retains the full reservation. Never infer a lower
    // amount from a provider window, which also includes unrelated usage.
    const r = fs.existsSync(f) ? readJSON(f) : null;
    if (r)
      requireThat(
        r.freeze === freeze && Number.isFinite(r.amount) && r.amount >= 0,
        "TARGETED_WORKLOAD_RESERVATION",
      );
    spent += targetedAccountedAmount(e, r?.amount ?? e.attempt.reserved_usd);
  }
  requireThat(
    Number.isFinite(worst) &&
      worst > 0 &&
      spent + worst <= targetedWorkload.workload_equivalent_cap,
    "TARGETED_WORKLOAD_SPEND_LIMIT",
  );
  return spent;
}

export function checkTargetedSend(root: string, freeze: string) {
  const active = readJSON(path.join(root, "campaign/active-stage-c.json"));
  requireThat(
    active.state === "OPEN" &&
      active.freeze_sha256 === freeze &&
      targetedLanes.some(
        (l) => active.lane === "r1-" + l.scenario + "--deepseek-flash",
      ),
    "TARGETED_WORKLOAD_LANE",
  );
}
