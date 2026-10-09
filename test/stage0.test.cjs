'use strict';
/**
 * stage0.test.cjs — Stage-0 runner acceptance tests.
 * Plain node, zero dependencies (repo convention: `node test/stage0.test.cjs`).
 * The module under test is ESM (agent1/stage0.mjs) — loaded via dynamic import().
 * Every case uses an isolated temp stores dir. Pre-genesis stores (empty journal,
 * {} memory — exactly what the repo ships) are seeded for the refusal case;
 * post-genesis stores are seeded via boot() itself, because Stage-0 must never
 * birth Agent1. No network: fake fetch + fake model + fixed clock.
 */
const { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const REPO_ROOT = resolve(__dirname, '..');
const CONFIG_DIR = join(REPO_ROOT, 'agent1', 'config');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

function freshStores() {
  return mkdtempSync(join(tmpdir(), 'agent1-stage0-'));
}

function seedPreGenesis(stores) {
  writeFileSync(join(stores, 'journal.jsonl'), '', 'utf8');
  writeFileSync(join(stores, 'memory.json'), '{}\n', 'utf8');
}

async function seedGenesisViaBoot(stores) {
  const { boot } = await import('../agent1/bootstrap.mjs');
  boot({ repoRoot: REPO_ROOT, storesDir: stores, configDir: CONFIG_DIR, now: '2026-10-09T11:00:00.000Z' });
}

function readJournal(stores) {
  const p = join(stores, 'journal.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
}

// fake market fetch: deterministic prices keyed by symbol
function fakeMarketFetch(prices) {
  return url => {
    const sym = String(url.match(/symbols=([a-z]+)/i)?.[1] ?? '').toLowerCase();
    if (!(sym in prices)) return Promise.reject(new Error(`no price for ${sym}`));
    return Promise.resolve({ [sym]: { usd: prices[sym] } });
  };
}

// fake model: scripted responses in order; index clamps to the last response
function fakeModel(responses) {
  let i = 0;
  return {
    complete: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return r;
    },
  };
}

const GOOD_OBS = JSON.stringify({
  seen: 'BTC printed 62000 USD on the evidence line above.',
  notKnown: 'I do not know why it moved, whether the feed is representative, or what happens next.',
  numbers: [{ label: 'BTC', value: 62000 }],
});
const GOOD_BEAR = JSON.stringify({ strongestBear: 'A single spot print from one aggregator says nothing about depth, venue divergence, or the next candle — the observation may be stale the moment it is written.' });

async function main() {
  const s0 = await import('../agent1/stage0.mjs');

  // ---- parseJsonObject ----
  console.log('parseJsonObject:');
  check('valid object', (s0.parseJsonObject('{"a":1}') ?? {}).a === 1);
  check('extracts from prose', (s0.parseJsonObject('noise {"a":2} noise') ?? {}).a === 2);
  check('rejects array', s0.parseJsonObject('[1,2]') === null);
  check('rejects non-json', s0.parseJsonObject('hello') === null);
  check('rejects broken json', s0.parseJsonObject('{"a":') === null);
  check('rejects empty', s0.parseJsonObject('') === null);

  // ---- numbersTraceToEvidence ----
  console.log('numbersTraceToEvidence:');
  const ev = [{ symbol: 'btc', price: 62000, source: 'coingecko' }, { symbol: 'eth', price: 3000, source: 'coingecko' }];
  check('traced number passes', s0.numbersTraceToEvidence([{ label: 'BTC', value: 62000 }], ev).ok === true);
  check('within tolerance passes (62200 vs 62000 = +0.32%)', s0.numbersTraceToEvidence([{ label: 'BTC', value: 62200 }], ev).ok === true);
  check('beyond tolerance fails (63000 vs 62000 = +1.6%)', s0.numbersTraceToEvidence([{ label: 'BTC', value: 63000 }], ev).ok === false);
  check('untraced lists reason', (() => { const r = s0.numbersTraceToEvidence([{ label: 'X', value: 1 }], ev); return r.ok === false && r.untraced[0].value === 1; })());
  check('non-finite fails', s0.numbersTraceToEvidence([{ label: 'X', value: 'abc' }], ev).ok === false);
  check('empty numbers pass', s0.numbersTraceToEvidence([], ev).ok === true);

  // ---- deriveState / buildReviewPack ----
  console.log('deriveState:');
  check('empty journal → n=0, not eligible', (() => { const s = s0.deriveState([]); return s.gradedCount === 0 && s.exitEligible === false && s.incidents === 0; })());
  check('one graded observation', (() => {
    const s = s0.deriveState([
      { type: 'session_start', session: 1 },
      { type: 'entry', kind: 'observation', seq: 1 },
      { type: 'grade', targetSeq: 1, grade: 'good-process' },
      { type: 'session_end', session: 1 },
    ]);
    return s.gradedCount === 1 && s.ungradedCount === 0 && s.gradeHistogram['good-process'] === 1 && s.exitEligible === false;
  })());
  check('ungraded observation counted', (() => {
    const s = s0.deriveState([{ type: 'entry', kind: 'observation', seq: 2 }]);
    return s.ungradedCount === 1 && s.exitEligible === false;
  })());
  check('incident blocks exit even at n>=30', (() => {
    const lines = [];
    for (let i = 1; i <= 30; i++) { lines.push({ type: 'entry', kind: 'observation', seq: i }); lines.push({ type: 'grade', targetSeq: i, grade: 'good-process' }); }
    lines.push({ type: 'fabrication_incident', targetSeq: 30 });
    const s = s0.deriveState(lines);
    return s.gradedCount === 30 && s.incidents === 1 && s.exitEligible === false;
  })());
  check('n>=30 clean → exitEligible', (() => {
    const lines = [];
    for (let i = 1; i <= 30; i++) { lines.push({ type: 'entry', kind: 'observation', seq: i }); lines.push({ type: 'grade', targetSeq: i, grade: 'good-process' }); }
    return s0.deriveState(lines).exitEligible === true;
  })());
  check('corrupt line tolerated as corrupt_line', (() => {
    const s = s0.deriveState([{ type: 'corrupt_line', raw: 'garbage' }]);
    return s.gradedCount === 0;
  })());
  check('review pack carries lastObservations + exitGate + histogram + sessions', (() => {
    const p = s0.buildReviewPack([
      { type: 'session_start', session: 1 },
      { type: 'entry', kind: 'observation', seq: 1, decision: 'x' },
      { type: 'grade', targetSeq: 1, grade: 'good-process' },
      { type: 'session_end', session: 1 },
    ]);
    return Array.isArray(p.lastObservations) && p.lastObservations.length === 1 && typeof p.exitGate === 'string' && p.sessions === 1 && p.gradeHistogram['good-process'] === 1;
  })());

  // ---- runStage0Session end-to-end ----
  console.log('runStage0Session:');

  // pre-genesis refusal — Stage-0 never births Agent1
  {
    const stores = freshStores(); seedPreGenesis(stores);
    let refused = null;
    try { await s0.runStage0Session({ model: fakeModel([GOOD_OBS, GOOD_BEAR]), marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }), repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores, now: () => '2026-10-09T12:00:00.000Z' }); }
    catch (e) { refused = e; }
    check('pre-genesis stores REFUSED (Stage-0 never births)', refused !== null && String(refused.message).includes('Day-0'), refused && refused.message);
    check('refusal left journal untouched (no genesis written)', readJournal(stores).length === 0);
    rmSync(stores, { recursive: true, force: true });
  }

  // happy path
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const r = await s0.runStage0Session({
      model: fakeModel([GOOD_OBS, GOOD_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('happy path completes good-process', r.aborted === false && r.grade === 'good-process', JSON.stringify(r.checks ?? {}));
    check('n incremented to 1', r.n === 1);
    check('exit not yet eligible', r.state.exitEligible === false);
    const lines = readJournal(stores);
    check('journal has session_start/entry/grade/session_end', ['session_start', 'entry', 'grade', 'session_end'].every(t => lines.some(l => l.type === t)));
    check('observation carries evidence + trace ok', (() => { const e = lines.find(l => l.type === 'entry' && l.kind === 'observation'); return e && Array.isArray(e.evidence) && e.evidence.length === 3 && e.numbersTrace.ok === true; })());
    check('bear_pass journaled targeting observation', (() => { const b = lines.find(l => l.type === 'entry' && l.kind === 'bear_pass'); return b && typeof b.targetSeq === 'number'; })());
    check('memory stamped UNVERIFIED_WORKING_NOTE', (() => { const m = JSON.parse(readFileSync(join(stores, 'memory.json'), 'utf8')); return m.stage0 && m.stage0.provenance === 'UNVERIFIED_WORKING_NOTE'; })());
    rmSync(stores, { recursive: true, force: true });
  }

  // fabrication incident
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const BAD_OBS = JSON.stringify({ seen: 'BTC at 99000.', notKnown: 'unknown why.', numbers: [{ label: 'BTC', value: 99000 }] });
    const r = await s0.runStage0Session({
      model: fakeModel([BAD_OBS, GOOD_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('fabrication → bad-process grade', r.grade === 'bad-process');
    check('fabrication → incident + abort', r.aborted === true && r.incident && r.incident.type === 'fabrication_incident', JSON.stringify(r.incident ?? {}));
    check('incident blocks exit', r.state.exitEligible === false);
    check('incident is its own journal entry', readJournal(stores).some(l => l.type === 'fabrication_incident'));
    rmSync(stores, { recursive: true, force: true });
  }

  // observe failure → abort, nothing journaled to grade
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const r = await s0.runStage0Session({
      model: fakeModel([GOOD_OBS, GOOD_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000 }), // sol missing → fetch throws
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('observe failure aborts session', r.aborted === true && String(r.reason).includes('no price for sol'));
    const lines = readJournal(stores);
    check('no observation journaled from nothing', !lines.some(l => l.type === 'entry' && l.kind === 'observation'));
    check('abort recorded as observe_failed + session_end', lines.some(l => l.type === 'observe_failed') && lines.some(l => l.type === 'session_end' && l.aborted === true));
    rmSync(stores, { recursive: true, force: true });
  }

  // unparseable observation → abort after retries
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const r = await s0.runStage0Session({
      model: fakeModel(['I am just going to talk about the market in prose.']),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('unparseable observation aborts', r.aborted === true && r.reason === 'observation_unparseable');
    check('nothing graded on unparseable', !readJournal(stores).some(l => l.type === 'grade'));
    rmSync(stores, { recursive: true, force: true });
  }

  // retry path: attempt 1 prose, attempt 2 good → session completes good-process
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const r = await s0.runStage0Session({
      model: fakeModel(['prose only, no json', GOOD_OBS, GOOD_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('retry path lands good-process', r.aborted === false && r.grade === 'good-process', JSON.stringify(r.checks ?? {}));
    rmSync(stores, { recursive: true, force: true });
  }

  // missing bear pass → bad-process, not aborted
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const r = await s0.runStage0Session({
      model: fakeModel([GOOD_OBS, 'prose only, no json']),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('missing bear → bad-process but session completes', r.aborted === false && r.grade === 'bad-process' && r.checks.bearPassPresent === false);
    rmSync(stores, { recursive: true, force: true });
  }

  // bear restating observation → bearDistinct fails
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const ECHO_BEAR = JSON.stringify({ strongestBear: 'BTC printed 62000 USD on the evidence line above.' });
    const r = await s0.runStage0Session({
      model: fakeModel([GOOD_OBS, ECHO_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('echo bear → bearDistinct false → bad-process', r.grade === 'bad-process' && r.checks.bearDistinct === false);
    rmSync(stores, { recursive: true, force: true });
  }

  // missing notKnown → uncertaintyStated fails
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const NO_NK = JSON.stringify({ seen: 'BTC printed 62000 USD.', notKnown: '', numbers: [{ label: 'BTC', value: 62000 }] });
    const r = await s0.runStage0Session({
      model: fakeModel([NO_NK, GOOD_BEAR]),
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    });
    check('empty notKnown → uncertaintyStated false → bad-process', r.grade === 'bad-process' && r.checks.uncertaintyStated === false);
    rmSync(stores, { recursive: true, force: true });
  }

  // continuity: second session derives state from journal truth
  {
    const stores = freshStores(); seedPreGenesis(stores); await seedGenesisViaBoot(stores);
    const opts = {
      marketFetch: fakeMarketFetch({ btc: 62000, eth: 3000, sol: 140 }),
      repoRoot: REPO_ROOT, configDir: CONFIG_DIR, storesDir: stores,
      now: () => '2026-10-09T12:00:00.000Z',
    };
    await s0.runStage0Session({ ...opts, model: fakeModel([GOOD_OBS, GOOD_BEAR]) });
    const r2 = await s0.runStage0Session({ ...opts, model: fakeModel([GOOD_OBS, GOOD_BEAR]) });
    check('second session counts journal truth (n=2, session=2)', r2.n === 2 && r2.session === 2);
    rmSync(stores, { recursive: true, force: true });
  }

  console.log(`\nstage0.test.cjs: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error('TEST RUNTIME REFUSED:', e.message); process.exit(1); });