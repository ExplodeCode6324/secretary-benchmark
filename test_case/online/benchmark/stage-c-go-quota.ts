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
  goAccount,
  goWindows,
  localGoAmounts,
  hasGoReservation,
  recordGoReservation,
  type LocalAmounts,
} from "./stage-c-go-local-usage.ts";
import { retestWorkload } from "./stage-c-targeted-policy.ts";
type RequestWindow = {
  signal: AbortSignal;
  deadline: () => number | undefined;
};
export async function retestQuota(
  key: string,
  transport: typeof fetch,
  window: RequestWindow,
) {
  const deadline = window.deadline();
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
      const usage = await checkGoUsage(key, transport, signal);
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
const activeFile = path.join(account, "active.json");
const holdFile = path.join(account, "hold.json");
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
export function holdGo(freeze: string, reason: string) {
  if (holdTargetedAccount(account, freeze, reason)) return;
  if (!fs.existsSync(holdFile))
    writeJSON(holdFile, { freeze, reason, at: new Date().toISOString() });
}
export function assertGoAvailable(target?: { root: string; freeze: string }) {
  if (target) return assertTargetedAccount(account, target.root, target.freeze);
  requireThat(!fs.existsSync(holdFile), "GO_ACCOUNT_ON_HOLD");
}
export async function claimGoFacility(
  root: string,
  freeze: string,
  residualSource?: string,
  targeted = false,
) {
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
    let finalCheck: (() => void) | undefined;
    try {
      if (targeted) checkTargetedSend(root, freeze);
      local = localGoAmounts(
        root,
        Date.now(),
        targeted
          ? (id, r) => {
              if (r.freeze === freeze)
                requireThat(
                  current.entries.has(id) && r.settled,
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
      if (targeted) checkTargetedSpend(account, freeze, current, worst);
      const retest =
        frozen &&
        JSON.parse(frozen.toString()).targeted_supplement?.series ===
          retestWorkload.series;
      if (retest) {
        requireThat(window, "GO_REQUEST_WINDOW_MISSING");
        const deadline = window.deadline();
        finalCheck = () => {
          window.signal.throwIfAborted();
          requireThat(
            deadline !== undefined &&
              deadline - Date.now() >= retestWorkload.response_headroom_ms,
            "GO_REQUEST_WINDOW_EXHAUSTED",
          );
        };
      }
      usage = retest
        ? await retestQuota(key, transport, window!)
        : await checkGoUsage(key, transport);
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
      );
      throw e;
    }
    const result = await admit(
      finalCheck &&
        (() => {
          try {
            finalCheck();
          } catch (error) {
            holdGo(freeze, "GO_REQUEST_WINDOW_EXHAUSTED");
            throw error;
          }
        }),
    );
    recordGoReservation(root, result, freeze, worst, usage);
    return { result, usage, unsettled, local, targeted, finalCheck };
  });
}
