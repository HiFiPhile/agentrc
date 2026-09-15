"""Tests for pr-reply's reply.py against a fake GitHub behind the gh calls."""
import importlib.util
import io
import json
import re
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'skills' / 'pr-reply' / 'scripts' / 'reply.py'
spec = importlib.util.spec_from_file_location('pr_reply', SCRIPT)
reply = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reply)

REPO, PR, ME = 'o/r', 7, 'hathach'


class FakeGitHub:
    """Review and issue comments on one PR, threads over the review comments,
    and a log of every mutation the script performed."""

    def __init__(self):
        self.review = {}   # id -> comment
        self.issue = {}    # id -> comment
        self.threads = {}  # thread node id -> {ids: [...], resolved: bool}
        self.next_id = 900
        self.mutations = []
        self.calls = []

    def review_comment(self, cid, body='bot says', login='bot', thread=None, parent=None):
        self.review[cid] = {'id': cid, 'body': body, 'user': {'login': login}, 'in_reply_to_id': parent,
                            'pull_request_url': f'https://api.github.com/repos/{REPO}/pulls/{PR}',
                            'html_url': f'https://github.com/{REPO}/pull/{PR}#discussion_r{cid}'}
        t = thread or f'T{cid}'
        self.threads.setdefault(t, {'ids': [], 'resolved': False})['ids'].append(cid)

    def issue_comment(self, cid, body='bot summary', login='bot'):
        self.issue[cid] = {'id': cid, 'body': body, 'user': {'login': login},
                           'issue_url': f'https://api.github.com/repos/{REPO}/issues/{PR}',
                           'html_url': f'https://github.com/{REPO}/pull/{PR}#issuecomment-{cid}'}

    def gh(self, args, stdin=None):
        self.calls.append(args)
        if args[:2] == ['api', 'graphql']:
            return self.graphql(args)
        if args[0] != 'api':
            return 1, '', 'unexpected gh call'
        method, path = args[2], args[3]
        body = json.loads(stdin) if stdin else None
        try:
            return 0, json.dumps(self.rest(method, path, body, '--paginate' in args)), ''
        except KeyError:
            return 1, '', f'gh: Not Found (HTTP 404)\n{path}'

    def rest(self, method, path, body, paginate):
        path = path.split('?')[0]
        pages = (lambda xs: [list(xs)]) if paginate else (lambda xs: list(xs))
        if path == 'user':
            return {'login': ME}
        m = re.fullmatch(rf'repos/{REPO}/pulls/{PR}/comments', path)
        if m and method == 'GET':
            return pages(self.review.values())
        m = re.fullmatch(rf'repos/{REPO}/issues/{PR}/comments', path)
        if m and method == 'GET':
            return pages(self.issue.values())
        if m and method == 'POST':
            self.mutations.append(('post-issue', body['body']))
            cid = self.next_id = self.next_id + 1
            self.issue_comment(cid, body['body'], ME)
            return self.issue[cid]
        m = re.fullmatch(rf'repos/{REPO}/pulls/{PR}/comments/(\d+)/replies', path)
        if m and method == 'POST':
            parent = int(m.group(1))
            if parent not in self.review:
                raise KeyError(parent)
            self.mutations.append(('post-reply', parent, body['body']))
            cid = self.next_id = self.next_id + 1
            thread = next(t for t, v in self.threads.items() if parent in v['ids'])
            self.review_comment(cid, body['body'], ME, thread=thread, parent=parent)
            return self.review[cid]
        m = re.fullmatch(rf'repos/{REPO}/pulls/comments/(\d+)', path)
        if m and method == 'GET':
            return self.review[int(m.group(1))]
        m = re.fullmatch(rf'repos/{REPO}/issues/comments/(\d+)', path)
        if m and method == 'GET':
            return self.issue[int(m.group(1))]
        self.mutations.append(('unexpected', method, path))
        raise KeyError(path)

    def graphql(self, args):
        q = next(a for a in args if a.startswith('query='))
        if q.startswith('query=mutation'):
            tid = next(a for a in args if a.startswith('id=')).split('=', 1)[1]
            self.mutations.append(('resolve', tid))
            self.threads[tid]['resolved'] = True
            return 0, json.dumps({'data': {'resolveReviewThread': {'thread': {'isResolved': True}}}}), ''
        nodes = [{'id': t, 'isResolved': v['resolved'], 'comments': {'nodes': [{'databaseId': i} for i in v['ids']]}}
                 for t, v in self.threads.items()]
        return 0, json.dumps({'data': {'repository': {'pullRequest': {'reviewThreads': {
            'pageInfo': {'hasNextPage': False, 'endCursor': None}, 'nodes': nodes}}}}}), ''


