'use strict';
/**
 * temporal-core v0.2 — provenance-carrying inheritance (P5).
 *
 * Additive layer over v0.1 (src/temporal-core.cjs, untouched): the desk's
 * TEMP-LANE P4 law, ported from the trading desk's governed-memory doctrine.
 *
 * Scar (desk, 2026-09): an inheritance plan where a successor could not tell
 * which knowledge it LIVED versus which it was HANDED. Secondhand law read as
 * firsthand scar is how an agent repeats a mistake its predecessor already
 * paid for — and mis-trusts the real scars at the same time.
 *
 * Laws:
 *  - Every entry carries provenance: EXPERIENCED_BY_SELF or
 *    INHERITED_FROM_PREDECESSOR. Absence is never "self" by default.
 *  - ARRIVED = INHERITED. Anything crossing an envelope boundary into a new
 *    agent is inherited, whatever the sender believed. Import never upgrades
 *    provenance — history is never rewritten as firsthand.
 *  - Inherited knowledge scores lower until re-earned by THIS agent.
 *  - Provenance is inside the digest chain: tampering with it breaks the
 *    envelope exactly like tampering with content.
 */

const crypto = require('crypto');
const { importanceScore, ENVELOPE_SCHEMA_VERSION } = require('./temporal-core.cjs');

const PROVENANCE_KINDS = ['EXPERIENCED_BY_SELF', 'INHERITED_FROM_PREDECESSOR'];
const ENVELOPE_SCHEMA_VERSION_V2 = 2;
const INHERITED_SCORE_PENALTY = 25;
const INHERITED_UNVERIFIED_EXTRA_PENALTY = 15;

/** Provenance is REQUIRED — absence is never "self" by default. */
function requireProvenance(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('provenance: entry required');
  const p = entry.provenance;
  if (!PROVENANCE_KINDS.includes(p)) {
    throw new Error(`provenance: entry must declare one of ${JSON.stringify(PROVENANCE_KINDS)} — got ${JSON.stringify(p ?? null)}`);
  }
  return p;
}

/** v0.1 score, then the provenance adjustment. Unknown provenance throws. */
function importanceScoreV2(entry) {
  const base = importanceScore(entry);
  requireProvenance(entry);
  let score = base;
  if (entry.provenance === 'INHERITED_FROM_PREDECESSOR') {
    score -= INHERITED_SCORE_PENALTY;
    if (entry.authorityClass === 'unverified') score -= INHERITED_UNVERIFIED_EXTRA_PENALTY;
  }
  return Math.max(0, score);
}

/** v0.1 digest shape (digestEntry is not exported; replicated byte-true). */
function v1Digest(entry, prevDigest) {
  const h = crypto.createHash('sha256');
  h.update(String(prevDigest));
  h.update('\u0000');
  h.update(JSON.stringify({
    content: entry.content, createdAt: entry.createdAt, author: entry.author,
    authorityClass: entry.authorityClass, classification: entry.classification,
  }));
  return h.digest('hex');
}

/** v2 digest: provenance (and an inherited entry's origin) are hashed too. */
function digestEntryV2(entry, prevDigest) {
  const h = crypto.createHash('sha256');
  h.update(String(prevDigest));
  h.update('\u0000');
  h.update(JSON.stringify({
    content: entry.content, createdAt: entry.createdAt, author: entry.author,
    authorityClass: entry.authorityClass, classification: entry.classification,
    provenance: entry.provenance,
    origin: entry.provenance === 'INHERITED_FROM_PREDECESSOR' ? (entry.origin ?? null) : undefined,
  }));
  return h.digest('hex');
}

