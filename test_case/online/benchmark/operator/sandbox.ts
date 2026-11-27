import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { repository, requireThat } from "../io.ts";

export function startTarget(work: string, ports: number[], timeout: number) {
  requireThat(
    process.env.BENCHMARK_DISABLE_TARGET !== "1",
    "Target disabled by operator",
  );
  const directory = path.join(
    repository,
    "test_case/online/benchmark/operator",
  );
  const program = path.join(directory, "target.ts");
  const exe = fs.realpathSync(process.execPath);
  const allowed = [
    program,
    path.join(repository, "package.json"),
    path.join(repository, "node_modules"),
    path.join(repository, "sut/secretary/src/pi_secretary/src"),
    path.join(repository, "sut/secretary/src/pi_resource/packages"),
    path.join(repository, "sut/secretary/package.json"),
    ...[
      "docs/api/v1/schema.json",
      "src/schema",
      "src/contracts",
      "src/state_machine",
    ].map((d) => path.join(repository, "sut/secretary", d)),
    "/usr/bin",
    "/bin",
    "/usr/lib",
    "/usr/share",
    "/lib",
    "/lib64",
    "/usr/lib64",
    exe,
    "/dev/null",
    "/dev/zero",
    "/dev/urandom",
    "/dev/random",
    "/etc/localtime",
  ];
  const env = {
    HOME: work,
    TMPDIR: work,
    PATH: path.dirname(exe),
    TSX_DISABLE_CACHE: "1",
    NODE_NO_WARNINGS: "1",
    LANG: "C",
    OPENSSL_CONF: "/dev/null",
  };
  const token = randomUUID();
  const nodeArgs = [
    exe,
    "--import",
    path.join(repository, "node_modules/tsx/dist/loader.mjs"),
    program,
    "--run",
    token,
  ];
  let launcher: string, args: string[];
  if (process.platform === "darwin") {
    // JS and dynamic libraries come from the local Node installation. No operator profile is mounted.
    allowed.push(
      "/System",
      "/Library/Apple",
      "/private/etc/localtime",
      "/usr/sbin",
      "/opt/homebrew/Cellar",
      "/opt/homebrew/opt",
      "/opt/homebrew/lib",
    );
    const paths = allowed
      .map((p) => "(subpath " + JSON.stringify(p) + ")")
      .join(" ");
    const net = ports
      .map((p) => '(allow network-outbound (remote tcp "localhost:' + p + '"))')
      .join("\n");
    const profile =
      '(version 1)(deny default)(import "system.sb")(allow process-exec*)(allow process-fork)(allow sysctl-read)(allow file-read-metadata)(allow signal (target self) (target children))(allow file-read* ' +
      paths +
      ")(allow file-read* file-write* (subpath " +
      JSON.stringify(work) +
      "))" +
      net;
    launcher = "/usr/bin/sandbox-exec";
    args = ["-p", profile, ...nodeArgs];
    fs.writeFileSync(path.join(path.dirname(work), "isolation.sb"), profile);
  } else if (process.platform === "linux") {
    launcher = "python3";
    args = [
      path.join(directory, "landlock.py"),
      JSON.stringify(allowed),
      work,
      JSON.stringify(ports),
      ...nodeArgs,
    ];
  } else throw Error("Unsupported target isolation host");
  const log = fs.openSync(path.join(work, "target.stderr"), "wx", 0o600);
  let child;
  try {
    child = spawn(launcher, args, {
      detached: true,
      cwd: work,
      env: {
        ...env,
        PATH: path.dirname(exe) + ":/opt/homebrew/bin:/usr/bin:/bin",
      },
      stdio: ["pipe", "pipe", log],
    });
  } finally {
    fs.closeSync(log);
  }
  const proc = child;
  const replies = readline
    .createInterface({ input: proc.stdout! })
    [Symbol.asyncIterator]();
  let failure: Error | undefined;
  proc.once("error", (e) => {
    failure = e;
  });
  const closed = new Promise<void>((resolve) =>
    proc.once("close", () => resolve()),
  );
  return {
    token,
    pid: proc.pid,
    async call(command: string, data: unknown = {}) {
      const id = randomUUID();
      const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
      try {
        requireThat(
          proc.exitCode === null && !proc.stdin!.destroyed,
          "TARGET_EXITED",
        );
        proc.stdin!.write(
          JSON.stringify({ protocol: 1, id, command, data }) + "\n",
        );
        const line = await replies.next();
        if (line.done) {
          await closed;
          throw Error(
            "TARGET_EXITED " +
              (failure?.message ?? proc.signalCode ?? proc.exitCode) +
              "; see target.stderr",
          );
        }
        const response = JSON.parse(line.value);
        requireThat(
          response.protocol === 1 && response.id === id,
          "INVALID_TARGET_ACK",
        );
        if (response.error) throw Error(response.error);
        return response.result;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      proc.stdin!.end();
      const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
