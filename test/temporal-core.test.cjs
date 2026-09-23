'use strict';
/** temporal-core v0.1 — acceptance tests, one block per spec primitive. */
const {
  makeClock, timeline, importanceScore, consolidate, restoreBatch,
  exportEnvelope, importEnvelope, ENVELOPE_SCHEMA_VERSION,
} = require('../src/temporal-core.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ===== P1: Clock trust chain ===== */
(async () => {
  console.log('P1 — clock trust chain');

  // Acceptance: a deliberately skewed clock is detected within one tick.
  const skew = 5 * 60 * 1000; // anchor 5 min ahead of chain truth
  let probeCalls = 0;
  const clock = makeClock({
    anchorMs: 1790148000000 + skew,
    timezone: 'America/New_York',
    onchainTime: async () => { probeCalls++; return { t: 1790148000000, block: 12345678, chain: 'base' }; },
  });
  const n1 = await clock.now();
  check('skew detected in one tick', n1.source === 'unproven' && n1.confidence === 'low' && probeCalls === 1, JSON.stringify(n1));
  check('flag carries delta + block', n1.flag && n1.flag.code === 'CLOCK_DIVERGENCE' && n1.flag.block === 12345678, JSON.stringify(n1.flag));

  // Honest clock: within threshold -> proven.
  const clock2 = makeClock({
    anchorMs: 1790148000000 + 30 * 1000,
    timezone: 'America/New_York',
    onchainTime: async () => ({ t: 1790148000000, block: 12345679, chain: 'base' }),
  });
  const n2 = await clock2.now();
  check('honest clock proven', n2.source === 'onchain-block' && n2.confidence === 'high' && !n2.flag, JSON.stringify(n2));

  // Probe failure -> unproven, never silently asserted.
  const clock3 = makeClock({
    anchorMs: 1790148000000, timezone: 'America/New_York',
    onchainTime: async () => { throw new Error('rpc down'); },
  });
  const n3 = await clock3.now();
  check('probe failure -> unproven', n3.source === 'unproven' && n3.flag && n3.flag.code === 'CLOCK_PROBE_FAILED', JSON.stringify(n3));

  // No probe wired -> injected/medium (honest about what it is).
  const clock4 = makeClock({ anchorMs: 1790148000000, timezone: 'America/New_York' });
  const n4 = await clock4.now();
  check('no probe -> injected/medium', n4.source === 'injected' && n4.confidence === 'medium', JSON.stringify(n4));

  // Relative-day words resolve ONLY from the anchor.
  const anchor = 1790148000000; // some day T
  check('dayWord today', clock4.dayWord(anchor) === 'today');
  check('dayWord yesterday', clock4.dayWord(anchor - 86400000) === 'yesterday');
  check('dayWord tomorrow', clock4.dayWord(anchor + 86400000) === 'tomorrow');
  check('dayWord beyond -> null (never guess)', clock4.dayWord(anchor - 3 * 86400000) === null);

  // Every ledger write carries provenance.
  const prov = clock4.provenance();
  check('provenance stamp present', prov && prov.timezone === 'America/New_York' && typeof prov.anchorMs === 'number');

  // makeClock refuses missing timezone (never assume a zone).
  let threw = false;
  try { makeClock({ anchorMs: 123 }); } catch { threw = true; }
  check('missing timezone refused', threw);

  /* ===== P3: Bounded timeline ===== */
  console.log('P3 — bounded timeline');
  const events = Array.from({ length: 137 }, (_, i) => ({ seq: i }));

  // Acceptance: any reconstruction reports "N of M events, cursor for the rest".
  const p1 = timeline(events, { limit: 50 });
  check('page 1: 50 of 137, 87 omitted', p1.events.length === 50 && p1.totalCount === 137 && p1.omittedCount === 87 && p1.nextCursor === 50 && p1.complete === false, JSON.stringify({ n: p1.events.length, omitted: p1.omittedCount }));
  const p2 = timeline(events, { limit: 50, cursor: p1.nextCursor });
  check('page 2: next 50, cursor advances', p2.events.length === 50 && p2.nextCursor === 100 && p2.omittedCount === 37);
  const p3 = timeline(events, { limit: 50, cursor: p2.nextCursor });
  check('page 3: tail 37, complete, nextCursor null', p3.events.length === 37 && p3.omittedCount === 0 && p3.nextCursor === null && p3.complete === true);

  // Zero silent truncation: default limit is explicit in the result.
  const dflt = timeline(events);
  check('default limit=50 is explicit', dflt.events.length === 50 && dflt.omittedCount === 87);
  const zero = timeline(events, { limit: 0 });
  check('limit 0 = count-only page', zero.events.length === 0 && zero.totalCount === 137 && zero.omittedCount === 137 && zero.nextCursor === 0);

  /* ===== P2: Importance-weighted consolidation ===== */
  console.log('P2 — weighted consolidation');
  const law = { id: 'law-1', content: 'never assert unproven time', classification: 'law', authorityClass: 'declared', principalAnchored: true, reinforcements: 3 };
  const weather = { id: 'wx-1', content: 'sunny today', classification: 'note', authorityClass: 'unverified' };
  const fact = { id: 'fact-1', content: 'ETH is a major', classification: 'fact', authorityClass: 'verified' };

  check('law outranks weather', importanceScore(law) > importanceScore(weather), `${importanceScore(law)} vs ${importanceScore(weather)}`);
  check('scores are auditable numbers', typeof importanceScore(fact) === 'number');

  // Acceptance: a pinned law survives a flood of ephemeral notes.
  const flood = Array.from({ length: 200 }, (_, i) => ({ id: `noise-${i}`, content: `noise ${i}`, classification: 'note', authorityClass: 'unverified' }));
  const { kept, evicted } = consolidate([law, ...flood], 50);
  check('pinned law survives 200-note flood', kept.some(e => e.id === 'law-1'), `kept=${kept.length}`);
  check('eviction sized to capacity', kept.length === 50 && evicted.length === 151);

  // Acceptance: every eviction names its victim and reason.
  const firstEvict = evicted[0];
  check('eviction manifest names victim+reason+recovery', !!(firstEvict.id && firstEvict.reason && firstEvict.recoverableAt), JSON.stringify(firstEvict));

  // Livelock refusal: one-by-one restore into a full store is refused.
  const store = { capacity: 3, entries: [{ id: 'a', content: 'x', classification: 'note', authorityClass: 'unverified' }] };
  const rb1 = restoreBatch(store, [{ id: 'b', content: 'x', classification: 'note', authorityClass: 'unverified' }, { id: 'c', content: 'x', classification: 'note', authorityClass: 'unverified' }]);
  check('batch restore fits -> restored', rb1.restored === 2 && rb1.refused === null && store.entries.length === 3);
  const rb2 = restoreBatch(store, [{ id: 'd', content: 'x', classification: 'note', authorityClass: 'unverified' }]);
  check('livelock shape refused in code', rb2.restored === 0 && rb2.refused && rb2.refused.code === 'RESTORE_LIVELOCK', JSON.stringify(rb2));
  const rb3 = restoreBatch(store, [{ id: 'e', content: 'x', classification: 'note', authorityClass: 'unverified' }, { id: 'f', content: 'x', classification: 'note', authorityClass: 'unverified' }]);
  check('batch exceeding capacity refused with remedy', rb3.restored === 0 && rb3.refused && rb3.refused.code === 'BATCH_EXCEEDS_CAPACITY', JSON.stringify(rb3));

  /* ===== P4: Portable inheritance envelope ===== */
  console.log('P4 — inheritance envelope');
  const entries = [
    { content: 'only two ERC-8004 mints: token 0 + token 1', createdAt: 1790060000000, author: 'principal', authorityClass: 'declared', classification: 'law' },
    { content: 'forge push lease = branch remote tip', createdAt: 1790070000000, author: 'agent0', authorityClass: 'verified', classification: 'fact' },
    { content: 'maybe weather affects gas', createdAt: 1790080000000, author: 'agent0', authorityClass: 'unverified', classification: 'note' },
  ];
  const env = exportEnvelope(entries, { objective: 'raise Agent1', openLoops: ['temporal-core build'], constraints: ['no secrets in sandbox'] });
  check('envelope versioned', env.schemaVersion === ENVELOPE_SCHEMA_VERSION);
  check('digest chain present', env.entries.every(e => /^[0-9a-f]{64}$/.test(e.digest)));
  check('continuity rides along', env.continuity.objective === 'raise Agent1' && env.continuity.openLoops.length === 1);

  // Acceptance: round-trip preserves author, authority class, timestamp per entry.
  const imp = importEnvelope(env);
  check('import ok + chain verified', imp.ok === true && imp.chainVerified === true);
  check('round-trip preserves fields', imp.entries.every((e, i) =>
    e.content === entries[i].content && e.authorityClass === entries[i].authorityClass &&
    e.createdAt === entries[i].createdAt && e.author === entries[i].author));
  check('unverified arrives marked, never promoted', imp.entries[2].authorityClass === 'unverified' && imp.entries[2].authorityClassPreserved === true);

  // Tamper-evident: flip one byte -> whole load fails.
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.entries[1].content = tampered.entries[1].content + ' tampered';
  const imp2 = importEnvelope(tampered);
  check('tampered chain fails whole load', imp2.ok === false && imp2.code === 'DIGEST_CHAIN_BROKEN', JSON.stringify(imp2));

  // Bad schema version refused.
  const imp3 = importEnvelope({ ...env, schemaVersion: 99 });
  check('bad schemaVersion refused', imp3.ok === false && imp3.code === 'BAD_SCHEMA_VERSION');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error('SUITE ERROR', err); process.exit(1); });