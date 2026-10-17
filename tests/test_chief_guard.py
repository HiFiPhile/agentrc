"""Tests for hooks/headless-chief/chief_guard.py, run as Claude Code runs it: hook JSON on stdin."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'hooks' / 'headless-chief' / 'chief_guard.py'
# Windows judges a /tmp path as MSYS bash maps it, through cygpath; without one it is denied
needs_msys = unittest.skipIf(os.name == 'nt' and not shutil.which('cygpath'), 'no cygpath to map /tmp')


class ChiefGuard(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.root = Path(td.name).resolve()
        self.project = self.root / 'wt'
        self.wt = self.project.as_posix()   # as a bash command names it: an unquoted backslash is an escape
        (self.project / 'src').mkdir(parents=True)
        (self.project / 'src' / 'a.c').write_text('int a;\n')
        # GIT_* from a calling hook would point git at another repository
        self.env = {k: v for k, v in os.environ.items() if k != 'CLAUDE_PROJECT_DIR' and not k.startswith('GIT_')}
        subprocess.run(['git', 'init', '-q', str(self.project)], check=True, env=self.env)

    def hook(self, command=None, tool='Bash', agent_type='chief', agent_id=None, file_path=None):
        event = {'hook_event_name': 'PreToolUse', 'tool_name': tool, 'cwd': str(self.project), 'agent_type': agent_type,
                 'tool_input': {'command': command} if tool == 'Bash' else {'file_path': file_path, 'content': 'x'}}
        if agent_id:
            event['agent_id'] = agent_id
        return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(event, ensure_ascii=False), env=self.env,
                              capture_output=True, encoding='utf-8', timeout=30)

    def assert_denied(self, command, *named, **kw):
        r = self.hook(command, **kw)
        self.assertEqual(r.returncode, 2, f'{command!r} passed')
        for want in named:
            self.assertIn(want, r.stderr)

    def assert_allowed(self, command, **kw):
        r = self.hook(command, **kw)
        self.assertEqual(r.returncode, 0, f'{command!r}: {r.stderr}')

    def test_only_chief_own_calls_are_checked(self):
        self.assert_allowed('git push', agent_type='code-writer', agent_id='a1')
        # a subagent chief dispatched carries an agent_id even under chief's agent_type
        self.assert_allowed('git push', agent_type='chief', agent_id='a2')
        self.assert_allowed('git commit -m x', agent_type=None)
        self.assert_denied('git push', 'changes the repository')

    def test_git_reads_pass(self):
        for c in ('git status --porcelain', 'git log --oneline abc..HEAD', 'git -C /x log -1', 'git -c core.pager=cat diff',
                  'git --no-pager show HEAD', 'git log --name-only --no-renames --format= a..HEAD', 'git fetch -q origin',
                  'git branch --show-current', 'git branch -a --contains abc', 'git tag -l v*', 'git stash list',
                  'git worktree list', 'git remote -v', 'git config --get user.name', 'git rev-parse HEAD',
                  'git symbolic-ref HEAD', 'git remote'):
            self.assert_allowed(c)

    def test_git_writes_are_denied(self):
        for c in ('git push origin HEAD', 'git commit -m x', 'git -C /x commit -am y', 'git -c a=b reset --hard',
                  'git rebase main', 'git checkout -b x', 'git switch main', 'git add -- src', 'git stash',
                  'git stash push -m x', 'git branch new', 'git branch -D old', 'git tag v1', 'git tag -d v1',
                  'git worktree remove x', 'git remote add o u', 'git config user.name x', 'git cherry-pick abc',
                  'git restore src/a.c', 'git clean -fd', 'git merge x', 'git pull', 'git symbolic-ref HEAD refs/heads/x'):
            self.assert_denied(c, 'changes the repository')

    def test_wrappers_chains_and_substitutions_are_seen(self):
        for c in ('GIT_DIR=x git push', 'env -u X git push', 'timeout 60 git push', 'nice -n 5 git push',
                  'git status && git push', 'git log | head; git commit -m x', 'true || git push', '(cd /tmp && git push)',
                  'echo "$(git push)"', 'echo `git push`', "bash -c 'git push'", 'sh -c "git log && git push"',
                  'if git push; then echo y; fi', 'xargs -n1 git push', '/usr/bin/git push', "eval 'git push'",
                  'command -- git push', 'exec -a x git push', 'git status # look\ngit push origin HEAD',
                  "# don't edit\nprintf x > src/a.c", "# it's fine\ngit status && git push origin HEAD",
                  "printf '%s\\n' https://github.com/o/r/issues/1#c2 > src/a.c", 'echo a#b; git push'):
            self.assert_denied(c)

    @needs_msys
    def test_quoted_words_are_data(self):
        self.assert_allowed("git log --grep='git push' --oneline")
        self.assert_allowed('echo "git commit"')
        self.assert_allowed("rg '>' src/a.c")
        self.assert_allowed('command -v git python3 node')
        self.assert_allowed('command -p -v git python3 node')
        self.assert_allowed("cat > /tmp/r.md <<'EOF'\n# it's a title\nEOF")
        self.assert_allowed('grep -c "a;b|c" src/a.c && echo \\> done')

    @needs_msys
    def test_heredoc_body_is_data_but_its_line_counts(self):
        self.assert_allowed("cat > /tmp/brief.md <<'EOF'\ngit push\ngh pr merge 1\nEOF")
        self.assert_denied("cat > src/x.md <<'EOF'\nhello\nEOF", 'literal absolute path')
        self.assert_denied("cat <<EOF | tee src/x\nhi\nEOF", 'literal absolute path')

    def test_gh_reads_pass(self):
        for c in ('gh pr view 12 --json state', 'gh pr checks 12', 'gh -R o/r pr list', 'gh issue view 3',
                  'gh run view 99 --log-failed', 'gh api repos/o/r/pulls/1', 'gh api -X GET search/issues -f q=x',
                  "gh api graphql -f query='query { viewer { login } }'", 'gh search issues foo', 'gh auth status'):
            self.assert_allowed(c)

    def test_gh_publishing_is_denied(self):
        for c in ('gh pr create -t x', 'gh pr merge 1', 'gh pr comment 1 -b x', 'gh pr review 1 --approve',
                  'gh issue create -t x', 'gh issue comment 3 -b y', 'gh issue close 3', 'gh pr edit 1',
                  'gh api -X POST repos/o/r/issues', 'gh api --method=PATCH repos/o/r/pulls/1', 'gh api repos/o/r/issues -f title=x',
                  "gh api graphql -f query='mutation { resolveReviewThread }'", 'gh release create v1', 'gh repo delete o/r'):
            self.assert_denied(c)

    def test_workflow_only_publishers_are_denied(self):
        self.assert_denied('python3 ~/.claude/skills/pr-babysit/scripts/push.py --pr 1', 'inside its workflow')
        self.assert_denied('python3 -X utf8 /x/sonar.py --pr 1', 'inside its workflow')
        self.assert_allowed('python3 ~/.claude/skills/pr-babysit/scripts/launch_result.py --output /tmp/o')

    def test_writes_inside_the_worktree_are_denied(self):
        for c in (f'echo x > {self.wt}/a', f'rm {self.wt}/src/a.c', f'mv /tmp/a {self.wt}/src/',
                  f'cp /tmp/a {self.wt}/src/b.c', f'printf x | tee {self.wt}/src/a.c',
                  f'git diff --output={self.wt}/p.patch', f'chmod --reference=/bin/sh {self.wt}/src/a.c'):
            self.assert_denied(c, 'literal absolute path')
        self.assert_denied(None, 'literal absolute path', tool='Write', file_path=str(self.project / 'src' / 'new.c'))

    def test_a_write_target_must_be_a_literal_absolute_path(self):
        # no shell state is tracked: after any cd, a relative or variable target could be the worktree
        for c in ('echo x > src/a.c', 'cd /tmp && printf done > chief-report.md', 'out=/tmp/r.md; printf done > "$out"',
                  'printf done > "$(git rev-parse --show-toplevel)/r.md"', 'mkdir -p "$(git rev-parse --git-path chief)"',
                  'touch new.c', 'git diff --output=chief-report.patch', 'cp -t . /tmp/brief.md', 'rsync -t /tmp/brief.md .',
                  'chmod 600 src/a.c', 'echo x > ~/chief-note.md', 'echo x > "$HOME/chief-note.md"'):
            self.assert_denied(c, 'literal absolute path')

    @needs_msys
    def test_writes_outside_the_worktree_pass(self):
        for c in ('echo x > /tmp/out.md', 'git log > /tmp/log 2>&1', 'git status 2>/dev/null', 'cp src/a.c /tmp/a.c',
                  'mkdir -p /tmp/chief-run', 'rm -f /tmp/x', "sed 's/a/b/' src/a.c", 'cat src/a.c >&2',
                  'echo "$(date)" > /tmp/stamp', "echo 'a > b' > /tmp/x.md",
                  'chmod 600 /tmp/chief-report.md', 'cp -t /tmp src/a.c', 'rsync -t src/a.c /tmp/chief-a.c',
                  'git -C /tmp diff --output=/tmp/p.patch', 'chmod --reference=/bin/sh /tmp/chief-report.md'):
            self.assert_allowed(c)
        self.assert_allowed(None, tool='Write', file_path='/tmp/report.md')

    def test_in_place_edits_are_denied(self):
        # chief writes its artifacts whole with Write; a worktree edit goes to a writer
        for c in ("sed -i 's/a/b/' /tmp/x.md", "sed -Ei 's/a/b/' /tmp/x.md", "sed --in-place=.bak 's/a/b/' /tmp/x.md",
                  "perl -pi -e 's/a/b/' /tmp/x.md", "cd hooks && sed -i 's/old/new/' chief_guard.py"):
            self.assert_denied(c, 'in place')

    def test_home_and_tmpdir_are_not_expanded(self):
        for c in (f'TMPDIR={self.wt}; printf done > "$TMPDIR/r.md"', f'HOME={self.wt} && printf done > "$HOME/r.md"',
                  f'export HOME={self.wt}; printf done > ~/r.md', f"bash -c 'TMPDIR={self.wt}; printf x > $TMPDIR/r'"):
            self.assert_denied(c, 'literal absolute path')

    def test_chief_directory_inside_a_primary_checkout_is_writable(self):
        chief = self.project / '.git' / 'chief'
        self.assert_allowed(f'mkdir -p {chief.as_posix()} && git log > {chief.as_posix()}/u1-commit-check.txt')
        self.assert_allowed(None, tool='Write', file_path=str(chief / 'brief.md'))
        self.assert_denied(f'echo x > {self.wt}/.git/config', 'literal absolute path')

    def test_combined_shell_flags_and_xargs_values(self):
        self.assert_denied("bash -lc 'git push origin HEAD'", 'changes the repository')
        self.assert_denied('xargs -n 1 git push', 'changes the repository')
        self.assert_denied('xargs -I {} git push origin {}', 'changes the repository')

    def test_attached_gh_fields_imply_post(self):
        self.assert_denied('gh api repos/o/r/issues -ftitle=x', 'non-GET')
        self.assert_denied('gh api repos/o/r/issues -Ftitle=x', 'non-GET')

    @needs_msys
    def test_unquoted_heredoc_substitutions_run(self):
        self.assert_denied("cat > /tmp/r.md <<EOF\n$(git push origin HEAD)\nEOF", 'changes the repository')
        self.assert_denied("cat > /tmp/r.md <<EOF\n'`git push`'\nEOF", 'changes the repository')
        self.assert_allowed("cat > /tmp/r.md <<'EOF'\n$(git push origin HEAD)\nEOF")

    @needs_msys
    def test_single_quoted_substitutions_are_data(self):
        self.assert_allowed("printf '%s\\n' '$(git push)' > /tmp/chief-report.md")
        self.assert_allowed("grep -n '`git push`' /tmp/notes.md")

    def test_git_reads_keep_their_own_short_options(self):
        self.assert_allowed('git ls-files -o --exclude-standard')
        self.assert_allowed('git grep -o chief -- src')

    def test_an_unparsable_command_is_denied(self):
        self.assert_denied('echo "unterminated', 'cannot parse')

    def test_a_non_ascii_worktree_is_still_the_worktree(self):
        # git names it in UTF-8: read in a locale's encoding (GBK) the guard crashed or missed it, and an erroring hook passes
        self.project = self.root / 'wt-ü✓'
        (self.project / 'src').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(self.project)], check=True, env=self.env)
        self.assert_denied(f"printf x > '{self.project.as_posix()}/src/a.c'", 'literal absolute path')
        self.assert_denied(None, 'literal absolute path', tool='Write', file_path=str(self.project / 'src' / 'ü.c'))
        self.assert_allowed(f"printf x > '{self.root.as_posix()}/ü-report.md'")

    @unittest.skipUnless(os.name == 'nt', 'Windows path forms')
    def test_windows_forms_of_a_worktree_path_are_denied(self):
        msys = '/' + self.wt[0].lower() + self.wt[2:]   # E:/x as Git Bash names it: /e/x
        native = str(self.project)
        for c in (f'echo x > {msys}/src/a.c', f'rm {msys}/src/a.c', f'cp /tmp/a {msys}/src/', f'echo x > /c/..{msys}/src/a.c',
                  f"echo x > '{native}\\src\\a.c'", f"echo x > '{self.wt.upper()}/SRC/A.C'", f"echo x > '//?/{self.wt}/src/a.c'",
                  f"echo x > '//./{self.wt}/src/a.c'", f"echo x > '{self.wt}/src/a.c:s'", "echo x > '//host/share/a.c'"):
            self.assert_denied(c, 'literal absolute path')
        for path in (f'{msys}/src/b.c', f'//?/{self.wt}/src/b.c', f'{native}\\src\\b.c'):
            self.assert_denied(None, 'literal absolute path', tool='Write', file_path=path)
        self.assert_allowed(f'echo x > /{self.wt[0].lower()}/chief-report-elsewhere.md')
        self.assert_allowed(f"echo x > '{self.root.as_posix()}/chief-report.md'")

    @unittest.skipUnless(os.name == 'nt', 'Windows has no /tmp of its own')
    def test_a_tmp_path_without_cygpath_is_denied(self):
        # bash maps /tmp through its mount table; with no cygpath to read it, the target cannot be placed
        self.env['PATH'] = os.pathsep.join(d for d in self.env['PATH'].split(os.pathsep) if d and not shutil.which('cygpath', path=d))
        self.assert_denied('echo x > /tmp/out.md', 'literal absolute path')
        self.assert_allowed(f"echo x > '{self.root.as_posix()}/out.md'")

    @unittest.skipUnless(os.name == 'nt', 'Windows finds a program without case or .exe')
    def test_windows_command_names_are_matched_without_case_or_suffix(self):
        for c in ('git.exe push', 'GIT push', 'Git.Exe commit -m x', '"C:/Program Files/Git/cmd/git.exe" push',
                  'env.exe git push', 'TIMEOUT.EXE 60 git push', 'GIT_DIR=E:/x/.git git push'):
            self.assert_denied(c, 'changes the repository')
        self.assert_denied('gh.exe pr merge 1', 'not a read')
        self.assert_denied('py -3 E:/x/push.py --pr 1', 'inside its workflow')
        self.assert_denied('python.exe E:/x/PUSH.PY --pr 1', 'inside its workflow')
        self.assert_allowed('git.exe status')

    @unittest.skipUnless(os.name == 'nt', 'Windows shells a bash command can start')
    def test_windows_shells_are_denied(self):
        native = str(self.project)
        for c in (f"cmd //c del '{native}\\src\\a.c'", f"cmd /k 'del {native}\\src\\a.c'", 'cmd.exe /C dir',
                  f"powershell -Command Set-Content '{native}\\src\\a.c' x", f"powershell Remove-Item '{native}\\src\\a.c'",
                  'pwsh -c "git push"', 'wsl git push', "bash -c 'cmd /c dir'", 'xargs powershell'):
            self.assert_denied(c, 'cannot follow')


if __name__ == '__main__':
    unittest.main()
