import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test as nodeTest } from 'node:test'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
// The body runs as the runtime runs it; `meta` is exposed so its value, not its spelling, is checked.
const body = readFileSync(new URL('../workflows/pr-babysit.js', import.meta.url), 'utf8')
  .replace(/^export const meta = /m, 'const meta = globalThis.__meta = ')

// Node gives the workflow body globals the runtime sandbox does not, so a test
// run here is more forgiving than production: `new URL` cost this workflow every
// run, refusing each one at preflight, while the suite stayed green. Shadowing
// them as parameters makes the body fail here the way it fails there.
const ABSENT = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer', 'process', 'fetch', 'structuredClone']

const GREEN = { status: 'green', infraRerun: [], realFailures: [] }
const finding = (over = {}) => {
  const f = {
    source: 'codex', commentId: 1, file: 'src/a.c', line: 1,
    claim: 'bad', verdict: 'valid', reason: '', fixHint: 'fix it', ...over,
  }
  return { findingId: `${f.commentId}#${f.line}`, commentDigest: `d${f.commentId}`, ...f } // overridable
}
const invalidFinding = (over = {}) => finding({ verdict: 'invalid', ...over })
const oneValid = { findings: [finding()], replies: [], done: true }
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
// reply.py's checksum, so a receipt can be built for a body the workflow chose
const fnv1a = (text) => {
  let h = 0x811c9dc5
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
const manifestOf = (calls, label) => JSON.parse(calls.find(c => c.label === label).prompt.match(/Manifest: (\{.*\})$/)[1]).replies
// The nth commit a run makes. Each is distinct, as a real commit is, because the
// audit rejects one whose SHA equals its parent.
const shaFor = (n) => (SHA.slice(0, 38) + String(n).padStart(2, '0')).toLowerCase()
const HEAD = '0f1e2d3c4b5a69788796a5b4c3d2e1f0deadbee5'
// Somebody else's commit: a plausible HEAD that is not one this run made.
const FOREIGN = 'c0ffee11223344556677889900aabbccddeeff01'
// What the preflight pins, and what the pre-publish recheck must still find.
const PIN = {
  branch: 'claude/foo', prBranch: 'claude/foo',
  prHead: HEAD, prRepo: 'hathach/tinyusb', prUrl: 'https://github.com/hathach/tinyusb/pull/3888',
  remote: 'origin',
  pushUrls: ['git@github.com:hathach/tinyusb.git'], head: HEAD, dirty: [],
}
// What the pre-publish recheck must still find: HEAD exactly where the run left it.
const RECHECK = { branch: 'claude/foo', pushUrls: ['git@github.com:hathach/tinyusb.git'], head: HEAD, staged: [] }

// The paths a publishing prompt names, read from the one line that carries
// nothing else: quoted fragments elsewhere in the prompt (commands, hook names)
// are not paths.
const pathLine = (prompt) => {
  const line = String(prompt).split('\n').find(l => /^'[^']*'( '[^']*')*$/.test(l))
  return line ? [...line.matchAll(/'([^']*)'/g)].map(m => m[1]) : []
}
// A deterministic 40-hex blob id per path, shared by the hook snapshot and the audit's ls-tree.
const blobOf = (f) => [...f].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 0xffffffff, 7).toString(16).padStart(40, '0')
const hookQuoted = (prompt) => [...(String(prompt).match(/pre-commit run --files ((?:'[^']*' ?)+)/) || ['', ''])[1].matchAll(/'([^']*)'/g)].map(m => m[1])
const lsTreeOf = (paths) => paths.map(f => `100644 blob ${blobOf(f)}\t${f}`)

// Drive the workflow against stub agents. Every cycle gets the same `reviews`
// and `ci` answer; `fix`/`push` patch (or null out) those replies.
async function run(opts = {}) {
  const logs = []
  const calls = opts.trace ?? [] // shared so a case that expects a throw can still see what ran
  const napPoints = [] // logs.length when a backoff started, to prove ordering
  const reviews = opts.reviews ?? { findings: [], replies: [], done: true }
  const ci = opts.ci ?? GREEN
  const patch = (base, over) => over === null ? null : { ...structuredClone(base), ...over }
  // The stub checkout's HEAD: the PR head until this run pushes, then the SHA it
  // pushed — the same rule the workflow's own expectedHead follows, so a second
  // cycle rechecks against what the first one actually left behind.
  let head = HEAD
  let made = SHA
  let commits = 0 // so each stub commit gets its own SHA, as a real one would
  let staged = [] // what the committer put in it, read back by the audit agent

  const agent = async (prompt, options) => {
    const label = options.label
    calls.push({
      label, prompt: String(prompt), agentType: options.agentType,
      phase: options.phase, schema: options.schema,
    })
    if (opts.throwOn && label.startsWith(opts.throwOn)) throw new Error(`${label} exploded`)
    if (label === 'preflight') return patch(PIN, opts.preflight)
    if (label.startsWith('recheck#')) {
      const over = typeof opts.recheck === 'function' ? opts.recheck(label) : opts.recheck
      return patch({ ...RECHECK, head }, over)
    }
    if (label.startsWith('ci#')) return structuredClone(ci)
    if (label.startsWith('reviews#')) {
      if (opts.reviewsPerCycle) return opts.reviewsPerCycle()
      if (reviews instanceof Error) throw reviews
      return structuredClone(reviews)
    }
    if (label === 'scope:verify') {
      // git ls-files echoes the paths that exist; the prompt single-quotes each
      // one, so reading them back out of it is also the proof that it did.
      const quoted = [...String(prompt).matchAll(/'([^']*)'/g)].map(m => m[1])
      return { files: opts.lsFiles ? opts.lsFiles(quoted) : quoted }
    }
    if (label.startsWith('scope:')) return { files: opts.scope ?? [] }
    if (label.startsWith('fix:')) {
      if (opts.fix === null) return null // a dead code-writer
      return {
        item: label.slice(4), diffstat: `stat:${label.slice(4)}`,
        buildOk: true, board: '', notes: '', ...opts.fix,
      }
    }
    if (label.startsWith('replies#') || label.startsWith('resolve#')) {
      if (opts.posting === null || (typeof opts.posting === 'function' && opts.posting(label) === null)) return null // a dead posting agent
      // The script's receipts, one per manifest entry, echoing each body's
      // digest: posted, read back and resolved unless a case says the batch
      // failed (dropDoneIds), a reply landed with the wrong body (wrongBody),
      // its read-back was unavailable (unreadable), the POST's response was
      // lost (lost), the agent invented an id (strayDoneIds), the id is on
      // none of the PR's id spaces (noTarget), it names a review body
      // (reviewBody) or the receipts are reshaped (receipts).
      const entries = JSON.parse(String(prompt).match(/Manifest: (\{.*\})$/)[1]).replies
      const failed = opts.dropDoneIds && opts.dropDoneIds(label)
      const receipt = ({ commentId, digest }) => failed
        ? { commentId, kind: 'review', replyId: null, digest, sent: false, posted: false, verified: false, resolved: null, error: 'posting failed' }
        : opts.noTarget && opts.noTarget(commentId)
          ? { commentId, kind: 'none', replyId: null, digest, sent: false, posted: false, verified: false, resolved: null, error: `comment ${commentId} is not on PR #7` }
        : opts.reviewBody && opts.reviewBody(commentId)
          ? { commentId, kind: 'review-body', replyId: 500 + commentId, digest, sent: true, posted: true, verified: true, resolved: null, error: null }
        : opts.lost && opts.lost(commentId)
          ? { commentId, kind: 'review', replyId: null, digest, sent: true, posted: false, verified: false, resolved: null, error: 'connection reset' }
          : opts.wrongBody && opts.wrongBody(commentId)
            ? { commentId, kind: 'review', replyId: 500 + commentId, digest, sent: true, posted: true, verified: false, resolved: null, error: 'read-back mismatch on body' }
            : opts.unreadable && opts.unreadable(commentId)
              ? { commentId, kind: 'review', replyId: 500 + commentId, digest, sent: true, posted: true, verified: null, resolved: null, error: 'read-back unavailable: HTTP 502' }
              : { commentId, kind: 'review', replyId: 500 + commentId, digest, sent: true, posted: true, verified: true, resolved: true, error: null }
      const receipts = [...entries.map(receipt), ...(opts.strayDoneIds || []).map(id => receipt({ commentId: id, digest: 'deadbeef' }))]
      return { receipts: opts.receipts ? opts.receipts(receipts, label) : receipts }
    }
    if (label.startsWith('hooks#')) {
      if (opts.hooks === null) return null // a dead hook agent
      // The tree as the hooks find it: exactly the owned paths, modified. A case
      // that wants a hook to regenerate something overrides `after`.
      const owned = hookQuoted(prompt)
      const status = owned.map(f => ` M ${f}`)
      const snap = owned.map(f => `644 ${blobOf(f)} ${f}`)
      const base = { ran: true, passed: true, modifiedBy: [], before: status, after: status, snapshotBefore: snap, snapshotAfter: snap }
      return { ...base, ...(typeof opts.hooks === 'function' ? opts.hooks(base) : opts.hooks) }
    }
    if (label.startsWith('commit#')) {
      if (opts.commit === null) return null // a dead commit agent
      // What the committer staged, remembered so the read-back agent can report
      // it. A distinct SHA per commit, as a real one is: the audit rejects a
      // commit whose SHA equals its parent, so reusing one would fail in cycle 2.
      staged = pathLine(prompt)
      made = shaFor(++commits)
      return { committed: true, detail: 'committed', ...opts.commit }
    }
    if (label.startsWith('audit#')) {
      if (opts.audit === null) return null // a dead read-back agent
      // ls-tree of the commit: what the stub committed is what the tree held.
      const entries = staged.map(f => `100644 blob ${blobOf(f)}\t${f}`)
      return { sha: made, parents: [head], paths: staged, leftover: [], entries, ...opts.audit }
    }
    if (label.startsWith('push#')) {
      // This stage may not commit and is handed the SHA, so it reports only
      // whether the send worked; the workflow supplies committed and sha.
      if (opts.push === null) return { pass: false, detail: 'push rejected' }
      const push = { pass: true, detail: 'pushed to claude/foo', ...opts.push }
      if (push.pass) head = made // the pushed commit is where the checkout now sits
      return push
    }
    if (label.startsWith('challenge#')) {
      assert.equal(options.agentType, 'finding-verifier')
      if (opts.challengePerCycle) return opts.challengePerCycle()
      if (!('challenge' in opts)) {
        // default: uphold every submitted dismissal, i.e. today's behaviour
        const ids = [...String(prompt).matchAll(/"id":(\d+)/g)].map(m => Number(m[1]))
        return { verdicts: ids.map(id => ({ id, upheld: true, reason: 'stands' })) }
      }
      return opts.challenge === null ? null : structuredClone(opts.challenge)
    }
    if (label.startsWith('check:')) {
      assert.equal(options.agentType, 'finding-verifier')
      return structuredClone(opts.verify ?? { addresses: true, reason: 'verified' })
    }
    throw new Error(`unstubbed agent label ${label}`)
  }
  // Match the host's pipeline: every item's first stage runs concurrently, each
  // second stage starts as soon as its own first stage lands, results in order.
  const pipeline = (items, first, second) =>
    Promise.all(items.map(async item => second(await first(item), item)))
  const parallel = (thunks) => Promise.all(thunks.map(fn => fn()))
  const workflow = async () => { throw new Error('pr-babysit cannot nest a workflow') }

  // nap()'s real delay is minutes; fire it immediately and record where in the
  // log stream it happened.
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => { napPoints.push(logs.length); realTimeout(fn, 0); return 0 }
  try {
    const fn = new AsyncFunction(
      'args', 'agent', 'pipeline', 'parallel', 'phase', 'log', 'workflow', 'budget',
      ...ABSENT, body)
    const result = await fn(
      { pr: 3888, maxCycles: 1, autoPush: true, reviewers: ['codex'], ...opts.args },
      agent, pipeline, parallel, () => {}, (m) => logs.push(String(m)), workflow, null,
      ...ABSENT.map(() => undefined))
    return { result, logs, labels: calls.map(c => c.label), calls, napPoints }
  } finally {
    globalThis.setTimeout = realTimeout
  }
}

const summaries = (logs) => logs.filter(l => l.startsWith('cycle ') && l.includes(' summary '))
// Split on the padded delimiter, not on a bare pipe: an escaped `\|` inside a
// cell must stay part of that cell.
const rowsOf = (summary) => summary.split('\n').slice(3)
  .map(l => l.replace(/^\| /, '').replace(/ \|$/, '').split(' | ').map(c => c.trim()))
// GFM's own row rule: a backslash escapes the next character, so only an
// unescaped pipe splits cells. Applying it is the only way to prove a claim
// carrying `\|` renders inside one cell instead of spilling into extra columns.
const gfmCells = (row) => {
  const cells = ['']
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') cells[cells.length - 1] += row[++i] ?? ''
    else if (row[i] === '|') cells.push('')
    else cells[cells.length - 1] += row[i]
  }
  return cells.slice(1, -1).map(c => c.trim()) // the framing pipes leave an empty cell at each end
}

// node:test is free to run a file's tests concurrently, and run() swaps the
// global setTimeout for the length of one workflow run — two live runs would
// restore each other's timer and lose the nap ordering asserted below. Chaining
// each test onto the previous one keeps exactly one run() in flight.
let queue = Promise.resolve()
const test = (name, fn) => nodeTest(name, () => (queue = queue.then(fn, fn)))

test('meta names the three phases the workflow dispatches into', async () => {
  const { calls } = await run({ reviews: oneValid })
  assert.equal(globalThis.__meta.name, 'pr-babysit')
  assert.deepEqual(globalThis.__meta.phases.map(p => p.title), ['Triage', 'Fix', 'Push'])
  const titles = new Set(globalThis.__meta.phases.map(p => p.title))
  for (const c of calls) assert.ok(titles.has(c.phase), `${c.label} ran in phase ${c.phase}`)
})

test('args validation', async () => {
  await assert.rejects(run({ args: { pr: undefined } }), /args must be/)
  await assert.rejects(run({ args: { pr: 0 } }), /args must be/)
  await assert.rejects(run({ args: { pr: -3 } }), /positive integer/)
  await assert.rejects(run({ args: { pr: 'abc' } }), /positive integer/)
  await assert.rejects(run({ args: { maxCycles: 0 } }), /maxCycles must be/)
  await assert.rejects(run({ args: { reviewers: undefined } }), /reviewers must be an array/)
  await assert.rejects(run({ args: { ciWait: 0 } }), /ciWait must be a positive integer/)
  await assert.rejects(run({ args: { ciWait: 1.5 } }), /ciWait must be a positive integer/)
  await assert.rejects(run({ args: { lane: 'review' } }), /lane must be 'both', 'ci' or 'reviews'/)
  await assert.rejects(run({ args: { lane: 'ci' } }), /needs yieldAfterCycle/)
})

test('an unknown reviewer or a malformed protected pattern throws before any agent runs', async () => {
  for (const [args, expected] of [
    [{ reviewers: ['codex', 'gpt'] }, /unknown reviewer\(s\) \["gpt"\]/],
    [{ reviewers: 'codex' }, /reviewers must be an array of codex, copilot, coderabbit, claude/],
    [{ reviewers: [4] }, /unknown reviewer/],
    [{ reviewers: ['codex'], autoRun: ['copilot'] }, /autoRun must be a subset of reviewers \["codex"\]/],
    [{ reviewers: ['codex'], autoRun: 'codex' }, /autoRun must be a subset/],
    [{ protected: '^test/hil/(' }, /protected is not a valid regex/],
    [{ protected: '   ' }, /non-empty regex string/],
    [{ protected: 7 }, /non-empty regex string/],
  ]) {
    const trace = []
    await assert.rejects(run({ args, trace }), expected, JSON.stringify(args))
    assert.deepEqual(trace, [], 'nothing may be dispatched before the args are checked')
  }
  // Names are normalized, and an empty roster is a legal value, not a typo.
  const named = await run({ args: { reviewers: ['  CodeX ', 'CopIlot'] } })
  assert.equal(named.result.pass, true)
  const none = await run({ args: { reviewers: [] } })
  assert.equal(none.result.pass, true)
})

test('the requested reviewers, normalized, are the ones the validator is asked for', async () => {
  const { calls } = await run({ args: { reviewers: ['  CodeX ', 'CopIlot'] } })
  const reviews = calls.find(c => c.label.startsWith('reviews#'))
  assert.match(reviews.prompt, /the reviewers to harvest on this PR are codex, copilot, and no others/)
  assert.doesNotMatch(reviews.prompt, /coderabbit/i, 'an unrequested bot must not be harvested')
})

test('the auto-running reviewers are named apart from the harvest list', async () => {
  // Harvest-only Copilot must never become a settlement requirement.
  const split = await run({ args: { reviewers: ['codex', 'copilot'], autoRun: [' Codex '] } })
  const prompt = split.calls.find(c => c.label.startsWith('reviews#')).prompt
  assert.match(prompt, /harvest on this PR are codex, copilot, and no others; of those, codex auto-run on every push and gate done/)
  // Default: everybody harvested is also waited for, as before the split.
  const same = await run({ args: { reviewers: ['codex', 'copilot'] } })
  assert.match(same.calls.find(c => c.label.startsWith('reviews#')).prompt, /of those, codex, copilot auto-run/)
  const nobody = await run({ args: { reviewers: ['copilot'], autoRun: [] } })
  assert.match(nobody.calls.find(c => c.label.startsWith('reviews#')).prompt, /none of them auto-run, so done waits on nobody/)
})

test('reviewers: [] runs no review lane at all and still completes', async () => {
  const { result, labels, logs } = await run({
    args: { reviewers: [] },
    // Would be harvested if the lane ran; the stub is never reached.
    reviews: oneValid,
  })
  assert.equal(labels.some(l => l.startsWith('reviews#')), false, 'nobody to harvest, so nobody is asked')
  assert.equal(labels.some(l => l.startsWith('fix:')), false)
  assert.ok(logs.some(l => l === 'cycle 1: no reviewers requested — CI lane only'))
  assert.equal(result.pass, true, `a CI-only run must still reach a verdict (got ${result.reason})`)
  assert.deepEqual(result.history[0].reviews, { findings: [], replies: [], done: true })
})

test('the preflight pins the checkout without touching it', async () => {
  const { calls, logs } = await run()
  const pre = calls[0]
  assert.equal(pre.label, 'preflight')
  assert.match(pre.prompt, /Editing and committing nothing/)
  // Branch, head SHA and head repository in one call — a name alone is not an identity.
  assert.match(pre.prompt, /gh pr view 3888 --json headRefName,headRefOid,headRepositoryOwner,headRepository,url/)
  assert.match(pre.prompt, /git remote get-url --push --all/)
  assert.match(pre.prompt, /git status --porcelain/)
  assert.deepEqual(pre.schema.required.slice().sort(),
    ['branch', 'dirty', 'head', 'prBranch', 'prHead', 'prRepo', 'prUrl', 'pushUrls', 'remote'])
  assert.ok(logs.some(l =>
    l === 'preflight: hathach/tinyusb claude/foo@0f1e2d3 tracking origin, clean'))
})

test('a dirty start refuses before any writer runs', async () => {
  const { result, labels, logs } = await run({
    reviews: oneValid, preflight: { dirty: [' M src/a.c', '?? junk.o'] },
  })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'dirty-start')
  assert.deepEqual(result.dirty, [' M src/a.c', '?? junk.o'])
  assert.equal(result.cycles, 0)
  assert.deepEqual(labels, ['preflight'], 'a pre-existing edit could be swept into the PR')
  assert.ok(logs.some(l => /the checkout is dirty — 2 path\(s\)/.test(l)))
})

test('a checkout on the wrong branch refuses before any writer runs', async () => {
  const { result, labels, logs } = await run({
    reviews: oneValid, preflight: { branch: 'main', prBranch: 'claude/foo' },
  })
  assert.equal(result.reason, 'wrong-branch')
  assert.equal(result.branch, 'main')
  assert.equal(result.expected, 'claude/foo')
  assert.deepEqual(labels, ['preflight'])
  assert.ok(logs.some(l => /checked out main, but PR #3888 heads claude\/foo/.test(l)))
})

test('the right branch name at the wrong commit refuses', async () => {
  // A branch name is not an identity: the same name can be stale or ahead, and
  // its commits would become the baseline every later audit trusts.
  const { result, labels, logs } = await run({ reviews: oneValid, preflight: { head: FOREIGN } })
  assert.equal(result.reason, 'wrong-head')
  assert.equal(result.head, FOREIGN)
  assert.equal(result.expected, HEAD)
  assert.deepEqual(labels, ['preflight'])
  assert.ok(logs.some(l => /HEAD is c0ffee1, but PR #3888 heads 0f1e2d3/.test(l)))
})

test('a tracked remote that is not the PR head repository refuses', async () => {
  // The PR heads a fork, or the checkout tracks one: either way the push would
  // land somewhere other than the PR this run is babysitting.
  for (const [preflight, expected] of [
    // A fork PR: the URL still names the BASE repo, so the expected remote comes
    // from the head repository, and a checkout tracking the base is wrong.
    [{ prRepo: 'contributor/tinyusb' }, 'github.com/contributor/tinyusb'],
    [{ pushUrls: ['git@github.com:contributor/tinyusb.git'] }, 'github.com/hathach/tinyusb'],
    // The host is half the identity: the right path on the wrong host updates
    // nothing on GitHub.
    [{ pushUrls: ['git@evil.example:hathach/tinyusb.git'] }, 'github.com/hathach/tinyusb'],
    // A name that merely starts the same is a different repository.
    [{ pushUrls: ['https://github.com/hathach/tinyusb-backup.git'] }, 'github.com/hathach/tinyusb'],
    // Forms git accepts as remotes but GitHub is not: a relative local path, a
    // file URL, a deeper path, an absolute path.
    [{ pushUrls: ['github.com/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    [{ pushUrls: ['file://github.com/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    [{ pushUrls: ['https://github.com/hathach/tinyusb/extra'] }, 'github.com/hathach/tinyusb'],
    [{ pushUrls: ['/srv/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    // Unauthenticated transports carry no push: github.com is not enough.
    [{ pushUrls: ['http://github.com/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    [{ pushUrls: ['git://github.com/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    [{ pushUrls: [] }, 'github.com/hathach/tinyusb'],
    // A push URL that is a local path to git, because the delimiter is wrong.
    [{ pushUrls: ['git@github.com/hathach/tinyusb'] }, 'github.com/hathach/tinyusb'],
    // Several push URLs: one bad one is enough.
    [{ pushUrls: ['git@github.com:hathach/tinyusb.git', 'git@evil.example:hathach/tinyusb.git'] },
      'github.com/hathach/tinyusb'],
    // github.com only for now; another host is refused rather than pushed to.
    [{ pushUrls: ['https://ghe.corp.example/hathach/tinyusb.git'] }, 'github.com/hathach/tinyusb'],
    [{ prUrl: 'https://ghe.corp.example/hathach/tinyusb/pull/3888' }, 'github.com/hathach/tinyusb'],
    [{ prUrl: 'http://github.com/hathach/tinyusb/pull/3888' }, 'github.com/hathach/tinyusb'],
  ]) {
    const { result, labels, logs } = await run({ reviews: oneValid, preflight })
    assert.equal(result.reason, 'wrong-remote', JSON.stringify(preflight))
    assert.equal(result.expected, expected)
    // The refusal names a push URL it actually rejected, or says there was none.
    const urls = preflight.pushUrls ?? ['git@github.com:hathach/tinyusb.git']
    assert.ok(urls.includes(result.remoteUrl) || result.remoteUrl === '(no push URL)', result.remoteUrl)
    assert.deepEqual(labels, ['preflight'])
    assert.ok(logs.some(l => /not PR #3888's head repository/.test(l)), logs.join('\n'))
  }
})

test('a dead preflight stops the run with nothing else dispatched', async () => {
  for (const opts of [{ preflight: null }, { throwOn: 'preflight' }]) {
    const { result, labels } = await run({ reviews: oneValid, ...opts })
    assert.equal(result.pass, false)
    assert.equal(result.reason, 'preflight-died', JSON.stringify(opts))
    assert.equal(result.cycles, 0)
    assert.deepEqual(result.history, [])
    assert.deepEqual(labels, ['preflight'])
  }
})

test('a clean green PR passes and still logs a summary', async () => {
  const { result, logs } = await run()
  assert.equal(result.pass, true)
  assert.deepEqual(summaries(logs).length, 1)
  assert.match(summaries(logs)[0], /^cycle 1 summary — CI green, all bots settled\n\(no bot findings/)
  assert.equal(result.history[0].summary, summaries(logs)[0])
})

test('the summary tables every verdict, fix and pushed SHA', async () => {
  const { result, logs } = await run({
    reviews: {
      findings: [
        finding({ commentId: 3, file: 'src/c.c', line: 3, claim: 'refuted | with a pipe', verdict: 'invalid' }),
        finding({ commentId: 1, file: 'src/a.c', line: 1, claim: 'real bug' }),
        finding({ commentId: 2, file: 'src/b.c', line: 2, claim: 'already gone', verdict: 'stale' }),
      ],
      // the validator drafts a reply for every invalid AND stale finding
      replies: [{ commentId: 3, body: 'refuted because…' }, { commentId: 2, body: 'already fixed in…' }],
      done: true,
    },
  })
  const rows = rowsOf(summaries(logs)[0])
  assert.deepEqual(rows.map(r => r[2]), ['valid', 'stale', 'invalid'], 'valid first, then stale, then invalid')
  assert.match(rows[0][3], /^fixed \+ pushed/)
  assert.equal(rows[0][4], shaFor(1).slice(0, 8))
  assert.match(rows[1][3], /already fixed, replied/)
  assert.match(rows[2][3], /refuted, replied/)
  assert.deepEqual([rows[1][4], rows[2][4]], ['-', '-'], 'only fixed findings carry a commit')
  assert.match(rows[2][1], /refuted \\\| with a pipe/, 'a pipe in a claim is escaped, not table-breaking')
  assert.equal(result.history[0].reviewPush.sha, shaFor(1))
})

test('a claim already containing a backslash-pipe stays one cell', async () => {
  const { logs } = await run({
    reviews: { findings: [finding({ claim: 'the regex \\| splits the row' })], replies: [], done: true },
  })
  const cells = gfmCells(summaries(logs)[0].split('\n')[3])
  assert.equal(cells.length, 5, 'the row keeps exactly its five columns')
  assert.equal(cells[1], 'src/a.c:1 the regex \\| splits the row', 'and renders the backslash and pipe literally')
})

test('a fix whose build failed is not published, and skips the verifier', async () => {
  const { result, logs, labels } = await run({
    reviews: oneValid, fix: { buildOk: false, notes: 'uncovered: src/class/bth/bth_device.c' },
  })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'fix-verification-failed')
  assert.equal(labels.some(l => l.startsWith('push#')), false, 'the publisher is not dispatched')
  // The writer's notes carry the build contract's reason (an uncovered path, a
  // missing-deps remedy); without them the row says only that something failed.
  assert.match(rowsOf(summaries(logs)[0])[0][3], /unverified: targeted build failed: uncovered: src/,
    'reported as unverified with the writer\'s reason, and the verifier is not paid for a broken build')
})

test('a dead code-writer withholds the fix', async () => {
  const { result, logs, labels } = await run({ reviews: oneValid, fix: null })
  assert.equal(result.reason, 'fix-verification-failed')
  assert.equal(labels.some(l => l.startsWith('push#')), false)
  assert.ok(logs.some(l => /lost to dead workers/.test(l)))
  assert.match(rowsOf(summaries(logs)[0])[0][3], /withheld/)
})

test('a fix the verifier rejects is reported unverified, not pushed', async () => {
  const { result, logs, labels, calls } = await run({
    reviews: oneValid, verify: { addresses: false, reason: 'does not address the claim' },
  })
  assert.equal(result.reason, 'fix-verification-failed')
  assert.equal(labels.some(l => l.startsWith('push#')), false)
  assert.match(rowsOf(summaries(logs)[0])[0][3], /unverified: does not address the claim/)
  assert.equal(calls.find(c => c.label.startsWith('check:')).agentType, 'finding-verifier')
})

test('a dry run leaves the fix uncommitted', async () => {
  const { result, logs, labels } = await run({ reviews: oneValid, args: { autoPush: false } })
  assert.equal(result.dryRun, true)
  assert.equal(labels.some(l => l.startsWith('push#') || l.startsWith('replies#')), false)
  assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed, uncommitted/)
})

test('a dry run dispatches no publisher and no posting agent', async () => {
  // The harness default is autoPush: true — the workflow's own default is the
  // dry run, and this is what that authorization withholds.
  const { result, labels } = await run({
    args: { autoPush: false },
    reviews: {
      findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'no' }], done: true,
    },
  })
  assert.equal(result.dryRun, true)
  for (const l of labels) {
    assert.ok(!/^(push#|recheck#|replies#|resolve#)/.test(l), `${l} ran in a dry run`)
  }
})

test('a change to a protected path is dropped from scope, and a group needing only it is left red', async () => {
  const { result, logs, labels } = await run({
    args: { protected: '^test/hil/[^/]+\\.json$' },
    reviews: { findings: [finding({ file: 'test/hil/tinyusb.json' })], replies: [], done: true },
  })
  assert.equal(result.reason, 'fix-verification-failed')
  assert.equal(labels.some(l => l.startsWith('fix:')), false, 'no fixer may be dispatched for a protected path')
  assert.ok(logs.some(l => /test\/hil\/tinyusb\.json is protected — dropped from scope/.test(l)))
  assert.ok(logs.some(l => /only a protected path would address it — leaving red for the user/.test(l)))
  assert.match(rowsOf(summaries(logs)[0])[0][3], /withheld/)
})

test('the publisher stages exactly the owned paths, never a protected one', async () => {
  const { result, calls } = await run({
    args: { protected: 'rig\\.json$' },
    reviews: {
      findings: [finding({ commentId: 1, file: 'hw/bsp/stm32f4/family.c' }),
        finding({ commentId: 2, file: 'hw/bsp/stm32f4/rig.json' })],
      replies: [], done: true,
    },
  })
  const fix = calls.find(c => c.label.startsWith('fix:'))
  assert.ok(fix.prompt.includes('never modify a path matching rig\\.json$'))
  // Staging is the commit agent's turn now; the push agent only ships a made SHA.
  const commit = calls.find(c => c.label === 'commit#1-review')
  assert.ok(commit)
  assert.match(commit.prompt, /run `git add --` with exactly these paths and no others/)
  assert.match(commit.prompt, /`git commit --only --` with the same paths, never a bare `git commit`/)
  assert.match(commit.prompt, /The `--` matters: a path may look like an option\./)
  assert.match(commit.prompt, /'hw\/bsp\/stm32f4\/family\.c'/)
  assert.doesNotMatch(commit.prompt, /rig\.json/, 'a protected path must never reach the index')
  assert.match(commit.prompt, /Do not push\. Leave every other working-tree change alone/)
  assert.match(commit.prompt, /On branch claude\/foo/)
  const push = calls.find(c => c.label === 'push#1-review')
  // The exact refspec is the point: pushing the branch would publish whatever
  // HEAD became after the audit, not the commit that was audited.
  assert.match(push.prompt, new RegExp(`git push 'origin' '${shaFor(1)}:refs/heads/claude/foo'`))
  assert.match(push.prompt, /Commit nothing, amend nothing, force nothing, add no flags\./)
  // The stage cannot commit and already knows the SHA, so it is asked for neither.
  assert.deepEqual(push.schema.required, ['pass', 'detail'])
  assert.deepEqual(Object.keys(push.schema.properties), ['pass', 'detail'])
  assert.equal(result.history[0].reviewPush.sha, shaFor(1))
})

test('the fixer is told to stage nothing, and how to verify', async () => {
  const { calls } = await run({ reviews: oneValid })
  const fix = calls.find(c => c.label.startsWith('fix:'))
  assert.equal(fix.agentType, 'code-writer')
  assert.match(fix.prompt, /Do not push, create a PR, or post an issue or PR comment\./)
  assert.match(fix.prompt, /Do not stage or commit: leave your changes in the working tree for this workflow to publish\./)
  assert.match(fix.prompt, /Verify with the repository's build contract, resolved for your scope; do not invent a command\./)
  assert.doesNotMatch(fix.prompt, /cmake|get_deps|BOARD=/, 'no repository-specific recipe is baked in')
  // Read the expected keys from code-writer's own output contract. A list
  // hardcoded here pins whatever the schema happens to say, which is how `board`
  // came to be rejected: the role always returns it, and this schema forbade it.
  const roleKeys = [...readFileSync(new URL('../agents/code-writer.md', import.meta.url), 'utf8')
    .match(/^\{"item".*\}$/m)[0].matchAll(/"(\w+)":/g)].map(m => m[1]).sort()
  assert.deepEqual(fix.schema.required.slice().sort(), roleKeys)
  const built = await run({ reviews: oneValid, args: { build: '  make check  ' } })
  const fix2 = built.calls.find(c => c.label.startsWith('fix:'))
  assert.match(fix2.prompt, /Verify with: make check \(a `<BUILD>` placeholder becomes a fresh `mktemp -d`\)\./)
  assert.doesNotMatch(fix2.prompt, /build contract/)
})

test('the CI watcher is given a wait budget, 30 minutes by default', async () => {
  const { calls } = await run()
  assert.match(calls.find(c => c.label === 'ci#1').prompt, /wait budget for pending checks: 30 minutes\./)
  const long = await run({ args: { ciWait: 90 } })
  assert.match(long.calls.find(c => c.label === 'ci#1').prompt, /wait budget for pending checks: 90 minutes\./)
})

test('a path whose name has a leading or trailing space is rejected, not trimmed', async () => {
  // Git allows both; trimming would quietly name a different file.
  const { calls } = await run({
    ci: {
      status: 'red', infraRerun: [],
      realFailures: [{ check: 'build / arm', firstError: 'the log named no files', files: [], rigSide: false }],
    },
    scope: [' src/lead.c', 'src/trail.c ', 'src/keep me.c'],
  })
  const ls = calls.find(c => c.label === 'scope:verify')
  assert.match(ls.prompt, /git -c core\.quotePath=false ls-files -- 'src\/keep me\.c'\n/, 'an interior space is still a legal path')
  assert.equal(ls.prompt.includes('lead.c'), false)
  assert.equal(ls.prompt.includes('trail.c'), false)
})

test('the scoper offers every candidate to git, and keeps only the paths it knows', async () => {
  // `git ls-files` is what decides a path is real; canon only normalises spelling.
  // So the invented path has to be one the stub withholds: if the workflow stopped
  // intersecting candidates with the ls-files output, `src/invented.c` would reach
  // the fixer and this would fail.
  const { calls } = await run({
    ci: {
      status: 'red', infraRerun: [],
      realFailures: [{ check: 'build / arm', firstError: 'the log named no files', files: [], rigSide: false }],
    },
    scope: ['src/my file (v2).c', 'src/./plus+@~[1].c', 'src/nope/../plus+@~[1].c', 'src/invented.c'],
    lsFiles: (offered) => offered.filter(f => f !== 'src/invented.c'),
  })
  const ls = calls.find(c => c.label === 'scope:verify')
  // Offered: both spellings of plus+@~[1].c collapsed to one, and the invented path too.
  assert.match(ls.prompt, /git -c core\.quotePath=false ls-files -- 'src\/my file \(v2\)\.c' 'src\/plus\+@~\[1\]\.c' 'src\/invented\.c'\n/)
  const fix = calls.find(c => c.label.startsWith('fix:'))
  assert.match(fix.prompt, /Scope: src\/my file \(v2\)\.c, src\/plus\+@~\[1\]\.c/)
  assert.equal(fix.prompt.includes('invented'), false, 'a path git did not confirm never reaches the fixer')
})

test('two matrix legs of one check name keep separate fixes', async () => {
  const { logs } = await run({
    ci: {
      status: 'red', infraRerun: [],
      realFailures: [
        { check: 'build / arm', firstError: 'error in stm32f4', files: ['hw/bsp/stm32f4/family.c'], rigSide: false },
        { check: 'build / arm', firstError: 'error in nrf', files: ['hw/bsp/nrf/family.c'], rigSide: false },
      ],
    },
  })
  const rows = rowsOf(summaries(logs)[0])
  assert.match(rows[0][3], /stat:hw\/bsp\/stm32f4/)
  assert.match(rows[1][3], /stat:hw\/bsp\/nrf/, 'the second leg must not inherit the first fix')
})

test('a rig-side CI failure is left red, with no fix and no commit', async () => {
  const { result, logs, labels } = await run({
    reviews: { findings: [], replies: [], done: true },
    ci: {
      status: 'red', infraRerun: [],
      realFailures: [{ check: 'hil / pico', firstError: 'board did not enumerate', files: [], rigSide: true }],
    },
  })
  assert.equal(result.reason, 'ci-red-rig-side')
  assert.equal(labels.some(l => l.startsWith('fix:')), false)
  const row = rowsOf(summaries(logs)[0])[0]
  assert.deepEqual([row[2], row[3], row[4]], ['rig-side', 'left red for the rig', '-'])
})

test('a mislabeled commit SHA is not shown as a commit', async () => {
  // The SHA in the table is the committer's, validated rather than trusted.
  const { logs } = await run({ reviews: oneValid, audit: { sha: 'committed 1234567 insertions' } })
  assert.equal(rowsOf(summaries(logs)[0])[0][4], '-')
  // And the pusher cannot rename it: the table reports the commit that was audited.
  const relabeled = await run({ reviews: oneValid, push: { sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' } })
  assert.equal(rowsOf(summaries(relabeled.logs)[0])[0][4], shaFor(1).slice(0, 8))
})

test('a dead review validator still settles the CI lane', async () => {
  const { result, logs, labels } = await run({ reviews: new Error('validator exploded') })
  assert.equal(result.reason, 'review-validator-died')
  assert.equal(result.history[0].error, 'pr-review-validator died')
  assert.deepEqual(labels.slice(0, 2), ['preflight', 'ci#1'], 'the CI lane was launched')
  assert.equal(result.history[0].ci.status, 'green', 'and awaited, so no agent outlives the workflow')
  assert.equal(summaries(logs).length, 1)
})

test('a failed push stops the loop after a summary', async () => {
  const { result, logs } = await run({ reviews: oneValid, push: null })
  assert.equal(result.reason, 'push-failed')
  assert.equal(summaries(logs).length, 1)
  const row = rowsOf(summaries(logs)[0])[0]
  assert.match(row[3], /fixed \+ committed a1b2c3d, NOT PUSHED: push rejected/,
    'the fix is committed locally — the row must say so, and say the push failed')
  assert.equal(row[4], '-', 'a failed push carries no commit SHA')
  assert.equal(result.history[0].reviewPushFailed.detail, 'push rejected')
  const dry = await run({ reviews: oneValid, args: { autoPush: false } })
  assert.notEqual(row[3], rowsOf(summaries(dry.logs)[0])[0][3], 'and reads differently from a dry run')
})

test('a partial publication answers no comment and claims no push', async () => {
  // The commit exists but nothing is on the remote, so a fix note pointing at it
  // would send the reviewer to a commit they cannot see.
  const { result, labels } = await run({ reviews: oneValid, push: null })
  const entry = result.history[0]
  assert.equal(result.reason, 'push-failed')
  assert.deepEqual(entry.reviewPushFailed,
    { pass: false, committed: true, detail: 'push rejected', sha: shaFor(1) },
    'the commit exists, so its SHA is what the human recovers from')
  assert.equal(entry.reviewPush, undefined, 'a partial publication is not a push')
  assert.equal(labels.some(l => l.startsWith('resolve#')), false, 'no fix note may go out')
  assert.equal(entry.fixNotePosts, undefined)
})

test('a commit that never landed is not reported as committed', async () => {
  const { result, logs, labels } = await run({
    reviews: oneValid,
    commit: { committed: false, detail: 'pre-commit hook rejected' },
  })
  assert.equal(result.reason, 'push-failed')
  assert.equal(labels.includes('push#1-review'), false, 'there is nothing to push')
  const row = rowsOf(summaries(logs)[0])[0]
  assert.match(row[3], /fixed, COMMIT FAILED: pre-commit hook rejected/,
    'nothing landed in git — the row must not send the reader after a nonexistent commit')
  assert.doesNotMatch(row[3], /NOT PUSHED|\+ committed/, 'and must not claim a commit to recover')
  assert.equal(row[4], '-')
})

test('the publisher rechecks the checkout and refuses to publish onto a moved one', async () => {
  const url = 'git@github.com:hathach/tinyusb.git'
  for (const [recheck, detail] of [
    [{ branch: 'main' }, 'checkout moved: branch is main, not claude/foo'],
    // pushurl is what `git push <remote>` follows, so it is what the recheck watches.
    [{ pushUrls: ['git@github.com:fork/tinyusb.git'] },
      'checkout moved: origin now pushes to git@github.com:fork/tinyusb.git'],
    [{ pushUrls: [] }, 'checkout moved: origin now pushes to (nowhere)'],
    [{ head: FOREIGN }, 'checkout moved: HEAD is c0ffee1, not the 0f1e2d3 this run left'],
    [{ staged: ['src/other.c', 'src/more.c'] }, 'checkout moved: 2 path(s) already staged by somebody else'],
    [null, 'recheck agent died'],
  ]) {
    const { result, logs, labels, calls } = await run({ reviews: oneValid, recheck })
    assert.equal(result.reason, 'push-failed', detail)
    assert.deepEqual(result.history[0].reviewPushFailed, { pass: false, committed: false, detail, sha: '' })
    assert.ok(labels.includes('recheck#1-review'))
    assert.equal(labels.includes('commit#1-review'), false, 'nothing may be staged on a moved checkout')
    assert.equal(labels.includes('push#1-review'), false, 'and nothing may be published from it')
    assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed, COMMIT FAILED/, detail)
    const re = calls.find(c => c.label === 'recheck#1-review')
    assert.match(re.prompt, /Editing and committing nothing/)
    assert.match(re.prompt, /head = `git rev-parse HEAD`/, 'identity is an exact SHA, never a count')
    assert.match(re.prompt, /staged = the lines of `git diff --cached --name-only`/)
    assert.deepEqual(re.schema.required.slice().sort(), ['branch', 'head', 'pushUrls', 'staged'])
  }
})

test('a replacement commit that keeps the count is still a moved checkout', async () => {
  // The false accept the SHA comparison replaced: cycle 1 pushes one commit, and
  // somebody amends it. One commit before, one after — a count sees nothing.
  let cycle = 0
  const { result, logs, labels } = await run({
    args: { autoPush: true, maxCycles: 2 },
    recheck: (label) => label === 'recheck#2-review' ? { head: FOREIGN } : undefined,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [finding({ commentId: cycle, line: cycle })], replies: [], done: true }
    },
  })
  assert.equal(result.reason, 'push-failed')
  assert.equal(result.history[1].reviewPushFailed.detail,
    'checkout moved: HEAD is c0ffee1, not the a1b2c3d this run left')
  assert.ok(labels.includes('commit#1-review'), 'cycle 1 published normally')
  assert.equal(labels.includes('commit#2-review'), false, 'cycle 2 must not build on a commit it did not make')
  assert.ok(logs.some(l => /push#2-review: refusing to publish — HEAD is c0ffee1/.test(l)))
})

test('a HEAD reset behind the pinned head refuses', async () => {
  // Cycle 1's commit is gone: HEAD is back at the PR head this run started from.
  // A count would see FEWER commits than we made and never fire at all.
  let cycle = 0
  const { result, labels } = await run({
    args: { autoPush: true, maxCycles: 2 },
    recheck: (label) => label === 'recheck#2-review' ? { head: HEAD } : undefined,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [finding({ commentId: cycle, line: cycle })], replies: [], done: true }
    },
  })
  assert.equal(result.reason, 'push-failed')
  assert.equal(result.history[1].reviewPushFailed.detail,
    'checkout moved: HEAD is 0f1e2d3, not the a1b2c3d this run left')
  assert.equal(labels.includes('commit#2-review'), false)
})

test('a path somebody else staged refuses before the commit agent runs', async () => {
  // `git add` would fold their staged change into our commit, and the audit that
  // follows reads the commit, not the index it came from.
  const { result, labels, logs } = await run({
    reviews: oneValid, recheck: { staged: ['src/theirs.c'] },
  })
  assert.equal(result.reason, 'push-failed')
  assert.equal(result.history[0].reviewPushFailed.detail,
    'checkout moved: 1 path(s) already staged by somebody else')
  assert.deepEqual(labels.filter(l => /^(recheck|commit|push)#/.test(l)), ['recheck#1-review'])
  assert.ok(logs.some(l => /refusing to publish — 1 path\(s\) already staged/.test(l)))
})

test('the commit is read back by an agent that did not write it', async () => {
  const { calls } = await run({ reviews: oneValid })
  const audit = calls.find(c => c.label === 'audit#1-review')
  // A committer reporting on its own commit is the one witness not to rely on.
  assert.match(audit.prompt, /Editing and committing nothing/)
  assert.deepEqual(audit.schema.required, ['sha', 'parents', 'paths', 'leftover', 'entries'])
  assert.match(audit.prompt, /every parent, not only the first/)
  const commit = calls.find(c => c.label === 'commit#1-review')
  assert.deepEqual(commit.schema.required, ['committed', 'detail'],
    'the committer is not asked what its own commit contains')
  assert.ok(calls.indexOf(commit) < calls.indexOf(audit))
  const dead = await run({ reviews: oneValid, audit: null })
  assert.equal(dead.result.history[0].reviewPushFailed.committed, true)
  assert.match(dead.result.history[0].reviewPushFailed.detail, /audit agent died after the commit landed/)
  assert.equal(dead.labels.includes('push#1-review'), false, 'an unread commit must not leave the machine')
})

test('a commit on the wrong parent is committed but never pushed', async () => {
  // Something landed between the recheck and the commit: the commit carries work
  // this run never audited, so it stops on the machine.
  const { result, logs, labels } = await run({ reviews: oneValid, audit: { parents: [FOREIGN] } })
  assert.equal(result.reason, 'push-failed')
  assert.deepEqual(result.history[0].reviewPushFailed, {
    pass: false, committed: true, sha: shaFor(1),
    detail: 'commit failed audit: commit sits on c0ffee1, not 0f1e2d3',
  })
  assert.equal(labels.includes('push#1-review'), false, 'an unaudited commit must not leave the machine')
  assert.ok(logs.some(l => /committed but NOT pushed — commit sits on c0ffee1/.test(l)))
  assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed \+ committed [0-9a-f]{7}, NOT PUSHED: commit failed audit/)
})

test('a merge commit is never pushed, even on the right first parent', async () => {
  // Its first parent is where the run left HEAD, so a first-parent check passes
  // while the second parent brings history nothing audited.
  const { result, labels } = await run({ reviews: oneValid, audit: { parents: [HEAD, FOREIGN] } })
  assert.equal(result.reason, 'push-failed')
  assert.match(result.history[0].reviewPushFailed.detail,
    /commit failed audit: commit has 2 parents: a merge brings history this run never audited/)
  assert.equal(labels.includes('push#1-review'), false)
})

test('a commit carrying a path the run did not own is never pushed', async () => {
  const { result, logs, labels } = await run({
    reviews: oneValid,
    audit: { paths: ['src/a.c', 'test/hil/tinyusb.json'] },
  })
  assert.equal(result.reason, 'push-failed')
  assert.equal(result.history[0].reviewPushFailed.committed, true)
  assert.equal(result.history[0].reviewPushFailed.detail,
    'commit failed audit: commit carries unowned path(s): test/hil/tinyusb.json')
  assert.equal(labels.includes('push#1-review'), false)
  assert.ok(logs.some(l => /committed but NOT pushed — commit carries unowned path/.test(l)))
})

test('a reply poster that throws leaves the debt owed, not the cycle dead', async () => {
  // The comments it posts are public and it records what went out AFTER it
  // returns, so a rejection there must not take the cycle with it: the run has
  // to end saying the replies are still owed, not that something exploded.
  const { result, logs } = await run({ reviews: oneValid, throwOn: 'resolve#' })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'deferred-replies-unresolved', 'the debt is what is unresolved')
  assert.equal(result.history.length, 1, 'the verdict keeps the history it was built from')
  assert.deepEqual(result.history[0].fixNotePosts, { pass: false, detail: 'agent died', receipts: [] },
    'the receipt exists even though the poster died')
  assert.ok(logs.some(l => /resolve#1 errored — resolve#1 exploded/.test(l)), logs.join('\n'))
  assert.equal(summaries(logs).length, 1, 'the scoreboard survives an agent-failure cycle')
  const row = rowsOf(summaries(logs)[0])[0]
  assert.match(row[3], /fixed \+ pushed/, 'the push did land before the throw — the row must say so')
  assert.equal(row[4], SHA.slice(0, 8))
})

test('a publisher agent that throws is a failed push, not a crash', async () => {
  // Each publisher turn is guarded, so a rejection there becomes a push verdict
  // the summary can report rather than an unexplained dead cycle.
  for (const [throwOn, detail, committed] of [
    ['recheck#', 'recheck agent died', false],
    ['commit#', 'commit agent died', null], // no receipt either way: neither true nor false is earned
    ['push#', 'push agent died after the commit landed', true],
  ]) {
    const { result, logs } = await run({ reviews: oneValid, throwOn })
    assert.equal(result.reason, 'push-failed', throwOn)
    assert.equal(result.history[0].reviewPushFailed.detail, detail)
    assert.equal(result.history[0].reviewPushFailed.committed, committed)
    assert.match(rowsOf(summaries(logs)[0])[0][3],
      committed === null ? /fixed, COMMIT OUTCOME UNKNOWN: commit agent died/
        : committed ? /fixed \+ committed [0-9a-f]{7}, NOT PUSHED/ : /fixed, COMMIT FAILED/, throwOn)
  }
})

test('the pending-bot backoff is taken after the cycle summary', async () => {
  const { result, logs, napPoints } = await run({
    args: { maxCycles: 2 },
    reviews: { findings: [], replies: [], done: false },
  })
  assert.equal(result.reason, 'maxCycles reached')
  assert.equal(summaries(logs).length, 2, 'every cycle reports')
  assert.equal(napPoints.length, 1, 'no backoff after the last cycle')
  const firstSummaryAt = logs.findIndex(l => l.startsWith('cycle 1 summary'))
  assert.ok(napPoints[0] > firstSummaryAt, 'cycle 1 reported before the wait, not after it')
})

test('reviews go to the validator role directly, and no lane leaves the roles', async () => {
  // The `workflow` binding throws, so a run that reaches its verdict is itself
  // the proof that nothing nested a workflow; these are the only roles it may
  // dispatch to (the mechanical lanes carry a model, not an agentType).
  const ROLES = ['pr-ci-watcher', 'pr-review-validator', 'finding-verifier', 'code-writer']
  const wide = await run({
    reviews: {
      findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'no' }], done: true,
    },
  })
  const scoped = await run({
    ci: {
      status: 'red', infraRerun: [],
      realFailures: [{ check: 'build / arm', firstError: 'no files in the log', files: [], rigSide: false }],
    },
    scope: ['src/a.c'],
  })
  const calls = [...wide.calls, ...scoped.calls]
  assert.equal(calls.find(c => c.label.startsWith('reviews#')).agentType, 'pr-review-validator')
  assert.equal(calls.find(c => c.label.startsWith('ci#')).agentType, 'pr-ci-watcher')
  for (const c of calls) {
    if (c.agentType !== undefined) assert.ok(ROLES.includes(c.agentType), `${c.label} dispatched to ${c.agentType}`)
  }
  assert.ok(calls.some(c => c.label.startsWith('fix:')) && calls.some(c => c.label.startsWith('scope:')))
  // Dispatch only proves what the exercised branches did: a dormant workflow()
  // call would never be reached here, and runCycle would absorb the stub's throw
  // as 'cycle-threw' if it were. So refuse the spelling too, over the whole source.
  assert.doesNotMatch(body, /\bworkflow\s*\(/, 'this workflow must never nest another workflow')
  assert.doesNotMatch(body, /codex-agent/, 'the review lane is a Claude role, not a codex agent')
})

test('the harvest contract requires a findingId on every finding', async () => {
  const { calls } = await run()
  const items = calls.find(c => c.label.startsWith('reviews#')).schema.properties.findings.items
  assert.ok(items.required.includes('findingId'), 'REVIEWS no longer requires findingId')
  assert.ok(items.required.includes('commentDigest'), 'nor a digest to catch an edited comment')
  assert.equal(items.additionalProperties, false)
})

test('the cycle records what each posting lane reported', async () => {
  const { result, calls } = await run({
    reviews: {
      findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'no' }], done: true,
    },
  })
  const entry = result.history[0]
  assert.deepEqual(entry.refutedPosts, { pass: true, detail: 'posted and read back', receipts: [receiptFor(2, 'no')] })
  assert.equal(entry.fixNotePosts.pass, true)
  assert.equal(entry.fixNotePosts.receipts[0].digest, fnv1a(manifestOf(calls, 'resolve#1')[0].body))
  const dead = await run({ reviews: oneValid, posting: null })
  assert.deepEqual(dead.result.history[0].fixNotePosts, { pass: false, detail: 'agent died', receipts: [] })
})

test('every dismissal is challenged before it is posted', async () => {
  // The challenge protects the act of publicly refuting a reviewer. It is a
  // second Claude role; an independent model is the chief session's coworker lane.
  const { calls } = await run({
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
  })
  const ch = calls.find(c => c.label.startsWith('challenge#'))
  assert.ok(ch, 'a validated refutation must still be challenged')
  assert.equal(ch.agentType, 'finding-verifier')
})

test('an upheld refutation still replies and resolves', async () => {
  const { calls } = await run({
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    args: { autoPush: true },
  })
  const posted = calls.find(c => c.label.startsWith('replies#'))
  assert.ok(posted, 'expected the refutation to be posted')
  assert.match(posted.prompt, /"commentId":1/)
})

test('sibling refutations on one comment are merged into its single reply', async () => {
  // Posting resolves the thread, so only one reply per comment goes out - but
  // that reply retires every dismissal on the comment, so dropping a sibling
  // draft would retire a refutation the reviewer never saw.
  const { calls, result } = await run({
    reviews: {
      findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
      replies: [{ commentId: 7, body: 'the first point misreads the guard' },
        { commentId: 7, body: 'the second point is about dead code' }],
      done: true,
    },
    args: { autoPush: true, maxCycles: 1 },
  })
  const posted = calls.filter(c => c.label.startsWith('replies#'))
  assert.equal(posted.length, 1, 'one posting agent, one reply per thread')
  assert.match(posted[0].prompt, /the first point misreads the guard/)
  assert.match(posted[0].prompt, /the second point is about dead code/)
  assert.equal(result.pass, true, `both dismissals must be settled (got ${result.reason})`)
})

test('an overturned finding is fixed, replied to, and carries the challenger reason', async () => {
  const { calls } = await run({
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: false, reason: 'the NAK path is real' }] },
    args: { autoPush: true },
  })
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false, 'no refutation is posted')
  const fix = calls.find(c => c.label.startsWith('fix:'))
  assert.match(fix.prompt, /the NAK path is real/)
  // every finding on the comment was overturned, so the fix note is NOT withheld
  const resolve = calls.find(c => c.label.startsWith('resolve#'))
  assert.ok(resolve, 'expected the fix note to be posted')
  assert.match(resolve.prompt, /"commentId":1/)
})

test('a mixed comment defers its reply and blocks the green exit', async () => {
  const { calls, result } = await run({
    reviews: {
      findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
      replies: [{ commentId: 7, body: 'both wrong' }],
      done: true,
    },
    challenge: { verdicts: [
      { id: 0, upheld: false, reason: 'real' },
      { id: 1, upheld: true, reason: 'stands' },
    ] },
    args: { autoPush: true, maxCycles: 1 },
  })
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false)
  const resolve = calls.find(c => c.label.startsWith('resolve#'))
  if (resolve) assert.doesNotMatch(resolve.prompt, /"commentId":7/)
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'deferred-replies-unresolved')
  assert.deepEqual(result.deferred, [7])
})

test('no fix note is dispatched when the push answers no comment', async () => {
  // The mixed comment defers its note, so there is nothing to post. Dispatching
  // anyway risks throwing after the fix is already pushed, which would report
  // the cycle as a crash instead of re-arming for the deferred reply.
  const { calls, result } = await run({
    reviews: {
      findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
      replies: [{ commentId: 7, body: 'both wrong' }],
      done: true,
    },
    challenge: { verdicts: [
      { id: 0, upheld: false, reason: 'real' },
      { id: 1, upheld: true, reason: 'stands' },
    ] },
    throwOn: 'resolve#',
    args: { autoPush: true, maxCycles: 1 },
  })
  assert.equal(calls.some(c => c.label.startsWith('resolve#')), false, 'nothing to answer, nothing to dispatch')
  assert.equal(result.reason, 'deferred-replies-unresolved', `the push must not read as a crash (got ${result.reason})`)
})

test('two valid findings on one comment share one fix note', async () => {
  // One note per thread, as postReplyRecipe posts it - and it has to name both
  // claims, because paying the comment settles both.
  let cycle = 0
  const { calls, result } = await run({
    args: { autoPush: true, maxCycles: 2 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [finding({ commentId: 1, claim: 'the first leak' }),
          finding({ commentId: 1, line: 9, claim: 'the second leak' })], replies: [], done: true }
        : { findings: [], replies: [], done: true }
    },
  })
  const resolve = calls.filter(c => c.label.startsWith('resolve#'))
  assert.equal(resolve.length, 1)
  assert.equal([...resolve[0].prompt.matchAll(/"commentId":1\b/g)].length, 1, 'one note for the thread')
  assert.match(resolve[0].prompt, /the first leak\\n- src\/a\.c:9: the second leak/, 'both findings named in the one note')
  assert.equal(result.pass, true, `the comment must be settled (got ${result.reason})`)
})

test('a dry run that runs out of cycles still reads as a dry run', async () => {
  // Bots never settle, so the green exit that reports dryRun is never reached
  // and the loop expires with the debt it was never allowed to post.
  const { result } = await run({
    args: { autoPush: false, maxCycles: 2 },
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: false },
  })
  assert.equal(result.reason, 'deferred-replies-unresolved')
  assert.deepEqual(result.deferred, [1])
  assert.equal(result.dryRun, true, 'unposted-by-design debt must not read as a failed reply workflow')
})

test('a broken challenge response fails the cycle', async () => {
  for (const challenge of [
    null,
    { verdicts: [] },
    { verdicts: [{ id: 9, upheld: true, reason: 'x' }] },
    { verdicts: [{ id: 0, upheld: true, reason: 'x' }, { id: 0, upheld: false, reason: 'y' }] },
  ]) {
    const { result } = await run({
      reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
      challenge, args: { autoPush: true, maxCycles: 1 },
    })
    assert.equal(result.reason, 'review-challenger-died')
  }
})

test('the summary marks an overturned finding', async () => {
  const { logs } = await run({
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
    args: { autoPush: true, maxCycles: 1 },
  })
  // Named in the order the decision was made: the validator refutes, the
  // challenger overturns that dismissal.
  assert.ok(logs.some(l => l.includes('refuted, then overturned')),
    'cycle table must show the overturn in the order the roles acted')
})

test('a deferred obligation is cleared only by a posted reply', async () => {
  // Cycle 1 defers comment 7 (one overturned, one upheld). A later cycle sees
  // only the upheld one, posts it, and that posting is what clears the deferral.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
          replies: [{ commentId: 7, body: 'both wrong' }], done: true }
        : { findings: [invalidFinding({ commentId: 7, line: 9 })],
          replies: [{ commentId: 7, body: 'still wrong' }], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: false, reason: 'real' }, { id: 1, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(result.pass, true, `the posted reply must discharge the deferral (got ${result.reason})`)
})

test('an orphan reply is never posted unchallenged', async () => {
  // REVIEWS does not tie replies to findings, so a validator can emit a reply
  // for a commentId that has no non-valid finding. Nothing challenges it, and
  // posting it publicly refutes a reviewer on no one's authority.
  const { calls } = await run({
    reviews: {
      findings: [finding({ commentId: 1, verdict: 'valid' })],
      replies: [{ commentId: 99, body: 'you are wrong' }],
      done: true,
    },
    args: { autoPush: true, maxCycles: 1 },
  })
  const posted = calls.find(c => c.label.startsWith('replies#'))
  if (posted) assert.doesNotMatch(posted.prompt, /"commentId":99/, 'orphan reply was posted')
})

test('a stray doneId cannot discharge an unrelated deferral', async () => {
  // The posting agent returns receipts. Trusting an id that was never in
  // the payload lets one clear an obligation nobody answered.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 2 },
    strayDoneIds: [7],
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
          replies: [{ commentId: 7, body: 'both wrong' }], done: true }
        : { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => ({ verdicts: [
      { id: 0, upheld: false, reason: 'real' }, { id: 1, upheld: true, reason: 'stands' }] }),
  })
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'a stray doneId discharged comment 7 without any reply being posted')
})

test('a refutation with no drafted reply is not silently dropped', async () => {
  // REVIEWS lets a validator report a non-valid finding and draft no reply for
  // it. Nothing else accounts for that answer, so the cycle could go green with
  // the reviewer's thread untouched.
  const { result } = await run({
    reviews: { findings: [invalidFinding({ commentId: 5 })], replies: [], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    args: { autoPush: true, maxCycles: 1 },
  })
  assert.equal(result.pass, false, 'an unanswered refutation must not pass')
  assert.deepEqual(result.deferred, [5])
})

test('a comment mixing valid and refuted findings is not resolved early', async () => {
  // Posting the refutation resolves the whole thread, hiding the valid finding
  // until its fix lands - and burying it for good if the fixer then fails.
  const { calls, result } = await run({
    reviews: {
      findings: [finding({ commentId: 3, verdict: 'valid' }), invalidFinding({ commentId: 3, line: 9 })],
      replies: [{ commentId: 3, body: 'the second one is wrong' }],
      done: true,
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    args: { autoPush: true, maxCycles: 1 },
  })
  const posted = calls.find(c => c.label.startsWith('replies#'))
  if (posted) assert.doesNotMatch(posted.prompt, /"commentId":3/, 'thread resolved before the fix')
  assert.equal(result.pass, false)
  assert.deepEqual(result.deferred, [3])
})

test('a fix note does not discharge a deferred refutation', async () => {
  // The fix note says "fixed in commit X"; it is not the refutation that was
  // owed. Letting its receipt clear the deferral answers the thread with the
  // wrong content and lets the next green cycle pass.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 2 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [finding({ commentId: 4, verdict: 'valid' }), invalidFinding({ commentId: 4, line: 9 })],
          replies: [{ commentId: 4, body: 'the second is wrong' }], done: true }
        : { findings: [finding({ commentId: 4, verdict: 'valid' })], replies: [], done: true }
    },
    challengePerCycle: () => ({ verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }),
  })
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'a fix note discharged a refutation it never made')
})

test('a comment is never replied to twice in one cycle', async () => {
  const { calls } = await run({
    reviews: {
      findings: [invalidFinding({ commentId: 8 })],
      replies: [{ commentId: 8, body: 'wrong' }, { commentId: 8, body: 'also wrong' }],
      done: true,
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    args: { autoPush: true, maxCycles: 1 },
  })
  const posted = calls.find(c => c.label.startsWith('replies#'))
  assert.ok(posted)
  assert.equal([...posted.prompt.matchAll(/"commentId":8/g)].length, 1, 'duplicate reply posted')
})

test('a deferred refutation can still be posted after a fix note', async () => {
  // The fix note records the comment in answeredWith. If that also blocks the
  // reply stage, the refutation its debt still owes can never go out and the
  // deferral is permanent.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) {
        return { findings: [finding({ commentId: 4, verdict: 'valid' }), invalidFinding({ commentId: 4, line: 9 })],
          replies: [{ commentId: 4, body: 'the second is wrong' }], done: true }
      }
      if (cycle === 2) return { findings: [finding({ commentId: 4, verdict: 'valid' })], replies: [], done: true }
      return { findings: [invalidFinding({ commentId: 4, line: 9 })],
        replies: [{ commentId: 4, body: 'still wrong' }], done: true }
    },
    challengePerCycle: () => ({ verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }),
  })
  assert.equal(result.pass, true, `the owed refutation must be postable (got ${result.reason})`)
})

