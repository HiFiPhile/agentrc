"""Tests for ci-rerun's circleci.py against a fake job endpoint and a fake CLI."""
import importlib.util
import io
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'skills' / 'ci-rerun' / 'scripts' / 'circleci.py'
spec = importlib.util.spec_from_file_location('ci_circleci', SCRIPT)
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

W1, W2, NEW = '3a705162-e09b-4ef8-9488-d034f9818421', '7a72feba-da90-4613-bd4e-7b6b4b674475', 'd2814134-464c-4966-9dff-c403909287d9'
BASE = 'https://circleci.com/api/v1.1/project/github/o/r/'


class CircleciTest(unittest.TestCase):
    def setUp(self):
        self.jobs = {}      # number -> record
        self.outputs = {}   # output_url -> messages
        self.cli = []       # argv of each circleci call
        self.cli_result = lambda wid: (0, json.dumps({'workflow_id': NEW}), '')

        def fetch(url):
            if url.startswith(BASE):
                n = url[len(BASE):]
                if n in self.jobs:
                    return self.jobs[n]
                raise ci.Failed(f'{url}: HTTP Error 404')
            if url in self.outputs:
                return self.outputs[url]
            raise ci.Failed(f'{url}: HTTP Error 502')

        def run(argv, **kw):
            self.cli.append(argv)
            rc, out, err = self.cli_result(argv[3])
            return mock.Mock(returncode=rc, stdout=out, stderr=err)
        for target, fake in (('fetch', fetch), ('subprocess', mock.Mock(run=run))):
            patcher = mock.patch.object(ci, target, fake)
            patcher.start()
            self.addCleanup(patcher.stop)

    def job(self, number, wid, steps=()):
        self.jobs[str(number)] = {'workflows': {'workflow_id': wid}, 'steps': list(steps)}

    def main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = ci.main([*argv, '--repo', 'o/r'])
        return rc, out.getvalue(), err.getvalue()

    def test_jobs_of_one_workflow_are_one_rerun(self):
        self.job(1, W1); self.job(2, W1); self.job(3, W2)
        rc, out, _ = self.main('rerun', '1', '2', '3')
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out.strip().splitlines()[-1]), {'reruns': [
            {'workflow': W1, 'jobs': [1, 2], 'newWorkflow': NEW}, {'workflow': W2, 'jobs': [3], 'newWorkflow': NEW}], 'errors': []})
        self.assertEqual(self.cli, [['circleci', 'workflow', 'rerun', W1, '--from-failed', '--json'],
                                    ['circleci', 'workflow', 'rerun', W2, '--from-failed', '--json']])

    def test_unknown_job_and_failed_cli_are_errors_the_rest_still_runs(self):
        self.job(1, W1); self.job(3, W2)
        self.cli_result = lambda wid: (0, json.dumps({'workflow_id': NEW}), '') if wid == W2 else (1, '', 'Unauthorized')
        rc, out, _ = self.main('rerun', '1', '2', '3')
        self.assertEqual(rc, 1)
        r = json.loads(out.strip().splitlines()[-1])
        self.assertEqual(r['reruns'], [{'workflow': W2, 'jobs': [3], 'newWorkflow': NEW}])
        self.assertEqual(len(r['errors']), 2)
        self.assertIn('404', r['errors'][0])
        self.assertIn('Unauthorized', r['errors'][1])

    def test_a_record_without_a_workflow_uuid_is_refused(self):
        self.jobs['5'] = {'workflows': {'workflow_id': 'build'}}
        rc, out, _ = self.main('rerun', '5')
        self.assertEqual(rc, 1)
        self.assertEqual(self.cli, [])
        self.assertIn('no workflow id', json.loads(out)['errors'][0])

    def test_a_cli_answer_without_a_new_workflow_is_an_error(self):
        self.job(1, W1)
        self.cli_result = lambda wid: (0, 'not json', '')
        rc, out, _ = self.main('rerun', '1')
        self.assertEqual(rc, 1)
        self.assertIn('rerun failed', json.loads(out)['errors'][0])

    def test_log_prints_the_failed_steps_tail(self):
        self.job(9, W1, [{'name': 'Checkout code', 'actions': [{'status': 'success', 'output_url': 'u0'}]},
                         {'name': 'Build', 'actions': [{'status': 'failed', 'output_url': 'u1'}]}])
        self.outputs['u1'] = [{'message': 'line1\nline2\n'}, {'message': 'FAILED: x\n'}]
        rc, out, _ = self.main('log', '9', '--lines', '2')
        self.assertEqual(rc, 0)
        self.assertEqual(out, '== Build\nline2\nFAILED: x\n')

    def test_log_without_a_failed_step_is_an_error(self):
        self.job(9, W1, [{'name': 'Build', 'actions': [{'status': 'success', 'output_url': 'u0'}]}])
        rc, _, err = self.main('log', '9')
        self.assertEqual(rc, 1)
        self.assertIn('no failed step', err)


if __name__ == '__main__':
    unittest.main()
