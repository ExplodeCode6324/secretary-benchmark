import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { read, requireThat, sha } from "./io.ts";
import { nativeWriteRecipe } from "./stage-c-fault.ts";

export const targetedWorkload = {
  series: "issue122-r67-evidence-v1",
  decision_sha256:
    "c64298f1088737700233eca0111db47df254fdadcddfa758008199549702fd61",
  carry_sha256:
    "46c7a33c0f31424a38f1c31ada840ae278aa6ebbbba1a14b9a759e911c10df2d",
  reader_operator_release_sha256:
    "65a3843895940153f1f219807018861fa2a68f1a629b9c58a7bfad30452c2bc0",
  reader_native_sha256:
    "28162e8380ff3385bdc201e2641d088df94cb73fa9766647b110e60e557fdf57",
  reader_package_sha256:
    "94fa256ec9cabb6c476ac191aefd2c1e23600b4431939a2c4052adae23d2dfe1",
  workload_equivalent_cap: 5,
  reader_equivalent_cap: 0.933888,
  calibration_limit: 1,
  candidate_limit: 4,
  excluded_old_slot: 97,
  retained_old_reservation: 0.2162688,
  c12b_recipe: nativeWriteRecipe,
  route: "opencode-go",
} as const;
export const targetedLanes = [
  {
    scenario: "C16-combined",
    seed: 851137952,
    cap: 609,
    seconds: 12090,
    profile: "RC98304",
  },
  { scenario: "C12b", seed: 643644539, cap: 25, seconds: 668, profile: "DEP" },
] as const;
export function checkTargetedInputs(
  scope: typeof targetedWorkload,
  root?: string,
) {
  requireThat(
    isDeepStrictEqual(scope, targetedWorkload),
    "TARGETED_WORKLOAD_POLICY",
  );
  if (root) {
    const file = (name: string) => read(path.join(root, "inputs", name));
    requireThat(
      sha(file("targeted-decisions.json")) === scope.decision_sha256 &&
        sha(file("targeted-carry.json")) === scope.carry_sha256,
      "TARGETED_MASTER_RECORDS",
    );
  }
}
