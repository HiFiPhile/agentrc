#!/usr/bin/env python3
"""Post PR review replies from a manifest, read each back, resolve its thread.

  reply.py --pr N --manifest FILE [--repo OWNER/NAME]

FILE: {"replies": [{"commentId": <int>, "body": "<text>", "digest": "<fnv1a>"}, ...]},
digest being the caller's FNV-1a (32-bit, over code points, 8 hex) of the body,
which the body must match before anything is posted. Each commentId names one
of three things on the PR: a review comment (an inline thread), an issue comment,
or a review whose body carries the finding (a bot's summary, or a point GitHub
would not anchor inline). A reply of ours with the identical body already under
the comment is reused, never posted twice. A review reply is read back and must
match the body, the parent, our login and the PR before its thread is resolved;
the other two have no thread: the reply is an issue comment whose body is the
original's URL as a quote line plus the text. Nothing is ever edited or deleted.

stdout ends with one JSON line {"receipts": [{"commentId", "kind", "replyId",
"digest", "sent", "posted", "verified", "resolved", "error"}]}: kind is
"review", "issue" or "review-body", "none" when all three were searched and the
id is on none of them (the caller owes it nothing), null when a lookup failed
before that was known; sent says a POST was issued (a lost response leaves sent true and replyId null: the
reply may exist), posted that GitHub answered it, verified is true on a
matching read-back, false on a mismatch and null when the read-back could not
be fetched. `reply.py --digest TEXT` prints TEXT's digest for a manifest
written by hand. Exit 0 when every reply is verified and, for a review
reply, resolved; 1 otherwise; 2 on a usage or manifest error.
"""

import argparse
import json
import subprocess
import sys

THREADS_QUERY = ('query($o:String!,$r:String!,$p:Int!,$c:String){repository(owner:$o,name:$r){'
                 'pullRequest(number:$p){reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor}'
                 'nodes{id isResolved comments(first:50){nodes{databaseId}}}}}}}')
RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'


class ApiError(Exception):
    pass


def fnv1a(text):
    """The same checksum pr-babysit computes over a body it hands out."""
    h = 0x811c9dc5
    for ch in text:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xffffffff
    return f'{h:08x}'


