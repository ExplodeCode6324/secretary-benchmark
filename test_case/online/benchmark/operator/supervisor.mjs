// This detached leader pins the process group until it terminates the whole group.
// Only the sandboxed target inherits the protocol pipes. The controller owns IPC.
import { spawn } from "node:child_process";

if (process.argv[2] !== "--run" || !process.send)
  throw new Error("Missing target supervisor control channel");
const [launcher, ...args] = process.argv.slice(4);
function stop() {
  process.kill(-process.pid, "SIGKILL");
}
process.on("disconnect", stop);
process.on("message", (message) => {
  if (message === "stop") stop();
});
const target = spawn(launcher, args, { stdio: "inherit" });
target.once("error", (error) => {
  process.stderr.write(String(error) + "\n");
  stop();
});
target.once("exit", stop);
