import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  repository,
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
        unknownExposure: r && !r.hold ? 0 : req.data.ceiling,
      };
    });
}
function writeReport(root: string, id: string, output?: string) {
  requireThat(id === "original" || gradeUUID(id), "Invalid grade ID");
  const gradePath = path.join(root, "grades", id, "grade.json");
  if (id === "original" && !fs.existsSync(gradePath))
    return incomplete(root, output);
  const run = openSeal(path.join(root, "execution.json"));
  const g = openSeal(gradePath);
  for (const key of ["input", "response"])
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
    scoringEvidence: {
      calibration: g.calibration,
      input: g.input,
      response: g.response,
    },
    publishedAt: summary.at,
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
      "Known list cost (USD)": record.requests.reduce(
        (sum: number, r: any) => sum + (r.cost ?? 0),
        0,
      ),
      "Unknown exposure (USD)": record.requests.reduce(
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
  return {
    run: run.id,
    grade: id,
    verdict: a.verdict,
    report: path.join(dest, "report.md"),
    json: path.join(dest, "report.json"),
  };
}
function incomplete(root: string, output?: string) {
  const file = path.join(root, "incomplete.json");
  if (!fs.existsSync(file)) {
    const m = openSeal(path.join(root, "manifest.json")),
      hasRun = fs.existsSync(path.join(root, "execution.json"));
    const failures = path.join(root, "failures");
    seal(file, {
      run: path.basename(root),
      case: m.config.case,
      status: hasRun ? "UNGRADED" : "INCOMPLETE",
      coverage: { planned: 1, executed: hasRun ? 1 : 0, graded: 0 },
      firstFailures: fs.existsSync(failures)
        ? fs
            .readdirSync(failures)
            .sort()
            .map((f) => load(path.join(failures, f)))
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
async function assess(root: string, again: boolean) {
  const id = await gradeExecution(root, again),
    grade = openSeal(path.join(root, "grades", id, "grade.json"));
  const failures = path.join(root, "failures");
  seal(path.join(root, "grades", id, "accounting.json"), {
    grade: bound(grade),
    at: new Date().toISOString(),
    requests: meter(root),
    failures: fs.existsSync(failures)
      ? fs
          .readdirSync(failures)
          .sort()
          .map((f) => load(path.join(failures, f)))
      : [],
  });
  return writeReport(root, id);
}
async function execute(root: string, m: any, approved?: string) {
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
      requireThat(
        process.platform === "darwin",
        "Live targets require the verified macOS isolation backend; Linux supports offline fixtures",
      );
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
      const route = await checkRoute();
      save(path.join(root, "route.json"), route);
      gate = await gateway(root, m, signal.signal);
    }
    target = startTarget(
      work,
      [...(db ? [db.port] : []), ...(gate ? [gate.port] : [])],
      c.timeoutSeconds * 1000,
    );
    seal(path.join(root, "worker.json"), { pid: target.pid });
    const cap = await target.call("capabilities");
    requireThat(
      cap.protocol === 1 &&
        ["start", "deliver", "observe", "export", "stop"].every((k) =>
          cap.commands.includes(k),
        ),
      "Target capability mismatch",
    );
    const ready = await target.call("start", {
      target: c.target,
      workload: c.workload,
      control,
      denied: [privateFile, alias],
      dsn: db ? coreDSN(db) : null,
      gateway: gate?.url,
      capability: gate?.capability,
    });
    requireThat(
      ready.ready && ready.denied === 2,
      "Target isolation preflight failed",
    );
    if (c.workload === "opencode-go") await claim(m, id);
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
    const texts = [...m.suite.setup, m.suite.probe],
      events: any[] = [];
    let probeBefore = new Set<string>();
    for (const [i, text] of texts.entries()) {
      writeJSON(path.join(root, "guard.json"), [
        sentinel,
        ...texts.slice(i + 1),
      ]);
      if (i === texts.length - 1)
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
      events.push(value);
    }
    requireThat(
      bound(await target.call("export")) === bound(events),
      "Target export differs from observations",
    );
    requireThat(
      events.at(-1).messages.some((r: any) => r.text?.trim()),
      "Missing observable final answer",
    );
    requireThat(
      !fs.existsSync(path.join(root, "failures")),
      "Target transport failed; inspect the first dispatch failure",
    );
    const wire = captured()
      .filter((x) => !probeBefore.has(x.name))
      .sort((a, b) => a.data.at.localeCompare(b.data.at))[0];
    if (c.workload === "opencode-go")
      requireThat(
        wire && wire.data.kind === "workload",
        "Missing first probe wire",
      );
    const firstProbeMessages =
      wire?.data.body.messages ??
      events.at(-1).calls[0]?.request?.messages ??
      (c.target.startsWith("scripted-")
        ? texts.map((text) => ({ role: "user", content: text }))
        : []);
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
  } finally {
    if (
      fs.existsSync(alias) &&
      fs.lstatSync(alias).isSymbolicLink() &&
      fs.readlinkSync(alias) === privateFile
    )
      fs.unlinkSync(alias);
    signal.abort();
    if (target) await target.close();
    if (gate) await gate.close();
    if (db && pgRunning(db)) await stopDatabase(db);
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
    "recover-run": ["--run"],
    "reconcile-call": ["--run", "--attempt", "--evidence", "--approval"],
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
      const model = c.workload === "opencode-go" ? await checkRoute() : null;
      return {
        digest: bound(m),
        manifest: m,
        publishedModel: model?.published_version ?? null,
        maxTariffEquivalent:
          c.workload !== "opencode-go"
            ? 0
            : (c.maxWorkloadCalls + c.maxJudgeCalls) *
              goReaderPolicy.request_ceiling_usd_equivalent.candidate,
      };
    }
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
        );
        return assess(root, false);
      });
    } catch (error: any) {
      save(path.join(root, "failures", Date.now() + ".json"), {
        at: new Date().toISOString(),
        error: error.message,
      });
      const result = incomplete(root);
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
  if (command === "reconcile-call")
    return reconcile(
      root,
      options["--attempt"] ?? "",
      path.resolve(options["--evidence"] ?? ""),
      options["--approval"] ?? "",
    );
  if (command === "recover-run") {
    return lease(root, async () => {
      const marker = load(path.join(root, "facility.json"));
      requireThat(
        marker.repository === repository && gradeUUID(marker.nonce),
        "Unknown facility",
      );
      if (fs.existsSync(path.join(root, "stopped.json")))
        return { run: path.basename(root), stopped: true };
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
      const workerFile = path.join(root, "worker.json");
      if (fs.existsSync(workerFile)) {
        const worker = openSeal(workerFile);
        try {
          process.kill(worker.pid, 0);
          throw Error(
            "Target PID still present; wait for the recorded worker to exit",
          );
        } catch (e: any) {
          if (e.code !== "ESRCH") throw e;
        }
      }
      seal(path.join(root, "stopped.json"), {
        id: owner.id,
        systemID: db.systemID,
        at: new Date().toISOString(),
      });
      save(path.join(root, "failures", randomUUID() + ".json"), {
        at: new Date().toISOString(),
        error: "Interrupted execution; owned facility recovered",
      });
      return incomplete(root);
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
