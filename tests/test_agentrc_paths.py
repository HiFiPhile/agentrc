"""How agentrc's own files name agentrc content: through `${AGENTRC_DIR:-$HOME/.claude}` (`.codex` for Codex),
which a project install points at this checkout, quoted wherever a shell runs it, and only at paths that exist."""
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from helpers import guard_survivors  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SCANNED = ('agents', 'skills', 'workflows', 'instructions', 'hooks', 'README.md')

# A literal user-wide path to agentrc content misses a project install. Claude state (~/.claude/projects,
# settings.json, transcripts) is no agentrc content and is not matched.
USER_WIDE = re.compile(r'(?<!:-)(?:~|\$HOME)/\.(?:claude|codex)/(?:skills|agents|workflows|hooks)/[^\s`\'")]*')
ALLOWED = {
    # captain is user-wide only (README, Per project): captain_guard.py allows these literal paths and rejects any
    # `$` form, and captain.md's hook, its SKILL.md recipes and user.md's captain rule run them
    '/.claude/skills/captain/',
}

EXPANSION = re.compile(r'\$\{AGENTRC_DIR')
FENCE = re.compile(r'^\s*```')
INLINE = re.compile(r'`([^`\n]+)`')
COMMAND = re.compile(r'(?:python3?|py|bash|sh|node|[A-Za-z_]\w*=)(?:\s|"|\$)')
HOLDER = re.compile(r'^([A-Za-z_]\w*)="?\$\{AGENTRC_DIR', re.M)
RUN_UNQUOTED = re.compile(r'\b(?:python3?|bash|sh|node)\s+(?:-\S+\s+)*\$\{AGENTRC_DIR')
NAMED = re.compile(r'\$\{AGENTRC_DIR:-\$HOME/\.(?:claude|codex)\}"?/([^\s`\'")\]]+)|\$\{AGENTRC\}/([^\s`\'")\]]+)')
# a variable a recipe or workflow sets to an agentrc path: S="${AGENTRC_DIR:-$HOME/.claude}/x", const S = `${AGENTRC}/x`
ASSIGNED = re.compile(r'^\s*(?:const\s+)?([A-Za-z_]\w*)\s*=\s*["`]?(?:\$\{AGENTRC_DIR:-\$HOME/\.(?:claude|codex)\}|\$\{AGENTRC\})/'
                      r'([^\s"`\']+)', re.M)


def setUpModule():
    guard_survivors(__name__)


def scanned():
    for top in SCANNED:
        path = ROOT / top
        files = [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file())
        for f in files:
            if '__pycache__' in f.parts:
                continue
            try:
                text = f.read_text(encoding='utf-8')
            except UnicodeDecodeError:
                continue
            yield f.relative_to(ROOT).as_posix(), text


def unquoted(text):
    """Offsets of each `${AGENTRC_DIR` with no `"` right before it."""
    return [m.start() for m in EXPANSION.finditer(text) if text[m.start() - 1:m.start()] != '"']


class AgentrcPaths(unittest.TestCase):
    def test_content_is_named_through_agentrc_dir(self):
        bad = [f'{name}:{text.count(chr(10), 0, m.start()) + 1}: {m[0]}'
               for name, text in scanned() for m in USER_WIDE.finditer(text)
               if not any(allowed in m[0] for allowed in ALLOWED)]
        self.assertEqual(bad, [], 'name agentrc content as "${AGENTRC_DIR:-$HOME/.claude}/..." or allow it here')

    def test_an_expansion_a_shell_runs_is_quoted(self):
        """In a code block, or an inline command, the expansion is quoted, and so is a variable holding one."""
        bad = []
        for name, text in scanned():
            md, fenced, held = name.endswith('.md'), False, set()
            for n, line in enumerate(text.splitlines(), 1):
                if md and FENCE.match(line):
                    fenced, held = not fenced, set()
                    continue
                if fenced:
                    spans = [line]
                    held |= set(HOLDER.findall(line))
                elif md:
                    spans = [s for s in INLINE.findall(line) if COMMAND.match(s)]
                else:  # a workflow's AGENTRC constant is shell text its commands splice in
                    spans = [line] if line.startswith('const AGENTRC ') else []
                bare_use = any(re.search(rf'(?<!")\$\{{?{v}\b', line) for v in held)
                if any(unquoted(s) for s in spans) or RUN_UNQUOTED.search(line) or bare_use:
                    bad.append(f'{name}:{n}: {line.strip()[:120]}')
        self.assertEqual(bad, [], 'quote the whole path: python3 "${AGENTRC_DIR:-$HOME/.claude}/skills/x/y.py"')

    def test_every_named_path_exists(self):
        """Directly, or through a variable set to an agentrc path in the same file (`$S/x.py`, `${S}/x.py`)."""
        bad = []
        for name, text in scanned():
            named = [(m.start(), m[1] or m[2]) for m in NAMED.finditer(text)]
            for var, base in ASSIGNED.findall(text):
                named += [(m.start(), f'{base}/{m[1]}') for m in re.finditer(rf'\$\{{?{var}\}}?/([^\s`\'")\]]+)', text)]
            for at, path in named:
                path = path.rstrip('.,;:')
                if any(c in path for c in '<*$'):
                    continue
                if not (ROOT / path).exists():
                    bad.append(f'{name}:{text.count(chr(10), 0, at) + 1}: {path}')
        self.assertEqual(bad, [], 'a path under AGENTRC_DIR names this checkout\'s files')


if __name__ == '__main__':
    unittest.main()
