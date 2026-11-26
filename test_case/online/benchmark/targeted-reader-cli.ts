import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  checkWorkloadClosure,
  targetWorkloadSource,
  workloadLanes,
} from "./targeted-reader-workload.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noLinks, requireThat, sha } from "./io.ts";
import { gradeJSONBytes } from "./grading-transaction.ts";
import { trialPacket } from "./stage-c-grading.ts";
import {
  admittedReaderQuery,
  goReader,
  goVisibilityVersion,
} from "./stage-c-visibility-rubric.ts";
import {
  projectTargetedC16,
  targetedControls,
} from "./targeted-reader-packet.ts";
import {
  validateTargetedFreeze,
  validateTargetedInput,
  verifyTargetedReceipt,
  targetedRoutes,
  retestSeries,
  type TargetedRoute,
  type CalibrationIdentity,
  type TargetedReaderFreeze,
} from "./targeted-reader-grade.ts";
function bytes(file: string) {
  noLinks(file);
  requireThat(fs.lstatSync(file).isFile(), "TARGETED_REGULAR_FILE");
  return fs.readFileSync(file);
}
const object = (file: string) => JSON.parse(bytes(file).toString("utf8"));
function canonical(file: string) {
  const data = bytes(file),
    v = JSON.parse(data.toString("utf8"));
  requireThat(data.equals(gradeJSONBytes(v)), "TARGETED_NONCANONICAL_INPUT");
  return v;
}
function text(file: string) {
  const data = bytes(file),
    s = data.toString("utf8");
  requireThat(Buffer.from(s).equals(data), "TARGETED_UTF8");
  return s;
}
function install(dest: string, entries: Record<string, Buffer>) {
  noLinks(path.dirname(dest));
  fs.mkdirSync(dest, { mode: 0o700 });
  const complete = path.join(dest, "prepared.json");
  for (const [name, data] of Object.entries(entries)) {
    fs.writeFileSync(path.join(dest, name), data, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
  }
  const hashes = Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k, sha(v)]),
  );
  fs.writeFileSync(complete, gradeJSONBytes(hashes), {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  return hashes;
}
export function prepareTargetedPacket(args: string[]) {
  const [route, dir, facility, workloadFreeze, captureFile] = args;
  requireThat(
    route === "calibration"
      ? args.length === 2
      : route === "c16-repeat1"
        ? args.length === 5
        : route === "c12b" && args.length === 4,
    "TARGETED_PREPARE_ROUTE",
  );
  let packet: any, binding: any, key: any;
  if (route === "calibration") {
    ({ packet, key } = targetedControls());
    binding = { assertion_controls: 22, visibility_controls: 6 };
  } else {
    const kind = route as keyof typeof workloadLanes,
      lane = workloadLanes[kind];
    const source = targetWorkloadSource(
      facility,
      checkWorkloadClosure(facility, workloadFreeze),
      kind,
      captureFile,
    );
    const result = trialPacket(
      facility,
      lane,
      route === "c16-repeat1" ? "C16-combined" : "C12b",
      goReader,
      goVisibilityVersion,
    );
    ({ packet, private: binding } = result);
    binding = { ...binding, workload: source.proof };
    if (route === "c16-repeat1")
      ({ packet, binding } = projectTargetedC16(
        packet,
        binding,
        source.capture,
      ));
    else
      packet = {
        ...packet,
        evidence: [
          ...packet.evidence,
          {
            id: randomUUID(),
            text:
              "Recovery observations\n" + JSON.stringify(source.observation),
          },
        ],
      };
  }
  const query = admittedReaderQuery(packet);
  return install(dir, {
    "packet.json": gradeJSONBytes(packet),
    "binding.json": gradeJSONBytes(binding),
    "a-query.txt": Buffer.from(query),
    ...(key ? { "key.json": gradeJSONBytes(key) } : {}),
  });
}
export function readerAction(
  action: "admit" | "verify",
  folder: string,
  digest: string,
  route: TargetedRoute,
  facility: string,
) {
  requireThat(
    targetedRoutes.includes(route) && /^[0-9a-f]{64}$/.test(digest),
    "TARGETED_ROUTE",
  );
  const f: TargetedReaderFreeze = canonical(path.join(folder, "series.json"));
  requireThat(sha(gradeJSONBytes(f)) === digest, "TARGETED_SERIES_DIGEST");
  validateTargetedFreeze(f);
  requireThat(Object.hasOwn(f.routes, route), "TARGETED_UNAVAILABLE");
  const closed = checkWorkloadClosure(
    facility,
    f.workload_freeze_sha256,
    f.workload_dispatch_sha256,
  );
  requireThat(f.series === closed.series, "TARGETED_WORKLOAD_SERIES");
  if (f.series === retestSeries) {
    const policy = object(
      path.join(facility, "configs/stage-c-freeze.json"),
    ).targeted_supplement;
    requireThat(
      Object.values(f.routes).every(
        (row) => row.decision_sha256 === policy.decision_sha256,
      ),
      "TARGETED_DECISION_BINDING",
    );
    requireThat(
      Object.keys(f.routes).length > 1,
      "TARGETED_NO_ELIGIBLE_CANDIDATE",
    );
    if (route !== "calibration")
      requireThat(
        closed.state.terminals[
          workloadLanes[route as keyof typeof workloadLanes]
        ]?.status === "COMPLETED",
        "TARGETED_INCOMPLETE_WORKLOAD",
      );
  }
  const grade = closed.grade;
  requireThat(
    grade?.reader === goReader &&
      grade.version === goVisibilityVersion &&
      grade.max_attempts === 1 &&
      grade.packet_sha256 === f.routes.calibration.packet_sha256 &&
      grade.key_sha256 === f.key_sha256 &&
      grade.rubric_sha256 === f.rubric_sha256,
    "TARGETED_PREWORKLOAD_CALIBRATION",
  );
  const input = (r: TargetedRoute, n: string) =>
    path.join(folder, "inputs", r, n);
  function originals(r: TargetedRoute, origin: CalibrationIdentity | null) {
    const p = canonical(input(r, "packet.json")),
      b = canonical(input(r, "binding.json"));
    const ex = (n: string) => path.join(folder, "exchange", r, n);
    const rt = bytes(ex("a-transport.json")),
      dt = bytes(ex("a-dispatch.json")),
      raw = text(ex("a-raw.txt")),
      receiptPath = ex("a-receipt.json");
    const result = verifyTargetedReceipt(
      f,
      digest,
      r,
      p,
      b,
      origin,
      r === "calibration" ? canonical(input(r, "key.json")) : null,
      {
        raw,
        query: text(ex("a-query.txt")),
        metadata: text(ex("metadata.json")),
        dispatch: JSON.parse(dt.toString("utf8")),
        transport: JSON.parse(rt.toString("utf8")),
        receipt: fs.existsSync(receiptPath) ? text(receiptPath) : null,
      },
    );
    return {
      ...result,
      dispatch_sha256: sha(dt),
      transport_sha256: sha(rt),
      official_sha256: sha(gradeJSONBytes(result.official)),
      supplemental_sha256: sha(gradeJSONBytes(result.supplemental)),
    };
  }
  const packet = canonical(input(route, "packet.json")),
    binding = canonical(input(route, "binding.json"));
  const query = validateTargetedInput(f, route, packet, binding);
  if (route === "c16-repeat1" || route === "c12b") {
    const actual = targetWorkloadSource(facility, closed, route);
    requireThat(
      isDeepStrictEqual(binding.workload, actual.proof) &&
        binding.run === actual.proof.run &&
        binding.lane === actual.proof.lane &&
        binding.report_sha256 === actual.proof.trial_sha256,
      "TARGETED_CURRENT_WORKLOAD_SOURCE",
    );
    if (route === "c16-repeat1")
      requireThat(
        binding.capture_sha256 === sha(gradeJSONBytes(actual.capture)),
        "TARGETED_CURRENT_CAPTURE_BYTES",
      );
  }
  requireThat(
    text(path.join(folder, "exchange", route, "a-query.txt")) === query,
    "TARGETED_NATIVE_INPUT",
  );
  let origin: CalibrationIdentity | null = null;
  if (route === "calibration") {
    const key = canonical(input(route, "key.json"));
    requireThat(
      sha(gradeJSONBytes(key)) === f.key_sha256 &&
        key.length === 28 &&
        new Set(key.map((k: any) => k.id)).size === 28 &&
        key.every((k: any) => packet.controls.some((c: any) => c.id === k.id)),
      "TARGETED_PRIVATE_KEY",
    );
  } else {
    const cal = originals("calibration", null);
    requireThat(
      cal.accepted &&
        cal.official.status === "PASSED" &&
        cal.official.matched === 28 &&
        cal.supplemental.matched === 28,
      "TARGETED_NO_PASSED_CALIBRATION",
    );
    origin = {
      native_at: cal.calibration_native_at,
      returned_model: cal.returned_model,
      packet_sha256: cal.packet_sha256,
      transport_sha256: cal.transport_sha256,
      official_sha256: cal.official_sha256,
      supplemental_sha256: cal.supplemental_sha256,
    };
    if (action === "admit") {
      const age = Date.now() - Date.parse(origin.native_at);
      requireThat(age >= 0 && age <= 86400000, "TARGETED_CALIBRATION_AGE");
    }
  }
  return action === "verify"
    ? originals(route, origin)
    : {
        stage: route === "calibration" ? "calibration" : "candidate",
        route,
        series_sha256: digest,
        ...f.routes[route],
        origin,
      };
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  try {
    const [action, ...args] = process.argv.slice(2);
    requireThat(
      action === "prepare" ||
        (["admit", "verify"].includes(action) && args.length === 4),
      "TARGETED_ARGUMENTS",
    );
    process.stdout.write(
      JSON.stringify(
        action === "prepare"
          ? prepareTargetedPacket(args)
          : readerAction(
              action as "admit" | "verify",
              args[0],
              args[1],
              args[2] as TargetedRoute,
              args[3],
            ),
      ) + "\n",
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : "TARGETED_ERROR");
    process.exitCode = 1;
  }
}
