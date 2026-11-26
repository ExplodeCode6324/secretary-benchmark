import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
import { rehearsalKey } from "./stage-c-rehearsal.ts";
import {
  claimTargetedAccount,
  assertTargetedAccount,
  closeTargetedAccount,
  holdTargetedAccount,
  targetedClaim,
  checkTargetedSend,
  checkTargetedSpend,
} from "./stage-c-targeted-account.ts";
import { residualForFreeze } from "./stage-c-go-residual.ts";
import fs from "node:fs";
import path from "node:path";
import { lease, read, readJSON, requireThat, sha, writeJSON } from "./io.ts";
import { checkGoUsage } from "./stage-c-go-provider.ts";
import { ledger } from "./campaign.ts";
import {
  accountFor,
  goAccount,
  goWindows,
  localGoAmounts,
  hasGoReservation,
  recordGoReservation,
  type LocalAmounts,
} from "./stage-c-go-local-usage.ts";
import {
  continuationWorkload,
  retestWorkload,
  isRetest,
} from "./stage-c-targeted-policy.ts";
type RequestWindow = {
  signal: AbortSignal;
  deadline: (stage?: "quota" | "reservation" | "send") => number | undefined;
};
export async function retestQuota(
  key: string,
  transport: typeof fetch,
  window: RequestWindow,
  continuing = false,
) {
  const deadline = window.deadline("quota");
  const check = (allowance: number) => {
    window.signal.throwIfAborted();
    requireThat(
      deadline !== undefined &&
        deadline - Date.now() >=
          allowance + retestWorkload.response_headroom_ms,
      "GO_REQUEST_WINDOW_EXHAUSTED",
    );
  };
  for (let attempt = 0; ; attempt++) {
    check(retestWorkload.quota_read_timeout_ms);
    try {
      const signal = AbortSignal.any([
        window.signal,
        AbortSignal.timeout(retestWorkload.quota_read_timeout_ms),
      ]);
      const usage = await checkGoUsage(key, transport, signal, continuing);
      check(0);
      return usage;
    } catch (error) {
      const transient =
        error instanceof TypeError ||
        (error instanceof Error &&
          (error.name === "TimeoutError" ||
            error.message === "GO_METADATA_UNAVAILABLE"));
      if (
        window.signal.aborted ||
        !transient ||
        attempt >= retestWorkload.metadata_rechecks
      )
        throw error;
    }
  }
}
const account = goAccount;

