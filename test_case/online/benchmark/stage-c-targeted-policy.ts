import { isGoRehearsal } from "./stage-c-go-rehearsal.ts";
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
export const retestWorkload = {
  ...targetedWorkload,
  series: "issue122-r75-retest-v1",
  decision_sha256:
    "ac4fcbb85b32332b15378543c136fd2e0d973ca0e91e11827b9cc0d4212f35a6",
  carry_sha256:
    "5e34327c61d3b842ab3b1dac2ab52766b2e6770297e440846096ae88aff7fd2d",
  reader_operator_release_sha256:
    "540e14c1f8d809c17b0dfb3d6d3c0f631a6bad499de85ae9b096040f48463065",
  reader_native_sha256:
    "5f4464007d84c5c6306d21f00ffe76972b78f9b25a403bbebd065f9abee11c67",
  reader_package_sha256:
    "50d202461d7ff96286e6cbc5ed38cc23207f76fc624b48a4f9feb5763106a907",
  candidate_limit: 2,
  reader_equivalent_cap: 0.5013504,
  proof_verifier_sha256:
    "476979e03d5a42b52ec234d0e679d436893db9119d5e208c1088b56e349df534",
  before_observation_sha256:
    "37f3a9a57e6d28c9e64dd9fd901822b350553583d2073ac85ba7b76ab2a5baca",
  metadata_rechecks: 2,
  quota_read_timeout_ms: 5000,
  response_headroom_ms: 60000,
} as const;
export const continuationWorkload = {
  ...retestWorkload,
  series: "issue122-r77-continuation-v1",
  decision_sha256: "b683c5ed3f7ad4e65def42739543633ffbdb435797eb1999ca00115960d4af92",
  workload_equivalent_cap: null,
  reader_equivalent_cap: null,
  proof_verifier_sha256:"c3363c93fc5da6cf1692c272d1a148d05b3722577709f3d9030df2698d43232b",
  before_observation_sha256:"5bfd8f4e3fb6a351e2353933c32b17be7c0b4403e6551c36fa9af50b3995d0c8",
  request_budget: null,
  interruption_policy: "RECONCILE_AND_CONTINUE",
  stop_policy: "CONFIRMED_SECRETARY_SYSTEM_FAILURE_ONLY",
} as const;
export const isRetest = (series: unknown) =>
  series === retestWorkload.series || series === continuationWorkload.series;
export type TargetedPolicy = typeof targetedWorkload | typeof retestWorkload | typeof continuationWorkload;
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
export function checkTargetedInputs(scope: TargetedPolicy, root?: string) {
  requireThat(
    isDeepStrictEqual(
      scope,
      scope.series === continuationWorkload.series ? continuationWorkload : scope.series === retestWorkload.series
        ? retestWorkload
        : targetedWorkload,
    ),
    "TARGETED_WORKLOAD_POLICY",
  );
  if (root) {
    const file = (name: string) => read(path.join(root, "inputs", name));
    if ("before_observation_sha256" in scope) {
      const bytes = file("reader-before.json");
      const record = JSON.parse(bytes.toString());
      requireThat(
        sha(bytes) === scope.before_observation_sha256 &&
          ((scope.series===continuationWorkload.series?record.observed?.facility:record.facility) === root || isGoRehearsal(root)) &&
          record.series === scope.series &&
          record.verifier_sha256 === scope.proof_verifier_sha256,
        "RETEST_READER_BASELINE",
      );
    }
    requireThat(
      sha(file("targeted-decisions.json")) === scope.decision_sha256 &&
        sha(file("targeted-carry.json")) === scope.carry_sha256,
      "TARGETED_MASTER_RECORDS",
    );
  }
}