test('an already-answered comment is not deferred for a missing draft', async () => {
  // An entry in answeredWith means the thread was answered and resolved.
  // Re-opening its debt because this harvest drafted no reply creates an
  // obligation nothing can discharge.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 3 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [invalidFinding({ commentId: 7 })],
          replies: [{ commentId: 7, body: 'wrong' }], done: true }
        : { findings: [invalidFinding({ commentId: 7 })], replies: [], done: true }
    },
    challengePerCycle: () => ({ verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }),
  })
  assert.equal(result.pass, true, `an answered comment must not be re-deferred (got ${result.reason})`)
})

test('an obligation dies with the finding that created it', async () => {
  // Cycle 1 defers a mixed comment. Cycle 2 overturns its refuted half, so
  // nothing is owed but a fix note. A stored obligation would outlive its
  // cause here and end the run as unresolved with nothing actually owed.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    reviewsPerCycle: () => {
      cycle++
      return { findings: [finding({ commentId: 6, verdict: 'valid' }),
        invalidFinding({ commentId: 6, line: 9 })],
      replies: [{ commentId: 6, body: 'the second is wrong' }], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: false, reason: 'actually real' }] },
  })
  assert.notEqual(result.reason, 'deferred-replies-unresolved',
    'the deferral outlived the refuted finding that created it')
  assert.equal(result.deferred, undefined)
})

