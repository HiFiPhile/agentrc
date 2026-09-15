---
name: ci-rerun
description: Re-run failed CircleCI jobs, or read their failed step logs, from the job numbers a GitHub check carries. Use when a PR's CircleCI checks failed for an infrastructure reason (a lost clone, a dropped SSH handshake, a runner timeout) and the workflow should run its failed jobs again.
---

# CircleCI from a GitHub check

A CircleCI check on a PR links to `https://circleci.com/gh/<owner>/<repo>/<job-number>`,
and that number is all `gh pr checks` gives. `scripts/circleci.py` turns it
into the job's workflow and acts on that.

```bash
C=~/.claude/skills/ci-rerun/scripts/circleci.py
python3 $C log 391824                 # the failed steps' last 150 lines, to classify the failure
python3 $C rerun 391824 391728 ...    # each job's workflow, once, from its failed jobs
```

`rerun` prints one JSON line, `{"reruns": [{"workflow", "jobs", "newWorkflow"}], "errors": [...]}`,
and exits 1 when any workflow could not be re-run. Several failed jobs of one
workflow are one re-run; the new workflow id is what a watcher records. The
re-run goes through the installed `circleci` CLI and its token in
`~/.circleci/cli.yml`; the job and log lookups are public.

## Judgment

- **Classify first.** Read the log; re-run only a failure that is the
  infrastructure's, not the code's. A re-run that fails the same way is a real
  failure.
- **Once.** One re-run per workflow per failure; a second attempt is a
  human's call.
- **Re-running is not publishing.** It changes nothing on the branch or the
  PR and needs no grant.
