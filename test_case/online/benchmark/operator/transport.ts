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
export async function checkRoute() {
  const response = await fetch(goCatalogue, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  requireThat(response.ok, "Go catalogue unavailable");
  const model = ((await response.json()) as any).data.find(
    (x: any) => x.id === goModel,
  );
  const rule = goModelRule(model, new Date().toISOString(), true);
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
export async function claim(m: any, run: string) {
  const account = accountDirectory();
  const digest = bound(m);
  const binding = { digest, run };
  await lease(account, async () => {
    save(path.join(account, "claims", digest + ".json"), binding);
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
  const binding = load(path.join(account, "claims", freeze + ".json"));
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
    let local = Number(process.env.BENCHMARK_PRIOR_EXPOSURE_USD ?? 0);
    requireThat(Number.isFinite(local) && local >= 0, "Invalid prior exposure");
    for (const entry of entries) {
      const closed = path.join(ledger, entry.id + ".settled.json");
      requireThat(
        fs.existsSync(closed),
        "Uncertain provider send; reconcile first",
      );
      const receipt = load(closed);
      requireThat(!receipt.hold, "Provider settlement hold");
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
    save(path.join(ledger, attempt + ".reservation.json"), {
      id: attempt,
      run,
      freeze,
      kind,
      start: started,
      ceiling: reserve,
    });
    save(path.join(root, "transport", attempt + ".request.json"), {
      kind,
      at: stamp,
      digest: sha(body),
      body: payload,
      ceiling: reserve,
    });
  });
  const timeout = AbortSignal.timeout(
    Math.min(120, m.config.timeoutSeconds) * 1000,
  );
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
  requireThat(r.ok, "Provider HTTP " + r.status + "; reservation retained");
  const sse = await r.text(),
    meter = goResponseMeter(),
    ids = new Set<string>();
  let usage: any = null,
    finished = false;
  for (const line of sse.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const frame = JSON.parse(data);
    if (frame.model) ids.add(frame.model);
    meter.observe(frame);
    if (frame.usage) usage = frame.usage;
    if (frame.choices?.some((x: any) => x.finish_reason)) finished = true;
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
  const hold =
    (identityChanged ? "Serving identity changed within profile" : null) ||
    targetedBillingHold(
      meter.receipt,
      finished && sse.includes("[DONE]") && usage !== null,
    ) ||
    (ids.size !== 1 || ![goModel, goCanonicalModel].includes([...ids][0])
      ? "Unexpected served identity"
      : null);
  const cost = meter.receipt.list_cost;
  const receipt = {
    at: stamp,
    id: attempt,
    kind,
    models: [...ids],
    usage,
    elapsedMs: Date.now() - started,
    cost: cost ?? reserve,
    billing: meter.receipt,
    hold:
      hold || (cost === null || cost > reserve ? "Unverified tariff" : null),
  };
  save(path.join(root, "transport", attempt + ".response.json"), {
    ...receipt,
    sse,
  });
  save(path.join(ledger, attempt + ".settled.json"), receipt);
  requireThat(!receipt.hold, receipt.hold ?? "Provider hold");
  return sse;
}
export async function gateway(
  root: string,
  m: any,
  signal: AbortSignal,
  rehearsal?: (body: any) => string,
) {
  const capability = randomUUID();
  const server = http.createServer(async (req, res) => {
    try {
      requireThat(
        req.method === "POST" &&
          req.url === "/v1/chat/completions" &&
          req.headers.authorization === "Bearer " + capability,
        "Invalid target capability",
      );
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        requireThat(size <= m.maxWireBytes, "Workload wire limit exceeded");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const blocked = load(path.join(root, "guard.json"));
      requireThat(
        blocked.every((text: string) => !body.includes(text)),
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
          body: payload,
          digest: sha(body),
        });
        sse = rehearsal(payload);
      } else
        sse = await send(
          root,
          m,
          "workload",
          body,
          { "user-agent": "secretary-pi-demo/0.2" },
          signal,
        );
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(sse);
    } catch (error: any) {
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
    url: "http://127.0.0.1:" + port + "/v1",
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
