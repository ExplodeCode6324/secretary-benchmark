"""Rehearse one frozen R77 workload with the isolated benchmark runner (no provider calls)."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid
import time
import signal

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkout", type=Path, required=True)
parser.add_argument("--inputs", type=Path)
parser.add_argument("--carry-source", type=Path)
parser.add_argument("--crash-after-unknown", action="store_true")
parser.add_argument("--damage-checkpoint", action="store_true")
parser.add_argument("--mode", choices=["NORMAL", "CONTINUATION_CONTROLS", "EXHAUST_C16", "INTERRUPT_C16", "SYSTEM_C16", "IDENTITY_C16", "TRANSIENT_PG"], required=True)
args = parser.parse_args()
os.umask(0o077)
checkout = args.checkout.resolve(strict=True)
root = checkout / ".local/benchmark/tests" / ("go-retest-rehearsal-" + str(uuid.uuid4()))
env = {k: v for k, v in os.environ.items() if not k.startswith("SECRETARY_") and not any(t in k for t in ["API_KEY", "ACCESS_TOKEN", "AUTH_TOKEN"])}
def run(argv):
    return subprocess.check_output(argv, cwd=checkout, env=env, text=True).strip()
def digest(data):
    return hashlib.sha256(data).hexdigest()
def authenticated_copy(source, dest, expected=None):
    if source.is_symlink():
        raise ValueError("unexpected symlink")
    data = source.read_bytes()
    if expected and digest(data) != expected:
        raise ValueError("fixture digest mismatch: " + source.name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("xb") as stream:
        stream.write(data)
def module(name, expression):
    script = 'import * as mod from "./test_case/online/benchmark/' + name + '.ts"; console.log(JSON.stringify(mod.' + expression + '))'
    return json.loads(run(["node","--import","tsx","--input-type=module","-e",script]))
source = module("source", "fingerprint()")
scope = module("stage-c-targeted-policy", "continuationWorkload")
inputs = root/"inputs"
if bool(args.inputs) != bool(args.carry_source):
    parser.error("Supply both private input paths, or omit both to use the public fixture")
if args.inputs:
    for name, pin in [("targeted-carry.json",scope["carry_sha256"]),("targeted-decisions.json",scope["decision_sha256"]),("reader-before.json",scope["before_observation_sha256"]),("official/go-model.json",None)]:
        authenticated_copy(args.inputs/name, inputs/name, pin)
    carry = json.loads((inputs/"targeted-carry.json").read_bytes())
    for name, pin in {**carry["parent_records"], "active.json":carry["account_active_sha256"], "hold.json":carry["hold_sha256"], "usage-reservations/reader-candidate-97.json":carry["unsettled_entry_sha256"]}.items():
        authenticated_copy(args.carry_source/name,root/"fixture-account"/name,pin)
    preflight = json.loads((args.inputs/"stage-c-preflight.json").read_bytes())
else:
    public = checkout/"test_case/offline/benchmark/fixtures/continuation"
    authenticated_copy(public/"carry.json", inputs/"targeted-carry.json")
    authenticated_copy(public/"catalogue-model.json", inputs/"official/go-model.json")
    for name in ("targeted-decisions.json", "reader-before.json"):
        (inputs/name).write_text("PUBLIC_OFFLINE_FIXTURE\n")
    for entry in (public/"account").rglob("*.json"):
        authenticated_copy(entry, root/"fixture-account"/entry.relative_to(public/"account"))
    preflight = json.loads((public/"preflight.json").read_bytes())
preflight.update(source=source, targeted_supplement=scope,evidence_class="OFFLINE_SSE",rehearsal_go=args.mode,rehearsal_read="ORIGINAL_OFFSET")
(inputs/"stage-c-preflight.json").write_text(json.dumps(preflight,indent=2)+"\n")
cli=["npm","run","--silent","benchmark","--"]
now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
print(root,flush=True)
receipt=json.loads(run(cli+["baseline-stage-c-freeze","--root",str(root),"--batch","1","--provenance",now]))
h=receipt["hash"]
assert receipt["physical_provider_sends"]==0 and json.loads((root/"configs/stage-c-freeze.json").read_bytes())["evidence_class"]=="OFFLINE_SSE"
approved=["--root",str(root),"--sha256",h,"--approval","issue122-rehearsal-"+h[:40]]
print(run(cli+["baseline-stage-c-start"]+approved),flush=True)
dispatch=["node","--import","tsx","test_case/online/benchmark/cli.ts","baseline-stage-c-dispatch"]+approved
if args.crash_after_unknown:
    worker=subprocess.Popen(dispatch,cwd=checkout,env=env,stdout=subprocess.DEVNULL)
    try:
        until=time.monotonic()+240
        while not list(root.glob("evidence/*/stage-c-unknown-checkpoint.json")):
            if worker.poll() is not None or time.monotonic()>until:
                raise RuntimeError("No original UNKNOWN checkpoint")
            time.sleep(.05)
        worker.send_signal(signal.SIGTERM)
    finally:
        if worker.poll() is None:
            worker.terminate()
        worker.wait(timeout=30)
if args.damage_checkpoint:
    assert args.mode == "TRANSIENT_PG" and not args.crash_after_unknown
    with subprocess.Popen(dispatch,cwd=checkout,env=env,stdout=subprocess.PIPE,text=True) as worker:
        until=time.monotonic()+240
        while True:
            current=json.loads((root/"campaign/stage-c-dispatch.json").read_bytes())
            pending=current.get("pending",{}).get("r1-C12b--deepseek-flash",{})
            if pending.get("checkpoint") and current["current"]=="r1-C16-combined--deepseek-flash":
                break
            if worker.poll() is not None or time.monotonic()>until:
                raise RuntimeError("No independently sealed checkpoint")
            time.sleep(.1)
        with (root/"pg"/pending["run"]/"data"/"offline-checkpoint-drift").open("xb") as injected:
            injected.write(b"public rehearsal only")
        output,_=worker.communicate()
        assert worker.returncode==0
        state=json.loads(output)
else:
    state=json.loads(run(dispatch))
print(json.dumps(state),flush=True)
assert state["ended"] and state["current"] is None
for lane, row in state["terminals"].items():
    evidence=root/"evidence"/row["run"]
    raw=(evidence/"stage-c-trial.json").read_bytes()
    trial=json.loads(raw)
    assert digest(raw)==row["report_sha256"] and trial["physical_provider_sends"]==0
    if args.mode=="SYSTEM_C16" and "C16" in lane:
        assert row["reason"]=="CONFIRMED_SECRETARY_SYSTEM_FAILURE"
        certificate=json.loads((root/"campaign/secretary-system-failure.json").read_bytes())
        assert certificate["run"]==row["run"] and digest((evidence/certificate["evidence_file"]).read_bytes())==certificate["evidence_sha256"]
        continue
    if args.damage_checkpoint and "C12b" in lane:
        assert row["reason"]=="CONTINUATION_DATABASE_CHANGED" and row["status"]=="INCOMPLETE"
        assert state["quarantined"][row["run"]]==lane
        assert json.loads((root/"campaign/manifest.json").read_bytes())["state"]=="CLOSED"
        continue
    assert row["status"]=="COMPLETED", row
    if "C12b" in lane:
        result=json.loads((evidence/"stage-c-recovery-receipt.json").read_bytes())["result"]
        assert result["physical_writes"]==1 and result["unknown_journal"] and result["reconciled"]
        if args.mode=="TRANSIENT_PG":
            assert any(i["reason"]=="PG_TRANSIENT_57P03" and i["run"]==row["run"] for i in state["history"][lane])
        if args.crash_after_unknown:
            assert any(i["reason"]=="INTERRUPTED_TRAJECTORY" and i["run"]==row["run"] for i in state["history"][lane])
    else:
        assert len(trial["trail"]["cycles"])==2 and len(trial["trail"]["inputs"])==64
        if args.mode in ["EXHAUST_C16","INTERRUPT_C16"]:
            assert state["history"][lane][0]["run"]==row["run"] and '"ACCEPTED"' in (evidence/"stage-c-resumes.jsonl").read_text()
    if args.mode=="CONTINUATION_CONTROLS":
        retries=[json.loads(x) for x in (evidence/"stage-c-model-retries.jsonl").read_text().splitlines()]
        assert {"HTTP_429","GO_METADATA_UNAVAILABLE"} <= {x["reason"] for x in retries}
        assert (root/"campaign/provider-backoff.jsonl").stat().st_size>0
    if args.mode=="IDENTITY_C16" and "C16" in lane:
        view=json.loads(run(["node","--import","tsx","test_case/online/benchmark/targeted-result.ts","--sealed-lane",str(root),h,"c16-repeat1"]))
        assert view["gate"]=="OPEN" and "EXTRA_RESTART_IN_CONTINUITY_WINDOW" in view["gaps"]
        assert any(change["outcome"]=="VERSION_TRANSITION" for change in view["identity_changes"])
        assert any(event["critical"] for event in view["mechanical"]["extra_restarts"])
