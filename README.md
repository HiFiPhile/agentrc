# agentrc

Personal agent config shared by Claude Code and Codex, versioned in git.

```
install.py   symlinks chosen parts of this checkout into ~/.claude and ~/.codex
CLAUDE.md    user-wide instructions, also ~/.codex/AGENTS.md
skills/      skills for both agents
agents/      <name>.md for both agents, plus <name>.toml for Codex
hooks/       Claude Code hooks, one folder each with a hooks.json
workflows/   saved workflows (Claude only)
tests/       unit tests for skill scripts, hooks and the installer
```

## Install

Every entry is a symlink, so edits are live. Each flag takes every entry of
its kind; nothing is installed by default.

```sh
git clone git@github.com:hathach/agentrc.git ~/code/agentrc
~/code/agentrc/install.py install --skill --agent --workflow --claude-md
~/code/agentrc/install.py remove --skill
```

- `--skill`: into `~/.claude/skills` and `~/.codex/skills`. A skill's hook of
  the same name links into `~/.claude/hooks` and its events are registered in
  `~/.claude/settings.json` (backed up the first time).
- `--agent`: the `.md` into `~/.claude/agents` and `~/.codex/agents`, the
  `.toml`, if any, into `~/.codex/agents`.
- `--workflow`: into `~/.claude/workflows`.
- `--claude-md`: `~/.claude/CLAUDE.md`, and `~/.codex/AGENTS.md` to it.

The target directories stay real, so local entries sit beside the links.
`install` refuses before touching anything if a target is a file or a
nonempty directory; `remove` never deletes one, and leaves CLAUDE.md links
that point elsewhere. Rerun after adding an entry: dead links into this repo
are pruned.

Project repos such as tinyusb call these skills by bare name and expect this
install.

## Simplify gate (per repository)

`hooks/simplify-gate` snapshots the checkout and its worktrees when a prompt
arrives and when the session stops, then sends the diff to a read-only
`codex exec` YAGNI challenge at Stop: at most two rounds per user turn, one
retry on Codex failure, then the stop goes through with a notice. One review
runs at a time; edits it did not cover wait for the next turn. The challenge notes that
a peer sharing the checkout may have made part of the diff, and Claude rejects
findings on files it neither wrote nor commissioned.

`--skill` registers the hook; switch the gate on per repository with
`/simplify-gate on` in a Claude session there, or:

```sh
cd ~/code/tinyusb && ~/.claude/skills/simplify-gate/scripts/gate.py on
```

The hook costs one `git rev-parse` per checkout and starts the gate only where
`<git common dir>/simplify-gate` exists, so one marker covers a repository and
its worktrees. `/simplify-gate status` prints the state with the effective
model and effort; `on --model M --effort E` overrides the defaults at the top
of `simplify_gate.py`. Session state lives under
`~/.cache/agentrc/simplify-gate/`.

## Chief session

`agents/chief.md` is a dispatch-only main session with no file or shell tools:
every read, edit, build and review goes to the repository's agents, skills and
workflows. Its direct Codex exchanges go through `agents/coworker.md`, the
`cowork.py` transport. `workflows/code-audit.js` is its saved review: one `code-verifier`
per directory x dimension, then `finding-verifier` on every finding
(`args: { dirs, dimensions }`, both required). Start it inside the task
worktree:

```sh
~/code/agentrc/install.py install --agent --workflow
git worktree add .worktrees/<branch> -b <branch> <base> && cd .worktrees/<branch> && claude --agent chief
```

Headless (`claude -p --agent chief`), set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`,
or `-p` kills units still running ten minutes after the chief's turn ends.

## Tests

```sh
python3 -m unittest discover -s tests
```

Needs PyYAML; the pre-commit hook runs the same command (`pre-commit install`).
