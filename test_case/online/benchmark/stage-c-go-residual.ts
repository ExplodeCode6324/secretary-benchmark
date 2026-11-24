import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { read, requireThat, sha } from "./io.ts";

// The closed parent and its first account hold remain independent evidence.
export const goResidualSource = {
  freeze: "90f5696faf56148ce8ec55788d08cf44993c8dadaadd173be994751160bdaf74",
  dispatch: "fde48c7e6727c89bbec5c33f9353c4d5381237088f62361da26a71709c2490db",
  manifest: "d634b96459531684f3789e588b4de2f657a1266ef44a88b82fa88c283d2d2068",
  ledger: "cf001036622f73d15b384d570ca5bd58b595e51d20637e8b6c3569098bb8b051",
  partition: 5,
  lanes: [
    "r2-C07-cancelled--deepseek-flash",
    "r3-C07-cancelled--deepseek-flash",
  ],
};
export function residualParent(g: { residual?: unknown } | undefined) {
  if (!g || !Object.hasOwn(g, "residual")) return false;
  requireThat(
    isDeepStrictEqual(g.residual, goResidualSource),
    "GO_RESIDUAL_PARENT_CHANGED",
  );
  return true;
}
export function checkGoResidualFiles(root: string) {
  const dir = path.join(root, "inputs/go-residual-parent");
  const files = {
    freeze: "stage-c-freeze.json",
    dispatch: "stage-c-dispatch.json",
    manifest: "manifest.json",
    ledger: "attempts.jsonl",
  } as const;
  for (const key of Object.keys(files) as (keyof typeof files)[]) {
    requireThat(
      sha(read(path.join(dir, files[key]))) === goResidualSource[key],
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
      state.freeze_sha256 === goResidualSource.freeze &&
      manifest.state === "CLOSED" &&
      manifest.final_ledger.attempts === 413 &&
      manifest.final_ledger.unsettled === 0 &&
      goResidualSource.lanes.every(
        (lane) =>
          state.terminals[lane]?.status === "UNRUN" &&
          state.terminals[lane]?.reason === "GO_ACCOUNT_ON_HOLD" &&
          !state.terminals[lane].run &&
          !events.some((e) => e.attempt?.lane === lane),
      ),
    "GO_RESIDUAL_NOT_ZERO_SEND",
  );
}