def gh(args, stdin=None):
    r = subprocess.run(['gh', *args], input=stdin, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def api(method, path, body=None, paginate=False):
    """One REST call through gh; a failure becomes ApiError carrying gh's diagnostic."""
    args = ['api', '-X', method, path]
    if paginate:
        args += ['--paginate', '--slurp']
    stdin = None
    if body is not None:
        args += ['--input', '-']
        stdin = json.dumps(body)
    rc, out, err = gh(args, stdin)
    if rc != 0:
        raise ApiError(err.strip() or out.strip())
    if not out.strip():
        return None
    data = json.loads(out)
    if paginate:
        return [x for page in data for x in page]
    return data


def graphql(query, variables):
    """-f keeps a string a string (a repo named 123 must not become a number);
    -F is for the integer PR number."""
    args = ['api', 'graphql', '-f', f'query={query}']
    for k, v in variables.items():
        args += ['-F' if isinstance(v, int) else '-f', f'{k}={v}']
    rc, out, err = gh(args)
    if rc != 0:
        raise ApiError(err.strip() or out.strip())
    return json.loads(out)


class Poster:
    def __init__(self, repo, pr):
        self.repo, self.pr = repo, pr
        self.me = api('GET', 'user')['login']
        self._review = None
        self._issue = None
        self._reviews = None

    def review_comments(self):
        if self._review is None:
            self._review = api('GET', f'repos/{self.repo}/pulls/{self.pr}/comments?per_page=100', paginate=True)
        return self._review

    def issue_comments(self):
        if self._issue is None:
            self._issue = api('GET', f'repos/{self.repo}/issues/{self.pr}/comments?per_page=100', paginate=True)
        return self._issue

    def reviews(self):
        if self._reviews is None:
            self._reviews = api('GET', f'repos/{self.repo}/pulls/{self.pr}/reviews?per_page=100', paginate=True)
        return self._reviews

    def kind_of(self, comment_id):
        """('review', comment) for an inline review comment on this PR, ('issue',
        comment) for an issue comment on it, ('review-body', review) for a review
        whose body is the target, ('none', None) when all three were searched and
        none has the id; ApiError when a lookup failed or the id is ambiguous."""
        found = [(kind, c) for kind, pool in (('review', self.review_comments()), ('issue', self.issue_comments()),
                                              ('review-body', self.reviews()))
                 for c in pool if c['id'] == comment_id]
        if len(found) > 1:
            raise ApiError(f'id {comment_id} is ambiguous on PR #{self.pr}: {", ".join(k for k, _ in found)}')
        return found[0] if found else ('none', None)

    def existing(self, kind, comment_id, body):
        pool = self.review_comments() if kind == 'review' else self.issue_comments()
        for c in pool:
            if c['user']['login'] != self.me or c['body'] != body:
                continue
            if kind != 'review' or c.get('in_reply_to_id') == comment_id:
                return c['id']
        return None

    def post(self, kind, comment_id, body):
        if kind == 'review':
            c = api('POST', f'repos/{self.repo}/pulls/{self.pr}/comments/{comment_id}/replies', {'body': body})
        else:
            c = api('POST', f'repos/{self.repo}/issues/{self.pr}/comments', {'body': body})
        return c['id']

    def verify(self, kind, comment_id, reply_id, body):
        """(True, None) on a matching read-back, (False, why) on a mismatch,
        (None, why) when the reply could not be fetched."""
        try:
            c = api('GET', f'repos/{self.repo}/{"pulls" if kind == "review" else "issues"}/comments/{reply_id}')
        except ApiError as e:
            return None, f'read-back unavailable: {e}'
        if kind == 'review':
            checks = [('body', c.get('body') == body), ('parent', c.get('in_reply_to_id') == comment_id),
                      ('author', c.get('user', {}).get('login') == self.me),
                      ('pr', str(c.get('pull_request_url', '')).endswith(f'/pulls/{self.pr}'))]
        else:
            checks = [('body', c.get('body') == body), ('author', c.get('user', {}).get('login') == self.me),
                      ('pr', str(c.get('issue_url', '')).endswith(f'/issues/{self.pr}'))]
        bad = [name for name, ok in checks if not ok]
        return (True, None) if not bad else (False, f'read-back mismatch on {", ".join(bad)}')

    def resolve(self, comment_id):
        owner, name = self.repo.split('/', 1)
        cursor = None
        while True:
            v = {'o': owner, 'r': name, 'p': self.pr}
            if cursor:
                v['c'] = cursor
            page = graphql(THREADS_QUERY, v)['data']['repository']['pullRequest']['reviewThreads']
            for t in page['nodes']:
                if any(c['databaseId'] == comment_id for c in t['comments']['nodes']):
                    if t['isResolved']:
                        return None
                    r = graphql(RESOLVE_MUTATION, {'id': t['id']})
                    ok = r.get('data', {}).get('resolveReviewThread', {}).get('thread', {}).get('isResolved')
                    return None if ok else 'resolve mutation did not report isResolved'
            if not page['pageInfo']['hasNextPage']:
                return f'no review thread contains comment {comment_id}'
            cursor = page['pageInfo']['endCursor']


def issue_body(original, body):
    return f"> {original['html_url']}\n\n{body}"


def handle(poster, item):
    rc = {'commentId': item['commentId'], 'kind': None, 'replyId': None, 'digest': fnv1a(item['body']),
          'sent': False, 'posted': False, 'verified': False, 'resolved': None, 'error': None}
    if item['digest'] != rc['digest']:
        rc['error'] = 'manifest body does not match its digest'
        return rc
    try:
        kind, original = poster.kind_of(item['commentId'])
        rc['kind'] = kind
        if kind == 'none':
            rc['error'] = f'comment {item["commentId"]} is not on PR #{poster.pr}'
            return rc
        body = item['body'] if kind == 'review' else issue_body(original, item['body'])
        reply_id = poster.existing(kind, item['commentId'], body)
        if reply_id is None:
            rc['sent'] = True
            reply_id = poster.post(kind, item['commentId'], body)
            rc['posted'] = True
        rc['replyId'] = reply_id
        rc['verified'], rc['error'] = poster.verify(kind, item['commentId'], reply_id, body)
        if rc['verified'] and kind == 'review':
            rc['error'] = poster.resolve(item['commentId'])
            rc['resolved'] = rc['error'] is None
    except ApiError as e:
        rc['error'] = str(e)
    return rc


def load_manifest(path):
    with open(path) as f:
        m = json.load(f)
    replies = m.get('replies') if isinstance(m, dict) else None
    if not isinstance(replies, list) or not replies:
        raise ValueError('manifest needs a non-empty "replies" list')
    seen = set()
    for r in replies:
        if not isinstance(r.get('commentId'), int) or not isinstance(r.get('body'), str) or not r['body'].strip():
            raise ValueError(f'bad manifest entry: {r!r}')
        if not isinstance(r.get('digest'), str):
            raise ValueError(f'manifest entry without a digest: {r!r}')
        if r['commentId'] in seen:
            raise ValueError(f'commentId {r["commentId"]} listed twice')
        seen.add(r['commentId'])
    return replies


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--pr', type=int)
    p.add_argument('--manifest')
    p.add_argument('--repo', help='OWNER/NAME (default: gh repo view)')
    p.add_argument('--digest', metavar='TEXT', help='print the digest of TEXT and exit')
    a = p.parse_args(argv)
    if a.digest is not None:
        print(fnv1a(a.digest))
        return 0
    if a.pr is None or a.manifest is None:
        p.error('--pr and --manifest are required')
    try:
        replies = load_manifest(a.manifest)
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f'reply.py: {e}', file=sys.stderr)
        return 2
    repo = a.repo
    if not repo:
        rc, out, err = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])
        if rc != 0:
            print(f'reply.py: {err.strip()}', file=sys.stderr)
            return 2
        repo = out.strip()
    try:
        poster = Poster(repo, a.pr)
    except ApiError as e:
        print(f'reply.py: {e}', file=sys.stderr)
        return 2
    receipts = [handle(poster, item) for item in replies]
    print(json.dumps({'receipts': receipts}))
    ok = all(r['verified'] is True and (r['kind'] != 'review' or r['resolved']) for r in receipts)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