test('overturning one refutation does not excuse a vanished sibling', async () => {
  // Comment 7 owes two refutations. The next harvest drops one and the
  // challenger overturns the other; the fix note then resolves the thread. The
  // dropped dismissal was never answered, so it still holds the loop open.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) {
        return { findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
          replies: [], done: true }
      }
      if (cycle === 2) return { findings: [invalidFinding({ commentId: 7, line: 9 })], replies: [], done: true }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: true, reason: 'stands' }, { id: 1, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
  })
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'one overturn discharged an unrelated unanswered dismissal')
  assert.deepEqual(result.deferred, [7])
})

test('a retried fix note discharges its own carried obligation', async () => {
  // The first attempt posts nothing, so the fix note is owed into the next
  // cycle. Only that same answer can clear it - no refutation was ever owed.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    dropDoneIds: (label) => cycle === 1 && label.startsWith('resolve#'),
    reviewsPerCycle: () => {
      cycle++
      return cycle <= 2 ? structuredClone(oneValid) : { findings: [], replies: [], done: true }
    },
  })
  assert.equal(result.pass, true, `the retried fix note must clear its deferral (got ${result.reason})`)
})

test('a stale re-report of a fixed finding owes nothing', async () => {
  // The thread was answered and resolved by the fix note. Reporting the same
  // finding stale afterwards is a consequence of our own fix, not a dismissal
  // owed to the reviewer - and no reply is ever drafted for it.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 3 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? structuredClone(oneValid)
        : { findings: [finding({ verdict: 'stale' })], replies: [], done: true }
    },
  })
  assert.equal(result.pass, true, `a stale re-report reopened a settled comment (got ${result.reason})`)
})

