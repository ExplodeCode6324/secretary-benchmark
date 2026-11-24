import fs from "node:fs";
import path from "node:path";
import { lease, readJSON, requireThat, repository, writeJSON } from "./io.ts";
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
  if (!fs.existsSync(holdFile))
    writeJSON(holdFile, { freeze, reason, at: new Date().toISOString() });
}
export function assertGoAvailable() {
  requireThat(!fs.existsSync(holdFile), "GO_ACCOUNT_ON_HOLD");
}
export async function claimGoFacility(root: string, freeze: string) {
  await lease(account, async () => {
    assertGoAvailable();
    const prev = fs.existsSync(activeFile) ? readJSON(activeFile) : null;
    requireThat(
      !prev || prev.closed || (prev.root === root && prev.freeze === freeze),
      "GO_OTHER_FACILITY_ACTIVE",
    );
    writeJSON(activeFile, { root, freeze, closed: false });
  });
}
export async function closeGoFacility(root: string, freeze: string) {
  await lease(account, async () => {
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
  admit: () => Promise<string>,
) {
  return lease(account, async () => {
    assertGoAvailable();
    const active = readJSON(activeFile);
    requireThat(
      !active.closed && active.freeze === freeze && active.root === root,
      "GO_FACILITY_BINDING",
    );
    const local = localGoAmounts(root);
    const unsettled = [...ledger(root).entries.values()]
      .filter((e) => !e.settled && !hasGoReservation(root, e.attempt.id))
      .reduce((n, e) => n + e.attempt.reserved_usd, 0);
    let usage;
    try {
      usage = await checkGoUsage(key, transport);
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
        reason.startsWith("GO_") ? reason : "GO_REQUEST_ADMISSION_FAILED",
      );
      throw e;
    }
    const result = await admit();
    recordGoReservation(root, result, freeze, worst, usage);
    return { result, usage, unsettled, local };
  });
}
