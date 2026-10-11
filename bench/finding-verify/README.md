# finding-verify replay corpus

Ground truth for agentrc#64: whether a finding-verifier that judges a batch of related findings stays as
correct as one dispatch per finding. Each case is one past `verify:dIxJ:k` unit of code-audit, as a
pr-review run gave it, with the pinned commits to replay it against and a truth label adjudicated
independently of the verifier.

- `extract.py`: journals and verify transcripts into cases; run it on the host that ran the reviews.
- `sample.py`: a seeded, stratified draw in clusters.
- `adjudicate.py`: the blind brief, and the merge of adjudicators' answers into `corpus.jsonl`.
- `replay.mjs`: one run of the corpus through `workflows/code-audit.js`, per finding or batched.
- `score.py`: a paired repetition's figures and its adoption gate, and the blind evidence brief.

Each script's docstring has the rules.

A cluster is one file of one head, hardware claims apart, across scan units and dimensions: the shared
source context #64 names. A comparison that batches per code-audit scan unit instead scores only the
labelled members of each batch. The `hardware` tag reads the claim's own text; a dispatcher that splits by
dimension needs its own rule, which `dimension` lets a comparison apply.

## corpus.jsonl

One case per line: `id`, `repo`, `pr`, `base`, `head`, `dir`, `dimension`, `finding`, `path` and `worktree`
(below), `prompt` (what the verifier was sent), `verifier` (`models` and the verdict it returned), `source`
(the run's unit label), `cluster`, `tags`, and `truth`:
`label` true or false, null while disputed; `status` agreed, lead or disputed; `answers` by adjudicator,
each with its label, evidence and what it needed beyond the code.

A label follows the verifier's own criterion, as `adjudicate.py`'s RULES give it to the adjudicators.

Every pinned commit resolved on GitHub when the corpus was drawn.

## Drawing it again

```bash
extract.py --out cases.jsonl
sample.py --cases cases.jsonl --out sample.jsonl --seed 1 --total 60
adjudicate.py brief --sample sample.jsonl --clusters 0-6 --checkout hathach/tinyusb=$HOME/code/tinyusb \
  --checkout hathach/agentrc=$HOME/code/agentrc > brief.md     # per adjudicator, per range
adjudicate.py merge --sample sample.jsonl --a codex=a1.json,a2.json --b opus=b1.json,b2.json --lead lead=l.json --out corpus.jsonl
```

## Replaying a case

- `prompt` is what the verifier was sent then. To replay it verbatim, fetch `head` (and `base`) into a
  scratch worktree and send it unchanged, except that a case naming a `worktree` has that prefix replaced
  with the scratch worktree; `path` is the file relative to the root.
- The prompt leans on context the case does not pin: the finding-verifier role and its Severity section,
  the verdict schema in `workflows/code-audit.js`, and the instructions loaded where the run's session
  started. The historical `verifier` verdicts are a reference, not a baseline.
- Same-line findings here are distinct cases with distinct ids.

## Comparing batched and per-finding verification

The adoption experiment for #64 is not the verbatim replay: `replay.mjs` runs today's `code-audit.js` in
both modes on the same findings, `path` in place of any absolute `file` as code-audit now makes it, so the
two modes differ only in batching. Each verify dispatch is a fresh `claude -p --agent finding-verifier` in a
worktree of the case's head, on the model and effort code-audit names (the role's own, Opus at high, unless
it routes a nit to Sonnet). A finding is batchable only when its routing `hardware` is false: here derived
from the adjudicators' `needs` and the claim's text, unsure counting as hardware, then code-audit's own
checks. Faults (a dead reply, a missing, duplicate or unknown id, a partial grade) are tested in
`tests/code_audit_harness.mjs`, not injected into the paid run; both modes retry a dead or partly graded
verdict once.

```bash
replay.mjs --corpus corpus.jsonl --mode single --out runs/r1-single --worktrees runs/wt \
  --checkout hathach/tinyusb=$HOME/code/tinyusb --checkout hathach/agentrc=$HOME/code/agentrc
replay.mjs ... --mode batch --out runs/r1-batch
score.py brief --corpus corpus.jsonl --single runs/r1-single --batch runs/r1-batch > runs/r1-brief.md
# a blind reviewer answers the brief as runs/r1-evidence.json
score.py report --corpus corpus.jsonl --single runs/r1-single --batch runs/r1-batch \
  --evidence runs/r1-evidence.json --out runs/r1-report.json
```

Batching is adopted only when every repetition passes the gate `score.py` names, each pair run under one
unchanged `env.json`.

The routing here is the adjudicators', which production does not have: code-audit batches on the scanner's
own `hardware` flag. A pass therefore shows batching safe under that routing only. Before batching becomes
the default, rescan the corpus heads and measure the scanner flag against `needs`: the cases it would batch
that an adjudicator needed a document or a board for, and the original findings a rescan no longer reports,
which give no routing verdict at all.

### Repetition 1, 2026-10-11

Run at agentrc `d4c03bb` (the digests in each run's `env.json`), all 63 cases, both runs under one
environment. 22 cases were batched (all routed `hardware` false); 41 stayed alone.

| | single | batch |
|---|---|---|
| right of 59 settled | 47 | 50 |
| false refutations / confirmations | 10 / 2 | 8 / 1 |
| dispatches (retries) | 66 (3) | 54 (2) |
| cost, all cases | $25.12 | $19.71 |
| cost, the 22 batched cases | $7.89 | $4.76 (-40%) |

Environment, accounting (no coverage lost), correctness (no regression; batch mode fixed three single-mode
errors) and cost passed. Evidence failed: a blind Opus review of the 22 found the batch reason dropping its
verdict's decisive fact in three (`03b9552f0973`, `6252fb798b42`, `b4f1fb2afbc5`: each verdict right, its
reason citing less than the reference rests on), the single reason in none. Repetition 2 was stopped after
its first dispatches: it could not change the outcome. Batching stays opt-in (`args.batch`); a next attempt
changes the batch prompt to keep each member's evidence and needs fresh repetitions.

## This draw

Seed 1, total 60, from 1100 cases extracted on 2026-10-10 out of 12 pr-review runs (tinyusb #3776 to #4017,
agentrc #4): 63 cases in 22 clusters. Adjudicators: `codex` (gpt-6-astra, cowork review tier) and `opus`
(Claude Opus 5.5), each blind to the verifier and to the other; `lead` broke ties after reading both, and
its tiebreaks went through a Codex review that reopened four.

- 47 agreed, 12 settled by the lead, 4 disputed with what decides each in their answers:
  `a4b3d6de5aba` (SAM E70 dual-bank ZLP, a board run), `2b056b060c13` and `7f7d55de67fc` (LPC55 SETUP copy
  without volatile: the shipped compiler's code and the controller's write while latched),
  `7ac6c1913465` (whether tinyusb's TU_ASSERT rule exempts SDK-copied BSP code, the maintainer's call).
- Truth: 40 true, 19 false. The historical per-finding verdicts were right on 47 of 59: 8 true findings
  refuted, 4 false ones confirmed; 11 of 16 on hardware claims.
