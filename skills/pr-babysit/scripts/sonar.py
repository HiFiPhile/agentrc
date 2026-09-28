#!/usr/bin/env python3
"""Mark the SonarCloud issues behind a PR's code-scanning comments false positive.

  sonar.py --pr N --head SHA --manifest FILE

FILE holds {"items": [{"commentId", "commentDigest", "how", "note", "digest"}]}:
how is "refutation" or "fixNote", digest the workflow's fnv1a of note, and
commentDigest harvest.py's digest of the comment body the note answered. Each
comment is read from GitHub; only a github-advanced-security[bot] comment on
PR N, still that body, carrying a SONAR_ISSUE_KEY and a sonarcloud.io link to
PR N names an issue. The issue is read on the PR from SonarCloud with
$SONAR_TOKEN, which goes to https://sonarcloud.io only. Each item's outcome:

  skipped   the comment names no SonarCloud issue of PR N, or was edited
            since its answer
  resolved  the issue is already resolved or closed; nothing changed
  waiting   a fixNote item whose PR analysis is not of SHA: whether the fix
            cleared the issue is not known yet
  marked    the issue was open: note added as its comment, unless an identical
            one is there, then transitioned to false positive and read back so
  failed    a request failed or the read-back disagrees; detail says which

stdout ends with one JSON line {results: [{commentId, issue, outcome, detail}],
seal} (seal: facts.sealed). Exit 2 with {"error": ...} when the arguments or
manifest are wrong or SONAR_TOKEN is unset, and then nothing was changed.
"""

import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from facts import FULL_SHA, Parser, Unusable, attempt, fnv1a, report  # noqa: E402
from harvest import digest  # noqa: E402

HOST = 'https://sonarcloud.io'
BOT = 'github-advanced-security[bot]'
KEY = re.compile(r'<!--SONAR_ISSUE_KEY:([A-Za-z0-9_-]+)-->')
LINK = re.compile(r'https://sonarcloud\.io/project/issues\?[^"\s<>]+')
OPEN = ('OPEN', 'CONFIRMED', 'REOPENED')


