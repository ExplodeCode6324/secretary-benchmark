// The controller sends only the current event. This executable has no suite or judge imports.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
let questionSeries = false;
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
    if (data.target === "secretary") {
      const check = spawnSync(
        "python3",
        ["-I", "-c", "import fcntl, hashlib, json, pathlib"],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      if (check.status !== 0)
        throw Error(
          "Journal helper preflight failed: " +
            (check.error?.message ?? check.status),
        );
    }
    target = data.target;
    questionSeries = data.questionSeries === true;
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
      const previousPage: any = questionSeries
        ? await service.query(
            service.principal,
            "timeline",
            new URLSearchParams({ limit: "1" }),
          )
        : null;
      const previousTail = previousPage?.items.at(-1)?.id;
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
      let freshItems = timeline.items;
      if (questionSeries) {
        let page = timeline;
        while (
          page.before &&
          (!previousTail ||
            !freshItems.some((item: any) => item.id === previousTail))
        ) {
          page = await service.query(
            service.principal,
            "timeline",
            new URLSearchParams({
              limit: "200",
              direction: "before",
              cursor: page.before,
            }),
          );
          freshItems = [...page.items, ...freshItems];
        }
        if (previousTail)
          freshItems = freshItems.slice(
            freshItems.findIndex((item: any) => item.id === previousTail) + 1,
          );
      }
      const callIds = new Set(calls.map((c) => c.id));
      const visible = freshItems.filter(
        (item: any) => item.kind === "message" && item.role === "assistant",
      );
      const belongs = (item: any) => {
        if (!callIds.has(item.call_id)) return false;
        if (!questionSeries) return true;
        const call = app!.store.get<any>("ModelCall", item.call_id);
        const ctx = app!.store.get<any>("Context", call.context_id);
        return (
          ctx.loop_id === input.loop_id &&
          ctx.purpose === "MAIN" &&
          call.completed_at &&
          call.completed_at <= input.updated_at &&
          !item.incomplete &&
          !item.withdrawn
        );
      };
      const messages = visible.filter(belongs);
      if (questionSeries)
        for (const msg of messages) {
          while (msg.next_cursor) {
            const piece: any = await service.query(
              service.principal,
              "messages/" + msg.id + "/content",
              new URLSearchParams({ cursor: msg.next_cursor }),
            );
            if (
              piece.id !== msg.id ||
              piece.revision !== msg.revision ||
              piece.next_cursor === msg.next_cursor
            )
              throw Error("Unstable answer body");
            msg.text += piece.text;
            msg.next_cursor = piece.next_cursor;
          }
        }
      observation = {
        inputId,
        loop: input.loop_id,
        receipt,
        messages,
        ...(questionSeries
          ? {
              otherMessages: visible.filter((item: any) => !belongs(item)),
              handledAt: input.updated_at,
            }
          : {}),
        calls: calls.map((c) => ({
          id: c.id,
          state: c.state,
          ...(questionSeries
            ? { contextId: c.context_id }
            : { request: app!.store.read(c.request) }),
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
    service = undefined;
    app = undefined;
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

// The controller can disappear before sending stop. Release the journal and pool on EOF.
await service?.close();
await app?.close();
