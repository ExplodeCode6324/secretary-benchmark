import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  repository,
  processIdentity,
  processStatus,
  requireThat,
  sha,
  writeJSON,
  lease,
  noLinks,
} from "../io.ts";
import {
  newDatabase,
  initializeDatabase,
  startDatabase,
  createDatabase,
  coreDSN,
  verifyDatabase,
  stopDatabase,
  pgRunning,
  controlID,
} from "../postgres.ts";
import { goReaderPolicy } from "../stage-c-visibility-rubric.ts";
import { gradeJSONBytes, gradeUUID } from "../grading-transaction.ts";
import { startTarget } from "./sandbox.ts";
import {
  candidate,
  gradeExecution,
  checkSeriesReader,
  nativeTurn,
  mockStream,
} from "./grading.ts";
import {
  bound,
  config,
  dir,
  load,
  manifest,
  openSeal,
  put,
  rootFor,
  save,
  seal,
  verifyApproval,
  verifyJudgeSource,
} from "./files.ts";
import {
  accountDirectory,
  checkRoute,
  claim,
  claimHistory,
  gateway,
  credential,
  reconcile,
} from "./transport.ts";
import { admittedReaderQuery } from "../stage-c-visibility-rubric.ts";

import { Domains } from "../domain.ts";
import {
  archiveConfiguration,
  archiveFacility,
  assertArchiveTargetExternal,
} from "../archive.ts";
import {
  verifySeriesPlan,
  seriesRecord,
  seriesMarkdown,
  rescoreAgreement,
  recoveredOutcomes,
  qualificationSummary,
  sealInterruptedGrade,
} from "./series.ts";
import { eventTexts, questions } from "./questions.ts";
import { pack, verifyBundle } from "./bundle.ts";
function receipts(root: string) {
  const tr = path.join(root, "transport");
  return fs.existsSync(tr)
    ? fs
        .readdirSync(tr)
        .sort()
        .map((f) => ({ name: f, data: load(path.join(tr, f)) }))
    : [];
}
function meter(root: string) {
  return receipts(root)
    .filter((x) => x.name.endsWith(".request.json"))
    .map((req) => {
      const file = path.join(
        root,
        "transport",
        req.name.replace(".request.json", ".response.json"),
      );
      const r = fs.existsSync(file) ? load(file) : null;
      return {
        id: req.name.split(".")[0],
        kind: req.data.kind,
        at: req.data.at,
        wireDigest: req.data.digest,
        settled: r !== null && !r.hold,
        hold: r?.hold ?? null,
        models: r?.models ?? [],
        servedIdentity: r?.billing?.identity ?? null,
        reportedVersion: r?.billing?.identity?.version ?? null,
        billingSource: r?.billing?.billing_source ?? null,
        usage: r?.usage ?? null,
        cost: r?.billing?.list_cost ?? null,
        cash: r?.billing?.cash_debit_usd ?? null,
        elapsedMs: r?.elapsedMs ?? null,
        accountingStatus:
          r?.accountingStatus ??
          (r?.billing?.list_cost == null ? "UNKNOWN" : "REPORTED"),
        unknownExposure:
          r && !r.hold && r.billing?.list_cost != null ? 0 : req.data.ceiling,
      };
    });
}
function writeReport(root: string, id: string, output?: string) {
  requireThat(id === "original" || gradeUUID(id), "Invalid grade ID");
  const gradePath = path.join(root, "grades", id, "grade.json");
  if (
    id === "original" &&
    (!fs.existsSync(gradePath) ||
      !fs.existsSync(path.join(root, "grades/original/accounting.json")))
  ) {
    requireThat(
      fs.existsSync(path.join(root, "incomplete.json")),
      "Original measurement is not published; recover an interrupted run first",
    );
    return incomplete(root, output);
  }
  const run = openSeal(path.join(root, "execution.json"));
  const g = openSeal(gradePath);
  for (const key of run.manifest.suite.timeline ? [] : ["input", "response"])
    requireThat(
      g[key] === bound(load(path.join(root, "grades", id, key + ".json"))),
      "Grade evidence mismatch",
    );
  requireThat(
    g.execution === bound(run) &&
      g.id === id &&
      g.canonical === (id === "original"),
    "Grade does not match sealed execution",
  );
  const summary = openSeal(path.join(root, "grades", id, "accounting.json"));
  requireThat(
    summary.grade === bound(g),
    "Accounting does not match sealed grade",
  );
  if (run.manifest.suite.timeline) {
    const r = seriesRecord(run, g, summary, path.dirname(gradePath));
    if (run.manifest.config.judgeProtocol && id !== "original") {
      const originalDir = path.join(root, "grades", "original");
      const originalGrade = openSeal(path.join(originalDir, "grade.json"));
      const account = openSeal(path.join(originalDir, "accounting.json"));
      requireThat(
        originalGrade.execution === bound(run) &&
          account.grade === bound(originalGrade),
        "Diagnostic baseline mismatch",
      );
      const original = seriesRecord(run, originalGrade, account, originalDir);
      Object.assign(r, {
        judgeRescoreAgreement: rescoreAgreement(
          original.questions,
          r.questions,
        ),
      });
    }
    const out =
      output ?? path.join(root, "reports", ...(id === "original" ? [] : [id]));
    emitReports(out, r, seriesMarkdown(r));
    return {
      run: run.id,
      grade: id,
      status: r.status,
      counts: r.counts,
      report: path.join(out, "report.md"),
      json: path.join(out, "report.json"),
    };
  }
  const orig =
    id === "original"
      ? g
      : fs.existsSync(path.join(root, "grades/original/grade.json"))
        ? openSeal(path.join(root, "grades/original/grade.json"))
        : null;
  const a = g.mark.assertions[0];
  const record = {
    schema: 1,
    run: run.id,
    case: run.manifest.config.case,
    mode: run.manifest.config.workload,
    config: run.manifest.config,
    harness: run.manifest.source,
    sut: run.manifest.sut.commit,
    rubric: run.manifest.judgePolicy,
    target: run.manifest.config.target,
    workModel: run.manifest.workModel,
    workEffort: run.manifest.workEffort,
    judgeModel: run.manifest.judgeModel,
    judgeEffort: run.manifest.effort,
    execution: bound(run),
    grade: id,
    canonical: g.canonical,
    verdict: a.verdict,
    reason: a.rationale,
    evidence: a.evidence,
    visibility: g.mark.visibility,
    disagreement: orig ? a.verdict !== orig.mark.assertions[0].verdict : null,
    coverage: { planned: 1, executed: 1, graded: 1 },
    events: run.events.length,
    effects: run.events.at(-1).effects,
    firstFailures: summary.failures,
    executionMs: run.durationMs,
    requests: summary.requests,
    claimHistory: summary.claimHistory,
    scoringEvidence: {
      calibration: g.calibration,
      input: g.input,
      response: g.response,
    },
    publishedAt: summary.at,
    catalogueVersion: run.manifest.publishedModel,
    unsupported: ["cold retrieval", "process restart", "native comparator"],
    productUsability: "NOT_TESTED",
  };
  const md = [
    "# Secretary benchmark",
    "",
    "| Item | Result |",
    "|---|---|",
    ...Object.entries({
      Run: record.run,
      Case: record.case,
      Mode: record.mode,
      Grade: id,
      Canonical: g.canonical,
      Verdict: a.verdict,
      Visibility: record.visibility,
      "Executed / graded / planned": "1 / 1 / 1",
      "External workload calls": record.requests.filter(
        (r: any) => r.kind === "workload",
      ).length,
      "External judge calls": record.requests.filter(
        (r: any) => r.kind === "judge",
      ).length,
      "Requests with incomplete billing": record.requests.filter(
        (r: any) => r.accountingStatus === "UNKNOWN",
      ).length,
      "Known list cost (USD)": record.requests.reduce(
        (sum: number, r: any) => sum + (r.cost ?? 0),
        0,
      ),
      "Unknown exposure (USD)": record.requests.some(
        (r: any) => r.unknownExposure === null,
      )
        ? "UNKNOWN"
        : record.requests.reduce(
            (sum: number, r: any) => sum + r.unknownExposure,
            0,
          ),
      "Execution (ms)": run.durationMs,
    }).map(([k, v]) => "| " + k + " | " + v + " |"),
    "",
    a.rationale,
    "",
    "Evidence IDs: " + a.evidence.join(", "),
    "",
  ].join("\n");
  const dest =
    output ?? path.join(root, "reports", ...(id === "original" ? [] : [id]));
  emitReports(dest, record, md);
  return {
    run: run.id,
    grade: id,
    verdict: a.verdict,
    report: path.join(dest, "report.md"),
    json: path.join(dest, "report.json"),
  };
}
function emitReports(dest: string, record: unknown, md: string) {
  dir(dest);
  for (const [name, bytes] of [
    ["report.json", gradeJSONBytes(record)],
    ["report.md", Buffer.from(md)],
  ] as const) {
    const file = path.join(dest, name);
    noLinks(file);
    if (fs.existsSync(file))
      requireThat(
        fs.readFileSync(file).equals(bytes),
        "Canonical report bytes differ",
      );
    else put(file, bytes);
  }
}
function incomplete(
  root: string,
  output?: string,
  history?: Awaited<ReturnType<typeof claimHistory>>,
) {
  const file = path.join(root, "incomplete.json");
  if (!fs.existsSync(file)) {
    const m = openSeal(path.join(root, "manifest.json")),
      hasRun = fs.existsSync(path.join(root, "execution.json"));
    const failures = path.join(root, "failures");
    const execution = hasRun
      ? openSeal(path.join(root, "execution.json"))
      : { manifest: m, events: [] };
    const rows = m.suite.timeline
      ? recoveredOutcomes(execution, path.join(root, "grades/original"))
      : undefined;
    seal(file, {
      run: path.basename(root),
      case: m.config.case,
      status:
        hasRun && !openSeal(path.join(root, "execution.json")).partial
          ? "UNGRADED"
          : "INCOMPLETE",
      claimHistory: history,
      coverage: rows
        ? {
            planned: rows.length,
            executed: rows.filter((row) => row.inputId).length,
            graded: rows.filter((row) =>
              ["PASS", "PARTIAL", "FAIL"].includes(row.verdict),
            ).length,
          }
        : { planned: 1, executed: hasRun ? 1 : 0, graded: 0 },
      recoveryFormat: rows ? 2 : undefined,
      questions: rows,
      firstFailures: fs.existsSync(failures)
        ? fs
            .readdirSync(failures)
            .sort()
            .map((f) => load(path.join(failures, f)))
            .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        : [],
      requests: meter(root),
    });
  }
  const record = openSeal(file),
    out = output ?? path.join(root, "reports");
  dir(out);
  const md = [
    "# Secretary benchmark",
    "",
    record.status,
    "",
    ...(record.recoveryFormat === 2 ? record.questions : []).map(
      (row: any) =>
        row.id + " · " + row.verdict + (row.reason ? " · " + row.reason : ""),
    ),
    ...record.firstFailures.map((f: any) => f.error),
    "",
  ].join("\n");
  for (const [name, bytes] of [
    ["report.json", gradeJSONBytes(record)],
    ["report.md", Buffer.from(md)],
  ] as const) {
    const dest = path.join(out, name);
    if (fs.existsSync(dest))
      requireThat(
        fs.readFileSync(dest).equals(bytes),
        "Incomplete report changed",
      );
    else put(dest, bytes);
  }
  return {
    run: record.run,
    status: record.status,
    report: path.join(out, "report.md"),
    json: path.join(out, "report.json"),
  };
}
async function publishIncomplete(root: string) {
  const m = openSeal(path.join(root, "manifest.json"));
  return incomplete(
    root,
    undefined,
    await claimHistory(m, path.basename(root)),
  );
}
async function assess(root: string, again: boolean) {
  return publishGrade(root, await gradeExecution(root, again));
}
async function publishGrade(root: string, id: string) {
  const folder = path.join(root, "grades", id),
    grade = openSeal(path.join(folder, "grade.json"));
  const execution = openSeal(path.join(root, "execution.json"));
  const failures = path.join(root, "failures");
  seal(path.join(folder, "accounting.json"), {
    grade: bound(grade),
    claimHistory: await claimHistory(execution.manifest, execution.id),
    ...(execution.manifest.suite.timeline
      ? {
          publisher: execFileSync(
            "git",
            ["-C", repository, "rev-parse", "HEAD"],
            { encoding: "utf8" },
          ).trim(),
          publisherTrackedDirty:
            execFileSync(
              "git",
              [
                "-C",
                repository,
                "status",
                "--porcelain",
                "--untracked-files=no",
                "--ignore-submodules=untracked",
              ],
              { encoding: "utf8" },
            ).trim() !== "",
          qualification: qualificationSummary(root, folder),
        }
      : {}),
    at: new Date().toISOString(),
    requests: meter(root),
    failures: fs.existsSync(failures)
      ? fs
          .readdirSync(failures)
          .sort()
          .map((f) => load(path.join(failures, f)))
          .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      : [],
  });
  return writeReport(root, id);
}
async function finishRecovery(root: string, m: any, approval?: string) {
  const original = path.join(root, "grades/original");
  if (fs.existsSync(path.join(original, "accounting.json")))
    return writeReport(root, "original");
  if (
    fs.existsSync(path.join(root, "incomplete.json")) ||
    !m.suite.timeline ||
    !fs.existsSync(path.join(root, "execution.json"))
  )
    return publishIncomplete(root);
  if (!fs.existsSync(path.join(original, "grade.json"))) {
    if (!fs.existsSync(path.join(original, "plan.json"))) {
      verifyApproval(m, approval);
      verifyJudgeSource(m);
      return assess(root, false);
    }
    sealInterruptedGrade(openSeal(path.join(root, "execution.json")), original);
  }
  return publishGrade(root, "original");
}
function clearTargetAliases(root: string) {
  const target = path.join(root, "target");
  noLinks(target);
  for (const [name, file] of [
    ["alias", "private-canary"],
    ["reference-alias", "references.json"],
  ]) {
    const link = path.join(target, name);
    if (
      fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() &&
      fs.readlinkSync(link) === path.join(root, file)
    )
      fs.unlinkSync(link);
  }
}
export function sealPrefix(root: string, m: any) {
  const started = openSeal(path.join(root, "series-started.json")),
    events = [];
  requireThat(
    started.manifest === bound(m) && started.id === path.basename(root),
    "Series ownership mismatch",
  );
  const texts = eventTexts(m.suite);
  for (let i = 0; i < texts.length; i++) {
    const prefix = path.join(root, "events", String(i));
    if (!fs.existsSync(prefix + ".ack.json")) break;
    const ack = openSeal(prefix + ".ack.json"),
      input = load(prefix + ".input.json"),
      observation = load(prefix + ".observation.json");
    requireThat(
      ack.sequence === i + 1 &&
        ack.input === bound(input) &&
        ack.observation === bound(observation) &&
        input.text === texts[i] &&
        input.id === observation.id &&
        ack.inputId === observation.inputId,
      "Invalid acknowledged prefix",
    );
    events.push(observation);
  }
  seal(path.join(root, "execution.json"), {
    schema: 2,
    id: started.id,
    manifest: m,
    events,
    partial: true,
    durationMs: Date.now() - started.at,
  });
}
async function execute(
  root: string,
  m: any,
  approved?: string,
  configPath?: string,
) {
  const start = Date.now(),
    id = path.basename(root),
    work = path.join(root, "target");
  dir(work);
  const sentinel = randomUUID(),
    privateFile = path.join(root, "private-canary"),
    alias = path.join(work, "alias"),
    control = randomUUID();
  put(privateFile, Buffer.from(sentinel));
  put(path.join(work, "control"), Buffer.from(control));
  fs.symlinkSync(privateFile, alias);
  const c = m.config;
  const denied = [privateFile, alias];
  let referenceCanary: string | undefined;
  if (m.suite.timeline) {
    referenceCanary = randomUUID();
    const ref = path.join(root, "references.json");
    seal(ref, {
      canary: referenceCanary,
      references: questions(m.suite, []).map((q) => q.item),
    });
    const otherAlias = path.join(work, "reference-alias");
    fs.symlinkSync(ref, otherAlias);
    denied.push(ref, otherAlias, path.resolve(configPath!));
  }
  const db =
    c.target === "secretary"
      ? await newDatabase(path.join(root, "pg/data"))
      : undefined;
  const signal = new AbortController();
  let gate: Awaited<ReturnType<typeof gateway>> | undefined,
    target: ReturnType<typeof startTarget> | undefined;
  try {
    if (db) {
      initializeDatabase(db);
      seal(path.join(root, "ownership.json"), {
        id,
        directory: db.directory,
        systemID: db.systemID,
      });
      seal(path.join(root, "pg", "recovery.json"), db);
      startDatabase(db);
      await createDatabase(db);
      await verifyDatabase(db);
    }
    if (c.workload === "wire-rehearsal") {
      gate = await gateway(root, m, signal.signal, () =>
        mockStream("REED-843"),
      );
    } else if (c.workload === "opencode-go") {
      const rehearsal = path.join(root, "preflight");
      dir(rehearsal);
      await nativeTurn(
        rehearsal,
        "Reply with OK.",
        async () => mockStream("OK"),
        120000,
      );
      verifyApproval(m, approved);
      credential("workload");
      credential("judge");
      const route = await checkRoute(c.billingPolicy === "record-only");
      save(path.join(root, "route.json"), route);
      gate = await gateway(root, m, signal.signal);
    }
    target = startTarget(
      work,
      [...(db ? [db.port] : []), ...(gate ? [gate.port] : [])],
      c.timeoutSeconds * 1000,
    );
    const cap = await target.call("capabilities");
    requireThat(target.pid, "Missing owned target PID");
    seal(
      path.join(root, "worker.json"),
      processIdentity(target.pid, target.token),
    );
    requireThat(
      cap.protocol === 1 &&
        ["start", "deliver", "observe", "export", "stop"].every((k) =>
          cap.commands.includes(k),
        ),
      "Target capability mismatch",
    );
    const ready = await target.call("start", {
      target: c.target,
      questionSeries: !!m.suite.timeline,
      workload: c.workload,
      control,
      denied,
      dsn: db ? coreDSN(db) : null,
      gateway: gate?.url,
      capability: gate?.capability,
    });
    requireThat(
      ready.ready && ready.denied === denied.length,
      "Target isolation preflight failed",
    );
    if (c.workload === "opencode-go") await claim(m, id);
    if (m.suite.timeline)
      seal(path.join(root, "series-started.json"), {
        id,
        manifest: bound(m),
        at: start,
      });
    const captured = () =>
      c.workload === "wire-rehearsal"
        ? fs
            .readdirSync(path.join(root, "mock-wires"), { withFileTypes: true })
            .map((f) => ({
              name: f.name,
              data: load(path.join(root, "mock-wires", f.name)),
            }))
        : receipts(root).filter((x) => x.name.endsWith(".request.json"));
    if (c.workload === "wire-rehearsal") dir(path.join(root, "mock-wires"));
    const texts = eventTexts(m.suite),
      events: any[] = [];
    let probeBefore = new Set<string>();
    for (const [i, text] of texts.entries()) {
      const blocked = [
        sentinel,
        ...(referenceCanary ? [referenceCanary] : []),
        ...texts
          .slice(i + 1)
          .filter(
            (future) =>
              !texts
                .slice(0, i + 1)
                .some((delivered) => delivered.includes(future)),
          ),
      ];
      writeJSON(
        path.join(root, "guard.json"),
        m.suite.timeline ? { sequence: i + 1, blocked } : blocked,
      );
      if (!m.suite.timeline && i === texts.length - 1)
        probeBefore = new Set(captured().map((x) => x.name));
      const event = { id: randomUUID(), sequence: i + 1, text };
      save(path.join(root, "events", String(i) + ".input.json"), event);
      const ack = await target.call("deliver", event),
        value = await target.call("observe");
      requireThat(
        ack.id === event.id &&
          value.id === ack.id &&
          value.sequence === i + 1 &&
          ack.inputId === value.inputId,
        "Missing normal-entry acknowledgement",
      );
      save(path.join(root, "events", String(i) + ".observation.json"), value);
      if (m.suite.timeline)
        seal(path.join(root, "events", String(i) + ".ack.json"), {
          sequence: i + 1,
          input: bound(event),
          observation: bound(value),
          inputId: value.inputId,
        });
      events.push(value);
    }
    requireThat(
      bound(await target.call("export")) === bound(events),
      "Target export differs from observations",
    );
    requireThat(
      m.suite.timeline ||
        events.at(-1).messages.some((r: any) => r.text?.trim()),
      "Missing observable final answer",
    );
    requireThat(
      !fs.existsSync(path.join(root, "failures")),
      "Target transport failed; inspect the first dispatch failure",
    );
    const wire = m.suite.timeline
      ? undefined
      : captured()
          .filter((x) => !probeBefore.has(x.name))
          .sort((a, b) => a.data.at.localeCompare(b.data.at))[0];
    if (!m.suite.timeline && c.workload === "opencode-go")
      requireThat(
        wire && wire.data.kind === "workload",
        "Missing first probe wire",
      );
    const firstProbeMessages = m.suite.timeline
      ? undefined
      : (wire?.data.body.messages ??
        events.at(-1).calls[0]?.request?.messages ??
        (c.target.startsWith("scripted-")
          ? texts.map((text) => ({ role: "user", content: text }))
          : []));
    const execution = {
      schema: 1,
      id,
      manifest: m,
      events,
      firstProbeMessages,
      probeCoverage: wire
        ? "Wire messages captured; omitted surfaces marked opaque"
        : "offline diagnostic capture",
      durationMs: Date.now() - start,
    };
    requireThat((await target.call("stop")).stopped, "Target did not stop");
    seal(path.join(root, "execution.json"), execution);
  } catch (error) {
    if (
      m.suite.timeline &&
      fs.existsSync(path.join(root, "series-started.json")) &&
      !fs.existsSync(path.join(root, "execution.json"))
    )
      sealPrefix(root, m);
    if (gate?.firstFailure) throw Error(gate.firstFailure);
    throw error;
  } finally {
    signal.abort();
    try {
      if (target) await target.close();
    } finally {
      try {
        if (gate) await gate.close();
      } finally {
        if (db && pgRunning(db)) await stopDatabase(db);
      }
    }
    clearTargetAliases(root);
    seal(path.join(root, "stopped.json"), {
      id,
      at: new Date().toISOString(),
      systemID: db?.systemID ?? null,
    });
  }
}
export async function operatorCommand(command: string, args: string[]) {
  if (command === "operator-help")
    return {
      guide: "docs/operator.md",
      examples: [
        "evaluate --config examples/secretary-smoke.json",
        "freeze --config examples/secretary-live.json",
        "export-run --run UUID --output NEW_DIR",
        "regrade --bundle DIR",
        "report --bundle DIR --grade original",
        "compare --run UUID --reference DIR",
        "archive-run --run UUID",
        "archive-run --run UUID --apply true",
      ],
    };
  const allowed: Record<string, string[]> = {
    evaluate: ["--config", "--approval"],
    freeze: ["--config"],
    report: ["--run", "--bundle", "--grade", "--output"],
    regrade: ["--run", "--bundle", "--approval"],
    compare: ["--run", "--bundle", "--reference"],
    "export-run": ["--run", "--output"],
    "reader-check": ["--run"],
    "archive-run": ["--run", "--apply"],
    "recover-run": ["--run", "--approval"],
    "reconcile-call": [
      "--run",
      "--bundle",
      "--attempt",
      "--evidence",
      "--approval",
    ],
  };
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    requireThat(
      allowed[command]?.includes(args[i]) &&
        args[i + 1] &&
        !Object.hasOwn(options, args[i]),
      "Invalid operator options",
    );
    options[args[i]] = args[i + 1];
  }
  if (command === "evaluate" || command === "freeze") {
    const c = config(options["--config"] ?? "examples/secretary-smoke.json"),
      m = manifest(c);
    if (command === "freeze") {
      const model =
        c.workload === "opencode-go"
          ? await checkRoute(c.billingPolicy === "record-only")
          : null;
      return {
        digest: bound(m),
        ...(c.judgeProtocol
          ? {
              manifestPreview: {
                ...m,
                config: {
                  ...c,
                  controlSuite: {
                    identity: c.controlSuite.identity,
                    sha256: c.controlSuite.sha256,
                    visibility: c.controlSuite.visibility,
                    labelSource: c.controlSuite.labelSource,
                    count: c.controlSuite.items.length,
                  },
                },
                qualificationEvidence: "WITHHELD_FROM_CONSOLE",
              },
            }
          : { manifest: m }),
        publishedModel: model?.published_version ?? null,
        maxTariffEquivalent:
          c.billingPolicy === "record-only"
            ? null
            : c.workload !== "opencode-go"
              ? 0
              : (c.maxWorkloadCalls + c.maxJudgeCalls) *
                goReaderPolicy.request_ceiling_usd_equivalent.candidate,
      };
    }
    if (c.workload === "opencode-go")
      requireThat(
        process.platform === "darwin",
        "Live targets require the verified macOS isolation backend; Linux supports offline fixtures",
      );
    verifyApproval(m, options["--approval"] ?? process.env.BENCHMARK_APPROVAL);
    const id = randomUUID(),
      root = rootFor(id);
    dir(root);
    seal(path.join(root, "manifest.json"), m);
    console.error("Run " + id + " → " + root);
    try {
      return await Domains.use(root, async () => {
        await execute(
          root,
          m,
          options["--approval"] ?? process.env.BENCHMARK_APPROVAL,
          options["--config"] ?? "examples/secretary-smoke.json",
        );
        return assess(root, false);
      });
    } catch (error: any) {
      save(path.join(root, "failures", Date.now() + ".json"), {
        at: new Date().toISOString(),
        error: error.message,
      });
      if (
        c.timeline &&
        fs.existsSync(path.join(root, "stopped.json")) &&
        fs.existsSync(path.join(root, "execution.json")) &&
        !fs.existsSync(path.join(root, "grades", "original"))
      ) {
        const partial = await assess(root, false);
        console.error(JSON.stringify(partial));
        throw error;
      }
      if (c.timeline && fs.existsSync(path.join(root, "execution.json"))) {
        console.error(
          "Original pending. After stopping the facility, use recover-run --run " +
            id,
        );
        throw error;
      }
      const result = await publishIncomplete(root);
      console.error(JSON.stringify(result));
      throw error;
    }
  }
  requireThat(
    Boolean(options["--bundle"]) !== Boolean(options["--run"]),
    "Specify one of --run or --bundle",
  );
  const root = options["--bundle"]
    ? path.resolve(options["--bundle"])
    : rootFor(options["--run"] || "");
  noLinks(root);
  if (command === "reconcile-call") {
    const run = options["--bundle"]
      ? verifyBundle(root).id
      : path.basename(root);
    return reconcile(
      root,
      options["--attempt"] ?? "",
      path.resolve(options["--evidence"] ?? ""),
      options["--approval"] ?? "",
      run,
    );
  }
  if (command === "recover-run") {
    return lease(root, async () => {
      const marker = load(path.join(root, "facility.json"));
      requireThat(
        marker.repository === repository && gradeUUID(marker.nonce),
        "Unknown facility",
      );
      const m = openSeal(path.join(root, "manifest.json"));
      const sealRecoveredPrefix = () => {
        if (
          m.suite.timeline &&
          fs.existsSync(path.join(root, "series-started.json")) &&
          !fs.existsSync(path.join(root, "execution.json"))
        )
          sealPrefix(root, m);
      };
      if (fs.existsSync(path.join(root, "stopped.json"))) {
        clearTargetAliases(root);
        sealRecoveredPrefix();
        return finishRecovery(
          root,
          m,
          options["--approval"] ?? process.env.BENCHMARK_APPROVAL,
        );
      }
      const workerFile = path.join(root, "worker.json");
      if (fs.existsSync(workerFile)) {
        const worker = openSeal(workerFile);
        requireThat(
          processStatus(worker) === "STOPPED",
          "Owned target has not confirmed exit",
        );
        try {
          process.kill(-worker.pgid, 0);
          throw Error("Owned target process group is still present");
        } catch (e: any) {
          if (e.code !== "ESRCH") throw e;
        }
      }
      let systemID;
      if (m.config.target === "secretary") {
        const owner = openSeal(path.join(root, "ownership.json")),
          db = openSeal(path.join(root, "pg/recovery.json"));
        requireThat(
          owner.id === path.basename(root) &&
            db.directory === path.join(root, "pg/data") &&
            owner.directory === db.directory &&
            owner.systemID === db.systemID &&
            controlID(db) === db.systemID,
          "PG ownership mismatch",
        );
        await stopDatabase(db);
        systemID = db.systemID;
      }
      sealRecoveredPrefix();
      clearTargetAliases(root);
      seal(path.join(root, "stopped.json"), {
        id: path.basename(root),
        systemID,
        at: new Date().toISOString(),
      });
      save(path.join(root, "failures", randomUUID() + ".json"), {
        at: new Date().toISOString(),
        error: "Interrupted execution; owned facility recovered",
      });
      return finishRecovery(
        root,
        m,
        options["--approval"] ?? process.env.BENCHMARK_APPROVAL,
      );
    });
  }
  if (command === "archive-run") {
    requireThat(
      options["--run"] &&
        !options["--bundle"] &&
        (options["--apply"] === undefined || options["--apply"] === "true"),
      "Use archive-run --run UUID [--apply true]",
    );
    const dest = archiveConfiguration();
    assertArchiveTargetExternal(root, dest.destination, dest.mount);
    return archiveFacility(
      root,
      dest.destination,
      options["--apply"] === "true",
    );
  }
  if (options["--bundle"]) verifyBundle(root);
  if (command === "export-run") {
    requireThat(
      options["--output"],
      "Supply --output with a new bundle directory",
    );
    return await lease(root, async () =>
      pack(root, path.resolve(options["--output"])),
    );
  }
  if (command === "report")
    return writeReport(
      root,
      options["--grade"] ?? "original",
      options["--output"] ? path.resolve(options["--output"]) : undefined,
    );
  if (command === "compare") {
    const other = path.resolve(options["--reference"] ?? "");
    noLinks(other);
    verifyBundle(other);
    const x = openSeal(path.join(root, "execution.json")),
      y = openSeal(path.join(other, "execution.json"));
    const grade = (r: string) => {
      const g = openSeal(path.join(r, "grades/original/grade.json"));
      requireThat(
        g.execution === bound(openSeal(path.join(r, "execution.json"))),
        "Reference mismatch",
      );
      return g.mark.assertions[0].verdict;
    };
    if (x.manifest.suite.timeline || y.manifest.suite.timeline) {
      requireThat(
        x.manifest.suite.timeline && y.manifest.suite.timeline,
        "Incompatible scoring policies",
      );
      const records = [root, other].map((dir, i) => {
        const folder = path.join(dir, "grades", "original");
        if (!fs.existsSync(path.join(folder, "accounting.json"))) {
          const incomplete = openSeal(path.join(dir, "incomplete.json"));
          return {
            questions: incomplete.questions,
            coverage: incomplete.coverage,
          };
        }
        const g = openSeal(path.join(folder, "grade.json")),
          accounting = openSeal(path.join(folder, "accounting.json"));
        requireThat(
          g.execution === bound([x, y][i]) &&
            accounting.grade === bound(g) &&
            g.canonical &&
            g.id === "original",
          "Series reference mismatch",
        );
        return seriesRecord([x, y][i], g, accounting, folder);
      });
      const ids = [
        ...new Set(records.flatMap((r) => r.questions.map((q: any) => q.id))),
      ];
      return {
        sameContract: bound(x.manifest) === bound(y.manifest),
        sameCase:
          bound([x.manifest.config.caseVersion, x.manifest.suite]) ===
          bound([y.manifest.config.caseVersion, y.manifest.suite]),
        samePrompt:
          x.manifest.judgePolicy === y.manifest.judgePolicy &&
          x.manifest.implementation[
            x.manifest.config.judgeProtocol
              ? "fact-grading-v2.txt"
              : "fact-grading-v1.txt"
          ] ===
            y.manifest.implementation[
              y.manifest.config.judgeProtocol
                ? "fact-grading-v2.txt"
                : "fact-grading-v1.txt"
            ],
        coverage: records.map((r) => r.coverage),
        questions: ids.map((id) => {
          const referenceDigests = [x, y].map((e) => {
            const q = questions(e.manifest.suite, []).find(
              ({ item }) => item.question_id === id,
            )?.item;
            return q
              ? bound(
                  q.atomic
                    ? [q.question, q.atomic]
                    : [q.question, q.abstention_policy, q.reference_facts],
                )
              : null;
          });
          return {
            id,
            referenceDigests,
            sameReference:
              referenceDigests[0] !== null &&
              referenceDigests[0] === referenceDigests[1],
            verdicts: records.map(
              (r) =>
                r.questions.find((q: any) => q.id === id)?.verdict ??
                "NOT_IN_PACKAGE",
            ),
          };
        }),
      };
    }
    return {
      verdicts: [grade(root), grade(other)],
      sameContract: bound(x.manifest) === bound(y.manifest),
      note: "Verify served identity and resource conditions before pooling.",
    };
  }
  requireThat(
    !options["--bundle"] || command === "regrade",
    "Unsupported bundle operation",
  );
  const e = openSeal(path.join(root, "execution.json"));
  if (command === "reader-check") {
    if (e.manifest.suite.timeline) return checkSeriesReader(root, e);
    const q = admittedReaderQuery(candidate(e, "good").packet),
      folder = path.join(root, "reader-check", randomUUID());
    dir(folder);
    const r = await nativeTurn(
      folder,
      q,
      async () => mockStream('{"fixture":true}'),
      120000,
    );
    requireThat(
      JSON.parse(r.raw).fixture === true,
      "Native reader rehearsal failed",
    );
    return {
      externalCalls: 0,
      release: r.release,
      runtime: r.runtime,
      wire: r.wire,
    };
  }
  requireThat(command === "regrade", "Unknown operator command");
  verifyApproval(
    e.manifest,
    options["--approval"] ?? process.env.BENCHMARK_APPROVAL,
  );
  verifyJudgeSource(e.manifest);
  if (
    e.manifest.suite.timeline &&
    fs.existsSync(path.join(root, "grades/original/plan.json"))
  )
    verifySeriesPlan(path.join(root, "grades/original"), e);
  try {
    return await lease(root, async () => assess(root, true));
  } catch (error: any) {
    save(path.join(root, "failures", Date.now() + ".json"), {
      at: new Date().toISOString(),
      error: error.message,
    });
    throw error;
  }
}
