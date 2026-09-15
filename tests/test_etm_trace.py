"""Tests for the etm-trace scripts: etm_capture.py inherits its trace config
from an explicit reference Ozone project wherever it is run from and refuses
ambiguous or incomplete inputs; etm_profile.py parses Ozone's code-profile
report and refuses anything else. No Ozone, no hardware."""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / 'skills' / 'etm-trace' / 'scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


capture = load('etm_capture')
profile = load('etm_profile')

JDEBUG = '''\
void OnProjectLoad (void) {
  // Project.SetDevice ("COMMENTED_OUT");
  Project.SetDevice ("STM32H743XI");
  Project.SetTIFSpeed ("50 MHz");
  Project.SetTracePortWidth (2);
  Project.SetTraceTiming (100, 100, 100, 100);
  Edit.SysVar (VAR_TRACE_CORE_CLOCK, 200000000);
  File.Open ("$(ProjectDir)/firmware.elf");
}

void AfterTargetReset (void) {
  _SetupTarget();
}

void AfterTargetDownload (void) {
  _SetupTarget();
}

void BeforeTargetConnect (void) {
  Project.SetJLinkScript ("$(ProjectDir)/scripts/trace.pex");
}

void _SetupTarget (void) {
  Target.SetReg ("SP", 0);
}

void AfterTargetConnect (void) {
  Target.WriteU32 (0xE0040004, 1);
}
'''

PROFILE = '''\
Code Coverage Summary
Module/Function                | Source Lines     | Instructions
-------------------------------+------------------+------------------
firmware.elf                   |   10 /  20  50.0% |   30 /  60  50.0%
  tud_task                     |    5 /   5 100.0% |   20 /  20 100.0%
  idle_loop                    |    1 /   5  20.0% |    2 /  10  20.0%
  Total                        |   10 /  20  50.0% |   30 /  60  50.0%

Code Profile Summary
Module/Function                | Run Count | Fetch Count
-------------------------------+-----------+------------
firmware.elf                   |           |
  tud_task                     |   1 000   |   20 000
  idle_loop                    |   5 000   |   80 000
  [Unaccounted]                |           |    1 000
  Total                        |   6 000   |  101 000
'''


class ResolveJdebug(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.ref = Path(self._dir.name) / 'ozone' / 'board.jdebug'
        self.ref.parent.mkdir()
        self.ref.write_text(JDEBUG)
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir('/')   # nothing is resolved against the cwd or the script's location

    def test_inherits_every_field_from_the_reference(self):
        cfg = capture.resolve_jdebug(str(self.ref))
        self.assertEqual(cfg['device'], 'STM32H743XI')
        self.assertEqual(cfg['tif_speed'], '50 MHz')
        self.assertEqual(cfg['port_width'], '2')
        self.assertEqual(cfg['timing'], '100, 100, 100, 100')
        self.assertEqual(cfg['core_clock'], '200000000')
        self.assertEqual(cfg['ref'], str(self.ref))
        # $(ProjectDir) resolves against the reference's own directory
        self.assertEqual(cfg['jlink_script'], str(self.ref.parent / 'scripts' / 'trace.pex'))

    def test_hooks_ride_along_except_the_ones_the_template_owns(self):
        cfg = capture.resolve_jdebug(str(self.ref))
        self.assertIn('_SetupTarget();', cfg['reset_hook'])
        self.assertIn('AfterTargetDownload', cfg['download_hook'])
        self.assertIn('void _SetupTarget (void)', cfg['connect_hook'])
        self.assertIn('void AfterTargetConnect (void)', cfg['connect_hook'])
        for owned in ('OnProjectLoad', 'BeforeTargetConnect'):
            self.assertNotIn(owned, cfg['connect_hook'])

    def test_refuses_a_file_without_a_device(self):
        self.ref.write_text('void OnProjectLoad (void) {\n}\n')
        with self.assertRaises(SystemExit) as cm:
            capture.resolve_jdebug(str(self.ref))
        self.assertIn('Project.SetDevice', str(cm.exception))

    def test_refuses_a_missing_file(self):
        with self.assertRaises(SystemExit) as cm:
            capture.resolve_jdebug(str(self.ref.parent / 'absent.jdebug'))
        self.assertIn('not found', str(cm.exception))


class CaptureCli(unittest.TestCase):
    """Argument contract only: every run here exits before Ozone is looked up."""

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPTS / 'etm_capture.py'), *args],
                              capture_output=True, text=True, timeout=30, cwd='/')

    def test_needs_exactly_one_of_jdebug_or_device(self):
        with tempfile.NamedTemporaryFile(suffix='.elf') as elf:
            for args in ((), ('--jdebug', 'x.jdebug', '--device', 'X')):
                r = self.run_cli('--elf', elf.name, *args)
                self.assertEqual(r.returncode, 1, r.stderr)
                self.assertIn('exactly one of --jdebug', r.stderr)

    def test_elf_is_required_and_must_exist(self):
        r = self.run_cli('--device', 'X')
        self.assertEqual(r.returncode, 2)
        self.assertIn('--elf', r.stderr)
        r = self.run_cli('--device', 'X', '--elf', '/nonexistent/fw.elf')
        self.assertEqual(r.returncode, 1)
        self.assertIn('ELF not found', r.stderr)

    def test_max_inst_is_clamped_with_a_warning(self):
        # exits at the reference-project check, after the clamp warning
        with tempfile.NamedTemporaryFile(suffix='.elf') as elf:
            r = self.run_cli('--jdebug', '/nonexistent.jdebug', '--elf', elf.name,
                             '--max-inst', '20000000')
            self.assertEqual(r.returncode, 1)
            self.assertIn('clamped to 10000000', r.stderr)
            self.assertIn('reference project not found', r.stderr)

    def test_help_runs_from_anywhere(self):
        r = self.run_cli('--help')
        self.assertEqual(r.returncode, 0)
        self.assertIn('--jdebug', r.stdout)
        self.assertNotIn('--board', r.stdout)


class ParseProfile(unittest.TestCase):
    def test_reads_both_sections(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'code_profile.txt'
            p.write_text(PROFILE)
            funcs, totals = profile.parse_profile(str(p))
        self.assertEqual(funcs['tud_task'], {'module': 'firmware.elf', 'run': 1000,
                                             'fetch': 20000, 'inst_pct': 100.0})
        self.assertEqual(funcs['idle_loop']['fetch'], 80000)
        self.assertEqual(totals, {'run': 6000, 'fetch': 101000, 'unaccounted': 1000,
                                  'src_cov': (10, 20), 'inst_cov': (30, 60)})

    def test_refuses_a_non_profile_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'session.log'
            p.write_text('device=STM32H743XI\n')
            with self.assertRaises(SystemExit) as cm:
                profile.parse_profile(str(p))
        self.assertIn('not an Ozone code-profile', str(cm.exception))

    def test_itrace_unit_comes_from_the_header(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'itrace.csv'
            p.write_text('Index;Timestamp[us];PC\n')
            self.assertEqual(profile.itrace_unit(str(p)), 'us')
            p.write_text('Index;PC\n')
            self.assertEqual(profile.itrace_unit(str(p)), '?')


if __name__ == '__main__':
    unittest.main()
