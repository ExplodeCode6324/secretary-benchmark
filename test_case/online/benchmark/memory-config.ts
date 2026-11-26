import { requireThat } from "./io.ts";
import { modelIDs, type ModelID, type Profile } from "./live-model.ts";
import { stageLane, stageModels, type StageModel } from "./stage-b-policy.ts";
export type LiveConfiguration = {
  version: 1;
  mode: "live";
  track: "memory";
  case_id: string;
  seed: number;
  model: ModelID;
  profile: Profile;
  max_sends: number;
  fault_injection?: "write-after-fsync";
  fault_path?: string;
};
export type StageConfiguration = Omit<
  LiveConfiguration,
  "version" | "track" | "model" | "profile" | "fault_injection" | "fault_path"
> & {
  version: 2;
  track: "issue122";
  model: StageModel;
  profile: "DEP" | "RC98304";
  lane: string;
  freeze_sha256: string;
  fault_injection?: never;
  fault_path?: never;
};
export type CompletionConfiguration = Omit<StageConfiguration, "version"> & {
  version: 5;
};
export function validateLiveConfiguration(
  c: LiveConfiguration | StageConfiguration | CompletionConfiguration,
) {
  if (c.version === 5) {
    requireThat(
      Object.keys(c).sort().join(",") ===
        "case_id,freeze_sha256,lane,max_sends,mode,model,profile,seed,track,version" &&
        c.mode === "live" &&
        c.track === "issue122" &&
        stageModels.includes(c.model) &&
        ["DEP", "RC98304"].includes(c.profile) &&
        /^[a-f0-9]{64}$/.test(c.freeze_sha256) &&
        /^r[123]-C[0-9]{2}[a-zA-Z0-9_-]*--[a-z0-9.-]+$/.test(c.lane) &&
        Number.isSafeInteger(c.seed) &&
        Number.isSafeInteger(c.max_sends) &&
        c.max_sends > 0,
      "STAGE_C_CONFIG_BINDING",
    );
    return;
  }
  if (c.version === 2) {
    const lane = stageLane(c.lane);
    requireThat(
      Object.keys(c).sort().join(",") ===
        "case_id,freeze_sha256,lane,max_sends,mode,model,profile,seed,track,version" &&
        c.track === "issue122" &&
        c.mode === "live" &&
        lane &&
        lane.scenario === c.case_id &&
        lane.model === c.model &&
        lane.profile === c.profile &&
        lane.cap === c.max_sends &&
        Number.isSafeInteger(c.seed) &&
        /^[a-f0-9]{64}$/.test(c.freeze_sha256),
      "STAGE_B_CONFIG_BINDING",
    );
    return;
  }
  const keys = [
    "version",
    "mode",
    "track",
    "case_id",
    "seed",
    "model",
    "profile",
    "max_sends",
    "fault_injection",
    "fault_path",
  ];
  requireThat(
    Object.keys(c).every((k) => keys.includes(k)) &&
      c.version === 1 &&
      c.mode === "live" &&
      c.track === "memory" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(c.case_id) &&
      Number.isSafeInteger(c.seed) &&
      modelIDs.includes(c.model) &&
      ["RC", "DEP"].includes(c.profile) &&
      Number.isSafeInteger(c.max_sends) &&
      c.max_sends > 0 &&
      c.max_sends <= 160,
    "CONFIG_UNSUPPORTED_ISSUE121_LIVE",
  );
  requireThat(
    c.fault_injection === undefined
      ? c.fault_path === undefined
      : c.fault_injection === "write-after-fsync" &&
          typeof c.fault_path === "string" &&
          /^[a-zA-Z0-9_-]+\.txt$/.test(c.fault_path),
    "INVALID_LIVE_FAULT_TARGET",
  );
}
