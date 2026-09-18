import json
import tomllib
import unittest
from pathlib import Path

import yaml

AGENTS = Path(__file__).resolve().parents[1] / 'agents'
SKILLS = AGENTS.parent / 'skills'


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

    def test_hw_validator_example_carries_what_chief_adjudicates_on(self):
        """chief reads status apart from verdict and trusts a board only on a cleanup receipt."""
        body = (AGENTS / 'hw-validator.md').read_text()
        example = json.loads(body.split('## Output contract')[1].split('\n\n')[2])
        self.assertIn(example['status'], ('complete', 'blocked', 'needs-user'))
        self.assertIn(example['verdict'], ('real', 'fixed', 'rig-side', 'not-reproduced', 'inconclusive'))
        for key in ('question', 'criterion', 'reason', 'worktree', 'branch', 'head', 'host', 'board', 'probe', 'example', 'peer',
                    'runs', 'cleanup', 'budget', 'limits', 'blocker', 'next'):
            self.assertIn(key, example)
        for row in example['runs']:
            self.assertIn(row['purpose'], ('criterion', 'setup', 'cleanup'))
        self.assertEqual(sum(row['repetitions'] for row in example['runs']), example['budget']['used']['repetitions'])
        criterion = sum(row['repetitions'] for row in example['runs'] if row['purpose'] == 'criterion')
        self.assertLess(criterion, example['budget']['used']['repetitions'], 'auxiliary invocations are counted apart from the criterion runs')
        self.assertLess(example['budget']['used']['observationS'],
                        example['budget']['allowed']['observationWindowS'] * example['budget']['used']['repetitions'],
                        'a deterministic attempt ends before the window ceiling')
        run = example['runs'][0]
        for key in ('revision', 'configuration', 'firmware', 'instrument', 'technique', 'command', 'repetitions', 'duration',
                    'observed', 'evidence', 'artifacts'):
            self.assertIn(key, run)
        self.assertIsInstance(run['technique'], list)
        cleanup = example['cleanup']
        self.assertIn('pristine', cleanup)
        self.assertEqual(sorted(cleanup['flashVerify']), ['command', 'result'], 'a hash alone does not verify a flash')
        for key in ('instrumentRemoved', 'clientsStopped', 'hostRestored', 'lockReleased'):
            self.assertIn(cleanup[key], ('done', 'failed', 'n-a'))
        self.assertIn(cleanup['sourceDisposition'], ('restored', 'unrestored'))
        self.assertEqual(sorted(cleanup['runState']), ['command', 'result'], 'a verified flash alone does not restore the run state')
        allowed, used = example['budget']['allowed'], example['budget']['used']
        for key in ('wallMin', 'cleanupReserveMin', 'lockWaitMin', 'observationWindowS', 'experimentalFlashes',
                    'restorationFlashes', 'repetitionsPerFirmware'):
            self.assertIn(key, allowed)
        for key in ('wallMin', 'cleanupMin', 'lockWaitMin', 'observationS', 'experimentalFlashes', 'restorationFlashes', 'repetitions'):
            self.assertIn(key, used)
        for verdict in ('`real`', '`fixed`', '`rig-side`', '`not-reproduced`', '`inconclusive`'):
            self.assertIn(verdict, body)
        self.assertEqual(used['restorationFlashes'], 0, 'a verified tested image that is the restoration image is kept, not reflashed')
        self.assertIn(example['runs'][0]['firmware'], cleanup['pristine'])
    def test_hw_debugger_example_carries_what_chief_relaunches_on(self):
        """chief relaunches only on a non-empty `changed`; `fixed` is the validator's alone."""
        body = (AGENTS / 'hw-debugger.md').read_text()
        example = json.loads(body.split('## Output contract')[1].split('\n\n')[2])
        self.assertIn(example['verdict'], ('real', 'rig-side', 'not-reproduced', 'inconclusive'))
        for key in ('question', 'reason', 'reproducer', 'head', 'base', 'board', 'probe', 'hypotheses', 'cause', 'fix', 'changed',
                    'runs', 'cleanup', 'budget', 'limits', 'blocker', 'next'):
            self.assertIn(key, example)
        self.assertTrue(example['reason'].strip())
        for h in example['hypotheses']:
            self.assertIn(h['result'], ('supported', 'refuted', 'unresolved'))
            for key in ('claim', 'prediction', 'experiment', 'evidence', 'doc'):
                self.assertIn(key, h)
        self.assertIn(example['cause']['confidence'], ('supported', 'unresolved'))
        self.assertIn(example['fix']['state'], ('committed', 'pending-finalization', 'patch-only', 'none'))
        for entry in example['changed']:
            self.assertEqual(sorted(entry), ['artifact', 'entry', 'removed'])
        self.assertIn(example['cleanup']['sourceDisposition'], ('restored', 'fix-committed', 'unrestored'))
        self.assertEqual(sorted(example['cleanup']['runState']), ['command', 'result'])
        self.assertTrue(example['cleanup']['pristine'].startswith(example['base']), 'restoration is pinned to the pre-fix revision')
        self.assertNotEqual(example['base'], example['head'])
        allowed, used = example['budget']['allowed'], example['budget']['used']
        for key in ('wallMin', 'cleanupReserveMin', 'lockWaitMin', 'observationWindowS', 'experimentalFlashes', 'restorationFlashes',
                    'repetitionsPerExperiment', 'candidateComparisonRepetitions', 'hypotheses', 'finalizationMin'):
            self.assertIn(key, allowed)
        for key in ('wallMin', 'cleanupMin', 'lockWaitMin', 'observationS', 'experimentalFlashes', 'restorationFlashes',
                    'repetitions', 'hypotheses', 'finalizationMin'):
            self.assertIn(key, used)
        ids = {run['id'] for run in example['runs']}
        refs = [h['experiment'] for h in example['hypotheses']] + example['cause']['evidence'] + [c['artifact'] for c in example['changed']]
        self.assertLessEqual(set(refs), ids, 'every referenced run is in runs')
        self.assertEqual(sum(run['repetitions'] for run in example['runs']), used['repetitions'])
        self.assertEqual(len(example['hypotheses']), used['hypotheses'])

    def test_hardware_commit_recipes_put_options_before_the_pathspec(self):
        """An option after `--` is read as a path, so the recipe must carry -m before it."""
        for name in ('chief.md', 'hw-debugger.md'):
            body = (AGENTS / name).read_text()
            self.assertIn('git commit --only -m "<subject>" -- <same paths>', body, name)
            self.assertNotIn('git commit --only -- <same paths>', body, name)

    def test_cleanup_pins_restoration_and_keeps_a_verified_image(self):
        body = ' '.join((SKILLS / 'target-debug' / 'SKILL.md').read_text().split())
        self.assertIn('save the restoration artifact apart from later build outputs and pin it', body)
        self.assertIn('establishes that it matches the pinned artifact', body)
        self.assertIn('`restorationFlashes` counts actual programming attempts', body)
        self.assertNotIn('reflash pristine firmware', body)
        chief = (AGENTS / 'chief.md').read_text()
        self.assertIn('the bench runs the pinned restoration firmware, which may predate the fix', chief)
        self.assertIn('keeps the evidence and handoff artifacts', chief)

    def test_observation_window_bounds_one_attempt_and_every_invocation_counts(self):
        body = ' '.join((SKILLS / 'target-debug' / 'SKILL.md').read_text().split())
        self.assertIn('observation window is the ceiling on one reproducer attempt', body)
        self.assertIn('a completed deterministic operation ends the attempt', body)
        self.assertIn('costs time, not a repetition', body)
        self.assertIn('Observation window per attempt (ceiling)', (AGENTS / 'chief.md').read_text())

    def test_rp2040_verification_precondition_is_reachable_and_usb_run_state_needs_function(self):
        flat = lambda path: ' '.join(path.read_text().split())
        td = SKILLS / 'target-debug'
        note = flat(td / 'projects' / 'tinyusb.md')
        self.assertIn('Before any RP2040 flash read or `verify_image`, stop at a hardware breakpoint in flash-resident code', note)
        self.assertIn('scripts/rp2040_verify.py', note)
        self.assertIn('Mechanism not established.', note)
        self.assertIn('"RP2040 flash verification"', flat(td / 'gdb.md'))
        skill = flat(td / 'SKILL.md')
        self.assertIn('RP2040: a flash-resident halt', skill)
        self.assertIn('a device number alone establishes neither', skill)
        self.assertIn('attributable supplied evidence', flat(AGENTS / 'hw-validator.md'))

    def test_chief_quotes_unit_json_and_leaves_verdicts_to_the_role(self):
        body = (AGENTS / 'chief.md').read_text()
        self.assertIn("Every hardware dispatch requests the role's Output contract unchanged.", body)
        self.assertIn('quoted verbatim in a fenced block labelled with the unit', body)


if __name__ == '__main__':
    unittest.main()
