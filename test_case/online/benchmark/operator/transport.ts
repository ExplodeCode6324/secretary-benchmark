import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { requireThat, noLinks, sha, lease } from "../io.ts";
import {
  goAPI,
  goCatalogue,
  goCanonicalModel,
  goModel,
  goModelRule,
  goResponseMeter,
  checkGoUsage,
  targetedBillingHold,
} from "../stage-c-go-provider.ts";
import { checkGoHeadroom } from "../stage-c-go-quota.ts";
import { goReaderPolicy } from "../stage-c-visibility-rubric.ts";
import { bound, dir, load, save, openSeal } from "./files.ts";

const reserve = goReaderPolicy.request_ceiling_usd_equivalent.candidate;
export function accountDirectory() {
  const file = process.env.BENCHMARK_OPERATOR_ACCOUNT;
  requireThat(
    file && path.isAbsolute(file),
    "Set BENCHMARK_OPERATOR_ACCOUNT to a shared, owner-only accounting directory",
  );
  noLinks(file);
  dir(file);
  const st = fs.statSync(file);
  requireThat(
    st.uid === process.getuid?.() && !(st.mode & 0o077),
    "Account directory must be owner-only",
  );
  return file;
}
export function credential(kind: "workload" | "judge") {
  const prefix =
    kind === "judge" ? "SECRETARY_BENCHMARK_JUDGE" : "SECRETARY_BENCHMARK_GO";
  const direct =
    process.env[
      kind === "judge"
        ? "SECRETARY_BENCHMARK_JUDGE_KEY"
        : "SECRETARY_BENCHMARK_GO_API_KEY"
    ];
  if (direct) return direct;
  const file = process.env[prefix + "_FILE"],
    variable = process.env[prefix + "_VARIABLE"] ?? "OPENCODE_GO_API_KEY";
  requireThat(
    file && path.isAbsolute(file) && /^[A-Z_][A-Z_0-9]*$/.test(variable),
    "Configure a protected " + kind + " credential reference",
  );
  noLinks(file);
  const st = fs.statSync(file);
  requireThat(
    st.isFile() && st.uid === process.getuid?.() && !(st.mode & 0o077),
    "Credential file must be owned by this user with mode 0600",
  );
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const entries = lines
    .map((line) => line.trim().replace(/^export\s+/, ""))
    .filter((line) => line.startsWith(variable + "="));
  requireThat(
    entries.length === 1,
    "Credential reference missing or ambiguous: " + variable,
  );
  const value = entries[0]
    .slice(variable.length + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2");
  requireThat(
    value.length > 0 && !/\s/.test(value),
    "Invalid credential value",
  );
  return value;
}
export async function checkRoute(recordOnly = false) {
  const response = await fetch(goCatalogue, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  requireThat(response.ok, "Go catalogue unavailable");
  const model = ((await response.json()) as any).data.find(
    (x: any) => x.id === goModel,
  );
  const rule = goModelRule(model, new Date().toISOString(), true);
  if (recordOnly)
    return {
      published_version: rule.published_version,
      checked_at: rule.checked_at,
      publication_url: rule.publication_url,
      provenance_sha256: rule.provenance_sha256,
      published_cost: model.cost ?? null,
    };
  requireThat(
    model.cost.text.input.price === 0.15 &&
      model.cost.text.output.price === 0.6 &&
      model.cost.text.input.cache.read === 0.003 &&
      model.cost.multipliers?.length === 1 &&
      model.cost.multipliers[0].factor === 2,
    "Go tariff changed",
  );
  return rule;
}
// A freeze designates one target execution. Judge-only regrades reuse that claim.
function claimFile(account: string, m: any) {
  return path.join(account, "claims", bound(m) + ".json");
}
export async function claim(m: any, run: string) {
  const account = accountDirectory();
  const digest = bound(m);
  const binding = { digest, run };
  await lease(account, async () => {
    const file = claimFile(account, m);
    if (m.config.billingPolicy === "record-only")
      requireThat(
        !fs.existsSync(file),
        "This freeze already has a target execution; select a new cohort for a new measurement",
      );
    save(file, binding);
  });
}
export async function claimHistory(m: any, run: string) {
  if (m.config.workload !== "opencode-go") return undefined;
  // Snapshots contain only run IDs and freezes. Never copy credentials or private
  // account paths into a report. The lock makes the observed claim set consistent.
  const at = new Date().toISOString();
  const unavailable = { status: "UNAVAILABLE", at, claims: null };
  if (!process.env.BENCHMARK_OPERATOR_ACCOUNT) return unavailable;
  try {
    const account = accountDirectory();
    return await lease(account, async () => {
      const directory = path.join(account, "claims");
      const claims = fs.existsSync(directory)
        ? fs
            .readdirSync(directory)
            .filter((name) => name.endsWith(".json"))
            .sort()
            .map((name) => {
              const { digest, run: claimedRun } = load(
                path.join(directory, name),
              );
              requireThat(
                typeof claimedRun === "string" &&
                  /^[a-f0-9]{64}$/.test(digest) &&
                  name === digest + ".json",
                "Invalid measurement claim",
              );
              return {
                run: claimedRun,
                freeze: digest,
                current: claimedRun === run && digest === bound(m),
              };
            })
        : [];
      return { status: "RECORDED", at: new Date().toISOString(), claims };
    });
  } catch (error: any) {
    if (["EACCES", "EIO", "ENODEV", "ESTALE"].includes(error.code))
      return unavailable;
    throw error;
  }
}
export async function remainingJudgeCalls(m: any, run: string) {
  const account = accountDirectory();
  return lease(account, async () => {
    const binding = load(claimFile(account, m));
    requireThat(
      binding.run === run && binding.digest === bound(m),
      "Freeze claimed by a different run",
    );
    const ledger = path.join(account, "requests");
    const spent = fs.existsSync(ledger)
      ? fs
          .readdirSync(ledger)
          .filter((n) => n.endsWith(".reservation.json"))
          .map((n) => load(path.join(ledger, n)))
          .filter((r) => r.run === run && r.kind === "judge").length
      : 0;
    return m.config.maxJudgeCalls - spent;
  });
}
export async function send(
  root: string,
  m: any,
  kind: "workload" | "judge",
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  const account = accountDirectory(),
    attempt = randomUUID(),
    freeze = bound(m),
    run =
      kind === "judge"
        ? openSeal(path.join(root, "execution.json")).id
        : path.basename(root);
  const binding = load(claimFile(account, m));
  requireThat(
    binding.run === run && binding.digest === freeze,
    "Freeze claimed by a different run",
  );
  requireThat(
    process.env[
      kind === "judge" ? "BENCHMARK_DISABLE_JUDGE" : "BENCHMARK_DISABLE_TARGET"
    ] !== "1",
    "Endpoint disabled by operator",
  );
  const key = credential(kind),
    payload = JSON.parse(body);
  const countLimit =
    kind === "judge" ? m.config.maxJudgeCalls : m.config.maxWorkloadCalls;
  requireThat(
    payload.model === goModel &&
      payload.stream === true &&
      Buffer.byteLength(body) <= m.maxWireBytes &&
      Number.isSafeInteger(
        payload.max_tokens ?? payload.max_completion_tokens,
      ) &&
      (payload.max_tokens ?? payload.max_completion_tokens) <= m.maxOutput,
    "Unapproved wire model, bytes or output ceiling",
  );
  requireThat(!body.includes(key), "Credential in outbound body");
  const recordOnly = m.config.billingPolicy === "record-only";
  const started = Date.now(),
    stamp = new Date().toISOString();
  const ledger = path.join(account, "requests");
  dir(ledger);
  await lease(account, async () => {
    const entries = fs
      .readdirSync(ledger)
      .filter((n) => n.endsWith(".reservation.json"))
      .map((f) => load(path.join(ledger, f)));
    const prior = entries.filter((x) => x.run === run);
    requireThat(
      prior.filter((x) => x.kind === kind).length < countLimit,
      "Call allowance exhausted",
    );
    if (recordOnly) {
      // Transport and identity failures end the affected measurement. Other runs'
      // billing records and allowance estimates do not pre-empt an actual request.
      for (const entry of prior) {
        // A failed target delivery does not make the independently sealed prefix
        // uncertain. The judge may assess it without resending the delivery.
        if (
          m.suite?.timeline &&
          kind === "judge" &&
          entry.kind === "workload"
        ) {
          const file = path.join(ledger, entry.id + ".settled.json");
          const hold = fs.existsSync(file) ? load(file).hold : null;
          requireThat(
            !String(hold).includes("PROVIDER_QUOTA_LIMIT"),
            "PROVIDER_QUOTA_LIMIT on workload",
          );
          continue;
        }
        const f = path.join(ledger, entry.id + ".settled.json");
        requireThat(
          fs.existsSync(f) && !load(f).hold,
          "Earlier request has no usable model response in this run",
        );
      }
    } else {
      let local = Number(process.env.BENCHMARK_PRIOR_EXPOSURE_USD ?? 0);
      requireThat(
        Number.isFinite(local) && local >= 0,
        "Invalid prior exposure",
      );
      for (const entry of entries) {
        const reconciled = path.join(ledger, entry.id + ".reconciled.json");
        if (fs.existsSync(reconciled)) {
          const r = load(reconciled);
          requireThat(
            r.run === entry.run &&
              r.freeze === entry.freeze &&
              r.cost === entry.ceiling &&
              r.attempt === entry.id,
            "Invalid reconciliation",
          );
          requireThat(
            entry.run !== run,
            "Reconciled run is closed; freeze a new authorized cohort",
          );
          if (Date.now() - entry.start < 31 * 86400e3) local += entry.ceiling;
          continue;
        }
        const closed = path.join(ledger, entry.id + ".settled.json");
        requireThat(
          fs.existsSync(closed),
          "Uncertain provider send; reconcile first",
        );
        const receipt = load(closed);
        requireThat(
          !receipt.hold || (receipt.holdScope === "run" && entry.run !== run),
          "Provider settlement hold; reconcile the original attempt",
        );
        if (Date.now() - entry.start < 31 * 86400e3) local += receipt.cost;
      }
      const usage = await checkGoUsage(key, fetch);
      const remainingJudge = Math.max(
        0,
        m.config.maxJudgeCalls - prior.filter((x) => x.kind === "judge").length,
      );
      checkGoHeadroom(
        usage,
        reserve * (kind === "workload" ? 1 + remainingJudge : 1),
        { rolling: local, monthly: local, weekly: local },
      );
    }
    save(path.join(ledger, attempt + ".reservation.json"), {
      id: attempt,
      run,
      freeze,
      kind,
      start: started,
      wireDigest: sha(body),
      ceiling: recordOnly ? null : reserve,
    });
    save(path.join(root, "transport", attempt + ".request.json"), {
      kind,
      at: stamp,
      digest: sha(body),
      routing: {
        session: headers["x-opencode-session"] ?? null,
        userAgent: headers["user-agent"] ?? null,
      },
      body: payload,
      ceiling: recordOnly ? null : reserve,
    });
  });
  const timeout = AbortSignal.timeout(m.config.timeoutSeconds * 1000);
  const r = await fetch(goAPI + "/chat/completions", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Authorization: "Bearer " + key,
    },
    body,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const status = {
    at: new Date().toISOString(),
    status: r.status,
    requestId: r.headers.get("x-request-id") ?? r.headers.get("request-id"),
  };
  save(path.join(root, "transport", attempt + ".http.json"), status);
  const sse = await r.text();
  save(path.join(root, "transport", attempt + ".raw.json"), {
    ...status,
    body: sse,
  });
  // Distinguish explicit provider quota errors from transport errors and local estimates.
  let quotaError = false;
  if (!r.ok) {
    let message = sse;
    try {
      const e = JSON.parse(sse).error;
      if (e && typeof e === "object")
        message = [e.code, e.type, e.name, e.message].join(" ");
    } catch {
      /* Some providers return a plain-text error. */
    }
    quotaError =
      /insufficient[ _-](?:quota|credits|balance)|quota.{0,30}(?:exceed|exhaust|limit|reach)|(?:usage|allowance|spending)[ _-]limit|allowance.{0,30}exhaust/i.test(
        message,
      );
  }
  const meter = goResponseMeter(),
    ids = new Set<string>();
  let usage: any = null,
    finishReason: string | null = null,
    finished = false,
    parseError = r.ok
      ? null
      : (quotaError ? "PROVIDER_QUOTA_LIMIT HTTP " : "Provider HTTP ") +
        r.status;
  if (!parseError)
    try {
      for (const line of sse.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const frame = JSON.parse(data);
        if (frame.model) ids.add(frame.model);
        meter.observe(frame);
        if (frame.usage) usage = frame.usage;
        for (const choice of frame.choices ?? [])
          if (choice.index === 0 && choice.finish_reason) {
            finishReason = choice.finish_reason;
            finished = true;
          }
      }
    } catch {
      parseError = "Malformed provider response";
    }
  const previous = fs
    .readdirSync(ledger)
    .filter((f) => f.endsWith(".reservation.json"))
    .map((f) => load(path.join(ledger, f)))
    .filter((r) => r.run === run && r.kind === kind && r.id !== attempt)
    .map((r) => load(path.join(ledger, r.id + ".settled.json")));
  const identityChanged = previous.some(
    (r) =>
      r.models?.[0] !== [...ids][0] ||
      Object.entries(r.billing?.identity ?? {}).some(
        ([k, v]) => meter.receipt.identity[k] !== v,
      ),
  );
  const cost = meter.receipt.list_cost;
  const complete = finished && sse.includes("[DONE]");
  const financialHold = recordOnly
    ? null
    : targetedBillingHold(meter.receipt, complete && usage !== null) ||
      (cost === null || cost > reserve ? "Unverified tariff" : null);
  const protocolHold =
    parseError || (!complete ? "Incomplete provider stream" : null);
  const identityHold =
    identityChanged ||
    ids.size !== 1 ||
    ![goModel, goCanonicalModel].includes([...ids][0])
      ? "Unexpected or changed served identity"
      : null;
  const hold = protocolHold || financialHold || identityHold;
  const receipt = {
    at: stamp,
    id: attempt,
    kind,
    models: [...ids],
    finishReason,
    usage,
    elapsedMs: Date.now() - started,
    cost: recordOnly ? cost : (cost ?? reserve),
    accountingStatus:
      usage === null || cost === null || meter.receipt.cash_debit_usd === null
        ? "UNKNOWN"
        : "REPORTED",
    billing: meter.receipt,
    hold,
    holdScope: hold
      ? recordOnly || (!protocolHold && !financialHold)
        ? "run"
        : "account"
      : null,
  };
  save(path.join(root, "transport", attempt + ".response.json"), {
    ...receipt,
    rawDigest: sha(sse),
    ...status,
  });
  save(path.join(ledger, attempt + ".settled.json"), receipt);
  requireThat(!receipt.hold, receipt.hold ?? "Provider hold");
  if (kind === "judge" && m.suite?.timeline && finishReason !== "stop")
    throw Error("JUDGE_FINISH_REASON: " + finishReason);
  return sse;
}
export async function gateway(
  root: string,
  m: any,
  signal: AbortSignal,
  rehearsal?: (body: any) => string,
) {
  const capability = randomUUID();
  let queue = Promise.resolve();
  let firstFailure: string | undefined;
  let activeSequence = 0,
    sendsThisEvent = 0;
  const server = http.createServer(async (req, res) => {
    try {
      requireThat(
        !firstFailure,
        "Workload transport stopped after first failure",
      );
      requireThat(
        req.method === "POST" &&
          req.url === "/v1/chat/completions" &&
          req.headers.authorization === "Bearer " + capability,
        "Invalid target capability",
      );
      const session = req.headers["x-opencode-session"],
        agent = req.headers["user-agent"];
      requireThat(
        typeof session === "string" &&
          /^[A-Za-z0-9_.:-]{1,256}$/.test(session) &&
          agent === "secretary-pi-demo/0.2",
        "Missing or invalid native Secretary Go routing headers",
      );
      const routing = { "x-opencode-session": session, "user-agent": agent };
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= m.maxWireBytes, "Workload wire limit exceeded");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const guard = load(path.join(root, "guard.json"));
      const blocked = Array.isArray(guard) ? guard : guard.blocked;
      if (m.suite?.timeline) {
        requireThat(
          Number.isSafeInteger(guard.sequence) &&
            guard.sequence >= activeSequence &&
            guard.sequence > 0,
          "Invalid active timeline event",
        );
        if (activeSequence !== guard.sequence) {
          activeSequence = guard.sequence;
          sendsThisEvent = 0;
        }
        requireThat(
          ++sendsThisEvent <= m.config.workloadCallsPerEvent,
          "Workload request allowance exhausted for this event",
        );
      }
      function containsGuard(value: unknown): boolean {
        if (typeof value === "string")
          return blocked.some((text: string) =>
            m.suite?.timeline && text.length < 8
              ? value === text
              : value.includes(text),
          );
        return (
          value !== null &&
          typeof value === "object" &&
          Object.values(value).some(containsGuard)
        );
      }
      requireThat(
        !containsGuard(JSON.parse(body)),
        "Undelivered event or evaluator sentinel in transmitted request",
      );
      const payload = JSON.parse(body);
      requireThat(
        payload.model === goModel &&
          payload.stream === true &&
          (payload.max_tokens ?? payload.max_completion_tokens) > 0 &&
          (payload.max_tokens ?? payload.max_completion_tokens) <= m.maxOutput,
        "Invalid workload wire contract",
      );
      let sse: string;
      if (rehearsal) {
        const id = randomUUID();
        save(path.join(root, "mock-wires", id + ".json"), {
          at: new Date().toISOString(),
          kind: "workload",
          routing,
          body: payload,
          digest: sha(body),
        });
        sse = rehearsal(payload);
      } else {
        const next = queue.then(() =>
          send(root, m, "workload", body, routing, signal),
        );
        queue = next.then(
          () => {},
          () => {},
        );
        sse = await next;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse);
    } catch (error: any) {
      firstFailure ??= error.message;
      save(path.join(root, "failures", randomUUID() + ".json"), {
        at: new Date().toISOString(),
        error: error.message,
      });
      res.writeHead(409);
      res.end(
        JSON.stringify({ error: { message: "Workload dispatch refused" } }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    port,
    capability,
    get firstFailure() {
      return firstFailure;
    },
    url: "http://127.0.0.1:" + port + "/v1",
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

// Reconciliation never retries an uncertain send. Only an explicitly reviewed
// original attempt can be carried forward, at its entire authorized ceiling.
export async function reconcile(
  root: string,
  id: string,
  proof: string,
  approval: string,
  run = path.basename(root),
) {
  requireThat(/^[a-f0-9-]{36}$/.test(id), "Supply the original request UUID");
  const account = accountDirectory(),
    ledger = path.join(account, "requests");
  noLinks(proof);
  const bytes = fs.readFileSync(proof);
  requireThat(
    bytes.length > 0 && bytes.length <= 1024 * 1024,
    "Supply a bounded private reconciliation statement",
  );
  const record = JSON.parse(bytes.toString("utf8"));
  const digest = sha(bytes);
  requireThat(
    digest === approval &&
      record.attempt === id &&
      record.disposition === "retain-full-ceiling" &&
      typeof record.basis === "string" &&
      record.basis.trim().length > 0,
    "Reconcile requires the operator-approved SHA-256 of the original attempt statement",
  );
  return lease(account, async () => {
    const reservation = load(path.join(ledger, id + ".reservation.json"));
    const original = load(path.join(root, "transport", id + ".request.json"));
    const manifest = openSeal(path.join(root, "manifest.json"));
    const binding = load(
      path.join(account, "claims", reservation.freeze + ".json"),
    );
    requireThat(
      reservation.run === run &&
        reservation.freeze === bound(manifest) &&
        binding.run === reservation.run &&
        record.freeze === reservation.freeze &&
        record.run === reservation.run &&
        record.wireDigest === original.digest &&
        reservation.wireDigest === original.digest &&
        original.kind === reservation.kind,
      "Reconciliation scope mismatch",
    );
    const settled = path.join(ledger, id + ".settled.json");
    requireThat(
      !fs.existsSync(settled) || load(settled).hold,
      "The original already settled successfully",
    );
    const outcome = {
      at: new Date().toISOString(),
      attempt: id,
      run: reservation.run,
      freeze: reservation.freeze,
      wireDigest: original.digest,
      evidence: digest,
      basis: record.basis,
      disposition: record.disposition,
      cost: reservation.ceiling,
      cash: null,
      hold: null,
    };
    const name = id + ".reconciled.json";
    const existing = path.join(ledger, name);
    if (fs.existsSync(existing)) {
      requireThat(
        load(existing).evidence === digest,
        "Original reconciliation is immutable",
      );
    } else save(existing, outcome);
    const local = path.join(root, "transport", name);
    if (!fs.existsSync(local)) save(local, load(existing));
    return {
      attempt: id,
      disposition: record.disposition,
      retained: reservation.ceiling,
      originalFreezeClosed: true,
    };
  });
}
