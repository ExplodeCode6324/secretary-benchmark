"""Rehearse one frozen R77 workload with the isolated benchmark runner (no provider calls)."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--checkout", type=Path, required=True)
parser.add_argument("--inputs", type=Path, required=True)
parser.add_argument("--carry-source", type=Path, required=True)
parser.add_argument("--mode", choices=["NORMAL", "CONTINUATION_CONTROLS", "EXHAUST_C16", "INTERRUPT_C16", "SYSTEM_C16"], required=True)
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
for name, pin in [("targeted-carry.json",scope["carry_sha256"]),("targeted-decisions.json",scope["decision_sha256"]),("reader-before.json",scope["before_observation_sha256"]),("official/go-model.json",None)]:
    authenticated_copy(args.inputs/name, inputs/name, pin)
carry = json.loads((inputs/"targeted-carry.json").read_bytes())
for name, pin in {**carry["parent_records"], "active.json":carry["account_active_sha256"], "hold.json":carry["hold_sha256"], "usage-reservations/reader-candidate-97.json":carry["unsettled_entry_sha256"]}.items():
    authenticated_copy(args.carry_source/name,root/"fixture-account"/name,pin)
preflight = json.loads((args.inputs/"stage-c-preflight.json").read_bytes())
preflight.update(source=source, targeted_supplement=scope,evidence_class="OFFLINE_SSE",rehearsal_go=args.mode,rehearsal_read="ORIGINAL_OFFSET")
(inputs/"stage-c-preflight.json").write_text(json.dumps(preflight,indent=2)+"\n")
cli=["npm","run","--silent","benchmark","--"]
now=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z")
print(root,flush=True)
receipt=json.loads(run(cli+["baseline-stage-c-freeze","--root",str(root),"--batch","1","--provenance",now]))
h=receipt["hash"]
assert receipt["physical_provider_sends"]==0 and json.loads((root/"configs/stage-c-freeze.json").read_bytes())["evidence_class"]=="OFFLINE_SSE"
for command in ["baseline-stage-c-start","baseline-stage-c-dispatch"]:
    print(run(cli+[command,"--root",str(root),"--sha256",h,"--approval","issue122-rehearsal-"+h[:40]]),flush=True)
