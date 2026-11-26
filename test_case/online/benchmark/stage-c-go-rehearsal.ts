// Use a private account per offline run. All entry points require the owned test root.
import path from "node:path";
import { repository } from "./io.ts";

export function isGoRehearsal(root: string) {
  return (
    path.dirname(root) === path.join(repository, ".local/benchmark/tests") &&
    /^go-retest-rehearsal-[0-9a-f-]{36}$/.test(path.basename(root))
  );
}
