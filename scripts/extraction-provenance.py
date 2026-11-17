"""Generate the allowlisted source inventory; no private inputs are read."""
import hashlib,json,pathlib,subprocess
root=pathlib.Path(__file__).resolve().parent.parent
baseline=root/'sut/secretary'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
files=subprocess.check_output(['git','-C',str(root),'ls-files']).decode().splitlines()
rows=[]
for name in files:
    p=root/name
    if not p.is_file() or name.startswith('evidence/'):
        continue
    category=('synthetic development fixture/regression' if name.startswith('test_case/offline/') else
              'synthetic development scenarios/controls' if p.name in ['scenarios.ts','grader-controls.ts'] else
              'harness source/schema (private input readers contain no private input data)' if name.startswith('test_case/') else
              'public documentation/configuration/validation tooling')
    old=baseline/name
    rows.append({'path':name,'sha256':sha(p),'classification':category,
                 'baseline_sha256':sha(old) if old.is_file() else None,
                 'change':'UNCHANGED' if old.is_file() and p.read_bytes()==old.read_bytes() else 'ADAPTED_OR_NEW'})
for name in ['assessment.ts','grading.ts','grading-batch.ts','grading-migration.ts','grading-migration-store.ts','grading-attempt.ts','grading-transaction.ts','grader-controls.ts','public-grading.ts']:
    relative='test_case/online/benchmark/'+name
    assert sha(root/relative)==sha(baseline/relative), relative
result={'version':1,'status':'ADVISORY','qualification':'NOT_HUMAN_QUALIFIED',
        'baseline_reviewed_head':'50ffe5dd0ec50c89bb9421c38a7827bc75dc799a',
        'baseline_merged_head':'873b66f4b906ff53a62476ff5dd1466649c427f7',
        'merge_benchmark_diff':'EMPTY (verified before extraction)',
        'frozen_grading_source':'BYTE_IDENTICAL',
        'adaptations':['SUT imports and Python/runtime paths','SUT pin, recursive cleanliness and replay binding','home-relative protected checkout guard','explicit private archive configuration','standalone package, scoped CI, docs and differential/guard tests'],
        'excluded':['private inputs and run-specific controls','private model responses and rationales','private Git history and local settings','evidence files (each has its own provenance)'],
        'files':rows}
print(json.dumps(result,indent=2))
