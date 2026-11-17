"""Scan every reachable root-repository tree and classify publication files.
Pinned public dependencies retain their own history; never traverse .local.
This heuristic scan supplements source review; it does not prove absence of secrets.
"""
import hashlib, json, pathlib, re, subprocess
root = pathlib.Path(__file__).resolve().parent.parent
def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args])
patterns = [r'/Users/[^ /\n]+', r'/Volumes/[^ /\n]+', r'192\.168\.\d+\.\d+',
            r'(?:sk-proj-|ghp_|github_pat_|sk-ant-)[A-Za-z0-9_-]{12,}',
            r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
findings = []
commits = git('rev-list', '--all').decode().splitlines()
for commit in commits:
    for name in git('ls-tree', '-r', '--name-only', commit).decode().splitlines():
        if name == 'sut/secretary':
            continue
        text = git('show', commit + ':' + name).decode()
        if name.startswith('.local/'):
            findings.append([commit, name, 'private directory'])
        # Scanner source contains its own generic patterns, not operator identities.
        if name == 'scripts/audit-publication.py':
            continue
        for pattern in patterns:
            if re.search(pattern, text):
                findings.append([commit, name, pattern])
result = {'version':1,'status':'PASS' if not findings else 'FAIL',
          'commits':commits,'findings':findings,
          'limitation':'Heuristic root-history scan plus manual fixture/source classification; public pinned dependency histories are not rewritten.'}
print(json.dumps(result, indent=2))
raise SystemExit(bool(findings))