test('an edit to an answered comment owes an answer again', async () => {
  // The fix note answered and resolved comment 1. The reviewer then edits the
  // body: the point now being made is not the one we answered, so it accrues a
  // dismissal the run must not pass without.
  let cycle = 0
  const { result, logs } = await run({
    args: { autoPush: true, maxCycles: 3 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? structuredClone(oneValid)
        : { findings: [invalidFinding({ commentDigest: 'edited' })], replies: [], done: true }
    },
  })
  assert.ok(logs.some(l => l.includes('comment 1 was edited after we answered it')), 'the edit must be reported')
  assert.notEqual(result.pass, true, 'an edit to an answered comment went unnoticed')
  assert.deepEqual(result.deferred, [1])
})

test('a fix note reads as deferred only while it still owes a dismissal', async () => {
  // Nothing is outstanding here: the fix note closed the thread, so calling it
  // deferred names a next cycle that has nothing to do.
  let cycle = 0
  const paid = await run({
    args: { autoPush: true, maxCycles: 2 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? structuredClone(oneValid)
        : { findings: [finding({ verdict: 'stale' })], replies: [], done: true }
    },
  })
  assert.match(rowsOf(summaries(paid.logs)[1])[0][3], /already fixed, answered by fix note/)

  // Comment 4's refuted half is never replied to, so the fix note that answered
  // its valid half leaves that dismissal owed - and deferred is the right word.
  let mixed = 0
  const owing = await run({
    args: { autoPush: true, maxCycles: 3 },
    reviewsPerCycle: () => {
      mixed++
      if (mixed === 1) {
        return { findings: [finding({ commentId: 4, verdict: 'valid' }), invalidFinding({ commentId: 4, line: 9 })],
          replies: [], done: true }
      }
      if (mixed === 2) return { findings: [finding({ commentId: 4, verdict: 'valid' })], replies: [], done: true }
      return { findings: [invalidFinding({ commentId: 4, line: 9 })], replies: [], done: true }
    },
  })
  assert.match(rowsOf(summaries(owing.logs)[2])[0][3], /refuted, deferred to next cycle/)
})

