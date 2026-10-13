"""Focused safety/failure tests; no dependencies or external services."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).with_name('qualify-runtime.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)


class QualificationTests(unittest.TestCase):
    def test_environment_drops_inherited_database_and_tokens(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'synthetic', 'OPENAI_API_KEY': 'synthetic',
                                     'PAPERCLIP_API_KEY': 'synthetic', 'NODE_ENV': 'production'}):
            env = q.clean_environment(Path('/tmp/private-qualification'), '1.97.1')
        for name in ('DATABASE_URL', 'OPENAI_API_KEY', 'PAPERCLIP_API_KEY'):
            self.assertNotIn(name, env)
        self.assertEqual(env['NODE_ENV'], 'development')
        self.assertEqual(env['RUSTUP_AUTO_INSTALL'], '0')
        self.assertEqual(env['PAPERCLIP_TELEMETRY_DISABLED'], '1')
        self.assertNotEqual(env['HOME'], '/paperclip')

    def test_headers_parse_exact_patch_version(self):
        self.assertEqual(q.header_version('#define NODE_MAJOR_VERSION 24\n#define NODE_MINOR_VERSION 21\n#define NODE_PATCH_VERSION 0\n'), '24.21.0')

    def test_incomplete_headers_fail(self):
        with self.assertRaisesRegex(RuntimeError, 'incomplete'):
            q.header_version('#define NODE_MAJOR_VERSION 24\n')

    def test_smoke_rejects_root(self):
        with patch.object(q.os, 'getuid', return_value=0):
            with self.assertRaisesRegex(RuntimeError, 'non-root'):
                q.smoke({}, '1.97.1')

    def test_smoke_rejects_other_architecture_os(self):
        with patch.object(q.os, 'getuid', return_value=1000), patch.object(q.platform, 'system', return_value='Darwin'):
            with self.assertRaisesRegex(RuntimeError, 'Linux'):
                q.smoke({}, '1.97.1')

    def test_smoke_rejects_wrong_compiler_before_install(self):
        def version(command, **kwargs):
            return 'cargo 1.85.0' if command[0] == 'cargo' else 'synthetic version'
        with patch.object(q.os, 'getuid', return_value=1000), patch.object(q.platform, 'system', return_value='Linux'), patch.object(q, 'output', side_effect=version):
            with self.assertRaisesRegex(RuntimeError, 'runner-owned pin'):
                q.smoke({}, '1.97.1')

    def test_tree_mismatch_stops_before_any_qualification_command(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            args = SimpleNamespace(base='base', candidate='candidate')
            with patch.object(q, 'output', side_effect=['applied', 'candidate', 'base', 'expected-tree', 'wrong-tree', '']), patch.object(q, 'run_step') as step:
                with self.assertRaisesRegex(RuntimeError, 'tree equality'):
                    q.qualify(args, state, {}, '1.97.1')
                step.assert_not_called()

    def test_dirty_checkout_stops_before_any_qualification_command(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            args = SimpleNamespace(base='base', candidate='candidate')
            with patch.object(q, 'output', side_effect=['applied', 'candidate', 'base', 'tree', 'tree', ' M pnpm-lock.yaml']), patch.object(q, 'run_step') as step:
                with self.assertRaisesRegex(RuntimeError, 'clean checkout'):
                    q.qualify(args, state, {}, '1.97.1')
                step.assert_not_called()

    def test_unreviewed_tree_stops_before_any_qualification_command(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            args = SimpleNamespace(base='base', candidate='candidate', isolation_reviewed_tree='old-tree')
            with patch.object(q, 'output', side_effect=['applied', 'candidate', 'base', 'tree', 'tree', '']), patch.object(q, 'run_step') as step:
                with self.assertRaisesRegex(RuntimeError, 'isolation review'):
                    q.qualify(args, state, {}, '1.97.1')
                step.assert_not_called()

    def test_failing_command_retains_log_exit_and_measurement(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                q.run_step('failure', [sys.executable, '-c', "print('synthetic failure');raise SystemExit(7)"], path, {'PATH': '/usr/bin:/bin'}, path)
            self.assertEqual(caught.exception.returncode, 7)
            self.assertIn('synthetic failure', (path / 'failure.log').read_text())
            self.assertEqual(json.loads((path / 'steps.jsonl').read_text())['exitCode'], 7)
            self.assertGreater(json.loads((path / 'steps.jsonl').read_text())['childrenPeakRSSKiBSoFar'], 0)

    def test_passing_command_records_success(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            q.run_step('success', [sys.executable, '-c', 'pass'], path, {'PATH': '/usr/bin:/bin'}, path)
            self.assertEqual(json.loads((path / 'steps.jsonl').read_text())['exitCode'], 0)


if __name__ == '__main__':
    unittest.main()
