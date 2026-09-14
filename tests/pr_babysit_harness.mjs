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
const ABSENT = ['URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer', 'process', 'fetch']

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
      if (opts.posting === null) return null // a dead posting agent
      if (opts.dropDoneIds && opts.dropDoneIds(label)) return { pass: false, detail: 'posting failed', doneIds: [] }
      return {
        pass: true, detail: 'posted',
        doneIds: [...[...String(prompt).matchAll(/"commentId":(\d+)/g)].map(m => Number(m[1])),
          ...(opts.strayDoneIds || [])],
      }
    }
    if (label.startsWith('commit#')) {
      if (opts.commit === null) return null // a dead commit agent
      // What the committer staged, remembered so the read-back agent can report
      // it. A distinct SHA per commit, as a real one is: the audit rejects a
      // commit whose SHA equals its parent, so reusing one would fail in cycle 2.
      staged = [...String(prompt).matchAll(/'([^']*)'/g)].map(m => m[1])
      made = shaFor(++commits)
      return { committed: true, detail: 'committed', ...opts.commit }
    }
    if (label.startsWith('audit#')) {
      if (opts.audit === null) return null // a dead read-back agent
      return { sha: made, parents: [head], paths: staged, ...opts.audit }
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
})

test('an unknown reviewer or a malformed protected pattern throws before any agent runs', async () => {
  for (const [args, expected] of [
    [{ reviewers: ['codex', 'gpt'] }, /unknown reviewer\(s\) \["gpt"\]/],
    [{ reviewers: 'codex' }, /reviewers must be an array of codex, copilot, coderabbit, claude/],
    [{ reviewers: [4] }, /unknown reviewer/],
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
  assert.match(rows[1][3], /already fixed, replied \+ resolved/)
  assert.match(rows[2][3], /refuted, replied \+ resolved/)
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
  const { result, logs, labels } = await run({ reviews: oneValid, fix: { buildOk: false } })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'fix-verification-failed')
  assert.equal(labels.some(l => l.startsWith('push#')), false, 'the publisher is not dispatched')
  assert.match(rowsOf(summaries(logs)[0])[0][3], /unverified: targeted build failed/,
    'reported as unverified, and the verifier is not paid for a broken build')
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
  assert.match(ls.prompt, /git ls-files -- 'src\/keep me\.c'\n/, 'an interior space is still a legal path')
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
  assert.match(ls.prompt, /git ls-files -- 'src\/my file \(v2\)\.c' 'src\/plus\+@~\[1\]\.c' 'src\/invented\.c'\n/)
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
  assert.match(row[3], /fixed \+ committed, PUSH FAILED: push rejected/,
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
  assert.doesNotMatch(row[3], /PUSH FAILED|\+ committed/, 'and must not claim a commit to recover')
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
  assert.deepEqual(audit.schema.required, ['sha', 'parents', 'paths'])
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
  assert.match(rowsOf(summaries(logs)[0])[0][3], /fixed \+ committed, PUSH FAILED: commit failed audit/)
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

test('a worker rejection outside the guarded lanes still reports the cycle', async () => {
  // The publisher's three turns are each guarded now, so the fix-note poster is
  // the unguarded worker that proves the scoreboard survives a rejection.
  const { result, logs } = await run({ reviews: oneValid, throwOn: 'resolve#' })
  assert.equal(result.pass, false)
  assert.equal(result.reason, 'cycle-threw')
  assert.equal(result.history.length, 1, 'the verdict keeps the history it was built from')
  assert.match(result.history[0].error, /cycle threw: resolve#1 exploded/)
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
    ['commit#', 'commit agent died', false],
    ['push#', 'push agent died after the commit landed', true],
  ]) {
    const { result, logs } = await run({ reviews: oneValid, throwOn })
    assert.equal(result.reason, 'push-failed', throwOn)
    assert.equal(result.history[0].reviewPushFailed.detail, detail)
    assert.equal(result.history[0].reviewPushFailed.committed, committed)
    assert.match(rowsOf(summaries(logs)[0])[0][3],
      committed ? /fixed \+ committed, PUSH FAILED/ : /fixed, COMMIT FAILED/, throwOn)
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
  const { result } = await run({
    reviews: {
      findings: [finding({ commentId: 1 }), invalidFinding({ commentId: 2, line: 4 })],
      replies: [{ commentId: 2, body: 'no' }], done: true,
    },
  })
  const entry = result.history[0]
  assert.deepEqual(entry.refutedPosts, { pass: true, detail: 'posted', doneIds: [2] })
  assert.deepEqual(entry.fixNotePosts, { pass: true, detail: 'posted', doneIds: [1] })
  const dead = await run({ reviews: oneValid, posting: null })
  assert.deepEqual(dead.result.history[0].fixNotePosts, { pass: false, detail: 'agent died', doneIds: [] })
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
  assert.match(resolve[0].prompt, /the first leak; the second leak/)
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
  // The reply/resolve agents return doneIds. Trusting an id that was never in
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
  // owed. Letting its doneIds clear the deferral answers the thread with the
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

test('a stale reply settles the fix note its own failed attempt owed', async () => {
  // The fix note fails to post, then the finding comes back stale and its
  // "already fixed" reply posts and resolves the thread. That answers the
  // comment; holding the earlier note type against it defers it forever.
  let cycle = 0
  const { result } = await run({
    args: { autoPush: true, maxCycles: 4 },
    dropDoneIds: (label) => cycle === 1 && label.startsWith('resolve#'),
    reviewsPerCycle: () => {
      cycle++
      if (cycle === 1) return structuredClone(oneValid)
      if (cycle === 2) return { findings: [finding({ verdict: 'stale' })], replies: [{ commentId: 1, body: 'already fixed' }], done: true }
      return { findings: [], replies: [], done: true }
    },
  })
  assert.equal(result.pass, true, `the stale reply must settle the comment (got ${result.reason})`)
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