test('a dry run reports refutations it would post rather than deferring them', async () => {
  // Without autoPush nothing is posted, so an obligation would spin the loop to
  // exhaustion and call it unresolved. The review lane already says dryRun.
  const { calls, result } = await run({
    args: { autoPush: false, maxCycles: 3 },
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
  })
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false, 'a dry run must post nothing')
  assert.equal(result.dryRun, true)
  assert.equal(result.reason, undefined)
})

test('a dropped dismissal survives a later harvest that reports fewer', async () => {
  // Comment 7 owes two refutations. The next harvest reports only one, and the
  // one after overturns and fixes it. Taking that shrinking harvest as the
  // standing debt would forget the dismissal nobody ever answered.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 5 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) {
        return { findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
          replies: [], done: true }
      }
      if (cycle <= 3) return { findings: [invalidFinding({ commentId: 7, line: 9 })], replies: [], done: true }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 3
      ? { verdicts: [{ id: 0, upheld: false, reason: 'real' }] }
      : { verdicts: [{ id: 0, upheld: true, reason: 'stands' }, { id: 1, upheld: true, reason: 'stands' }]
        .slice(0, cycle === 1 ? 2 : 1) },
  })
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'a shrinking harvest discharged a dismissal nobody answered')
  assert.deepEqual(result.deferred, [7])
})

test('a stale reply after a failed fix note is a repair, not a second answer', async () => {
  // The fix note may be on the thread even though its receipt said otherwise;
  // the "already fixed" reply the stale re-report drafts would be a second
  // answer of another kind. The comment goes to a human with both facts.
  let cycle = 0
  const { result, calls } = await run({
    args: { autoPush: true, maxCycles: 4 },
    dropDoneIds: (label) => cycle === 1 && label.startsWith('resolve#'),
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) return structuredClone(oneValid)
      if (cycle === 2) return { findings: [finding({ verdict: 'stale' })], replies: [{ commentId: 1, body: 'already fixed' }], done: true }
      return { findings: [], replies: [], done: true }
    },
  })
  assert.equal(result.pass, false)
  assert.deepEqual(result.deferred, [1])
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false, 'the stale reply went out over a possible fix note')
  assert.deepEqual(result.state.debt.find(([id]) => id === 1)[1].repair, { replyId: null, error: 'offered fixNote is stale (now owes a refutation)' })
})

test('an answered comment is not replied to again for a stale re-report', async () => {
  // The fix note already resolved the thread. A drafted "already fixed" reply
  // for the same finding is a second answer to a closed thread.
  let cycle = 0
  const { calls } = await run({
    args: { autoPush: true, maxCycles: 2 },
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? structuredClone(oneValid)
        : { findings: [finding({ verdict: 'stale' })], replies: [{ commentId: 1, body: 'already fixed' }], done: true }
    },
  })
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false,
    'a resolved thread was answered twice')
})

const receiptFor = (commentId, body) =>
  ({ commentId, kind: 'review', replyId: 500 + commentId, digest: fnv1a(body), sent: true, posted: true, verified: true, resolved: true, error: null })

