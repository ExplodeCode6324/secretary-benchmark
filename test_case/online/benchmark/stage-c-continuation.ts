import path from "node:path";
import {randomUUID} from "node:crypto";
import {ledger} from "./campaign.ts";
import {appendJSON} from "./io.ts";

export function retryTime(value: string | null, now = Date.now()) {
  if (!value) return null;
  const time = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(time) && time <= 8.64e15 ? new Date(Math.max(time, now)).toISOString() : null;
}
export class SenderWindowError extends Error {
  constructor(readonly waiting_for: string, readonly wait_started: number) {
    super("C12B_SENDER_WINDOW_EXHAUSTED");
  }
}
type Refusal = {
  lane?: string; run: string; role?: string; context_sha256?: string;
  model_call?: string; deadline?: number; started: number; reason: string;
  phase: string; request_sha256: string | null; reservation_id?: string;
  waiting_for?:string; wait_started?:number;
};
export function appendRefusal(root: string, refusal: Refusal) {
  const now = Date.now();
  const entries = [...ledger(root).entries.values()];
  appendJSON(path.join(root,"campaign","facility-refusals.jsonl"), {
    ...refusal, id:randomUUID(), at:new Date(now).toISOString(),
    scope:"CALL", physical_send:false, remaining_ms:refusal.deadline === undefined ? null : refusal.deadline-now,
    wait_ms:now-(refusal.wait_started??refusal.started), ledger_entries:entries.length,
    outstanding:entries.filter(entry=>!entry.settled).length
  });
}

import fs from "node:fs";
import {snapshot} from "./snapshot.ts";
import type {Run} from "./domain.ts";
import {cas,lines} from "./stage-b-scenarios-evidence.ts";
import {readJSON,writeJSON,read,sha} from "./io.ts";
import {CoreClient} from "../../../sut/secretary/src/pi_secretary/src/core-client.ts";
import {stableID} from "../../../sut/secretary/src/pi_secretary/src/execution-utils.ts";

export function externalInterruption(root:string, run:Run, since:number) {
  const refusals=lines(path.join(root,"campaign","facility-refusals.jsonl")).filter(row=>row.run===run.id && Date.parse(row.at)>=since);
  const entries=[...ledger(root).entries.values()].filter(e=>e.attempt.run===run.id && Date.parse(e.attempt.at)>=since && (!e.settled || /UNCERTAIN|INTERRUPT|QUOTA|AUTH|GO_|HTTP_|NETWORK|IDENTITY|VERSION_TRANSITION|NO_POST|TIMEOUT/.test(e.outcome??"")));
  const incidents=[...refusals.map(r=>({at:r.at,reason:r.reason,id:r.id})),...entries.map(e=>({at:e.attempt.at,reason:e.outcome??"IN_FLIGHT",id:e.attempt.id}))].sort((a,b)=>a.at.localeCompare(b.at));
  return incidents[0];
}
export function nextDispatchTime(run:Run,now=Date.now()) {
  return Math.max(now+1000,...lines(path.join(run.evidence,"http.jsonl")).map(row=>Date.parse(row.retry_at)||0));
}
export async function resumeModelBlock(root:string,run:Run) {
  const observed=readJSON(path.join(run.evidence,"observed.json"));
  const session=observed.sessions.find((s:any)=>s.id===observed.session_id && s.state==="RECOVERY_BLOCKED" && s.model_blocked_call);
  if (!session) return;
  const call=observed.calls.find((c:any)=>c.id===session.model_blocked_call);
  if (!call) return;
  const refused=lines(path.join(root,"campaign","facility-refusals.jsonl")).some(r=>r.run===run.id && r.model_call===call.id && r.context_sha256===call.request.sha256);
  const sent=[...ledger(root).entries.values()].some(e=>{
    if(e.attempt.run!==run.id || !e.settled || !externalOutcome(e.outcome)) return false;
    const file=path.join(run.evidence,"send-"+e.attempt.id+".json");
    return fs.existsSync(file) && readJSON(file).model_call===call.id;
  });
  if(!refused && !sent) return;
  const request_id=stableID([run.id,"session/resume",session.id,session.revision].join(":"));
  const receipt=await new CoreClient(run.endpoint!).command("session/resume",{request_id,expected_revision:String(session.revision)});
  appendJSON(path.join(run.evidence,"stage-c-resumes.jsonl"),{request_id,call:call.id,session:session.id,revision:session.revision,acceptance:receipt.acceptance,at:new Date().toISOString()});
}
function externalOutcome(outcome:string|undefined) {
  return /UNCERTAIN|INTERRUPT|QUOTA|AUTH|GO_|HTTP_|NETWORK|IDENTITY|VERSION_TRANSITION|NO_POST|TIMEOUT/.test(outcome??"");
}
export function confirmedSystemFailure(run:Run) {
  const file=path.join(run.evidence,"observed.json");
  if(!fs.existsSync(file)) return;
  const observed=readJSON(file), session=observed.sessions.find((s:any)=>s.id===observed.session_id && s.state==="RECOVERY_BLOCKED" && !s.model_blocked_call);
  if(!session || !/^Error: (SUMMARY_SYSTEM_HASH_MISMATCH|CORRUPT_REVISION|CORRUPT_SNAPSHOT)$/.test(session.recovery_error??"")) return;
  const core=path.join(run.active,"core");
  const tx=snapshot(core).transactions.find(t=>t.records.some(r=>r.record_type==="Session" && r.id===session.id && r.revision===session.revision && r.recovery_error===session.recovery_error) && t.events.some(e=>e.event_type==="host.blocked" && cas(core,e.payload).error===session.recovery_error));
  if(!tx) return;
  const evidence_file="stage-c-system-failure.json";
  writeJSON(path.join(run.evidence,evidence_file),{run:run.id,lineage:run.lineage,session:session.id,revision:session.revision,reason:session.recovery_error,events:tx.events,observed_sha256:sha(read(file))});
  return {schema:"issue122-secretary-system-failure-v1",reason:session.recovery_error,run:run.id,evidence_file,evidence_sha256:sha(read(path.join(run.evidence,evidence_file)))};
}
