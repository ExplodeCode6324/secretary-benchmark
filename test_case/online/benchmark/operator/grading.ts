import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { gradeJSONBytes } from "../grading-transaction.ts";
import { targetedControls } from "../targeted-reader-packet.ts";
import {
  safeExcerpt,
  scoringRubric,
  matchesReader,
} from "../stage-c-grading.ts";
import {
  admittedReaderQuery,
  goReader,
  goVisibilityVersion,
  goReaderPolicy,
} from "../stage-c-visibility-rubric.ts";
import { repository, requireThat, sha } from "../io.ts";
import { send, remainingJudgeCalls } from "./transport.ts";
import { bound, dir, save, seal, openSeal } from "./files.ts";

const named = {
  provider: goReaderPolicy.provider,
  model: goReaderPolicy.model,
  reasoning_effort: "max",
};
const evidence = (text: string) => ({
  id: randomUUID(),
  text: safeExcerpt(text),
});
export function candidate(execution: any, control?: "good" | "bad") {
  const s = execution.manifest.suite,
    last = execution.events.at(-1);
  const setup = s.setup,
    question = s.probe;
  const answer = control
    ? control === "good"
      ? "REED-843"
      : "PINK-000"
    : last.messages.map((x: any) => x.text).join("\n");
  const messages = execution.firstProbeMessages;
  const rows = [
    evidence("Events in order: " + JSON.stringify([...setup, question])),
    evidence("Observable reply: " + answer),
    ...messages.map((message: unknown, index: number) =>
      evidence(
        "First eligible request message " +
          (index + 1) +
          ": " +
          JSON.stringify(message),
      ),
    ),
    evidence("Capture coverage: " + execution.probeCoverage),
    evidence("Observed effects: " + JSON.stringify(last.effects)),
  ];
  return {
    packet: {
      rubric: scoringRubric(goReader, goVisibilityVersion),
      assertions: ["natural_access"],
      evidence: rows,
    },
    expected: control ? (control === "good" ? "PASS" : "FAIL") : undefined,
    answer,
  };
}
function fixtureReply(packet: any, key?: any[], answer?: string) {
  const header = { packet_sha256: sha(gradeJSONBytes(packet)), judge: named };
  if (key)
    return {
      ...header,
      labels: key.map((k) => ({ id: k.id, verdict: k.expected })),
    };
  const valid = answer?.includes("REED-843");
  return {
    ...header,
    visibility: packet.evidence.some(
      (row: any) =>
        row.text.startsWith("First eligible request message") &&
        row.text.includes("REED-843"),
    )
      ? "RESIDENT"
      : "OPAQUE",
    visibility_evidence: [
      (
        packet.evidence.find(
          (row: any) =>
            row.text.startsWith("First eligible request message") &&
            row.text.includes("REED-843"),
        ) ??
        packet.evidence.find((row: any) =>
          row.text.startsWith("Capture coverage:"),
        )
      ).id,
    ],
    assertions: [
      {
        assertion: "natural_access",
        verdict: valid ? "PASS" : "FAIL",
        rationale: "Scripted protocol control",
        evidence: [packet.evidence[1].id],
      },
    ],
  };
}
export function mockStream(raw: string) {
  const chunk = (delta: any, finish: string | null, usage?: any) =>
    "data: " +
    JSON.stringify({
      id: "mock",
      object: "chat.completion.chunk",
      created: 1,
      model: goReaderPolicy.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      usage,
    }) +
    "\n\n";
  return (
    chunk({ role: "assistant", content: raw }, null) +
    chunk({}, "stop", {
      prompt_tokens: 5,
      completion_tokens: 5,
      total_tokens: 10,
    }) +
    "data: [DONE]\n\n"
  );
}
export function providerContent(sse: string) {
  let text = "";
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const delta = JSON.parse(data).choices?.find(
      (choice: any) => choice.index === 0,
    )?.delta;
    if (typeof delta?.content === "string") text += delta.content;
  }
  return text;
}
export async function nativeTurn(
  directory: string,
  query: string,
  dispatch: (wire: any) => Promise<string>,
  timeout: number,
) {
  const hermes = process.env.BENCHMARK_HERMES_ROOT;
  requireThat(
    hermes && path.isAbsolute(hermes),
    "Set BENCHMARK_HERMES_ROOT to the supported Hermes checkout",
  );
  const py =
    process.env.BENCHMARK_HERMES_PYTHON ?? path.join(hermes, "venv/bin/python");
  requireThat(fs.existsSync(py), "Hermes venv missing");
  const home = path.join(directory, "reader-home");
  dir(home);
  const log = fs.openSync(path.join(directory, "reader.stderr"), "wx", 0o600);
  const proc = spawn(
    py,
    [
      "-I",
      path.join(repository, "test_case/online/benchmark/operator/reader.py"),
    ],
    {
      cwd: home,
      env: {
        HOME: home,
        HERMES_HOME: home,
        HERMES_SAFE_MODE: "1",
        HERMES_IGNORE_RULES: "1",
        HERMES_IGNORE_USER_CONFIG: "1",
        HERMES_DISABLE_PLUGINS: "1",
        HERMES_DISABLE_MCP: "1",
        HERMES_STREAM_RETRIES: "0",
        HERMES_DISABLE_LAZY_INSTALLS: "1",
        PATH: "/usr/bin:/bin:/opt/homebrew/bin",
        LANG: "en_US.UTF-8",
      },
      stdio: ["pipe", "pipe", log],
    },
  );
  fs.closeSync(log);
  const closed = new Promise<number | null>((resolve, reject) => {
    proc.once("error", reject);
    proc.once("close", resolve);
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
  let wire: any,
    result: any,
    providerText = "";
  try {
    proc.stdin!.write(JSON.stringify({ hermes, query }) + "\n");
    for await (const line of readline.createInterface({
      input: proc.stdout!,
    })) {
      const event = JSON.parse(line);
      if (event.type === "wire") {
        requireThat(
          !wire && event.sha256 === sha(event.body),
          "Duplicate or damaged reader wire",
        );
        wire = event;
        save(path.join(directory, "wire.json"), wire);
        const sse = await dispatch(wire);
        providerText = providerContent(sse);
        save(path.join(directory, "provider-content.json"), {
          raw: providerText,
          wire: wire.sha256,
          responseStream: sha(sse),
        });
        proc.stdin!.end(JSON.stringify({ sse }) + "\n");
      } else {
        requireThat(
          event.type === "result" &&
            wire &&
            event.wire === wire.sha256 &&
            !result,
          "Invalid Hermes receipt",
        );
        result = event;
      }
    }
    requireThat(
      (await closed) === 0 && result && result.session === wire.session,
      "Hermes did not produce a complete receipt; see reader.stderr",
    );
    requireThat(
      providerText.length > 0 && result.raw.trim() === providerText.trim(),
      "Native reader text differs from the first provider response",
    );
    return { ...result, providerContent: sha(providerText) };
  } finally {
    clearTimeout(timer);
    proc.kill();
    await closed;
  }
}
async function grade(
  root: string,
  m: any,
  folder: string,
  packet: any,
  key?: any[],
  answer?: string,
) {
  requireThat(
    process.env.BENCHMARK_DISABLE_JUDGE !== "1",
    "Judge disabled by operator",
  );
  dir(folder);
  const query = admittedReaderQuery(packet);
  save(path.join(folder, "input.json"), { packet, query, digest: sha(query) });
  let raw: string;
  if (m.config.judge === "fixture") {
    raw = JSON.stringify(fixtureReply(packet, key, answer));
    save(path.join(folder, "response.json"), { raw, mode: "FIXTURE" });
  } else {
    const response = await nativeTurn(
      folder,
      query,
      (w) =>
        send(root, m, "judge", w.body, {
          "x-opencode-session": w.session,
          "user-agent": w.userAgent,
        }),
      m.config.timeoutSeconds * 1000,
    );
    save(path.join(folder, "response.json"), response);
    raw = response.raw;
  }
  return validateJudgeReply(raw, packet, key);
}
export function validateJudgeReply(raw: string, packet: any, key?: any[]) {
  const mark = JSON.parse(
    raw
      .trim()
      .replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i, "$1"),
  );
  requireThat(
    matchesReader(mark, sha(gradeJSONBytes(packet)), goReader),
    "Judge identity or packet mismatch",
  );
  if (key) {
    requireThat(
      mark.labels?.length === key.length &&
        key.length === 28 &&
        key.every(
          (k) =>
            mark.labels.filter(
              (l: any) => l.id === k.id && l.verdict === k.expected,
            ).length === 1,
        ),
      "28-item calibration failed",
    );
  } else {
    const ids = new Set(packet.evidence.map((r: any) => r.id));
    const refs = (v: any) =>
      Array.isArray(v) && v.length > 0 && v.every((x) => ids.has(x));
    const visibilityIds = new Set(
      packet.evidence
        .filter((row: any) =>
          row.text.startsWith(
            mark.visibility === "RESIDENT"
              ? "First eligible request message"
              : "Capture coverage:",
          ),
        )
        .map((r: any) => r.id),
    );
    requireThat(
      refs(mark.visibility_evidence) &&
        mark.visibility_evidence.every((id: string) => visibilityIds.has(id)),
      "Visibility must cite the first request or capture coverage",
    );
    const a = mark.assertions?.[0];
    requireThat(
      mark.assertions.length === 1 &&
        a.assertion === "natural_access" &&
        ["PASS", "FAIL", "UNRESOLVED", "NOT_TESTED"].includes(a.verdict) &&
        typeof a.rationale === "string" &&
        a.rationale.trim() &&
        refs(a.evidence) &&
        ["RESIDENT", "COLD", "OPAQUE"].includes(mark.visibility) &&
        refs(mark.visibility_evidence),
      "Invalid semantic judgement or evidence references",
    );
  }
  return mark;
}
export async function gradeExecution(root: string, regrade: boolean) {
  const execution = openSeal(path.join(root, "execution.json")),
    m = execution.manifest;
  const id = regrade ? randomUUID() : "original",
    folder = path.join(root, "grades", id);
  dir(folder);
  const calRoot = path.join(root, "calibrations");
  dir(calRoot);
  const prior = fs
    .readdirSync(calRoot)
    .map((name) => path.join(calRoot, name, "receipt.json"))
    .filter((file) => fs.existsSync(file))
    .map(openSeal)
    .filter((c) => c.manifest === bound(m))
    .sort((a, b) => b.at - a.at);
  let calibration = prior[0];
  if (!calibration || Date.now() - calibration.at >= 24 * 3600e3) {
    if (m.config.judge === "hermes-go") {
      requireThat(
        (await remainingJudgeCalls(m, execution.id)) >= 4,
        "Fresh calibration and candidate require four authorized judge calls",
      );
    }
    const c = targetedControls(),
      prefix = path.join(root, "calibrations", randomUUID());
    await grade(root, m, path.join(prefix, "calibration"), c.packet, c.key);
    for (const control of ["good", "bad"] as const) {
      const p = candidate(execution, control);
      const mark = await grade(
        root,
        m,
        path.join(prefix, control),
        p.packet,
        undefined,
        p.answer,
      );
      requireThat(
        mark.assertions[0].verdict === p.expected,
        "Case-shape discrimination control failed: " + control,
      );
    }
    const sources: Record<string, string> = {};
    for (const stage of ["calibration", "good", "bad"]) {
      for (const name of [
        "input.json",
        "response.json",
        ...(m.config.judge === "hermes-go"
          ? ["wire.json", "provider-content.json"]
          : []),
      ]) {
        const key = stage + "/" + name;
        sources[key] = sha(fs.readFileSync(path.join(prefix, key)));
      }
    }
    calibration = {
      sources,
      manifest: bound(m),
      at: Date.now(),
      source: path.relative(root, prefix),
      controls: 28,
      caseControls: 2,
      judge: m.config.judge,
    };
    seal(path.join(prefix, "receipt.json"), calibration);
  }
  requireThat(
    calibration.manifest === bound(m) &&
      Date.now() - calibration.at < 24 * 3600e3,
    "Stale or incompatible calibration",
  );
  for (const [file, digest] of Object.entries(calibration.sources)) {
    requireThat(
      sha(fs.readFileSync(path.join(root, calibration.source, file))) ===
        digest,
      "Calibration evidence changed",
    );
  }
  const openSealOrLoad = (name: string) =>
    JSON.parse(fs.readFileSync(path.join(folder, name), "utf8"));
  const p = candidate(execution),
    mark = await grade(root, m, folder, p.packet, undefined, p.answer);
  seal(path.join(folder, "grade.json"), {
    response: bound(openSealOrLoad("response.json")),
    input: bound(openSealOrLoad("input.json")),
    id,
    canonical: !regrade,
    calibration: bound(calibration),
    execution: bound(execution),
    mark,
  });
  return id;
}