test('a reply is published by the script from a workflow-built manifest', async () => {
  // The poster gets a manifest and the script path; it composes no body and
  // runs no gh call of its own. The fix note's text is the workflow's.
  const { calls } = await run({
    reviews: {
      findings: [finding({ commentId: 1, file: 'src/a.c', line: 3, claim: 'off by one' }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'not so' }], done: true,
    },
  })
  for (const label of ['replies#1', 'resolve#1']) {
    const c = calls.find(x => x.label === label)
    assert.ok(c, `${label} ran`)
    assert.match(c.prompt, /skills\/pr-reply\/scripts\/reply\.py --pr 3888 --manifest/, `${label} runs the script`)
    assert.doesNotMatch(c.prompt, /gh api/, `${label} types no gh call`)
    assert.equal(c.schema.properties.receipts.items.additionalProperties, false, `${label} takes receipts only`)
  }
  const notes = manifestOf(calls, 'resolve#1')
  assert.equal(notes.length, 1)
  assert.equal(notes[0].commentId, 1)
  assert.match(notes[0].body, /^Fixed in [0-9a-f]{40}\.\n\n- src\/a\.c:3: off by one$/, 'the note names the pushed SHA and the finding')
  assert.equal(notes[0].digest, fnv1a(notes[0].body))
  const replies = manifestOf(calls, 'replies#1')
  assert.deepEqual(replies, [{ commentId: 2, body: 'not so', digest: fnv1a('not so') }])
})

test('a reply that landed with the wrong body is a repair, never a repost', async () => {
  // The script read the reply back and it did not match: the thread stays
  // open, the comment keeps its debt with the reply id, and the next cycle
  // must not answer it a second time on top of the wrong one.
  let cycle = 0
  const { result, logs, calls } = await run({
    args: { autoPush: true, maxCycles: 2 },
    wrongBody: (id) => id === 2,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(result.pass, false)
  assert.deepEqual(result.deferred, [2])
  const [, d] = result.state.debt.find(([id]) => id === 2)
  assert.deepEqual(d.repair, { replyId: 502, error: 'read-back mismatch on body' })
  assert.equal(calls.filter(c => c.label.startsWith('replies#')).length, 1, 'no second reply after the wrong one')
  assert.ok(logs.some(l => /reply 502 to comment 2 exists with the wrong content .* needs a human repair/.test(l)), logs.join('\n'))
  assert.match(rowsOf(summaries(logs)[1])[0][3], /NEEDS REPAIR/)
  assert.equal(result.history[0].refutedPosts.pass, false)
})

test('a repair obligation survives a restart and still blocks a repost', async () => {
  const first = await run({
    args: { autoPush: true, maxCycles: 2, yieldAfterCycle: true },
    wrongBody: (id) => id === 2,
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  const second = await run({
    args: { autoPush: true, maxCycles: 2, state: first.result.state },
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(second.calls.some(c => c.label.startsWith('replies#')), false, 'reposted over a reply that needs repair')
  assert.deepEqual(second.result.state.debt.find(([id]) => id === 2)[1].repair, { replyId: 502, error: 'read-back mismatch on body' })
})

test('a receipt for a different body settles nothing', async () => {
  // The posting agent transcribed the manifest wrong, or answered with some
  // other reply's receipt: the digest does not match the body the workflow
  // handed out, so the comment stays owed.
  const { result, logs } = await run({
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    receipts: (rs) => rs.map(r => ({ ...r, digest: fnv1a('@/tmp/body.txt') })),
  })
  assert.equal(result.pass, false)
  assert.deepEqual(result.deferred, [2])
  assert.ok(logs.some(l => /receipt for comment 2 is for a different body/.test(l)), logs.join('\n'))
})

test('two receipts for one comment, or success without a reply id, settle nothing', async () => {
  const twice = await run({
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    receipts: (rs) => [{ ...rs[0], verified: false, error: 'read-back mismatch on body' }, rs[0]],
  })
  assert.deepEqual(twice.result.deferred, [2], 'a mismatch followed by a success is contradictory')
  assert.deepEqual(twice.result.state.debt.find(([id]) => id === 2)[1].repair, { replyId: 502, error: 'contradictory receipts' },
    'the reply the receipts name is kept so nothing is posted over it')
  const noId = await run({
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    receipts: (rs) => rs.map(r => ({ ...r, kind: 'issue', replyId: null, resolved: null })),
  })
  assert.deepEqual(noId.result.deferred, [2], 'verified with no reply id is impossible')
})

test('a comment on none of the PR\'s id spaces owes nothing', async () => {
  // Every space searched, nothing found: no reply can ever pay it, so the
  // debt is dropped, not carried through every later cycle. No reply exists,
  // so answeredWith stays empty and the summary says so.
  let cycle = 0
  const validOnce = () => (++cycle === 1 ? oneValid : { findings: [], replies: [], done: true })
  const { result } = await run({ args: { autoPush: true, maxCycles: 2 }, reviewsPerCycle: validOnce, noTarget: (id) => id === 1 })
  assert.equal(result.pass, true, `nothing is owed (got ${result.reason})`)
  assert.deepEqual(result.state.debt, [])
  assert.deepEqual(result.state.answeredWith, [])
  assert.equal(result.history[0].fixNotePosts.detail, 'not on the PR, nothing owed: 1')
  const refuted = await run({
    args: { autoPush: true },
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    noTarget: (id) => id === 2,
  })
  assert.equal(refuted.result.pass, true, 'a refutation with no target owes nothing either')
  assert.deepEqual(refuted.result.state.debt, [])
  assert.match(rowsOf(summaries(refuted.logs)[0])[0].join('|'), /refuted, no reply: comment is not on the PR/)
})

test('only an explicit none receipt retires a debt', async () => {
  // A lookup that failed (kind null) or a receipt for another body proves
  // nothing about whether the comment exists; the debt stays.
  for (const [name, reshape] of [
    ['lookup failed', (r) => ({ ...r, kind: null, sent: false, replyId: null, verified: false, error: 'HTTP 502' })],
    ['wrong digest', (r) => ({ ...r, kind: 'none', sent: false, replyId: null, verified: false, digest: 'deadbeef', error: 'not on PR' })],
    ['two receipts', (r) => [r, r].map(x => ({ ...x, kind: 'none', sent: false, replyId: null, verified: false }))],
  ]) {
    const { result } = await run({
      args: { autoPush: true },
      reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
      challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
      receipts: (rs) => rs.flatMap(reshape),
    })
    assert.deepEqual(result.deferred, [2], name)
    assert.ok(result.state.debt.some(([id]) => id === 2), `${name}: the debt is kept`)
  }
})

test('a none receipt that also names a reply is contradictory, not a retirement', async () => {
  // The script's absence shape is exact: kind none with no POST and no reply.
  // A receipt that says none and still carries a reply id can only be a
  // transcription error, so the debt is kept and the reply it names is the repair.
  for (const [name, reshape] of [
    ['mismatch', (r) => ({ ...r, kind: 'none', verified: false, resolved: null, error: 'read-back mismatch on body' })],
    ['success-shaped', (r) => ({ ...r, kind: 'none' })],
    ['sent, no reply', (r) => ({ ...r, kind: 'none', replyId: null, posted: false, verified: false, resolved: null })],
  ]) {
    const { result } = await run({
      args: { autoPush: true },
      reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
      challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
      receipts: (rs) => rs.map(reshape),
    })
    assert.deepEqual(result.deferred, [2], name)
    assert.deepEqual(result.state.answeredWith, [], `${name}: nothing was paid`)
    const [, d] = result.state.debt.find(([id]) => id === 2)
    assert.deepEqual(d.repair, name === 'sent, no reply' ? undefined : { replyId: 502, error: 'contradictory receipt' }, name)
  }
})

test('a verified review-body receipt pays like an issue comment', async () => {
  let cycle = 0
  const validOnce = () => (++cycle === 1 ? oneValid : { findings: [], replies: [], done: true })
  const { result } = await run({ args: { autoPush: true, maxCycles: 2 }, reviewsPerCycle: validOnce, reviewBody: (id) => id === 1 })
  assert.equal(result.pass, true, result.reason)
  assert.deepEqual(result.state.answeredWith.map(([id, a]) => [id, a.how]), [[1, 'fixNote']])
  assert.equal(result.history[0].fixNotePosts.detail, 'posted and read back')
})

test('an unavailable read-back is retried, not repaired', async () => {
  let cycle = 0
  const { result, calls } = await run({
    args: { autoPush: true, maxCycles: 2 },
    unreadable: (id) => cycle === 1 && id === 2,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(result.pass, true, `the retry settles it (got ${result.reason})`)
  assert.equal(calls.filter(c => c.label.startsWith('replies#')).length, 2)
  assert.equal(result.history[0].refutedPosts.pass, false)
  assert.equal(result.history[0].refutedPosts.receipts[0].verified, null)
})

test('a retry offers the body first posted, not the redraft', async () => {
  // A lost receipt or a failed resolve leaves a reply on the thread. The script
  // reuses only an identical body, so the next cycle must hand it the same text
  // even when the validator drafted new words.
  let cycle = 0
  const { result, calls, logs } = await run({
    args: { autoPush: true, maxCycles: 2 },
    posting: (label) => cycle === 1 && label.startsWith('replies#') ? null : true,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: cycle === 1 ? 'first wording' : 'second wording' }], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(result.pass, true, `settled on the retry (got ${result.reason})`)
  const bodies = calls.filter(c => c.label.startsWith('replies#')).map(c => manifestOf(calls, c.label)[0].body)
  assert.deepEqual(bodies, ['first wording', 'first wording'])
  assert.ok(logs.some(l => /comment 2 keeps the body already offered/.test(l)), logs.join('\n'))
  assert.equal(result.state.debt.length, 0, 'paid debt carries no attempt')
})

test('any failed attempt keeps the offered body: no receipt proves nothing landed', async () => {
  for (const [name, hook] of [['clean failure', 'dropDoneIds'], ['lost response', 'lost']]) {
    let cycle = 0
    const { result, calls } = await run({
      args: { autoPush: true, maxCycles: 2 },
      [hook]: () => cycle === 1,
      reviewsPerCycle: () => {
        cycle++
        return { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: cycle === 1 ? 'first wording' : 'second wording' }], done: true }
      },
      challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
    })
    assert.equal(result.pass, true, name)
    assert.deepEqual(calls.filter(c => c.label.startsWith('replies#')).map(c => manifestOf(calls, c.label)[0].body),
      ['first wording', 'first wording'], name)
  }
})

test('the offered body survives a restart', async () => {
  const first = await run({
    args: { autoPush: true, maxCycles: 2, yieldAfterCycle: true },
    posting: null,
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'first wording' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.deepEqual(first.result.state.debt.find(([id]) => id === 2)[1].attempt, { body: 'first wording', how: 'refutation', digest: 'd2' })
  const second = await run({
    args: { autoPush: true, maxCycles: 2, state: first.result.state },
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'second wording' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(manifestOf(second.calls, 'replies#2')[0].body, 'first wording')
  assert.equal(second.result.pass, true)
})

test('an offered answer the comment outgrew is a repair, not a reuse or a repost', async () => {
  // The reply failed to settle, then the reviewer edited the comment: the old
  // body may be on the thread and no longer answers what is asked. Same when
  // the verdict flipped and a fix note is now owed where a refutation was
  // offered. Neither the frozen text nor a fresh one goes out.
  let cycle = 0
  const edited = await run({
    args: { autoPush: true, maxCycles: 2 },
    posting: () => cycle === 1 ? null : true,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [invalidFinding({ commentId: 2, line: 4, commentDigest: `d${cycle}` })], replies: [{ commentId: 2, body: 'not so' }], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(edited.result.pass, false)
  assert.equal(edited.calls.filter(c => c.label.startsWith('replies#')).length, 1, 'no repost under the edited comment')
  assert.deepEqual(edited.result.state.debt.find(([id]) => id === 2)[1].repair,
    { replyId: null, error: 'offered refutation is stale (comment edited)' })
  assert.match(rowsOf(summaries(edited.logs)[1])[0][3], /NEEDS REPAIR: offered refutation is stale/)
  cycle = 0
  const flipped = await run({
    args: { autoPush: true, maxCycles: 2 },
    posting: () => cycle === 1 ? null : true,
    reviewsPerCycle: () => {
      cycle++
      return cycle === 1
        ? { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'no bug exists' }], done: true }
        : { findings: [finding({ commentId: 2, line: 4, verdict: 'valid' })], replies: [], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(flipped.calls.some(c => c.label.startsWith('resolve#')), false, 'the refutation must not go out as a fix note')
  assert.equal(flipped.result.pass, false)
  assert.match(flipped.result.state.debt.find(([id]) => id === 2)[1].repair.error, /now owes a fixNote/)
})

test('a rejected receipt that names a reply still blocks a repost', async () => {
  let cycle = 0
  const { result, calls } = await run({
    args: { autoPush: true, maxCycles: 2 },
    receipts: (rs) => cycle === 1 ? rs.map(r => ({ ...r, digest: fnv1a('@/tmp/body.txt') })) : rs,
    reviewsPerCycle: () => {
      cycle++
      return { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true }
    },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(calls.filter(c => c.label.startsWith('replies#')).length, 1, 'a second reply went over the untrusted one')
  assert.deepEqual(result.state.debt.find(([id]) => id === 2)[1].repair, { replyId: 502, error: 'receipt for a different body' })
})

test('a ci launch watches CI and never runs the validator', async () => {
  // Chief saw only a check conclude: this launch spends no opus on a harvest.
  const { result, labels, logs } = await run({
    args: { lane: 'ci', yieldAfterCycle: true, maxCycles: 3 },
    ci: { status: 'red', infraRerun: [], realFailures: [{ check: 'build', firstError: 'boom', files: ['src/a.c'], rigSide: false }] },
  })
  assert.equal(labels.some(l => l.startsWith('reviews#') || l.startsWith('challenge#') || l.startsWith('replies#')), false)
  assert.ok(labels.some(l => l === 'ci#1'))
  assert.ok(labels.some(l => l.startsWith('fix:')), 'the CI fix still runs')
  assert.equal(result.status, 'paused')
  assert.equal(result.observation.lane, 'ci')
  assert.equal(result.observation.reviews, null, 'nobody looked at reviews')
  assert.equal(result.history[0].reviews, null)
  assert.match(summaries(logs)[0], /reviews not observed this launch/)
})

test('a ci launch cannot declare the PR done, even green', async () => {
  const { result, logs } = await run({
    args: { lane: 'ci', yieldAfterCycle: true, maxCycles: 3 },
    ci: { status: 'green', infraRerun: [], realFailures: [] },
  })
  assert.equal(result.status, 'paused')
  assert.equal(result.pass, false)
  assert.ok(logs.some(l => /ci lane only — reviews not observed, no verdict this launch/.test(l)), logs.join('\n'))
})

test('a reviews launch runs no CI watcher and still fixes and pushes', async () => {
  const { result, labels, logs } = await run({
    args: { lane: 'reviews', yieldAfterCycle: true, maxCycles: 3 },
    reviews: oneValid,
  })
  assert.equal(labels.some(l => l.startsWith('ci#')), false)
  assert.ok(labels.some(l => l.startsWith('push#')), 'the review push went out')
  assert.equal(result.status, 'paused')
  assert.equal(result.observation.lane, 'reviews')
  assert.equal(result.observation.ci, null)
  assert.match(summaries(logs)[0], /CI not observed this launch/)
  assert.equal(result.state.expectedHead, shaFor(1), 'the pushed head is the next expectation')
})

test('a reviews launch with settled bots still declares nothing', async () => {
  const { result, logs } = await run({
    args: { lane: 'reviews', yieldAfterCycle: true, maxCycles: 3 },
    reviews: { findings: [], replies: [], done: true },
  })
  assert.equal(result.status, 'paused')
  assert.ok(logs.some(l => /reviews lane only — CI not observed, no verdict this launch/.test(l)), logs.join('\n'))
})

test('the lane is not part of the state a launch must match', async () => {
  const first = await run({ args: { lane: 'ci', yieldAfterCycle: true, maxCycles: 3 } })
  assert.equal(first.result.state.config.lane, undefined)
  const second = await run({ args: { lane: 'reviews', yieldAfterCycle: true, maxCycles: 3, state: first.result.state }, reviews: { findings: [], replies: [], done: true } })
  assert.equal(second.result.state.cyclesUsed, 2, 'the budget is shared across lanes')
  const third = await run({ args: { yieldAfterCycle: true, maxCycles: 3, state: second.result.state }, reviews: { findings: [], replies: [], done: true } })
  assert.equal(third.result.status, 'complete', `only the both launch completes (got ${third.result.reason})`)
  assert.deepEqual(third.result.history.map(e => e.lane), ['ci', 'reviews', 'both'])
})

test('debt and the pushed head carry across a lane switch', async () => {
  // A reviews launch pushes a fix and leaves a refutation owed; the ci launch
  // after it must start at the pushed head and keep the debt; the both launch
  // then pays it and completes.
  const reviews1 = { findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true }
  const first = await run({
    args: { lane: 'reviews', yieldAfterCycle: true, maxCycles: 4 },
    reviews: reviews1, dropDoneIds: (label) => label.startsWith('replies#'),
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(first.result.state.expectedHead, shaFor(1))
  assert.deepEqual(first.result.deferred, [2])
  const second = await run({
    args: { lane: 'ci', yieldAfterCycle: true, maxCycles: 4, state: first.result.state },
    preflight: { head: shaFor(1), prHead: shaFor(1) },
  })
  assert.equal(second.result.status, 'paused')
  assert.deepEqual(second.result.deferred, [2], 'the ci launch keeps the reply owed')
  assert.equal(second.result.state.expectedHead, shaFor(1))
  const third = await run({
    args: { yieldAfterCycle: true, maxCycles: 4, state: second.result.state },
    preflight: { head: shaFor(1), prHead: shaFor(1) },
    reviews: { findings: [invalidFinding({ commentId: 2, line: 4 })], replies: [{ commentId: 2, body: 'not so' }], done: true },
    challenge: { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.equal(third.result.status, 'complete', `the both launch pays and completes (got ${third.result.reason})`)
  assert.equal(third.result.state.debt.length, 0)
})

test('a dry run still runs the fixers it is allowed to run', async () => {
  // Withholding the refutation must not also withhold the local fix work the
  // review lane already promises to leave uncommitted.
  const { calls, result } = await run({
    args: { autoPush: false, maxCycles: 2 },
    reviews: {
      findings: [invalidFinding({ commentId: 1 }), finding({ commentId: 2, verdict: 'valid' })],
      replies: [{ commentId: 1, body: 'no' }],
      done: true,
    },
  })
  assert.ok(calls.some(c => c.label.startsWith('fix:')), 'the dry run skipped the fixer')
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false, 'a dry run must post nothing')
  assert.equal(result.dryRun, true)
})

test('re-overturning a finding does not retire a different dismissal', async () => {
  // Comment 7 owes A and B. B is overturned and fixed, then reported and
  // overturned again in a later cycle. Retiring by count would spend that
  // second overturn on A, which nobody ever answered.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 5 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) {
        return { findings: [invalidFinding({ commentId: 7 }), invalidFinding({ commentId: 7, line: 9 })],
          replies: [], done: true }
      }
      if (cycle <= 3) return { findings: [invalidFinding({ commentId: 7, line: 9 })], replies: [], done: true }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: true, reason: 'stands' }, { id: 1, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
  })
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'a repeated overturn discharged an unrelated dismissal')
  assert.deepEqual(result.deferred, [7])
})

test('a dry run runs the CI fixer before reporting withheld replies', async () => {
  // The refutation is withheld either way; returning on it before the CI lane
  // would skip fix work the dry run is allowed to do and leave uncommitted.
  const { calls, result } = await run({
    args: { autoPush: false, maxCycles: 2 },
    reviews: { findings: [invalidFinding()], replies: [{ commentId: 1, body: 'no' }], done: true },
    ci: {
      status: 'red',
      infraRerun: [],
      realFailures: [{ check: 'build-arm', firstError: 'undefined reference', files: ['src/a.c'], rigSide: false }],
    },
  })
  assert.ok(calls.some(c => c.label.startsWith('fix:')), 'the dry run skipped the CI fixer')
  assert.equal(calls.some(c => c.label.startsWith('replies#')), false, 'a dry run must post nothing')
  assert.equal(result.dryRun, true)
})

test('a dismissal survives the fix that moves its line', async () => {
  // Comment 7 owes A and B. B is overturned and fixed; A comes back at a new
  // line after that fix, is overturned and fixed too. Keying the dismissal on
  // the location would leave A's original key outstanding forever.
  let cycle = 0
  const A = (over) => invalidFinding({ commentId: 7, findingId: '7#1', line: 10, ...over })
  const { result } = await run({
    args: { autoPush: true, maxCycles: 5 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) return { findings: [A(), invalidFinding({ commentId: 7, findingId: '7#2', line: 20 })], replies: [], done: true }
      if (cycle === 2) return { findings: [invalidFinding({ commentId: 7, findingId: '7#2', line: 20 })], replies: [], done: true }
      if (cycle === 3) return { findings: [A({ line: 11 })], replies: [], done: true }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: true, reason: 'stands' }, { id: 1, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
  })
  assert.equal(result.pass, true, `a shifted line stranded a retired dismissal (got ${result.reason})`)
})

test('an edited comment stops the run instead of retiring by a reused id', async () => {
  // Editing a review comment renumbers the positions its ids are built from, so
  // 7#1 can name a different point than the one that debt belongs to.
  let cycle = 0
  const { result, logs } = await run({
    args: { autoPush: true, maxCycles: 4 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) return { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'before' })], replies: [], done: true }
      if (cycle === 2) return { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'after' })], replies: [], done: true }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 1
      ? { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }
      : { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
  })
  assert.ok(logs.some(l => l.includes('comment 7 was edited')), 'the edit must be reported')
  assert.equal(result.reason, 'deferred-replies-unresolved',
    'a reused id retired a dismissal after the comment was edited')
})

test('an edited comment can still be answered by a later refutation', async () => {
  // Blocking retirement must not also block recovery: once the comment is
  // renumbered, the dismissal it owes stays owed, and the drafted reply for it
  // must still be postable.
  let cycle = 0
  const { calls, result } = await run({
    args: { autoPush: true, maxCycles: 5 },
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) return { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'before' })], replies: [], done: true }
      if (cycle === 2) return { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'after' })], replies: [], done: true }
      if (cycle === 3) {
        return { findings: [invalidFinding({ commentId: 7, findingId: '7#2', commentDigest: 'after' })],
          replies: [{ commentId: 7, body: 'still wrong' }], done: true }
      }
      return { findings: [], replies: [], done: true }
    },
    challengePerCycle: () => cycle === 2
      ? { verdicts: [{ id: 0, upheld: false, reason: 'real' }] }
      : { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] },
  })
  assert.ok(calls.some(c => c.label.startsWith('replies#')), 'the refutation was withheld forever')
  assert.equal(result.pass, true, `an edited comment could not recover (got ${result.reason})`)
})

test('a harvest that reuses a findingId is rejected', async () => {
  // Two dismissals under one id collapse into a single obligation, so answering
  // one would silently answer both.
  const { result } = await run({
    args: { autoPush: true, maxCycles: 1 },
    reviews: {
      findings: [invalidFinding({ commentId: 7, findingId: '7#1', line: 10 }),
        invalidFinding({ commentId: 7, findingId: '7#1', line: 20 })],
      replies: [], done: true,
    },
  })
  assert.equal(result.reason, 'duplicate-finding-ids')
})

test('every agent that acts on GitHub is told which checkout the PR lives in', async () => {
  // The CI watcher and both comment posters infer the repository from their
  // working directory; pointed at another checkout by checkoutDir, they were
  // acting on the launching repository's same-numbered PR.
  const { calls } = await run({
    reviews: {
      findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'no' }], done: true,
    },
    args: { checkoutDir: '/srv/other/repo' },
  })
  for (const label of ['ci#1', 'reviews#1', 'replies#1', 'resolve#1']) {
    const c = calls.find(c => c.label === label)
    assert.ok(c, `${label} ran in this scenario`)
    assert.match(c.prompt, /\/srv\/other\/repo/, `${label} must name the checkout`)
  }
})

