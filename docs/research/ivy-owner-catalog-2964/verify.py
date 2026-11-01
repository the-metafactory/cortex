import argparse
import json
import pathlib
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description='Check catalog source paths, pinned commits, line bounds and cell citations; does not assess claim semantics.')
parser.add_argument('--repos-dir', type=pathlib.Path, required=True)
parser.add_argument('--discord-dir', type=pathlib.Path, required=True)
parser.add_argument('--document', type=pathlib.Path, default=pathlib.Path(__file__).with_name('README.md'))
args = parser.parse_args()
doc = args.document
base = args.repos_dir
roots = {name: base / name for name in ('cortex', 'soma', 'ranger', 'pulse', 'reflex', 'cortex-desk-adapters')}
roots['metafactory-cortex-adapter-discord'] = args.discord_dir
text = doc.read_text()
refs = re.findall(r'^\[([A-Z]+\d+)\]: https://github.com/the-metafactory/([^/]+)/blob/([0-9a-f]{40})/([^#]+)#L(\d+)-L(\d+)$', text, re.M)
issues = []
records = []
for label, repo, sha, path, first, last in refs:
    source = subprocess.run(['git', '-C', str(roots[repo]), 'show', sha + ':' + path], text=True, capture_output=True)
    lines = source.stdout.splitlines()
    valid = source.returncode == 0 and 0 < int(first) <= int(last) <= len(lines)
    records.append({'label': label, 'repo': repo, 'sha': sha, 'path': path, 'first': int(first), 'last': int(last), 'lineCount': len(lines), 'valid': valid})
    if not valid:
        issues.append(records[-1])
definitions = set(re.findall(r'^\[([A-Z]+\d+)\]:', text, re.M))
uses = set(re.findall(r'(?<!^)\[([A-Z]+\d+)\](?!:)', text, re.M))
if uses - definitions:
    issues.append({'undefined': sorted(uses - definitions)})
rows = [line for line in text.splitlines() if re.match(r'^\| O\d\d ', line)]
for row in rows:
    cells = [cell.strip() for cell in row.split('|')[1:-1]]
    if len(cells) != 6 or any(not cell for cell in cells):
        issues.append({'malformedRow': row})
    for index, cell in enumerate(cells[1:], 1):
        if not re.search(r'\[[A-Z]+\d+\]|Unknown|Unsupported', cell):
            issues.append({'unsourcedCell': cells[0], 'column': index})
print(json.dumps({'sourceReferences': len(refs), 'catalogRows': len(rows), 'records': records, 'issues': issues}, indent=2))
sys.exit(bool(issues))
