import json
import tomllib
import unittest
from pathlib import Path

import yaml

AGENTS = Path(__file__).resolve().parents[1] / 'agents'


class AgentFiles(unittest.TestCase):
    def test_every_agent_names_itself_and_every_codex_adapter_has_its_md(self):
        mds = {p.stem for p in AGENTS.glob('*.md')}
        self.assertLessEqual({p.stem for p in AGENTS.glob('*.toml')}, mds, 'a toml without its md')
        for stem in mds:
            with self.subTest(stem):
                self.assertEqual(yaml.safe_load((AGENTS / f'{stem}.md').read_text().split('---')[1])['name'], stem)
                if (AGENTS / f'{stem}.toml').exists():  # the toml is optional: install.py links it when present
                    toml = tomllib.loads((AGENTS / f'{stem}.toml').read_text())
                    self.assertEqual(toml['name'], stem)
                    self.assertIn(f'~/.codex/agents/{stem}.md', toml['developer_instructions'])

    def test_pr_review_validator_keeps_the_keys_tinyusb_dismissals_are_keyed_on(self):
        """tinyusb's pr-babysit keys dismissal debt on findingId and detects
        edited comments through commentDigest; its tests read this file."""
        body = (AGENTS / 'pr-review-validator.md').read_text()
        example = json.loads(body.split('## Output contract')[1].split('\n\n')[2])
        finding = example['findings'][0]
        self.assertEqual(finding['findingId'], f"{finding['commentId']}#1")
        self.assertRegex(finding['commentDigest'], r'^[0-9a-f]{12}$')
        self.assertIn('`findingId` of `<commentId>#<n>`', body)
        self.assertIn('`commentDigest` of the first 12 hex characters of that body\'s sha256', body)

    def test_pr_ci_watcher_example_carries_the_verdict_pr_babysit_keys_on(self):
        """pr-babysit fixes only verdict 'real' and stops honestly on 'unclassified'."""
        body = (AGENTS / 'pr-ci-watcher.md').read_text()
        example = json.loads(body.split('## Output contract')[1].split('\n\n')[2])
        failure = example['realFailures'][0]
        self.assertEqual(example['status'], 'red', 'a listed failure is red; the example must not teach green-with-failures')
        self.assertEqual(sorted(failure), ['check', 'files', 'firstError', 'verdict'])
        self.assertIn(failure['verdict'], ('real', 'rig-side', 'unclassified'))
        for verdict in ('"real"', '"rig-side"', '"unclassified"'):
            self.assertIn(verdict, body)
        self.assertNotIn('rigSide', body)

    def test_hw_debugger_example_carries_what_chief_adjudicates_on(self):
        """chief reads status apart from verdict and trusts a board only on a cleanup receipt."""
        body = (AGENTS / 'hw-debugger.md').read_text()
        example = json.loads(body.split('## Output contract')[1].split('\n\n')[2])
        self.assertIn(example['status'], ('complete', 'blocked', 'needs-user'))
        self.assertIn(example['verdict'], ('real', 'fixed', 'rig-side', 'not-reproduced', 'inconclusive'))
        for key in ('question', 'criterion', 'reason', 'worktree', 'branch', 'head', 'host', 'board', 'probe', 'example', 'peer',
                    'runs', 'cleanup', 'limits', 'blocker', 'next'):
            self.assertIn(key, example)
        run = example['runs'][0]
        for key in ('revision', 'configuration', 'firmware', 'instrument', 'technique', 'command', 'repetitions', 'duration',
                    'observed', 'evidence', 'artifacts'):
            self.assertIn(key, run)
        self.assertIsInstance(run['technique'], list)
        cleanup = example['cleanup']
        self.assertIn('pristine', cleanup)
        self.assertEqual(sorted(cleanup['flashVerify']), ['command', 'result'], 'a hash alone does not verify a flash')
        for key in ('sourceRestored', 'clientsStopped', 'hostRestored', 'lockReleased'):
            self.assertIn(cleanup[key], ('done', 'failed', 'n-a'))
        for verdict in ('`real`', '`fixed`', '`rig-side`', '`not-reproduced`', '`inconclusive`'):
            self.assertIn(verdict, body)


if __name__ == '__main__':
    unittest.main()