class ReplyTest(unittest.TestCase):
    def setUp(self):
        self.gh = FakeGitHub()
        patcher = mock.patch.object(reply, 'gh', self.gh.gh)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_script(self, replies, raw=False):
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
            json.dump({'replies': replies if raw else [{'digest': reply.fnv1a(r['body']), **r} if isinstance(r.get('body'), str) else r
                                                      for r in replies]}, f)
        out = io.StringIO()
        with redirect_stdout(out):
            rc = reply.main(['--pr', str(PR), '--manifest', f.name, '--repo', REPO])
        lines = out.getvalue().strip().splitlines()
        return rc, json.loads(lines[-1])['receipts'] if lines else []

    def test_review_reply_is_posted_read_back_and_resolved(self):
        self.gh.review_comment(10)
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'not so: see line 3'}])
        self.assertEqual(rc, 0)
        self.assertEqual(receipts, [{'commentId': 10, 'kind': 'review', 'replyId': 901, 'digest': reply.fnv1a('not so: see line 3'),
                                     'sent': True, 'posted': True, 'verified': True, 'resolved': True, 'error': None}])
        self.assertEqual(self.gh.mutations, [('post-reply', 10, 'not so: see line 3'), ('resolve', 'T10')])
        self.assertTrue(self.gh.threads['T10']['resolved'])

    def test_identical_existing_reply_is_reused_not_reposted(self):
        self.gh.review_comment(10)
        self.gh.review_comment(55, 'already said', ME, thread='T10', parent=10)
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'already said'}])
        self.assertEqual(rc, 0)
        self.assertEqual(receipts[0]['replyId'], 55)
        self.assertFalse(receipts[0]['posted'])
        self.assertEqual(self.gh.mutations, [('resolve', 'T10')])

    def test_read_back_mismatch_leaves_thread_open(self):
        self.gh.review_comment(10)
        real_post = self.gh.rest

        def mangling(method, path, body, paginate):
            if method == 'POST' and body:
                body = {'body': '@/tmp/body.txt'}  # what a wrong flag would have sent
            return real_post(method, path, body, paginate)
        self.gh.rest = mangling
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'the intended text'}])
        self.assertEqual(rc, 1)
        r = receipts[0]
        self.assertEqual((r['replyId'], r['posted'], r['verified'], r['resolved']), (901, True, False, None))
        self.assertIn('body', r['error'])
        self.assertFalse(self.gh.threads['T10']['resolved'])
        self.assertNotIn(('resolve', 'T10'), self.gh.mutations)

    def test_issue_comment_gets_quote_line_and_no_resolve(self):
        self.gh.issue_comment(20)
        rc, receipts = self.run_script([{'commentId': 20, 'body': 'seven points answered'}])
        self.assertEqual(rc, 0)
        r = receipts[0]
        self.assertEqual((r['kind'], r['verified'], r['resolved']), ('issue', True, None))
        self.assertEqual(self.gh.mutations, [('post-issue', f'> https://github.com/{REPO}/pull/{PR}#issuecomment-20\n\nseven points answered')])

    def test_unknown_comment_posts_nothing(self):
        rc, receipts = self.run_script([{'commentId': 99, 'body': 'x'}])
        self.assertEqual(rc, 1)
        self.assertIn('not on PR', receipts[0]['error'])
        self.assertEqual(self.gh.mutations, [])

    def test_one_failure_does_not_stop_the_others(self):
        self.gh.review_comment(10)
        rc, receipts = self.run_script([{'commentId': 99, 'body': 'x'}, {'commentId': 10, 'body': 'ok'}])
        self.assertEqual(rc, 1)
        self.assertEqual([r['verified'] for r in receipts], [False, True])

    def test_already_resolved_thread_is_left_alone(self):
        self.gh.review_comment(10)
        self.gh.threads['T10']['resolved'] = True
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'ok'}])
        self.assertEqual(rc, 0)
        self.assertTrue(receipts[0]['resolved'])
        self.assertEqual([m[0] for m in self.gh.mutations], ['post-reply'])

    def test_bad_manifest_is_exit_2_without_api_calls(self):
        for bad in ([], [{'commentId': '10', 'body': 'x'}], [{'commentId': 10, 'body': ' '}],
                    [{'commentId': 10, 'body': 'a'}, {'commentId': 10, 'body': 'b'}],
                    [{'commentId': 10, 'body': 'a', 'digest': None}]):
            with self.subTest(bad=bad):
                rc, receipts = self.run_script(bad)
                self.assertEqual(rc, 2)
                self.assertEqual(self.gh.calls, [])

    def test_digest_mismatch_posts_nothing(self):
        self.gh.review_comment(10)
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'transcribed wrong', 'digest': reply.fnv1a('the intended text')}])
        self.assertEqual(rc, 1)
        self.assertEqual(receipts[0]['error'], 'manifest body does not match its digest')
        self.assertEqual(self.gh.mutations, [])
        self.assertEqual([a for a in self.gh.calls if a[0] == 'api' and a[2] != 'GET'], [])

    def test_matching_digest_is_echoed_in_the_receipt(self):
        self.gh.review_comment(10)
        d = reply.fnv1a('right')
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'right', 'digest': d}])
        self.assertEqual((rc, receipts[0]['digest'], receipts[0]['verified']), (0, d, True))

    def test_unavailable_read_back_is_null_not_a_mismatch(self):
        self.gh.review_comment(10)
        real = self.gh.rest

        def flaky(method, path, body, paginate):
            if method == 'GET' and re.fullmatch(rf'repos/{REPO}/pulls/comments/\d+', path):
                raise KeyError('HTTP 502')
            return real(method, path, body, paginate)
        self.gh.rest = flaky
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'ok'}])
        self.assertEqual(rc, 1)
        r = receipts[0]
        self.assertEqual((r['replyId'], r['verified'], r['resolved']), (901, None, None))
        self.assertIn('read-back unavailable', r['error'])
        self.assertFalse(self.gh.threads['T10']['resolved'])
        # the retry with the same body reuses the reply and only resolves
        self.gh.rest = real
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'ok'}])
        self.assertEqual((rc, receipts[0]['replyId'], receipts[0]['posted'], receipts[0]['resolved']), (0, 901, False, True))
        self.assertEqual([m[0] for m in self.gh.mutations], ['post-reply', 'resolve'])

    def test_graphql_strings_go_through_f_and_the_number_through_F(self):
        self.gh.review_comment(10)
        self.run_script([{'commentId': 10, 'body': 'ok'}])
        q = next(a for a in self.gh.calls if a[:2] == ['api', 'graphql'] and any(x.startswith('o=') for x in a))
        self.assertIn('-f', q[q.index('o=o') - 1])
        self.assertIn('-f', q[q.index('r=r') - 1])
        self.assertEqual(q[q.index(f'p={PR}') - 1], '-F')

    def test_documented_manifest_works_as_written(self):
        # SKILL.md's example, digest computed the way it says, no test-side augmentation
        self.gh.review_comment(10)
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(reply.main(['--digest', 'hello']), 0)
        digest = out.getvalue().strip()
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'hello', 'digest': digest}], raw=True)
        self.assertEqual((rc, receipts[0]['verified']), (0, True))
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'hello'}], raw=True)
        self.assertEqual(rc, 2, 'an entry without a digest is refused')

    def test_lost_response_reports_sent_without_a_reply_id(self):
        self.gh.review_comment(10)
        real = self.gh.rest

        def lost(method, path, body, paginate):
            r = real(method, path, body, paginate)
            if method == 'POST':
                raise KeyError('connection reset')  # GitHub stored it, the answer never came
            return r
        self.gh.rest = lost
        rc, receipts = self.run_script([{'commentId': 10, 'body': 'ok'}])
        r = receipts[0]
        self.assertEqual((rc, r['sent'], r['posted'], r['replyId'], r['verified']), (1, True, False, None, False))
        self.assertEqual(len(self.gh.review), 2, 'the reply exists on GitHub')
        # a failure before any POST says so
        rc, receipts = self.run_script([{'commentId': 99, 'body': 'x'}])
        self.assertEqual((receipts[0]['sent'], receipts[0]['replyId']), (False, None))

    def test_never_edits_or_deletes(self):
        self.gh.review_comment(10)
        self.gh.review_comment(55, 'wrong text', ME, thread='T10', parent=10)
        self.run_script([{'commentId': 10, 'body': 'right text'}])
        methods = {a[2] for a in self.gh.calls if a[0] == 'api' and len(a) > 3 and a[1] == '-X'}
        self.assertLessEqual(methods, {'GET', 'POST'})


if __name__ == '__main__':
    unittest.main()
