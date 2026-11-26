import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { read, requireThat, sha } from "./io.ts";

// The closed parent and its first account hold remain independent evidence.
export const goResidualSource = {
  freeze: "90f5696faf56148ce8ec55788d08cf44993c8dadaadd173be994751160bdaf74",
  dispatch: "fde48c7e6727c89bbec5c33f9353c4d5381237088f62361da26a71709c2490db",
  manifest: "d634b96459531684f3789e588b4de2f657a1266ef44a88b82fa88c283d2d2068",
  ledger: "cf001036622f73d15b384d570ca5bd58b595e51d20637e8b6c3569098bb8b051",
  replay: "30216e18e1cfd38f1d00d51def3478ae13d9e27bb1ccd9ef928b99a97b88c644",
  partition: 5,
  lanes: [
    "r2-C07-cancelled--deepseek-flash",
    "r3-C07-cancelled--deepseek-flash",
  ],
};
export const goResidualSource7 = {
  freeze: "97bcbda3897e51b4fa06c86b398650f9ff5437ce07ce046fcf51c97e96e8d583",
  dispatch: "81733bb2049c6ef549a2d16dba2a33d51eaff8ef5a6e8c65f3ef929676311871",
  manifest: "f9b3a5ef5d3bb64762df7872449c48863f795326f6718106065a6fa5bd1651e5",
  ledger: "2908b403a71975c71bf534457a32d1f153e65f15f909144f4ac07341b16149e7",
  replay: "30216e18e1cfd38f1d00d51def3478ae13d9e27bb1ccd9ef928b99a97b88c644",
  partition: 7,
  lanes: [
    "r2-C13-task--deepseek-flash",
    "r3-C13-task--deepseek-flash",
    "r1-C13-inference--deepseek-flash",
    "r2-C13-inference--deepseek-flash",
    "r3-C13-inference--deepseek-flash",
    "r1-C14-retraction--deepseek-flash",
    "r2-C14-retraction--deepseek-flash",
    "r3-C14-retraction--deepseek-flash",
    "r1-C06-resident-B--deepseek-flash",
    "r2-C06-resident-B--deepseek-flash",
    "r3-C06-resident-B--deepseek-flash",
  ],
};
export function residualForFreeze(freeze: unknown) {
  const parent = [goResidualSource, goResidualSource7].find(
    (s) => s.freeze === freeze,
  );
  requireThat(parent, "GO_RESIDUAL_PARENT_CHANGED");
  return parent;
}
export function residualDefinition(g: { residual?: unknown } | undefined) {
  if (!g || !Object.hasOwn(g, "residual")) return undefined;
  const parent = residualForFreeze(
    (g.residual as { freeze?: unknown } | null)?.freeze,
  );
  requireThat(
    isDeepStrictEqual(g.residual, parent),
    "GO_RESIDUAL_PARENT_CHANGED",
  );
  return parent;
}
export function residualParent(g: { residual?: unknown } | undefined) {
  return Boolean(residualDefinition(g));
}
export function residualHistory(parent: typeof goResidualSource) {
  return parent.partition === 5
    ? { attempts: 413, reason: "GO_ACCOUNT_ON_HOLD", caps: [87, 87] }
    : {
        attempts: 180,
        reason: "fetch failed",
        caps: [25, 25, 27, 27, 27, 91, 91, 91, 27, 27, 27],
      };
}
export function checkGoResidualFiles(
  root: string,
  parent: typeof goResidualSource,
) {
  const dir = path.join(root, "inputs/go-residual-parent");
  const files = {
    freeze: "stage-c-freeze.json",
    dispatch: "stage-c-dispatch.json",
    manifest: "manifest.json",
    ledger: "attempts.jsonl",
    replay: "go-first-contact-replay.json",
  } as const;
  for (const key of Object.keys(files) as (keyof typeof files)[]) {
    requireThat(
      sha(read(path.join(dir, files[key]))) === parent[key],
      "GO_RESIDUAL_PARENT_EVIDENCE",
    );
  }
  const state = JSON.parse(read(path.join(dir, files.dispatch)).toString());
  const manifest = JSON.parse(read(path.join(dir, files.manifest)).toString());
  const events = read(path.join(dir, files.ledger))
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).event);
  requireThat(
    state.ended &&
      !state.current &&
      state.freeze_sha256 === parent.freeze &&
      manifest.state === "CLOSED" &&
      manifest.final_ledger.attempts === residualHistory(parent).attempts &&
      manifest.final_ledger.unsettled === 0 &&
      parent.lanes.every(
        (lane) =>
          state.terminals[lane]?.status === "UNRUN" &&
          state.terminals[lane]?.reason === residualHistory(parent).reason &&
          !state.terminals[lane].run &&
          !events.some((e) => e.attempt?.lane === lane),
      ),
    "GO_RESIDUAL_NOT_ZERO_SEND",
  );
}