const windows = goWindows;
export function checkGoHeadroom(
  usage: any,
  worst: number,
  local: LocalAmounts = { rolling: 0, weekly: 0, monthly: 0 },
) {
  requireThat(
    Number.isFinite(worst) &&
      worst >= 0 &&
      Object.entries(windows).every(([k, limit]) => {
        const m = usage?.[k];
        return (
          m?.status === "ok" &&
          Number.isFinite(m.percent) &&
          m.percent >= 0 &&
          ((100 - Math.ceil(m.percent) - 1) * limit) / 100 >=
            worst + local[k as keyof LocalAmounts]
        );
      }),
    "GO_INSUFFICIENT_WINDOW",
  );
}
export function holdGo(freeze: string, reason: string, root?: string) {
  const account = root ? accountFor(root) : goAccount,
    holdFile = path.join(account, "hold.json");
  if (
    root &&
    targetedClaim(account, freeze)?.freeze === freeze &&
    fs.existsSync(path.join(account, continuationWorkload.series + ".json")) &&
    readJSON(path.join(account, continuationWorkload.series + ".json"))
      .freeze === freeze
  )
    return;
  if (holdTargetedAccount(account, freeze, reason)) return;
  if (!fs.existsSync(holdFile))
    writeJSON(holdFile, { freeze, reason, at: new Date().toISOString() });
}
export function assertGoAvailable(target?: { root: string; freeze: string }) {
  const holdFile = path.join(account, "hold.json");
  if (target)
    return assertTargetedAccount(
      accountFor(target.root),
      target.root,
      target.freeze,
    );
  requireThat(!fs.existsSync(holdFile), "GO_ACCOUNT_ON_HOLD");
}
export async function claimGoFacility(
  root: string,
  freeze: string,
  residualSource?: string,
  targeted = false,
) {
  const account = accountFor(root),
    activeFile = path.join(account, "active.json");
  await lease(account, async () => {
    if (targeted) return claimTargetedAccount(account, root, freeze);
    assertGoAvailable();
    const prev = fs.existsSync(activeFile) ? readJSON(activeFile) : null;
    requireThat(
      !prev || prev.closed || (prev.root === root && prev.freeze === freeze),
      "GO_OTHER_FACILITY_ACTIVE",
    );
    if (residualSource) {
      const parent = residualForFreeze(residualSource);
      for (const lane of parent.lanes) {
        const claim = path.join(
          account,
          "residual-claims",
          residualSource,
          lane + ".json",
        );
        if (fs.existsSync(claim)) {
          const prev = readJSON(claim);
          requireThat(
            prev.root === root &&
              prev.freeze === freeze &&
              prev.lane === lane &&
              prev.parent === residualSource,
            "GO_RESIDUAL_ALREADY_CLAIMED",
          );
        } else writeJSON(claim, { root, freeze, lane, parent: residualSource });
      }
    }
    writeJSON(activeFile, {
      root,
      freeze,
      closed: false,
      ...(residualSource ? { residual_source: residualSource } : {}),
    });
  });
}
export async function closeGoFacility(root: string, freeze: string) {
  const account = accountFor(root),
    activeFile = path.join(account, "active.json");
  await lease(account, async () => {
    if (targetedClaim(account, freeze)?.freeze === freeze)
      return closeTargetedAccount(account, root, freeze);
    const current = readJSON(activeFile);
    requireThat(
      current.freeze === freeze && current.root === root,
      "GO_FACILITY_BINDING",
    );
    writeJSON(activeFile, { ...current, closed: true });
  });
}
export async function admitGoSend(
  root: string,
  freeze: string,
  key: string,
  worst: number,
  transport: typeof fetch,
  admit: (guard?: () => void) => Promise<string>,
  window?: RequestWindow,
) {
  const account = accountFor(root),
    activeFile = path.join(account, "active.json");
  if (isGoRehearsal(root))
    requireThat(key === rehearsalKey, "GO_REHEARSAL_CREDENTIAL");
  return lease(account, async () => {
    const claim = targetedClaim(account, freeze);
    const targeted = claim?.freeze === freeze;
    assertGoAvailable(targeted ? { root, freeze } : undefined);
    const active = targeted ? claim : readJSON(activeFile);
    requireThat(
      !active.closed && active.freeze === freeze && active.root === root,
      "GO_FACILITY_BINDING",
    );
    const policyFile = path.join(root, "configs/stage-c-freeze.json");
    const frozen = fs.existsSync(policyFile) ? read(policyFile) : undefined;
    requireThat(
      targeted ===
        Boolean(frozen && JSON.parse(frozen.toString()).targeted_supplement),
      "TARGETED_FREEZE_BINDING",
    );
    const current = ledger(root);
    if (targeted) {
      requireThat(frozen && sha(frozen) === freeze, "TARGETED_FREEZE_BINDING");
    }
    const expectedSource = frozen
      ? JSON.parse(frozen.toString()).go_continuation?.residual?.freeze
      : undefined;
    requireThat(
      expectedSource === active.residual_source,
      "GO_RESIDUAL_ACCOUNT_BINDING",
    );
    if (expectedSource) {
      const parent = residualForFreeze(expectedSource);
      requireThat(frozen && sha(frozen) === freeze, "GO_RESIDUAL_SEND_BINDING");
      const lane = readJSON(path.join(root, "campaign/active-stage-c.json"));
      requireThat(
        lane.state === "OPEN" &&
          lane.freeze_sha256 === freeze &&
          parent.lanes.includes(lane.lane),
        "GO_RESIDUAL_SEND_BINDING",
      );
      const claim = readJSON(
        path.join(
          account,
          "residual-claims",
          parent.freeze,
          lane.lane + ".json",
        ),
      );
      requireThat(
        claim.root === root &&
          claim.freeze === freeze &&
          claim.parent === parent.freeze &&
          claim.lane === lane.lane,
        "GO_RESIDUAL_SEND_CLAIM",
      );
    }
    let local: LocalAmounts;
    const unsettled = [...current.entries.values()]
      .filter((e) => !e.settled && !hasGoReservation(root, e.attempt.id))
      .reduce((n, e) => n + e.attempt.reserved_usd, 0);
    let usage;
    let finalCheck: ((stage?: "reservation" | "send") => void) | undefined;
    try {
      if (targeted) checkTargetedSend(root, freeze);
      const series =
        frozen && JSON.parse(frozen.toString()).targeted_supplement?.series;
      const continuing = series === continuationWorkload.series;
      local = localGoAmounts(
        root,
        Date.now(),
        targeted
          ? (id, r) => {
              if (r.freeze === freeze)
                requireThat(
                  current.entries.has(id) && (r.settled || continuing),
                  "TARGETED_UNMATCHED_ACCOUNT_RESERVATION",
                );
              else
                requireThat(
                  r.settled || id === "reader-candidate-97",
                  "TARGETED_OTHER_UNSETTLED",
                );
            }
          : undefined,
      );
      if (targeted && !continuing)
        checkTargetedSpend(account, freeze, current, worst);
      const retest = isRetest(series);
      if (retest) {
        requireThat(window, "GO_REQUEST_WINDOW_MISSING");
        finalCheck = (stage = "send") => {
          const deadline = window.deadline(stage);
          window.signal.throwIfAborted();
          requireThat(
            deadline !== undefined &&
              deadline - Date.now() >= retestWorkload.response_headroom_ms,
            "GO_REQUEST_WINDOW_EXHAUSTED",
          );
        };
      }
      usage = retest
        ? await retestQuota(key, transport, window!, continuing)
        : await checkGoUsage(key, transport);
      if (!continuing)
        checkGoHeadroom(usage, worst, {
          rolling: local.rolling + unsettled,
          weekly: local.weekly + unsettled,
          monthly: local.monthly + unsettled,
        });
    } catch (e) {
      const reason =
        e instanceof Error ? e.message : "GO_REQUEST_ADMISSION_FAILED";
      holdGo(
        freeze,
        reason.startsWith("GO_") || reason.startsWith("TARGETED_")
          ? reason
          : "GO_REQUEST_ADMISSION_FAILED",
        root,
      );
      throw e;
    }
    const result = await admit(
      finalCheck &&
        (() => {
          try {
            finalCheck("reservation");
          } catch (error) {
            holdGo(freeze, "GO_REQUEST_WINDOW_EXHAUSTED", root);
            if (
              frozen &&
              JSON.parse(frozen.toString()).targeted_supplement?.series ===
                continuationWorkload.series
            )
              throw Error("GO_RESERVATION_WINDOW_EXHAUSTED");
            throw error;
          }
        }),
    );
    recordGoReservation(root, result, freeze, worst, usage);
    return { result, usage, unsettled, local, targeted, finalCheck };
  });
}
