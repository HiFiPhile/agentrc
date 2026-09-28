#!/usr/bin/env python3
"""Measure a change to the pr-review workflow against a saved launch.

  compare.py units --run DIR
  compare.py diff --base FILE --candidate FILE

`units` reads one Workflow run directory (<session>/subagents/workflows/wf_*: its
journal.jsonl and agent transcripts) and recovers what the output leaves out: every
scanner proposal with its verifier's verdict and cost, every thread claim with its
judge's verdict and cost, and the cost of each stage. Costs are priced at
run_cost.py's RATES from each transcript (`costBasis`), not the session's allocated
figure run_cost.py tables, so compare them only with each other. A proposal whose
verifier died has verdict null; an agent with no transcript has cost null and is
named in `missingCost`.

`diff` names, per finding and per thread claim, what changed between two pr-review
outputs (Workflow output files or bare results): under `changed`, status or verdict,
severity, confidence, what covers it and whether the grading is complete; under
`reworded`, the text a reader must judge (the finding or claim, the impact facts,
the reason for the level), since two runs never repeat their wording; then each
unit, finding and claim coverage lost, and the verdict. A finding is keyed by its ledger id, else by file, line and dimension;
a claim by comment id and its order among that comment's claims, an alignment that
holds only while both read the same threads (a reordered claim shows as reworded).
A key holding more
than one record on a side is `ambiguous` unless both sides hold the same records
there, never paired by guess. `same` is true only when nothing differs.

stdout ends with one JSON line; {"error": ...}, exit 2, when an input is unusable.
"""

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'pr-babysit' / 'scripts'))
sys.path.insert(0, str(HERE.parents[1] / 'headless-chief' / 'scripts'))
from facts import Parser, Unusable, report  # noqa: E402
from launch_result import load_output  # noqa: E402
from run_cost import GENERIC, priced_at, rate_of, stage_of, usage_of  # noqa: E402

IMPACT = ('consequence', 'path', 'variants', 'recovery')
# pr-review.js's and code-audit.js's scales: a level counts only as one of these, with its facts and reason.
LEVELS = ('critical', 'high', 'medium', 'low', 'nit')
CONFIDENCE = ('high', 'medium', 'low')


def cost_of(transcript):
    if not transcript.is_file():
        return None
    by_model = usage_of(transcript)[0]
    return round(sum(priced_at(rate_of(m) or GENERIC, u['tokens']) for m, u in by_model.items()), 4)


def journal(run):
    """{label: (result or None, cost)} for every agent the run started, in start order."""
    path = run / 'journal.jsonl'
    try:
        rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
    except (OSError, ValueError) as e:
        raise Unusable(f'cannot read {path}: {e}')
    started = {r['key']: r for r in rows if r.get('type') == 'started'}
    results = {r['key']: r.get('result') for r in rows if r.get('type') == 'result'}
    out = {}
    for key, s in started.items():
        if s['label'] in out:
            raise Unusable(f"{path} starts two agents labelled {s['label']}")
        out[s['label']] = (results.get(key), cost_of(run / f"agent-{s['agentId']}.jsonl"))
    return out


def units(run):
    agents = journal(run)
    scans = []
    for label, (scan, cost) in agents.items():
        if not label.startswith('scan:'):
            continue
        unit = label.split(':', 1)[1]
        proposals = []
        for k, f in enumerate((scan or {}).get('findings') or []):
            v, vcost = agents.get(f'verify:{unit}:{k}', (None, None))
            proposals.append({**f, 'verdict': v, 'verifyCost': vcost})
        scans.append({'unit': unit, 'dimension': (scan or {}).get('dimension'), 'dead': scan is None, 'cost': cost,
                      'proposals': proposals})
    read, _ = agents.get('claims', (None, None))
    claims = []
    for i, c in enumerate((read or {}).get('claims') or []):
        v, jcost = agents.get(f'judge:{i}', (None, None))
        claims.append({**c, 'verdict': v, 'judgeCost': jcost})
    stages = defaultdict(float)
    for label, (_, cost) in agents.items():
        stages[stage_of(label).split(':', 1)[0]] += cost or 0
    missing = [label for label, (_, cost) in agents.items() if cost is None]
    kinds = Counter('dead' if not v else 'refuted' if not v.get('real') else 'confirmed' if complete(v) else 'ungraded'
                    for v in (p['verdict'] for s in scans for p in s['proposals']))
    return {'run': run.name, 'costBasis': 'run_cost.py RATES per transcript', 'missingCost': missing, 'proposals': dict(kinds),
            'refutedVerifyCost': round(sum(p['verifyCost'] or 0 for s in scans for p in s['proposals']
                                           if p['verdict'] and not p['verdict'].get('real')), 4),
            'stages': {k: round(v, 4) for k, v in sorted(stages.items(), key=lambda x: -x[1])},
            'scans': scans, 'claims': claims}


def result_of(path):
    out = load_output(path)
    r = out.get('result', out) if isinstance(out, dict) else None
    if not isinstance(r, dict) or r.get('status') != 'reviewed':
        raise Unusable(f'{path} holds no reviewed pr-review result')
    return r