class Failed(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# urllib carries the Authorization header across a redirect to any host.
OPENER = urllib.request.build_opener(NoRedirect)


def sonar(token, path, data=None):
    """One SonarCloud API call; the parsed JSON body, {} when there is none."""
    auth = base64.b64encode(f'{token}:'.encode()).decode()
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(f'{HOST}{path}', data=body, headers={'Authorization': f'Basic {auth}'})
    try:
        with OPENER.open(req, timeout=30) as r:
            text = r.read().decode()
    except urllib.error.HTTPError as e:
        raise Failed(f'{path.split("?")[0]}: HTTP {e.code} {e.msg}: {e.read().decode(errors="replace")[:200]}')
    except (urllib.error.URLError, OSError) as e:
        raise Failed(f'{path.split("?")[0]}: {e}')
    try:
        return json.loads(text) if text.strip() else {}
    except ValueError:
        raise Failed(f'{path.split("?")[0]}: response is not JSON')


def issue_of(comment_id, comment_digest, pr):
    """(project, issue key) the comment names, or a str saying why it names none."""
    code, out, err = attempt('gh', 'api', f'repos/{{owner}}/{{repo}}/pulls/comments/{comment_id}')
    if code:
        raise Failed(f'reading comment {comment_id}: {err.strip()}')
    try:
        c = json.loads(out)
    except ValueError:
        raise Failed(f'reading comment {comment_id}: gh printed no JSON')
    if (c.get('user') or {}).get('login') != BOT:
        return f"posted by {(c.get('user') or {}).get('login')}, not {BOT}"
    if not str(c.get('pull_request_url', '')).endswith(f'/pulls/{pr}'):
        return f'not a comment on PR #{pr}'
    body = c.get('body') or ''
    if digest(body) != comment_digest:
        return 'edited since its answer'
    key, links = KEY.search(body), LINK.findall(body)
    if not key or not links:
        return 'no SonarCloud issue key and link'
    q = urllib.parse.parse_qs(urllib.parse.urlparse(links[0]).query)
    if q.get('pullRequest') != [str(pr)] or q.get('issues') != [key.group(1)] or len(q.get('id', [])) != 1:
        return f'its SonarCloud link is not to issue {key.group(1)} of PR #{pr}'
    return q['id'][0], key.group(1)


def read_issue(token, project, key, pr):
    q = urllib.parse.urlencode({'componentKeys': project, 'issues': key, 'pullRequest': pr,
                                'additionalFields': 'comments,transitions'})
    found = [i for i in sonar(token, f'/api/issues/search?{q}').get('issues', []) if i.get('key') == key]
    if len(found) != 1:
        raise Failed(f'SonarCloud has no issue {key} on PR #{pr} of {project}')
    return found[0]


def analysed_head(token, project, pr):
    q = urllib.parse.urlencode({'project': project})
    prs = [p for p in sonar(token, f'/api/project_pull_requests/list?{q}').get('pullRequests', []) if p.get('key') == str(pr)]
    return ((prs[0].get('commit') or {}).get('sha') if prs else None) or None


def settle(token, item, pr, head, heads):
    found = issue_of(item['commentId'], item['commentDigest'], pr)
    if isinstance(found, str):
        return None, 'skipped', found
    project, key = found
    issue = read_issue(token, project, key, pr)
    if issue.get('status') not in OPEN:
        return key, 'resolved', f"{issue.get('status')} {issue.get('resolution') or ''}".strip()
    if item['how'] == 'fixNote':
        if project not in heads:
            heads[project] = analysed_head(token, project, pr)
        if heads[project] != head:
            return key, 'waiting', f"SonarCloud analysed {(heads[project] or 'nothing')[:12]}, not {head[:12]}"
    if 'falsepositive' not in (issue.get('transitions') or []):
        return key, 'failed', f"no falsepositive transition for this token: {issue.get('transitions')}"
    if not any(c.get('markdown') == item['note'] for c in issue.get('comments') or []):
        sonar(token, '/api/issues/add_comment', {'issue': key, 'text': item['note']})
    sonar(token, '/api/issues/do_transition', {'issue': key, 'transition': 'falsepositive'})
    after = read_issue(token, project, key, pr)
    if after.get('resolution') != 'FALSE-POSITIVE':
        return key, 'failed', f"read back {after.get('status')} {after.get('resolution')}, not FALSE-POSITIVE"
    return key, 'marked', 'false positive'


def items_of(path):
    try:
        m = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise Unusable(f'manifest {path}: {e}')
    items = m.get('items') if isinstance(m, dict) else None
    if not isinstance(items, list) or not items:
        raise Unusable('manifest has no items')
    for x in items:
        if not (isinstance(x, dict) and isinstance(x.get('commentId'), int) and isinstance(x.get('commentDigest'), str)
                and x.get('how') in ('refutation', 'fixNote')
                and isinstance(x.get('note'), str) and x['note'].strip() and isinstance(x.get('digest'), str)):
            raise Unusable(f'malformed item: {json.dumps(x)[:200]}')
        if fnv1a(x['note']) != x['digest']:
            raise Unusable(f"item {x['commentId']}: note does not match its digest; copy the manifest exactly")
    if len({x['commentId'] for x in items}) != len(items):
        raise Unusable('manifest names a comment twice')
    return items


def mark(argv):
    p = Parser(prog='sonar.py', add_help=False)
    p.add_argument('--pr', type=int, required=True)
    p.add_argument('--head', required=True)
    p.add_argument('--manifest', required=True)
    a = p.parse_args(argv)
    if not FULL_SHA.match(a.head):
        raise Unusable(f'not a full SHA: {a.head!r}')
    items = items_of(a.manifest)
    token = os.environ.get('SONAR_TOKEN', '').strip()
    if not token:
        raise Unusable('SONAR_TOKEN is not set')
    results, heads = [], {}
    for item in items:
        try:
            key, outcome, detail = settle(token, item, a.pr, a.head, heads)
        except Failed as e:
            key, outcome, detail = None, 'failed', str(e)
        results.append({'commentId': item['commentId'], 'issue': key, 'outcome': outcome, 'detail': detail})
    return {'results': results}


if __name__ == '__main__':
    sys.exit(report(mark, sys.argv[1:], seal=True))
