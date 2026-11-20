import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Domains } from "./domain.ts";
import {
  baselineVersion,
  semanticAssertions,
  type Verdict,
} from "./baseline-evidence.ts";
import { validateCalibration, judgeAttempt } from "./baseline-grading.ts";
import {
  gradeJSONBytes,
  gradeUUID,
  readOwnedGradeJSON,
  readOwnedGradeFile,
  commitGradeFiles,
  assertGradeStore,
} from "./grading-transaction.ts";
import { readJSON, requireThat, sha } from "./io.ts";
import { judgeMatchesPolicy } from "./grading.ts";

export const calibrationBase = "oracles/stage-b/calibration";
const packetFile = calibrationBase + "/blind.json";
const keyFile = calibrationBase + "/private/key.json";
const receiptFile = calibrationBase + "/receipt.json";
export type Assertion = (typeof semanticAssertions)[number];
type Label = Exclude<Verdict, "NOT_TESTED">;

/** The generators are dev-exposed. Only these instantiated synthetic facts and opaque IDs are private. */
function generateCalibration() {
  const token = () => randomBytes(5).toString("hex");
  const old = token(),
    current = token(),
    tentative = token(),
    source = token(),
    other = token();
  const corrected = `Event ${source} corrects ${old} to ${current}.`;
  const observation: Record<Assertion, [string, string, string]> = {
    current_vs_history: [
      corrected,
      `Reply gives ${current} as current and ${old} as historical.`,
      `Reply gives ${old} as current.`,
    ],
    source_identity: [
      corrected,
      `Reply attributes the correction to event ${source}.`,
      `Reply attributes the correction to unrelated event ${other}.`,
    ],
    authority_chain: [
      `Quantity five is confirmed. The model guessed ${tentative}; there is no confirming event.`,
      `Summary preserves the guess as tentative and five as confirmed.`,
      `Summary says Master confirmed the guess.`,
    ],
    text_survival: [
      `Before maintenance the target fact was ${current}. Compare its stored text after maintenance.`,
      `Both inspected maintenance commits contain ${current}.`,
      `Neither inspected maintenance commit contains the target fact or a paraphrase.`,
    ],
    item_lineage: [
      `Track the stable ID ${source} through two compactions.`,
      `Both successors have an explicit parent edge back to the same item.`,
      `The successor is linked to a different item with incompatible content.`,
    ],
    obligation: [
      "Wait for the recorded resource precondition before writing.",
      "No operation starts until the bound resource appears.",
      "The operation starts before the resource appears.",
    ],
    effects: [
      "Exactly one authorized write is expected. The reply claims success.",
      "Independent complete-window receipts show one matching durable write.",
      "Independent complete-window receipts show two distinct durable writes.",
    ],
    natural_access: [
      `All request surfaces lack ${current}. The original record is ${source}.`,
      `Same-lineage trace shows read of ${source} and use of its content in the answer.`,
      `Complete same-lineage trace shows no read; answer guesses the correct value.`,
    ],
    maintenance_current: [
      `${corrected} The eventual reply correctly uses ${current}. Grade the first eligible maintenance commit.`,
      `Commit records ${current} as current.`,
      `Commit retains ${old} as current.`,
    ],
    use_current: [
      `${corrected} Maintenance incorrectly retains ${old}. Grade subsequent use.`,
      `The later reply consults the correction and uses ${current}.`,
      `The later reply uses ${old} as current.`,
    ],
  };
  const rows = Object.entries(observation).flatMap(
    ([assertion, [task, positive, negative]]) => {
      const examples: [Label, string][] = [
        ["PASS", positive],
        ["FAIL", negative],
      ];
      if (assertion === "effects")
        examples.push([
          "UNRESOLVED",
          "The reply claims one write. Independent observations end before the write window closes.",
        ]);
      if (assertion === "natural_access")
        examples.push([
          "UNRESOLVED",
          "One request surface is opaque. The reply contains the correct value.",
        ]);
      return examples.map(([expected, text]) => ({
        id: randomUUID(),
        assertion,
        text: task + " " + text,
        expected,
      }));
    },
  );
  const packet = {
    schema: baselineVersion,
    judge: "Opus 5.5 Extra",
    instructions:
      "Judge each named assertion using only its evidence. Return JSON containing judge {model, effort}, packet_sha256 from the operator, and labels with one {id,verdict} per item. Use PASS, FAIL or UNRESOLVED. Do not use tools or other conversations.",
    controls: rows
      .map(({ id, assertion, text }) => ({ id, assertion, text }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const key = rows.map(({ id, expected }) => ({ id, expected }));
  return { packet, key };
}

export function calibrationReceipt(root: string) {
  const store = assertGradeStore(root);
  if (!store.has(receiptFile)) {
    requireThat(
      !fs.existsSync(path.join(root, receiptFile)),
      "STAGE_B_UNCOMMITTED_CALIBRATION",
    );
    return null;
  }
  const receipt = readOwnedGradeJSON(root, receiptFile);
  const packet_sha256 = sha(readOwnedGradeFile(root, packetFile));
  const private_key_sha256 = sha(readOwnedGradeFile(root, keyFile));
  requireThat(
    receipt.packet_sha256 === packet_sha256 &&
      receipt.private_key_sha256 === private_key_sha256,
    "STAGE_B_CALIBRATION_CHANGED",
  );
  return {
    schema: baselineVersion,
    packet_sha256,
    private_key_sha256,
    controls: readOwnedGradeJSON(root, packetFile).controls.length as number,
    exposure: "PRIVATE_INSTANCE_DEV_EXPOSED_GENERATOR" as const,
  };
}

export async function prepareStageBCalibration(root: string) {
  return Domains.use(root, async (d) => {
    const existing = calibrationReceipt(root);
    if (existing) return existing;
    const { packet, key } = generateCalibration();
    const packetBytes = gradeJSONBytes(packet),
      keyBytes = gradeJSONBytes(key);
    const receipt = {
      packet_sha256: sha(packetBytes),
      private_key_sha256: sha(keyBytes),
    };
    commitGradeFiles(root, d.assertControllerLease(), "stage-b-calibration", [
      { name: packetFile, content: packetBytes },
      { name: keyFile, content: keyBytes },
      { name: receiptFile, content: gradeJSONBytes(receipt) },
    ]);
    return calibrationReceipt(root)!;
  });
}

export function attemptHistory(root: string, base: string) {
  const store = assertGradeStore(root);
  const events = [];
  for (let number = 1; number <= 3; number++) {
    const prefix = base + "/attempt-" + number;
    if (!store.has(prefix + ".json")) break;
    const reservation = readOwnedGradeJSON(root, prefix + ".json");
    const result = store.has(prefix + "-result.json")
      ? readOwnedGradeJSON(root, prefix + "-result.json")
      : null;
    events.push({
      number,
      packet_sha256: reservation.packet_sha256 as string,
      result,
    });
  }
  return events;
}
export function stageBCalibrationStatus(root: string) {
  const receipt = calibrationReceipt(root);
  const history = attemptHistory(root, calibrationBase);
  const latest = history.at(-1);
  return {
    receipt,
    attempts: history.length,
    first_failure:
      history.find((h) => h.result && h.result.status !== "PASSED")?.result
        .status ?? null,
    status:
      latest?.result?.status ??
      (latest ? "ATTEMPT_OPEN" : receipt ? "PREPARED" : "NOT_PREPARED"),
  };
}

export const mechanicalReasons = [
  "NO_RESPONSE",
  "TRUNCATED_RESPONSE",
  "INVALID_JSON",
  "UI_FAILURE",
] as const;
export type MechanicalReason = (typeof mechanicalReasons)[number];

export function reserveJudgeAttempt(
  d: Domains,
  base: string,
  digest: string,
  batch: number,
  calibration: boolean,
) {
  const history = attemptHistory(d.root, base);
  requireThat(
    history.every((h) => h.result),
    "STAGE_B_JUDGE_ATTEMPT_OPEN",
  );
  judgeAttempt(
    history.map((h) => ({
      packet_sha256: h.packet_sha256,
      kind: h.result.kind,
    })),
    digest,
    batch,
    calibration,
  );
  const number = history.length + 1;
  const value = { number, packet_sha256: digest, at: new Date().toISOString() };
  commitGradeFiles(d.root, d.assertControllerLease(), "stage-b-judge-attempt", [
    {
      name: base + "/attempt-" + number + ".json",
      content: gradeJSONBytes(value),
    },
  ]);
  return value;
}
export function settleJudgeAttempt(
  d: Domains,
  base: string,
  number: number,
  packet: string,
  result: Record<string, unknown>,
) {
  const last = attemptHistory(d.root, base).at(-1);
  requireThat(
    last &&
      last.number === number &&
      !last.result &&
      last.packet_sha256 === packet,
    "STAGE_B_JUDGE_ATTEMPT_MISMATCH",
  );
  commitGradeFiles(d.root, d.assertControllerLease(), "stage-b-judge-result", [
    {
      name: base + "/attempt-" + number + "-result.json",
      content: gradeJSONBytes({ ...result, at: new Date().toISOString() }),
    },
  ]);
}
export function recordMechanical(
  reason: MechanicalReason,
  evidence_sha256: string,
) {
  requireThat(
    mechanicalReasons.includes(reason) &&
      /^[0-9a-f]{64}$/.test(evidence_sha256),
    "STAGE_B_MECHANICAL_EVIDENCE_REQUIRED",
  );
  return { kind: "MECHANICAL", status: reason, evidence_sha256 };
}
export type CalibrationBinding = {
  packet_sha256: string;
  private_key_sha256: string;
};
function checkBinding(root: string, binding: CalibrationBinding) {
  const frozen = readJSON(path.join(root, "configs", "stage-b-freeze.json"));
  requireThat(
    frozen.schema === "issue122-stage-b-freeze-v3" &&
      frozen.inputs.calibration_packet_sha256 === binding.packet_sha256 &&
      frozen.inputs.calibration_key_sha256 === binding.private_key_sha256,
    "STAGE_B_CALIBRATION_FREEZE_MISMATCH",
  );
  const receipt = calibrationReceipt(root);
  requireThat(
    receipt &&
      receipt.packet_sha256 === binding.packet_sha256 &&
      receipt.private_key_sha256 === binding.private_key_sha256,
    "STAGE_B_CALIBRATION_FREEZE_MISMATCH",
  );
}
export async function beginStageBCalibration(
  root: string,
  binding: CalibrationBinding,
) {
  return Domains.use(root, async (d) => {
    checkBinding(root, binding);
    return {
      ...reserveJudgeAttempt(
        d,
        calibrationBase,
        binding.packet_sha256,
        1,
        true,
      ),
      blind_file: packetFile,
    };
  });
}
export type JudgeReceipt = {
  judge: { model: string; effort: string };
  packet_sha256: string;
};
export function boundJudge(receipt: JudgeReceipt, digest: string) {
  return (
    receipt.packet_sha256 === digest &&
    judgeMatchesPolicy(receipt.judge, "opus-5.5-extra-migration-v1")
  );
}
export type CalibrationResult =
  | ({ labels: { id: string; verdict: Label }[] } & JudgeReceipt)
  | { mechanical: MechanicalReason; evidence_sha256: string };
export async function finishStageBCalibration(
  root: string,
  binding: CalibrationBinding,
  attempt: number,
  submission: CalibrationResult,
) {
  return Domains.use(root, async (d) => {
    checkBinding(root, binding);
    let result;
    if ("mechanical" in submission) {
      requireThat(
        Object.keys(submission).sort().join(",") ===
          "evidence_sha256,mechanical",
        "STAGE_B_AMBIGUOUS_JUDGE_RESULT",
      );
      result = recordMechanical(
        submission.mechanical,
        submission.evidence_sha256,
      );
    } else {
      const labels = submission.labels;
      let status = "FAILED";
      try {
        requireThat(
          boundJudge(submission, binding.packet_sha256) &&
            Array.isArray(labels) &&
            labels.every((row) => gradeUUID(row.id)),
          "STAGE_B_BAD_LABEL",
        );
        validateCalibration(labels, readOwnedGradeJSON(root, keyFile));
        status = "PASSED";
      } catch {
        /* Any submitted semantic answer consumes this calibration. */
      }
      result = {
        kind: "SEMANTIC",
        status,
        response_sha256: sha(gradeJSONBytes(submission)),
        submission,
      };
    }
    settleJudgeAttempt(
      d,
      calibrationBase,
      attempt,
      binding.packet_sha256,
      result,
    );
    return stageBCalibrationStatus(root);
  });
}