test('a commit that leaves an owned change behind is not pushed', async () => {
  // Subset was the whole audit: committed ⊆ owned. A committer that took one of
  // two fixed files passed it, and the push announced both findings fixed.
  const { result, labels, logs } = await run({
    reviews: oneValid, audit: { leftover: [' M src/a.c'] },
  })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'push-failed')
  assert.equal(labels.some(l => l.startsWith('push#')), false, 'the publisher is not dispatched')
  assert.match(result.history[0].reviewPushFailed.detail, /commit left owned change\(s\) behind:  M src\/a\.c/)
  assert.ok(logs.some(l => /committed but NOT pushed — commit left owned change/.test(l)))
})

// --- yielding launches: one cycle per launch, the ledger carried in `state` ---

// A debt-bearing first launch: one dismissal the validator drafted no reply for,
// so the cycle re-arms instead of passing. Yielding turns that re-arm into a pause.
const owing = { findings: [invalidFinding({ commentId: 5 })], replies: [], done: true }
const upheld = { verdicts: [{ id: 0, upheld: true, reason: 'stands' }] }

test('a yielding launch runs one cycle, pauses with its state, and takes no backoff', async () => {
  const { result, labels, napPoints } = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true },
    reviews: { findings: [], replies: [], done: false },
  })
  assert.equal(result.status, 'paused')
  assert.equal(result.reason, 'yielded')
  assert.equal(labels.filter(l => l.startsWith('reviews#')).length, 1, 'exactly one validator dispatch')
  assert.equal(napPoints.length, 0, 'the caller decides how long to wait')
  assert.equal(result.state.cyclesUsed, 1)
  assert.equal(result.state.maxCycles, 3)
  assert.equal(result.state.expectedHead, HEAD)
  assert.equal(result.observation.reviews.done, false)
  assert.equal(result.observation.ci.status, 'green')
})

test('state carries the ledger to the next launch, which re-reports what is owed', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  assert.equal(first.result.status, 'paused')
  assert.deepEqual(first.result.deferred, [5])
  assert.deepEqual(first.result.state.debt, [[5, { dismissals: ['5#1'], note: false, renumbered: false, digest: 'd5' }]])
  const second = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: first.result.state },
    reviews: owing, challenge: upheld,
  })
  const prompt = second.calls.find(c => c.label === 'reviews#2').prompt
  assert.ok(prompt.includes('[5]'), 'the validator is told which comment still owes an answer')
  assert.equal(second.result.state.cyclesUsed, 2)
  assert.deepEqual(second.result.deferred, [5], 'an obligation survives the launch boundary')
})

test('a resumed launch still catches an edited comment through the carried digest', async () => {
  const first = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true },
    reviews: { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'before' })], replies: [], done: true },
    challenge: upheld,
  })
  const second = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: first.result.state },
    reviews: { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'after' })], replies: [], done: true },
    challenge: { verdicts: [{ id: 0, upheld: false, reason: 'real' }] },
  })
  assert.ok(second.logs.some(l => l.includes('comment 7 was edited')), 'the edit is seen across launches')
  // The same body must not read as an edit, or every resumed comment would.
  const same = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: first.result.state },
    reviews: { findings: [invalidFinding({ commentId: 7, findingId: '7#1', commentDigest: 'before' })], replies: [], done: true },
    challenge: upheld,
  })
  assert.ok(!same.logs.some(l => l.includes('was edited')), 'an unchanged comment is not an edit')
  assert.deepEqual(first.result.state.debt[0][1].digest, 'before', 'the digest travels in the state')
})

test('a resumed launch refuses a checkout that is another PR, even at the expected head', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  const second = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: first.result.state },
    preflight: { prRepo: 'someone/tinyusb', prUrl: 'https://github.com/someone/tinyusb/pull/3888', pushUrls: ['git@github.com:someone/tinyusb.git'] },
    reviews: owing,
  })
  assert.equal(second.result.reason, 'state-mismatch')
  assert.deepEqual(second.labels, ['preflight'])
})

test('the observation names the head the cycle reviewed, not the one it pushed', async () => {
  const { result } = await run({ reviews: oneValid, scope: ['src/a.c'], args: { autoPush: true, maxCycles: 1, yieldAfterCycle: true } })
  assert.equal(result.observation.reviewedHead, HEAD)
  assert.equal(result.state.expectedHead, shaFor(1), 'the continuation SHA is the pushed commit')
})

test('a state from a failed preflight resumes once the checkout is fixed', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, preflight: { dirty: ['x'] } })
  assert.equal(first.result.reason, 'dirty-start')
  const second = await run({
    args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: JSON.parse(JSON.stringify(first.result.state)) },
    reviews: { findings: [], replies: [], done: false },
  })
  assert.equal(second.result.status, 'paused')
  assert.equal(second.result.state.cyclesUsed, 1)
})

test('the cycle budget is cumulative across launches and refuses before any agent runs', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 1, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  assert.equal(first.result.status, 'blocked', 'the last cycle of the budget does not pause')
  assert.equal(first.result.reason, 'deferred-replies-unresolved')
  const second = await run({ args: { autoPush: true, maxCycles: 1, yieldAfterCycle: true, state: first.result.state }, reviews: owing })
  assert.equal(second.result.status, 'blocked')
  assert.equal(second.result.reason, 'budget-exhausted')
  assert.deepEqual(second.labels, [], 'not even the preflight')
})