/** Export v2: provenance REQUIRED on every entry — never export ambiguous history. */
function exportEnvelopeV2(entries, continuity = {}, inheritance = {}) {
  if (!Array.isArray(entries)) throw new Error('exportEnvelopeV2: entries must be an array');
  let prev = crypto.createHash('sha256').update('temporal-core/genesis').digest('hex');
  const chained = entries.map((e, i) => {
    requireProvenance(e);
    if (e.provenance === 'INHERITED_FROM_PREDECESSOR') {
      const o = e.origin ?? {};
      if (typeof o.predecessorId !== 'string' || !o.predecessorId.trim()) {
        throw new Error(`exportEnvelopeV2: inherited entry ${i} missing origin.predecessorId — inherited knowledge names its source`);
      }
      if (!o.receivedAt) {
        throw new Error(`exportEnvelopeV2: inherited entry ${i} missing origin.receivedAt — inherited knowledge names when it arrived`);
      }
    }
    const digest = digestEntryV2(e, prev);
    prev = digest;
    return { ...e, digest };
  });
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION_V2,
    entries: chained,
    continuity: {
      objective: continuity.objective ?? null,
      openLoops: continuity.openLoops ?? [],
      constraints: continuity.constraints ?? [],
    },
    inheritance: {
      predecessorId: inheritance.predecessorId ?? null,
      transferredAt: inheritance.transferredAt ?? null,
      note: inheritance.note ?? null,
    },
  };
}

/**
 * Import v2: verify the digest chain, PRESERVE authority classes AND
 * provenance exactly. Import is not a promotion step in either dimension.
 * A v0.1 envelope (schemaVersion 1) carries no provenance proof: every entry
 * arrives INHERITED_FROM_PREDECESSOR — arrived is inherited, whatever the
 * bytes claim about themselves.
 */
function importEnvelopeV2(envelope, opts = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, code: 'BAD_ENVELOPE', detail: 'envelope required' };
  }
  const isV1 = envelope.schemaVersion === ENVELOPE_SCHEMA_VERSION;
  const isV2 = envelope.schemaVersion === ENVELOPE_SCHEMA_VERSION_V2;
  if (!isV1 && !isV2) {
    return { ok: false, code: 'BAD_SCHEMA_VERSION', detail: `expected ${ENVELOPE_SCHEMA_VERSION} or ${ENVELOPE_SCHEMA_VERSION_V2}` };
  }
  if (!Array.isArray(envelope.entries)) return { ok: false, code: 'BAD_ENTRIES', detail: 'entries must be an array' };
  let prev = crypto.createHash('sha256').update('temporal-core/genesis').digest('hex');
  const out = [];
  for (let i = 0; i < envelope.entries.length; i++) {
    const e = envelope.entries[i];
    const expect = isV2 ? digestEntryV2(e, prev) : v1Digest(e, prev);
    if (e.digest !== expect) {
      return { ok: false, code: 'DIGEST_CHAIN_BROKEN', detail: `entry ${i} digest mismatch (expected ${expect.slice(0, 12)}…, got ${String(e.digest).slice(0, 12)}…)` };
    }
    prev = e.digest;
    const provenance = isV2 ? e.provenance : 'INHERITED_FROM_PREDECESSOR';
    out.push({
      content: e.content, createdAt: e.createdAt, author: e.author,
      authorityClass: e.authorityClass, classification: e.classification,
      provenance,
      origin: provenance === 'INHERITED_FROM_PREDECESSOR'
        ? (e.origin ?? {
            predecessorId: (envelope.inheritance && envelope.inheritance.predecessorId) || 'unknown',
            receivedAt: opts.receivedAt ?? null,
          })
        : undefined,
      provenancePreserved: true, // explicit: import is not an upgrade step
      authorityClassPreserved: true,
    });
  }
  return { ok: true, entries: out, continuity: envelope.continuity ?? null, inheritance: envelope.inheritance ?? null, chainVerified: true };
}

module.exports = {
  PROVENANCE_KINDS,
  ENVELOPE_SCHEMA_VERSION_V2,
  importanceScoreV2,
  exportEnvelopeV2,
  importEnvelopeV2,
  INHERITED_SCORE_PENALTY,
  INHERITED_UNVERIFIED_EXTRA_PENALTY,
};