"""Publication-only scan of reachable trees and commit metadata.
Operator literals and reviewed synthetic-pattern allowances stay in ignored files.
No match contents are emitted; findings identify source location and match hash.
"""
import argparse, hashlib, json, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--literals', required=True)
parser.add_argument('--allowlist')
args = parser.parse_args()
private_literals = pathlib.Path(args.literals).resolve()
assert private_literals.is_relative_to(root / '.local'), 'Literals must be ignored local input'
assert private_literals.stat().st_mode & 0o077 == 0, 'Literals must be owner-only'
literals = json.loads(private_literals.read_text())['literals']
assert literals and all(isinstance(x,str) and x for x in literals)
allowances = json.loads(pathlib.Path(args.allowlist).read_text()) if args.allowlist else []
assert all(x.get('rationale') for x in allowances)
allowed = {(x['path'],x['rule'],x['match_sha256']):x['rationale'] for x in allowances}
def git(*xs): return subprocess.check_output(['git','-C',str(root),*xs])
def digest(s): return hashlib.sha256(s.encode()).hexdigest()
patterns = {
 'personal-home': r'/(?:Users|home)/[^\s/\x22\x27]+',
 'volume-path': r'/Volumes/[^\s/\x22\x27]+',
 'private-ip': r'(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})(?![\d.])',
 'dsn': r'postgres(?:ql)?://[^\s\x22\x27`]+',
 'email': r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
 'local-hostname': r'\b[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.local\b',
 'token': r'(?:sk-proj-|ghp_|github_pat_|sk-ant-)[A-Za-z0-9_-]{12,}',
 'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
}
findings=[]; reviewed=[]
def scan(commit,name,text):
 for rule,pattern in [*patterns.items(), *[(f'operator-literal-{i}',r'(?<![A-Za-z0-9])'+re.escape(value)+r'(?![A-Za-z0-9])') for i,value in enumerate(literals)]]:
  for m in re.finditer(pattern,text,re.I):
   item={'commit':commit,'path':name,'rule':rule,'line':text.count('\n',0,m.start())+1,'match_sha256':digest(m.group())}
   key=(name,rule,item['match_sha256'])
   if name=='@commit-metadata' and rule=='email' and re.fullmatch(r'[A-Za-z0-9+_.-]+@users\.noreply\.github\.com',m.group()):
    reviewed.append({**item,'rationale':'Public GitHub noreply identity'})
   elif key in allowed and not rule.startswith('operator-literal'):
    reviewed.append({**item,'rationale':allowed[key]})
   else: findings.append(item)
commits=git('rev-list','--all').decode().splitlines()
for commit in commits:
 scan(commit,'@commit-metadata',git('show','-s','--format=%an%n%ae%n%cn%n%ce%n%B',commit).decode())
 for name in git('ls-tree','-r','--name-only',commit).decode().splitlines():
  if name=='sut/secretary':continue
  if name.startswith('.local/'):
   findings.append({'commit':commit,'path':name,'rule':'private-directory'});continue
  scan(commit,name,git('show',commit+':'+name).decode())
result={'version':2,'status':'PASS' if not findings else 'FAIL','commits':commits,
 'operator_literal_count':len(literals),'patterns':list(patterns),'findings':findings,
 'reviewed_matches':reviewed,
 'limitation':'Heuristic scan plus manual per-file classification, including evidence logs; already-public pinned dependency history is not rewritten.'}
print(json.dumps(result,indent=2))
raise SystemExit(bool(findings))
