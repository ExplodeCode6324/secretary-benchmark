import fs from "node:fs";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Store } from "../../../sut/secretary/src/pi_secretary/src/store.ts";
import { Host } from "../../../sut/secretary/src/pi_secretary/src/host.ts";
import { Scheduler } from "../../../sut/secretary/src/pi_secretary/src/scheduler.ts";
import { Authorization } from "../../../sut/secretary/src/pi_secretary/src/authorization.ts";
import { durableStream } from "../../../sut/secretary/src/pi_secretary/src/transport.ts";
import {
  createSummaryPlan,
  runSummary,
} from "../../../sut/secretary/src/pi_secretary/src/summary.ts";
import { extractionRequest } from "../../../sut/secretary/src/pi_secretary/src/memory-extraction.ts";
import { descriptor, liveRoles } from "./live-model.ts";
import { mkdir, readJSON, requireThat, sha, writeJSON } from "./io.ts";
import { physicalBound, type PhysicalPolicy } from "./stage-b-policy.ts";
import { fingerprint } from "./source.ts";
import { runStageProbe } from "./stage-b-probe.ts";

const controls = ["gpt-6-luna", "gpt-6.2-sol"] as const;
const paths = ["probe", "main", "task", "summary", "extraction"] as const;
type Sample = {
  model: (typeof controls)[number];
  path: (typeof paths)[number];
  endpoint: string;
  wire: string;
  product_payload_sha256: string | null;
};
const receiptFile = (root: string) =>
  path.join(root, "configs", "stage-b-tier-samples.json");

// Run only inside the leased prepare command or an isolated offline test.
// The pinned product delegates its fetch to this process. Never load credentials here.
export async function prepareTierSamples(root: string, policy: PhysicalPolicy) {
  if (fs.existsSync(receiptFile(root))) return;
  const parent = path.join(root, "evidence");
  mkdir(parent);
  const evidence = fs.mkdtempSync(path.join(parent, "tier-wire-"));
  const store = await Store.open(path.join(evidence, "store"));
  const original = globalThis.fetch;
  const samples: Sample[] = [];
  try {
    for (const id of controls) {
      const tier = policy.providers[id].request_service_tier;
      requireThat(tier === "default", "STAGE_B_EXPLICIT_TIER_REQUIRED");
      const key = "offline-synthetic-key",
        model = descriptor(id),
        roles = liveRoles(id, key, evidence, tier);
      const scheduler = new Scheduler(
        store,
        new Authorization(store),
        model,
        roles.task.stream,
      );
      const host = new Host(store, scheduler, model, roles.main.stream);
      const scope = {
        session_id: host.sessionID,
        task_id: null,
        execution_id: null,
      };
      for (const [i, label] of paths.entries()) {
        const loopID = "00000000-0000-4000-8000-00000000000" + String(i + 1);
        const wire: { endpoint: string; body: string }[] = [];
        globalThis.fetch = async (input, init) => {
          const request = new Request(input, init);
          requireThat(request.method === "POST", "STAGE_B_TIER_SAMPLE_METHOD");
          wire.push({ endpoint: request.url, body: await request.text() });
          return new Response('{"error":{"message":"offline fixture"}}', {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        };
        const n = store.events("model.payload").length;
        const args = {
          store,
          model,
          stream: roles.main.stream,
          sessionID: host.sessionID,
          loopID,
          consciousnessRevision: 1,
        };
        try {
          if (label === "probe") await runStageProbe(model, key, tier);
          else if (label === "summary")
            await runSummary({
              ...args,
              refs: [],
              plan: createSummaryPlan({
                model,
                refs: [],
                items: [],
                commitments: [],
                sources: [{ id: "fixture", text: "Synthetic fixture." }],
              }),
              commitments: [],
              candidate: { items: [], completed: 0 },
              checkpoint: () => {},
            });
          else if (label === "extraction")
            await extractionRequest({
              ...args,
              source: ["Synthetic fixture."],
              existing: [],
            });
          else {
            const send = durableStream(
              store,
              roles[label].stream,
              scope,
              loopID,
              label === "task" ? "TASK" : "MAIN",
            );
            await (
              await send(
                model,
                normalizeContext({
                  messages: [
                    {
                      role: "user",
                      content: "Synthetic " + label + " sample.",
                      timestamp: 1,
                    },
                  ],
                }),
              )
            ).result();
          }
        } catch (error) {
          // The synthetic HTTP failure propagates after durable payload admission.
          if (wire.length !== 1) throw error;
        }
        requireThat(
          wire.length === 1 &&
            store.events("model.payload").length ===
              n + (label === "probe" ? 0 : 1),
          "STAGE_B_TIER_SAMPLE_COUNT",
        );
        let productHash = null;
        if (label !== "probe") {
          const event = store.events("model.payload").at(-1)!;
          const { payload_ref } = store.read<{
            payload_ref: Parameters<Store["read"]>[0];
          }>(event.payload);
          productHash = sha(JSON.stringify(store.read(payload_ref)));
          requireThat(
            productHash === sha(wire[0].body),
            "STAGE_B_PRODUCT_PAYLOAD_MISMATCH",
          );
        }
        samples.push({
          model: id,
          path: label,
          endpoint: wire[0].endpoint,
          wire: wire[0].body,
          product_payload_sha256: productHash,
        });
      }
    }
  } finally {
    globalThis.fetch = original;
    await store.close();
  }
  writeJSON(receiptFile(root), { source: fingerprint(), samples });
}

export function verifyTierSamples(
  root: string,
  policy: PhysicalPolicy,
  source: ReturnType<typeof fingerprint>,
) {
  const receipt = readJSON<{ source: typeof source; samples: Sample[] }>(
    receiptFile(root),
  );
  requireThat(
    JSON.stringify(source) === JSON.stringify(receipt.source) &&
      Array.isArray(receipt.samples) &&
      receipt.samples.length === controls.length * paths.length,
    "STAGE_B_TIER_SAMPLE_BINDING",
  );
  return receipt.samples.map((s, i) => {
    const model = controls[Math.floor(i / paths.length)],
      label = paths[i % paths.length],
      tier = policy.providers[model].request_service_tier;
    requireThat(
      s.model === model &&
        s.path === label &&
        s.endpoint === descriptor(model).baseUrl + "/responses" &&
        typeof s.wire === "string",
      "STAGE_B_TIER_SAMPLE_BINDING",
    );
    const body = JSON.parse(s.wire),
      bytes = Buffer.byteLength(s.wire),
      hash = sha(s.wire);
    requireThat(
      tier === "default" &&
        body.model === model &&
        body.service_tier === tier &&
        body.stream === true &&
        (label === "probe"
          ? s.product_payload_sha256 === null
          : s.product_payload_sha256 === hash),
      "STAGE_B_TIER_SAMPLE_BINDING",
    );
    physicalBound(
      policy,
      model,
      bytes,
      body.max_output_tokens,
      label === "task" ? "task" : label === "probe" ? "probe" : "main",
    );
    return {
      model,
      path: label,
      endpoint: s.endpoint,
      service_tier: tier,
      bytes,
      output_cap: body.max_output_tokens,
      sha256: hash,
      product_payload_sha256: s.product_payload_sha256,
    };
  });
}
