// The controller sends only the current event. This executable has no suite or judge imports.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { App } from "../../../../sut/secretary/src/pi_secretary/src/app.ts";
import { ApplicationService } from "../../../../sut/secretary/src/pi_secretary/src/application-service.ts";
import {
  fixtureModel,
  fixtureStream,
  roleModel,
} from "../../../../sut/secretary/src/pi_secretary/src/model.ts";
import { getModel } from "@earendil-works/pi-ai/compat";

let app: App | undefined;
let service: ApplicationService | undefined;
let observations: any[] = [];
let target = "";
let scriptedSetup = "";
const commands = [
  "capabilities",
  "start",
  "deliver",
  "observe",
  "export",
  "stop",
];
const home = process.cwd();
async function handle(command: string, data: any) {
  if (command === "capabilities") return { protocol: 1, commands };
  if (command === "start") {
    if (target) throw Error("TARGET_ALREADY_STARTED");
    if (fs.readFileSync(path.join(home, "control"), "utf8") !== data.control)
      throw Error("TARGET_POSITIVE_CONTROL_FAILED");
    for (const forbidden of data.denied) {
      try {
        fs.readFileSync(forbidden);
      } catch (error: any) {
        if (["EACCES", "EPERM"].includes(error.code)) continue;
        throw error;
      }
      throw Error("TARGET_CANARY_READABLE");
    }
    target = data.target;
    if (target === "secretary") {
      let config;
      if (data.workload === "fixture") {
        config = { model: fixtureModel, stream: fixtureStream };
      } else {
        const model = {
          ...getModel("opencode-go", "deepseek-v4.1-flash"),
          baseUrl: data.gateway,
        };
        config = {
          main: roleModel(model, data.capability, "main"),
          task: roleModel(model, data.capability, "task"),
        };
      }
      app = await App.open(path.join(home, "core"), config, data.dsn);
      service = new ApplicationService(app);
    }
    return { ready: true, denied: data.denied.length };
  }
  if (!target) throw Error("TARGET_NOT_STARTED");
  if (command === "deliver") {
    if (
      typeof data.text !== "string" ||
      data.sequence !== observations.length + 1
    )
      throw Error("TARGET_EVENT_SEQUENCE");
    let observation;
    if (app && service) {
      const before = new Set(app.store.all("ModelCall").map((row) => row.id));
      const receipt = service.command(service.principal, "messages", {
        request_id: data.id,
        text: data.text,
      });
      await app.settle();
      const inputId = receipt.resource_ids.find((r) => r.type === "Input")?.id;
      const input: any = inputId && app.store.get("Input", inputId);
      if (input?.state !== "HANDLED")
        throw Error("SECRETARY_INPUT_NOT_HANDLED");
      const timeline: any = await service.query(
        service.principal,
        "timeline",
        new URLSearchParams({ limit: "200" }),
      );
      const calls = app.store
        .all<any>("ModelCall")
        .filter((c) => !before.has(c.id));
      const messages = timeline.items.filter(
        (item: any) =>
          item.kind === "message" &&
          item.role === "assistant" &&
          calls.some((c) => c.id === item.call_id),
      );
      observation = {
        inputId,
        loop: input.loop_id,
        receipt,
        messages,
        calls: calls.map((c) => ({
          id: c.id,
          state: c.state,
          request: app!.store.read(c.request),
        })),
        effects: app.store.all("Operation").map((op: any) => ({
          id: op.id,
          state: op.state,
          kind: op.action?.kind,
        })),
      };
    } else {
      const answer = target === "scripted-good" ? scriptedSetup : "unknown";
      scriptedSetup = data.text;
      observation = {
        inputId: data.id,
        messages: [{ text: answer }],
        calls: [],
        effects: [],
      };
    }
    observations.push({ sequence: data.sequence, id: data.id, ...observation });
    return {
      id: data.id,
      sequence: data.sequence,
      inputId: observation.inputId,
    };
  }
  if (command === "observe") return observations.at(-1);
  if (command === "export") return observations;
  if (command === "stop") {
    await service?.close();
    await app?.close();
    return { stopped: true };
  }
  throw Error("UNSUPPORTED_COMMAND");
}
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  try {
    if (request.protocol !== 1 || !commands.includes(request.command))
      throw Error("PROTOCOL_VERSION_OR_COMMAND");
    const result = await handle(request.command, request.data);
    process.stdout.write(
      JSON.stringify({ id: request.id, protocol: 1, result }) + "\n",
    );
  } catch (error: any) {
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        protocol: 1,
        error: String(error.message).slice(0, 240),
      }) + "\n",
    );
  }
  if (request.command === "stop") break;
}
