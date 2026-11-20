import path from "node:path";
import { Domains } from "./domain.ts";
import { inside, readJSON, requireThat } from "./io.ts";
import { dispatchStage, startStage } from "./stage-b-dispatch.ts";
import { prepareFreeze, freezeFile } from "./stage-b-freeze.ts";
import { buildStageBReport } from "./stage-b-report.ts";
import {
  prepareStageBCalibration,
  beginStageBCalibration,
  finishStageBCalibration,
} from "./stage-b-report-calibration.ts";
import {
  prepareStageBGrade,
  beginStageBGrade,
  finishStageBGrade,
} from "./stage-b-report-grading.ts";
import { executeStageScenario } from "./stage-b-scenarios.ts";

const commands = {
  calibration: [],
  prepare: [],
  report: [],
  start: ["--approval", "--sha256"],
  dispatch: ["--approval", "--sha256"],
  repair: ["--approval", "--sha256", "--attempt"],
  stop: ["--approval", "--sha256"],
  "calibration-begin": [],
  "calibration-finish": ["--attempt", "--source"],
  "grade-prepare": ["--lane"],
  "grade-begin": ["--lane", "--sha256"],
  "grade-finish": ["--lane", "--sha256", "--source", "--attempt"],
};
export async function stageCommand(
  command: string,
  root: string,
  options: Record<string, string>,
) {
  const name = command.slice(
    "baseline-stage-b-".length,
  ) as keyof typeof commands;
  requireThat(
    Object.hasOwn(commands, name) &&
      JSON.stringify(Object.keys(options).sort()) ===
        JSON.stringify(["--root", ...commands[name]].sort()),
    "STAGE_B_COMMAND_ARGUMENTS",
  );
  const approval = options["--approval"],
    hash = options["--sha256"],
    lane = options["--lane"];
  const source = () => {
    const file = path.resolve(options["--source"]);
    requireThat(
      inside(path.join(root, "configs"), file),
      "STAGE_B_REVIEW_INPUT_OUTSIDE_CONFIGS",
    );
    return readJSON(file);
  };
  const binding = () => {
    const { inputs } = readJSON(freezeFile(root));
    return {
      packet_sha256: inputs.calibration_packet_sha256,
      private_key_sha256: inputs.calibration_key_sha256,
    };
  };
  switch (name) {
    case "calibration":
      return prepareStageBCalibration(root);
    case "prepare":
      return Domains.use(root, async () => prepareFreeze(root));
    case "report":
      return Domains.use(root, async () => buildStageBReport(root));
    case "calibration-begin":
      return beginStageBCalibration(root, binding());
    case "calibration-finish":
      return finishStageBCalibration(
        root,
        binding(),
        Number(options["--attempt"]),
        source(),
      );
    case "grade-prepare":
      return prepareStageBGrade(root, lane);
    case "grade-begin":
      return beginStageBGrade(root, lane, hash);
    case "grade-finish":
      return finishStageBGrade(
        root,
        lane,
        hash,
        Number(options["--attempt"]),
        source(),
      );
    case "start":
      return Domains.use(root, async () => {
        await startStage(root, approval, hash);
        return { state: "OPEN", physical_provider_sends: 0 };
      });
    default:
      return Domains.use(root, async (domains) =>
        dispatchStage(
          domains,
          approval,
          hash,
          executeStageScenario,
          name,
          options["--attempt"],
        ),
      );
  }
}
