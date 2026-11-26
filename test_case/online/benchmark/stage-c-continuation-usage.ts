import path from "node:path";
import {ledger} from "./campaign.ts";
import {readJSON} from "./io.ts";
import {lines} from "./stage-b-scenarios-evidence.ts";
export function continuationUsage(root:string) {
  const forecast=readJSON(path.join(root,"reports/stage-c-projection.json"));
  const entries=[...ledger(root).entries.values()];
  const sends=entries.filter(e=>e.outcome!=="RETEST_CONFIRMED_NO_POST");
  const metrics=(get:(u:any)=>unknown)=>{
    let known=0,unknown=0;
    for(const e of sends){
      const value=get(e.usage);
      if(typeof value==="number" && Number.isFinite(value)) known+=value; else unknown++;
    }
    return {known,unknown_requests:unknown};
  };
  const cash=metrics(u=>u?.go_meter?.cash_debit_usd),list=metrics(u=>u?.go_meter?.list_cost);
  return {forecast,actual:{reservations:entries.length,possible_provider_sends:sends.length,confirmed_http_responses:sends.filter(e=>typeof (e.usage as any)?.provider==="object" && (e.usage as any)?.provider!=null).length,
    refused_before_post:lines(path.join(root,"campaign/facility-refusals.jsonl")).length,
    unknown_delivery:sends.filter(e=>!e.settled || /UNCERTAIN|INTERRUPT/.test(e.outcome??"")).length,
    input_tokens:metrics(u=>u?.provider?.prompt_tokens??u?.provider?.input_tokens),output_tokens:metrics(u=>u?.provider?.completion_tokens??u?.provider?.output_tokens),list_usd:list,cash_usd:cash},
    list_difference_from_peak_estimate_usd:list.unknown_requests===0?list.known-forecast.expected_usd_at_peak_rates:null};
}
