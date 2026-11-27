import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  deploymentGuard,
  noLinks,
  repository,
  requireThat,
  sha,
  syncDir,
} from "../io.ts";
import { gradeJSONBytes, gradeUUID } from "../grading-transaction.ts";
import { operatorVisibilityVersion } from "../stage-c-visibility-rubric.ts";
import { caseDefinition } from "../stage-c-plan.ts";
import { verifySut } from "../source.ts";
import { execFileSync } from "node:child_process";

export const rootFor = (id: string) => {
  requireThat(gradeUUID(id), "Expected the run UUID printed by evaluate");
  const root = path.join(repository, ".local/benchmark", id);
  deploymentGuard(repository, root);
  return root;
};
export const dir = (p: string) => {
  noLinks(p);
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
};
export function put(p: string, data: Buffer) {
  dir(path.dirname(p));
  noLinks(p);
  const temp = p + "." + randomUUID();
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temp, p);
  } finally {
    fs.unlinkSync(temp);
    syncDir(path.dirname(p));
  }
}
export const save = (p: string, value: unknown) =>
  put(p, gradeJSONBytes(value));
export const load = (p: string) => {
  noLinks(p);
  return JSON.parse(fs.readFileSync(p, "utf8"));
};
export function seal(p: string, data: unknown) {
  save(p, { schema: 1, digest: sha(gradeJSONBytes(data)), data });
}
export function openSeal(p: string) {
  const x = load(p);
  requireThat(
    x.schema === 1 && x.digest === sha(gradeJSONBytes(x.data)),
    "EVIDENCE_DIGEST_MISMATCH",
  );
  return x.data;
}
export function config(file: string) {
  const c = load(path.resolve(file));
  const keys = [
    "version",
    "suite",
    "case",
    "target",
    "workload",
    "judge",
    "repeat",
    "maxWorkloadCalls",
    "maxJudgeCalls",
    "timeoutSeconds",
  ];
  requireThat(
    Object.keys(c).every(
      (k) => keys.includes(k) || k === "cohort" || k === "billingPolicy",
    ) &&
      (c.cohort === undefined ||
        (typeof c.cohort === "string" &&
          /^[a-z0-9][a-z0-9-]{0,63}$/.test(c.cohort))) &&
      keys.every((k) => Object.hasOwn(c, k)),
    "Invalid configuration keys",
  );
  requireThat(
    (c.billingPolicy === undefined ||
      c.billingPolicy === "record-only" ||
      c.billingPolicy === "bounded") &&
      c.version === 1 &&
      c.suite === "public-resident-v1" &&
      c.case === "C04-resident" &&
      ["secretary", "scripted-good", "scripted-bad"].includes(c.target) &&
      ["fixture", "wire-rehearsal", "opencode-go"].includes(c.workload) &&
      ["fixture", "hermes-go"].includes(c.judge) &&
      c.repeat === 1 &&
      Number.isSafeInteger(c.timeoutSeconds) &&
      c.timeoutSeconds >= 10 &&
      c.timeoutSeconds <= 1200 &&
      Number.isSafeInteger(c.maxWorkloadCalls) &&
      c.maxWorkloadCalls >= 1 &&
      c.maxWorkloadCalls <= 32 &&
      Number.isSafeInteger(c.maxJudgeCalls) &&
      c.maxJudgeCalls >= 5 &&
      c.maxJudgeCalls <= 10,
    "Unsupported profile or limits; see the operator README",
  );
  requireThat(
    (c.workload !== "opencode-go") === (c.judge === "fixture") &&
      (c.workload === "fixture" || c.target === "secretary"),
    "Mixing real and simulated profiles is unsupported",
  );
  return c.workload === "opencode-go"
    ? { ...c, billingPolicy: c.billingPolicy ?? "record-only" }
    : c;
}
export function manifest(c: any) {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  if (c.workload === "opencode-go")
    requireThat(
      !git("status", "--porcelain", "--untracked-files=no"),
      "Live evaluation requires a clean tracked checkout",
    );
  const source = path.join(repository, "test_case/online/benchmark/operator");
  const files = fs
    .readdirSync(source)
    .filter((f) => /\.(?:ts|py)$/.test(f))
    .sort();
  return {
    version: 1,
    config: c,
    source: git("rev-parse", "HEAD"),
    sut: verifySut(),
    suite: caseDefinition(c.case),
    implementation: Object.fromEntries(
      files.map((f) => [f, sha(fs.readFileSync(path.join(source, f)))]),
    ),
    judgePolicy: operatorVisibilityVersion,
    readerRelease:
      c.judge === "hermes-go"
        ? "97a9ae8ee55d31bebce49f1fb6b5ef775323976a"
        : null,
    provider: c.workload,
    workEffort: c.workload === "fixture" ? null : "low",
    publishedModel:
      c.workload === "opencode-go" ? "DeepSeek V4.1 Flash 1017" : null,
    workModel:
      c.workload === "fixture" ? "secretary-fixture" : "deepseek-v4.1-flash",
    judgeModel:
      c.judge === "fixture" ? "scripted-judge" : "deepseek-v4.1-flash",
    effort: c.judge === "fixture" ? null : "max",
    protocol: 1,
    tariff:
      c.billingPolicy === "record-only"
        ? null
        : { inputUSDPerMillion: 0.3, outputUSDPerMillion: 1.2 },
    maxWireBytes: 524288,
    maxOutput: 49152,
    rubricSource: sha(
      fs.readFileSync(path.join(source, "../stage-c-visibility-rubric.ts")),
    ),
    attempts: 1,
  };
}
export const bound = (m: any) => sha(gradeJSONBytes(m));
export function verifyApproval(m: any, approval?: string) {
  if (
    m.config.workload === "opencode-go" &&
    (m.config.billingPolicy !== "record-only" || approval !== undefined)
  )
    requireThat(
      bound(m) === approval,
      "LIVE_FREEZE_REQUIRED: run freeze, then supply the approved digest",
    );
}

export function verifyJudgeSource(frozen: any) {
  const base = path.join(repository, "test_case/online/benchmark/operator");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  requireThat(
    git("rev-parse", "HEAD") === frozen.source &&
      git(
        "diff",
        "HEAD",
        "--",
        "test_case/online/benchmark",
        "package-lock.json",
      ) === "" &&
      frozen.rubricSource ===
        sha(
          fs.readFileSync(path.join(base, "../stage-c-visibility-rubric.ts")),
        ),
    "Regrade requires the frozen harness and rubric",
  );
  for (const name of ["reader.py", "grading.ts", "files.ts", "transport.ts"]) {
    requireThat(
      frozen.implementation[name] ===
        sha(fs.readFileSync(path.join(base, name))),
      "Reader implementation mismatch",
    );
  }
}