def complete(x):
    return x.get('severity') in LEVELS and x.get('confidence') in CONFIDENCE and bool(x.get('severityReason')) and isinstance(x.get('impact'), dict) and all(x['impact'].get(k) for k in IMPACT)


def keyed(records, key):
    groups = defaultdict(list)
    for x in records:
        groups[key(x)].append(x)
    return groups


def claim_keys(claims):
    seen = Counter()
    out = []
    for c in claims:
        seen[c.get('commentId')] += 1
        out.append((c, f"{c.get('commentId')}#{seen[c.get('commentId')]}"))
    return out


def texts(x, text):
    return {**{f: x.get(f) for f in text}, **{k: (x.get('impact') or {}).get(k) for k in IMPACT}}


def side_by_side(base, cand, fields, text, label):
    """What changed per key; each side a {key: [records]}."""
    changed, reworded, only_base, only_cand, ambiguous = [], [], [], [], []
    seen = lambda xs: sorted(json.dumps([x.get(f) for f in fields] + [complete(x), texts(x, text)]) for x in xs)
    for k in sorted(set(base) | set(cand)):
        b, c = base.get(k, []), cand.get(k, [])
        if len(b) > 1 or len(c) > 1:
            if seen(b) != seen(c):
                ambiguous.append({'key': k, 'base': len(b), 'candidate': len(c)})
        elif not c:
            only_base.append({'key': k, **{f: b[0].get(f) for f in fields}, 'label': label(b[0])})
        elif not b:
            only_cand.append({'key': k, **{f: c[0].get(f) for f in fields}, 'label': label(c[0])})
        else:
            d = {f: [b[0].get(f), c[0].get(f)] for f in fields if b[0].get(f) != c[0].get(f)}
            if complete(b[0]) != complete(c[0]):
                d['graded'] = [complete(b[0]), complete(c[0])]
            if d:
                changed.append({'key': k, 'label': label(b[0]), **d})
            tb, tc = texts(b[0], text), texts(c[0], text)
            if tb != tc:
                reworded.append({'key': k, **{f: [tb[f], tc[f]] for f in tb if tb[f] != tc[f]}})
    return {'changed': changed, 'reworded': reworded, 'onlyBase': only_base, 'onlyCandidate': only_cand, 'ambiguous': ambiguous}


def finding_key(f):
    return f.get('id') or f"{f.get('file')}:{f.get('line')}:{f.get('dimension')}"


def lost(r):
    """Each unit, finding and claim the output could not account for, as a sorted list of keys."""
    cov = r.get('coverage') or {}
    keys = [f"dropped {u.get('dir')} x {u.get('dim')}" for u in cov.get('dropped', [])]
    keys += [f"unverified {f.get('file')}:{f.get('line')} ({u.get('dim')}): {f.get('why')}"
             for u in cov.get('unverified', []) for f in u.get('findings', [])]
    keys += ['unjudged ' + json.dumps(x, sort_keys=True) for x in cov.get('unjudged', [])]
    return sorted(keys)


def diff(base, cand):
    findings = side_by_side(keyed(base.get('findings', []), finding_key), keyed(cand.get('findings', []), finding_key),
                            ('status', 'severity', 'confidence', 'coveredBy'), ('why', 'severityReason'),
                            lambda f: str(f.get('why') or f.get('id'))[:100])
    claims = side_by_side({k: [c] for c, k in claim_keys(base.get('claims', []))}, {k: [c] for c, k in claim_keys(cand.get('claims', []))},
                          ('verdict', 'severity', 'confidence'), ('claim', 'severityReason'), lambda c: str(c.get('claim'))[:100])
    lb, lc = lost(base), lost(cand)
    cov = {'onlyBase': [k for k in lb if k not in lc], 'onlyCandidate': [k for k in lc if k not in lb], 'base': len(lb), 'candidate': len(lc)}
    verdict = {'base': base.get('verdict'), 'candidate': cand.get('verdict')}
    same = all(not v for part in (findings, claims) for v in part.values()) and lb == lc and verdict['base'] == verdict['candidate']
    return {'same': same, 'findings': findings, 'claims': claims, 'coverage': cov, 'verdict': verdict}


def collect(argv):
    p = Parser(prog='compare.py')
    sub = p.add_subparsers(dest='cmd', required=True)
    u = sub.add_parser('units')
    u.add_argument('--run', required=True)
    d = sub.add_parser('diff')
    d.add_argument('--base', required=True)
    d.add_argument('--candidate', required=True)
    a = p.parse_args(argv)
    if a.cmd == 'units':
        run = Path(a.run)
        if not (run / 'journal.jsonl').is_file():
            raise Unusable(f'{run} is not a Workflow run directory: no journal.jsonl')
        return units(run)
    return diff(result_of(a.base), result_of(a.candidate))


if __name__ == '__main__':
    sys.exit(report(collect, sys.argv[1:]))
