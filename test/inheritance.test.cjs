'use strict';
/** temporal-core v0.2 — inheritance acceptance tests (provenance law). */
const {
  PROVENANCE_KINDS,
  ENVELOPE_SCHEMA_VERSION_V2,
  importanceScoreV2,
  exportEnvelopeV2,
  importEnvelopeV2,
  INHERITED_SCORE_PENALTY,
  INHERITED_UNVERIFIED_EXTRA_PENALTY,
} = require('../src/inheritance.cjs');
const { exportEnvelope, ENVELOPE_SCHEMA_VERSION } = require('../src/temporal-core.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ===== Provenance is required — absence is never "self" ===== */
console.log('P5 — provenance-carrying inheritance');
try {
  importanceScoreV2({ content: 'x', authorityClass: 'unverified', classification: 'note' });
  check('missing provenance refused', false, 'no throw');
} catch (e) {
  check('missing provenance refused', /must declare one of/.test(e.message), e.message);
}
try {
  importanceScoreV2({ content: 'x', authorityClass: 'unverified', classification: 'note', provenance: 'SELF' });
  check('unknown provenance kind refused', false, 'no throw');
} catch (e) {
  check('unknown provenance kind refused', /must declare one of/.test(e.message), e.message);
}

/* ===== Scoring: inherited knowledge scores lower until re-earned ===== */
const selfEntry = { id: 's1', content: 'lived scar', createdAt: 100, author: 'agent0', authorityClass: 'verified', classification: 'law', provenance: 'EXPERIENCED_BY_SELF' };
const inheritedEntry = { id: 'i1', content: 'handed law', createdAt: 100, author: 'agent0', authorityClass: 'verified', classification: 'law', provenance: 'INHERITED_FROM_PREDECESSOR', origin: { predecessorId: 'agent0', receivedAt: 200 } };
const selfUnverified = { ...selfEntry, id: 's2', authorityClass: 'unverified' };
const inheritedUnverified = { ...inheritedEntry, id: 'i2', authorityClass: 'unverified' };
const sSelf = importanceScoreV2(selfEntry);
const sInh = importanceScoreV2(inheritedEntry);
const sSelfU = importanceScoreV2(selfUnverified);
const sInhU = importanceScoreV2(inheritedUnverified);
check('self entry scores v0.1 base', sSelf === 60 + 80, String(sSelf));
check('inherited entry penalized', sInh === sSelf - INHERITED_SCORE_PENALTY, String(sInh));
check('inherited+unverified double penalty (same base, provenance only variable)', sInhU === sSelfU - INHERITED_SCORE_PENALTY - INHERITED_UNVERIFIED_EXTRA_PENALTY, `selfU=${sSelfU} inhU=${sInhU}`);
check('penalty never drives score negative', importanceScoreV2({ ...inheritedUnverified, classification: 'note', principalAnchored: false }) >= 0, 'floor holds');

/* ===== Export: inherited entries must name their source ===== */
try {
  exportEnvelopeV2([{ ...inheritedEntry, origin: undefined }]);
  check('inherited without origin refused', false, 'no throw');
} catch (e) {
  check('inherited without origin refused', /missing origin\.predecessorId/.test(e.message), e.message);
}
try {
  exportEnvelopeV2([{ ...inheritedEntry, origin: { predecessorId: 'agent0' } }]);
  check('inherited without receivedAt refused', false, 'no throw');
} catch (e) {
  check('inherited without receivedAt refused', /missing origin\.receivedAt/.test(e.message), e.message);
}

/* ===== Round-trip: provenance preserved, inside the digest chain ===== */
const env = exportEnvelopeV2(
  [selfEntry, inheritedEntry],
  { objective: 'raise agent1', openLoops: [], constraints: ['no live authority'] },
  { predecessorId: 'agent0', transferredAt: 300, note: 'first inheritance' },
);
check('schemaVersion 2', env.schemaVersion === ENVELOPE_SCHEMA_VERSION_V2, String(env.schemaVersion));
check('inheritance block carried', env.inheritance.predecessorId === 'agent0' && env.inheritance.transferredAt === 300, JSON.stringify(env.inheritance));
const imp = importEnvelopeV2(env);
check('import ok, chain verified', imp.ok === true && imp.chainVerified === true, JSON.stringify(imp).slice(0, 120));
check('self provenance preserved', imp.entries[0].provenance === 'EXPERIENCED_BY_SELF', imp.entries[0].provenance);
check('inherited provenance preserved', imp.entries[1].provenance === 'INHERITED_FROM_PREDECESSOR', imp.entries[1].provenance);
check('origin preserved', imp.entries[1].origin.predecessorId === 'agent0', JSON.stringify(imp.entries[1].origin));

/* ===== Tamper: provenance is inside the digest chain ===== */
const tampered = JSON.parse(JSON.stringify(env));
tampered.entries[0].provenance = 'INHERITED_FROM_PREDECESSOR';
const impT = importEnvelopeV2(tampered);
check('provenance tamper breaks chain', impT.ok === false && impT.code === 'DIGEST_CHAIN_BROKEN', JSON.stringify(impT).slice(0, 120));

/* ===== ARRIVED = INHERITED: v0.1 envelope imports as inherited ===== */
const v1Env = exportEnvelope([
  { id: 'v1a', content: 'old law', createdAt: 1, author: 'agent0', authorityClass: 'verified', classification: 'law' },
], { objective: 'v0.1 era' });
check('v1 envelope schema is 1', v1Env.schemaVersion === ENVELOPE_SCHEMA_VERSION, String(v1Env.schemaVersion));
const impV1 = importEnvelopeV2(v1Env, { receivedAt: 400 });
check('v1 import ok', impV1.ok === true, JSON.stringify(impV1).slice(0, 120));
check('v1 entries arrive INHERITED (arrived = inherited)', impV1.entries.every(e => e.provenance === 'INHERITED_FROM_PREDECESSOR'), JSON.stringify(impV1.entries.map(e => e.provenance)));
check('v1 origin filled from envelope.inheritance', impV1.entries[0].origin.predecessorId === 'unknown' && impV1.entries[0].origin.receivedAt === 400, JSON.stringify(impV1.entries[0].origin));
check('v1 authority class still preserved', impV1.entries[0].authorityClass === 'verified', impV1.entries[0].authorityClass);

/* ===== v1 entries with smuggled provenance claims stay inherited ===== */
const smuggled = JSON.parse(JSON.stringify(v1Env));
smuggled.entries[0].provenance = 'EXPERIENCED_BY_SELF';
const impS = importEnvelopeV2(smuggled);
check('v1 self-claim ignored — arrival is the proof', impS.ok === true && impS.entries[0].provenance === 'INHERITED_FROM_PREDECESSOR', JSON.stringify(impS.entries[0] && impS.entries[0].provenance));

/* ===== Bad schema refused ===== */
const bad = importEnvelopeV2({ schemaVersion: 99, entries: [] });
check('unknown schema refused', bad.ok === false && bad.code === 'BAD_SCHEMA_VERSION', JSON.stringify(bad));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);