test('a resumed launch refuses a head the previous launch did not leave', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  const moved = { ...first.result.state, expectedHead: FOREIGN }
  const second = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true, state: moved }, reviews: owing })
  assert.equal(second.result.reason, 'stale-head')
  assert.equal(second.result.expected, FOREIGN)
  assert.deepEqual(second.labels, ['preflight'])
})

test('state never carries autoPush, and a resumed dry run publishes nothing', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  assert.ok(!JSON.stringify(first.result.state).includes('autoPush'))
  const second = await run({
    args: { autoPush: false, maxCycles: 3, yieldAfterCycle: true, state: first.result.state },
    reviews: oneValid, scope: ['src/a.c'],
  })
  assert.equal(second.result.dryRun, true)
  assert.ok(!second.labels.some(l => /^(commit|push|replies|resolve)#/.test(l)), 'the earlier grant does not carry over')
})

test('a rig-side pause keeps the reply debt', async () => {
  const { result } = await run({
    args: { autoPush: true, maxCycles: 3 },
    reviews: owing, challenge: upheld,
    ci: { status: 'red', infraRerun: [], realFailures: [{ check: 'hil / pico', firstError: 'board did not enumerate', files: [], rigSide: true }] },
  })
  assert.equal(result.reason, 'ci-red-rig-side')
  assert.deepEqual(result.deferred, [5], 'the caller sees what is still owed when it decides to stop')
  assert.deepEqual(result.state.debt.map(([id]) => id), [5])
})

test('N cycles over N launches dispatch the validator N times, no more', async () => {
  const pending = { findings: [], replies: [], done: false }
  const one = await run({ args: { autoPush: true, maxCycles: 2 }, reviews: pending })
  const a = await run({ args: { autoPush: true, maxCycles: 2, yieldAfterCycle: true }, reviews: pending })
  const b = await run({ args: { autoPush: true, maxCycles: 2, yieldAfterCycle: true, state: a.result.state }, reviews: pending })
  const validators = (labels) => labels.filter(l => l.startsWith('reviews#')).length
  assert.equal(validators(one.labels), 2)
  assert.equal(validators(a.labels) + validators(b.labels), 2)
  assert.equal(b.result.reason, 'maxCycles reached')
  assert.equal(b.result.status, 'blocked')
})

test('a state from a run with other arguments, or of another shape, is refused', async () => {
  const first = await run({ args: { autoPush: true, maxCycles: 3, yieldAfterCycle: true }, reviews: owing, challenge: upheld })
  await assert.rejects(run({ args: { maxCycles: 3, reviewers: ['codex', 'copilot'], state: first.result.state } }),
    /different arguments/)
  await assert.rejects(run({ args: { maxCycles: 3, state: { version: 0 } } }), /not a pr-babysit state/)
})

test('every result carries a status, an observation and the state', async () => {
  for (const [opts, status] of [
    [{}, 'complete'],
    [{ preflight: { dirty: ['x'] } }, 'blocked'],
    [{ reviews: oneValid, scope: ['src/a.c'], args: { autoPush: false } }, 'blocked'],
  ]) {
    const { result } = await run(opts)
    assert.equal(result.status, status, JSON.stringify(opts))
    assert.ok('observation' in result && 'state' in result)
  }
})


// --- hook-regenerated paths: admitted from the hooks' own evidence, never by the committer ---

const gen = (base, extra = {}) => ({
  after: [...base.after, ' M docs/boards.rst'], modifiedBy: ['gen-doc'],
  snapshotAfter: [...base.snapshotAfter, `644 ${blobOf('docs/boards.rst')} docs/boards.rst`], ...extra,
})
const publishing = { reviews: oneValid, scope: ['src/a.c'], args: { autoPush: true, maxCycles: 1 } }

test('recorded hook output is committed, audited and pushed with the fix', async () => {
  const { result, logs, calls } = await run({ ...publishing, hooks: gen })
  assert.equal(result.history[0].reviewPush.pass, true, 'the widened commit is pushed')
  assert.equal(result.reason, 'maxCycles reached', 'and the cycle re-arms for the fresh CI run, as after any push')
  const commit = calls.find(c => c.label === 'commit#1-review')
  assert.deepEqual(pathLine(commit.prompt), ['src/a.c', 'docs/boards.rst'], 'the committer is handed the widened list')
  const audit = calls.find(c => c.label === 'audit#1-review')
  assert.ok(audit.prompt.includes("'docs/boards.rst'"), 'leftovers are read over the widened list too')
  assert.ok(logs.some(l => l.includes('hook output admitted into the commit: docs/boards.rst')))
  assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed \+ pushed, with hook output docs\/boards\.rst/)
  assert.deepEqual(result.history[0].reviewPush.generated, ['docs/boards.rst'])
})

test('a path changed by no hook is never admitted', async () => {
  const { result, labels } = await run({ ...publishing, hooks: b => gen(b, { modifiedBy: [] }) })
  assert.equal(result.reason, 'push-failed')
  assert.match(result.history[0].reviewPushFailed.detail, /changed outside the fix scope by no hook: docs\/boards\.rst/)
  assert.ok(!labels.some(l => l.startsWith('commit#')), 'nothing is committed')
})

test('a hook that changes an owned path stops publication', async () => {
  for (const after of [[`644 ${'f'.repeat(40)} src/a.c`], [`755 ${blobOf('src/a.c')} src/a.c`]]) {
    const { result, labels } = await run({ ...publishing, hooks: { modifiedBy: ['fmt'], snapshotAfter: after } })
    assert.match(result.history[0].reviewPushFailed.detail, /a hook changed an owned path after it was verified: src\/a\.c/)
    assert.ok(!labels.some(l => l.startsWith('commit#')), after[0])
  }
})

test('incomplete or inconsistent hook evidence admits nothing and commits nothing', async () => {
  for (const [hooks, expected] of [
    [{ snapshotBefore: [], snapshotAfter: [] }, /evidence is incomplete: no snapshot for src\/a\.c/],
    [b => gen(b, { snapshotAfter: b.snapshotAfter }), /evidence is incomplete: no snapshot for docs\/boards\.rst/],
    [{ ran: false, modifiedBy: ['gen-doc'] }, /evidence is inconsistent/],
  ]) {
    const { result, labels } = await run({ ...publishing, hooks })
    assert.match(result.history[0].reviewPushFailed.detail, expected)
    assert.ok(!labels.some(l => l.startsWith('commit#')), String(expected))
  }
})

test('a commit whose content differs from what the hooks left is never pushed', async () => {
  // The committer edited the regenerated file, or the fix, between the hooks and the commit.
  for (const path of ['docs/boards.rst', 'src/a.c']) {
    const { result, labels } = await run({
      ...publishing, hooks: gen,
      audit: { entries: [`100644 blob ${blobOf('src/a.c')}\tsrc/a.c`, `100644 blob ${blobOf('docs/boards.rst')}\tdocs/boards.rst`]
        .map(e => e.includes(`\t${path}`) ? e.replace(blobOf(path), 'e'.repeat(40)) : e) },
    })
    assert.match(result.history[0].reviewPushFailed.detail, new RegExp(`differs from what the hooks left: ${path.replace('.', '\\.')}`))
    assert.ok(!labels.some(l => l.startsWith('push#')), path)
  }
  const mode = await run({ ...publishing, audit: { entries: [`100755 blob ${blobOf('src/a.c')}\tsrc/a.c`] } })
  assert.match(mode.result.history[0].reviewPushFailed.detail, /differs from what the hooks left: src\/a\.c/)
})

test('a hook that creates a file, or fails, or finds the tree dirty outside the scope, commits nothing', async () => {
  for (const [hooks, expected] of [
    [b => ({ after: [...b.after, '?? build/log'], modifiedBy: ['gen'] }), /created or renamed file\(s\): build\/log/],
    [{ passed: false }, /hooks do not pass/],
    [b => ({ before: [...b.before, ' M other.c'], after: [...b.after, ' M other.c'] }), /outside the fix scope before the hooks ran: other\.c/],
    [null, /hook agent died/],
  ]) {
    const { result, labels } = await run({ ...publishing, hooks })
    assert.match(result.history[0].reviewPushFailed.detail, expected)
    assert.ok(!labels.some(l => l.startsWith('commit#')), String(expected))
  }
})

test('protected hook output is refused before the commit', async () => {
  const { result, labels } = await run({ ...publishing, args: { ...publishing.args, protected: '^docs/' }, hooks: gen })
  assert.match(result.history[0].reviewPushFailed.detail, /regenerated a protected path: docs\/boards\.rst/)
  assert.ok(!labels.some(l => l.startsWith('commit#')))
})

test('a hook-admitted path does not excuse an unowned one in the same commit', async () => {
  const { result, labels } = await run({ ...publishing, hooks: gen, audit: { paths: ['src/a.c', 'docs/boards.rst', 'src/z.c'] } })
  assert.match(result.history[0].reviewPushFailed.detail, /unowned path\(s\): src\/z\.c/)
  assert.ok(!labels.some(l => l.startsWith('push#')))
})

test('a commit that landed but was not pushed is a pending candidate in the state, not the next head', async () => {
  const blocked = await run({ ...publishing, audit: { paths: ['src/a.c', 'src/z.c'] } })
  assert.deepEqual(blocked.result.state.pending, { sha: shaFor(1), parent: HEAD, lane: 'review', stage: 'audit-blocked' })
  assert.equal(blocked.result.state.expectedHead, HEAD)
  const rejected = await run({ ...publishing, push: null })
  assert.equal(rejected.result.state.pending.stage, 'push-failed')
  const unknown = await run({ ...publishing, commit: null })
  assert.deepEqual(unknown.result.state.pending, { sha: null, parent: HEAD, lane: 'review', stage: 'push-unknown' })
  const pushed = await run(publishing)
  assert.equal(pushed.result.state.pending, null)
  assert.equal(pushed.result.state.expectedHead, shaFor(1))
})


test('an owned path the fix did not change, or deleted, is still complete evidence', async () => {
  // Scope {a.c, b.c}, the fix touched only a.c: b.c is snapshotted unchanged, and
  // ls-tree still lists it. A deleted owned path is `absent` before and after and
  // must be absent from the commit's tree too.
  const twoFiles = (b) => ({ ...publishing, reviews: { findings: [finding(), finding({ file: b, line: 2 })], replies: [], done: true } })
  const quiet = await run({
    ...twoFiles('src/b.c'),
    hooks: b => ({ before: [' M src/a.c'], after: [' M src/a.c'] }),
    audit: { paths: ['src/a.c', 'src/b.c'], entries: lsTreeOf(['src/a.c', 'src/b.c']) },
  })
  assert.equal((quiet.result.history[0].reviewPush || {}).pass, true, JSON.stringify(quiet.result.history[0].reviewPushFailed))
  const deleted = await run({
    ...twoFiles('src/gone.c'),
    hooks: b => ({ before: [' M src/a.c', ' D src/gone.c'], after: [' M src/a.c', ' D src/gone.c'],
      snapshotBefore: [b.snapshotBefore[0], 'absent - src/gone.c'], snapshotAfter: [b.snapshotAfter[0], 'absent - src/gone.c'] }),
    audit: { paths: ['src/a.c', 'src/gone.c'], entries: lsTreeOf(['src/a.c']) },
  })
  assert.equal(deleted.result.history[0].reviewPush.pass, true, JSON.stringify(deleted.result.history[0].reviewPushFailed))
  const resurrected = await run({
    ...twoFiles('src/gone.c'),
    hooks: b => ({ before: [' M src/a.c', ' D src/gone.c'], after: [' M src/a.c', ' D src/gone.c'],
      snapshotBefore: [b.snapshotBefore[0], 'absent - src/gone.c'], snapshotAfter: [b.snapshotAfter[0], 'absent - src/gone.c'] }),
    audit: { paths: ['src/a.c', 'src/gone.c'], entries: lsTreeOf(['src/a.c', 'src/gone.c']) },
  })
  assert.match(resurrected.result.history[0].reviewPushFailed.detail, /differs from what the hooks left: src\/gone\.c/)
})

test('modes are git modes: an executable fix commits as 100755 and a symlink never matches', async () => {
  const exe = await run({
    ...publishing,
    hooks: b => ({ snapshotBefore: [`755 ${blobOf('src/a.c')} src/a.c`], snapshotAfter: [`755 ${blobOf('src/a.c')} src/a.c`] }),
    audit: { entries: [`100755 blob ${blobOf('src/a.c')}\tsrc/a.c`] },
  })
  assert.equal(exe.result.history[0].reviewPush.pass, true)
  const link = await run({ ...publishing, audit: { entries: [`120000 blob ${blobOf('src/a.c')}\tsrc/a.c`] } })
  assert.match(link.result.history[0].reviewPushFailed.detail, /differs from what the hooks left: src\/a\.c/)
})

test('a path with a space or a quote survives status, snapshot, diff-tree and ls-tree unquoted', async () => {
  for (const p of ['src/space name.c', 'src/quote"name.c']) {
    const { result, calls } = await run({ ...publishing, reviews: { findings: [finding({ file: p })], replies: [], done: true } })
    assert.equal((result.history[0].reviewPush || {}).pass, true, JSON.stringify(result.history[0].reviewPushFailed))
    assert.deepEqual(pathLine(calls.find(c => c.label === 'commit#1-review').prompt), [p], 'the path itself was committed')
    assert.ok(calls.find(c => c.label === 'hooks#1-review').prompt.includes("--porcelain -z | tr '\\0' '\\n'"), 'status is read NUL-separated, never quoted')
    const audit = calls.find(c => c.label === 'audit#1-review').prompt
    assert.ok(audit.includes('ls-tree -z HEAD') && audit.includes("--name-only -r -z HEAD | tr '\\0' '\\n'"), 'and so are the commit paths')
  }
})

test('a file a hook created and staged is refused like an untracked one', async () => {
  const { result, labels } = await run({
    ...publishing,
    hooks: b => ({ after: [...b.after, 'A  new.c'], modifiedBy: ['gen'], snapshotAfter: [...b.snapshotAfter, `644 ${blobOf('new.c')} new.c`] }),
  })
  assert.match(result.history[0].reviewPushFailed.detail, /created or renamed file\(s\): new\.c/)
  assert.ok(!labels.some(l => l.startsWith('commit#')))
})

test('a commit whose audit died is a pending candidate with an unknown SHA', async () => {
  const { result, logs } = await run({ ...publishing, audit: null })
  assert.deepEqual(result.state.pending, { sha: null, parent: HEAD, lane: 'review', stage: 'audit-unknown' })
  assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed \+ committed \(SHA unknown\), NOT PUSHED: audit agent/)
})
