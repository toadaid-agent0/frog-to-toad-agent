'use strict';
/**
 * temporal-core v0.1 — reference implementation of the four primitives
 * from specs/temporal-awareness-core-v0.1.md (desk scar-derived).
 *
 * Community-clean infrastructure only: no trading logic, no wallet/signing
 * plumbing, no autonomous-authority change. Every primitive is pure JS with
 * an injected clock/RPC — deterministic and testable offline.
 */

const crypto = require('crypto');

/* ------------------------------------------------------------------ *
 * Primitive 1 — Clock trust chain: now() -> { t, source, confidence }
 * ------------------------------------------------------------------ *
 * Scar: unverified clock anchor; timezone-assumed reads; a schedule-trim
 * misdecision made from misread time context.
 * Law: time is OBSERVATION. An onchain cross-check grants no authority.
 */

const TIME_SOURCES = ['injected', 'ntp', 'onchain-block'];
const DEFAULT_DIVERGENCE_MS = 90 * 1000; // 90s: generous for block-time drift

/**
 * Build a proven clock from an injected anchor + optional onchain cross-check.
 * @param {object} opts
 * @param {number}   opts.anchorMs      injected wall-clock (epoch ms) — the desk's own anchor
 * @param {string}   opts.timezone      IANA zone for all rendering (e.g. America/New_York)
 * @param {() => Promise<{t:number, block:number, chain:string}|null>} [opts.onchainTime]
 *        read-only RPC probe: block timestamp + height. Absent => source stays 'injected'.
 * @param {number}   [opts.divergenceMs] max tolerated anchor-vs-onchain drift
 */
function makeClock(opts) {
  if (!opts || typeof opts.anchorMs !== 'number' || !Number.isFinite(opts.anchorMs)) {
    throw new Error('makeClock: anchorMs (finite epoch ms) is required');
  }
  if (!opts.timezone) throw new Error('makeClock: timezone is required — never assume a zone');
  const divergenceMs = opts.divergenceMs ?? DEFAULT_DIVERGENCE_MS;
  let onchainProbe = opts.onchainTime || null;

  const state = {
    anchorMs: opts.anchorMs,
    timezone: opts.timezone,
    lastCheck: null,   // { onchainMs, block, chain, deltaMs, checkedAt }
    degraded: false,   // true once a divergence beyond threshold was seen
    lastFlag: null,
  };

  async function now() {
    // Fresh cross-check each call when a probe is wired (cheap: one eth_call).
    if (onchainProbe) {
      try {
        const probe = await onchainProbe();
        if (probe && Number.isFinite(probe.t)) {
          const deltaMs = state.anchorMs - probe.t;
          state.lastCheck = {
            onchainMs: probe.t, block: probe.block, chain: probe.chain || 'unknown',
            deltaMs, checkedAt: state.anchorMs,
          };
          if (Math.abs(deltaMs) > divergenceMs) {
            state.degraded = true;
            state.lastFlag = {
              code: 'CLOCK_DIVERGENCE', deltaMs, thresholdMs: divergenceMs,
              chain: probe.chain || 'unknown', block: probe.block,
              verdict: 'unproven — anchor diverges from onchain block time',
            };
          } else {
            state.degraded = false;
          }
        } else {
          // Probe returned nothing usable: never silently assert proven time.
          state.degraded = true;
          state.lastFlag = { code: 'CLOCK_PROBE_EMPTY', verdict: 'unproven — onchain probe returned no data' };
        }
      } catch (err) {
        state.degraded = true;
        state.lastFlag = { code: 'CLOCK_PROBE_FAILED', verdict: 'unproven — onchain probe error', error: String(err && err.message || err) };
      }
    }
    const source = state.degraded ? 'unproven' : (onchainProbe ? 'onchain-block' : 'injected');
    const confidence = state.degraded ? 'low' : (onchainProbe ? 'high' : 'medium');
    return { t: state.anchorMs, source, confidence, timezone: state.timezone, flag: state.lastFlag };
  }

  return {
    now,
    /** Relative-day words resolve ONLY from the proven anchor — never model memory. */
    dayWord(ms) {
      const anchorDay = Math.floor(state.anchorMs / 86400000);
      const targetDay = Math.floor(ms / 86400000);
      if (targetDay === anchorDay) return 'today';
      if (targetDay === anchorDay - 1) return 'yesterday';
      if (targetDay === anchorDay + 1) return 'tomorrow';
      return null; // caller renders an absolute date; never guess
    },
    /** Every ledger write stamps its time-source provenance. */
    provenance() {
      return { anchorMs: state.anchorMs, timezone: state.timezone, lastCheck: state.lastCheck, degraded: state.degraded, lastFlag: state.lastFlag };
    },
    /** Test hook: swap the probe (or null it) without rebuilding. */
    _setProbe(p) { onchainProbe = p; },
    _setAnchor(ms) { state.anchorMs = ms; },
  };
}

/* ------------------------------------------------------------------ *
 * Primitive 3 — Bounded timeline reconstruction
 * ------------------------------------------------------------------ *
 * Scar: 50-cap silent truncation on journal reads; a reconstruction was
 * believed complete when it held only a prefix.
 * Law: truncation is always explicit; pagination is the default path.
 */

/**
 * @param {Array<object>} events  full event array (ascending sequence)
 * @param {object} [opts]
 * @param {number} [opts.limit=50]  page size (0 => count-only page)
 * @param {number} [opts.cursor]    offset into the event array
 * @returns {{events:Array, totalCount:number, omittedCount:number, nextCursor:(number|null), complete:boolean}}
 */
function timeline(events, opts = {}) {
  if (!Array.isArray(events)) throw new Error('timeline: events must be an array');
  const totalCount = events.length;
  const limit = opts.limit === undefined ? 50 : opts.limit;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('timeline: limit must be a non-negative integer');
  const cursor = opts.cursor === undefined ? 0 : opts.cursor;
  if (!Number.isInteger(cursor) || cursor < 0) throw new Error('timeline: cursor must be a non-negative integer');

  const slice = limit === 0 ? [] : events.slice(cursor, cursor + limit);
  const omittedCount = totalCount - cursor - slice.length;
  const nextCursor = omittedCount > 0 ? cursor + slice.length : null;
  return { events: slice, totalCount, omittedCount, nextCursor, complete: omittedCount === 0 };
}

/* ------------------------------------------------------------------ *
 * Primitive 2 — Importance-weighted consolidation
 * ------------------------------------------------------------------ *
 * Scar: hard-won laws evicted next to weather notes; a restore-never-ends
 * livelock; manual archive as the only rescue.
 * Law: eviction names its victim; batch restore is the only path.
 */

const AUTHORITY_BASE = { declared: 100, verified: 60, unverified: 10 };
const CLASS_BASE = { law: 80, fact: 40, note: 10 };

/** Score = authority baseline + class baseline + 5 per reinforcement + principal anchor. */
function importanceScore(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('importanceScore: entry required');
  const a = AUTHORITY_BASE[entry.authorityClass];
  if (a === undefined) throw new Error(`importanceScore: bad authorityClass ${JSON.stringify(entry.authorityClass)}`);
  const c = CLASS_BASE[entry.classification];
  if (c === undefined) throw new Error(`importanceScore: bad classification ${JSON.stringify(entry.classification)}`);
  const reinforcements = Math.max(0, entry.reinforcements | 0);
  const principal = entry.principalAnchored ? 50 : 0;
  return a + c + 5 * reinforcements + principal;
}

/**
 * Evict lowest-score entries until `entries.length <= capacity`.
 * @returns {{kept:Array, evicted:Array<{id,content,classification,authorityClass,score,reason,recoverableAt}>}}
 * Every eviction names its victim, reason, and recovery location.
 */
function consolidate(entries, capacity) {
  if (!Array.isArray(entries)) throw new Error('consolidate: entries must be an array');
  if (!Number.isInteger(capacity) || capacity < 0) throw new Error('consolidate: capacity must be a non-negative integer');
  const scored = entries.map((e, i) => ({ e, i, score: importanceScore(e) }));
  const kept = [];
  const evicted = [];
  // Stable: lowest score first; ties break oldest-first (lower index).
  const ranked = scored.slice().sort((x, y) => (x.score - y.score) || (x.i - y.i));
  const keepSet = new Set(ranked.slice(Math.max(0, scored.length - capacity)).map(r => r.i));
  for (const r of scored) {
    if (keepSet.has(r.i)) kept.push(r.e);
    else evicted.push({
      id: r.e.id ?? `idx:${r.i}`,
      content: r.e.content,
      classification: r.e.classification,
      authorityClass: r.e.authorityClass,
      score: r.score,
      reason: `capacity ${capacity}: score ${r.score} below surviving minimum`,
      recoverableAt: 'archive/evicted-memory-archive.md (durable notes file)',
    });
  }
  return { kept, evicted };
}

/**
 * Batch restore is the ONLY supported path. One-by-one restore is a livelock
 * (each save evicts the next-oldest; the restore never finishes) — refused in code.
 */
function restoreBatch(store, entries) {
  if (!Array.isArray(entries)) throw new Error('restoreBatch: entries must be an array (batch only)');
  if (entries.length === 0) return { restored: 0, refused: null };
  const capacity = typeof store.capacity === 'number' ? store.capacity : Infinity;
  if (entries.length > capacity) {
    return { restored: 0, refused: { code: 'BATCH_EXCEEDS_CAPACITY', detail: `${entries.length} entries vs capacity ${capacity} — restore would itself evict; raise capacity or trim the batch` } };
  }
  // Simulate the store's own eviction pressure: after a batch restore of N into
  // a store with room for N, nothing is evicted. The livelock shape (restore N
  // one-by-one into room for N) would evict N times — detect and refuse it.
  const oneByOneWouldEvict = entries.length > Math.max(0, capacity - store.entries.length);
  if (oneByOneWouldEvict && entries.length > 1) {
    return { restored: 0, refused: { code: 'RESTORE_LIVELOCK', detail: 'one-by-one restore would evict as it restores; use restoreBatch with a batch that fits' } };
  }
  store.entries.push(...entries);
  return { restored: entries.length, refused: null };
}

/* ------------------------------------------------------------------ *
 * Primitive 4 — Portable inheritance envelope
 * ------------------------------------------------------------------ *
 * Scar: a succession plan (token 0 -> token 1) with no portable format.
 * Law: the envelope is DATA. Import never promotes authority class.
 */

const ENVELOPE_SCHEMA_VERSION = 1;
const AUTHORITY_CLASSES = ['declared', 'verified', 'unverified'];

function digestEntry(entry, prevDigest) {
  const h = crypto.createHash('sha256');
  h.update(String(prevDigest));
  h.update('\u0000');
  h.update(JSON.stringify({
    content: entry.content, createdAt: entry.createdAt, author: entry.author,
    authorityClass: entry.authorityClass, classification: entry.classification,
  }));
  return h.digest('hex');
}

/** Export: build a digest-chained, versioned envelope. */
function exportEnvelope(entries, continuity = {}) {
  let prev = crypto.createHash('sha256').update('temporal-core/genesis').digest('hex');
  const chained = entries.map(e => {
    if (!AUTHORITY_CLASSES.includes(e.authorityClass)) {
      throw new Error(`exportEnvelope: bad authorityClass ${JSON.stringify(e.authorityClass)}`);
    }
    const digest = digestEntry(e, prev);
    prev = digest;
    return { ...e, digest };
  });
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    entries: chained,
    continuity: {
      objective: continuity.objective ?? null,
      openLoops: continuity.openLoops ?? [],
      constraints: continuity.constraints ?? [],
    },
  };
}

/**
 * Import: verify the digest chain, PRESERVE authority classes exactly.
 * An unverified note arrives marked unverified — never silently promoted.
 * A broken chain fails the whole load (tamper-evident).
 */
function importEnvelope(envelope) {
  if (!envelope || envelope.schemaVersion !== ENVELOPE_SCHEMA_VERSION) {
    return { ok: false, code: 'BAD_SCHEMA_VERSION', detail: `expected ${ENVELOPE_SCHEMA_VERSION}` };
  }
  if (!Array.isArray(envelope.entries)) return { ok: false, code: 'BAD_ENTRIES', detail: 'entries must be an array' };
  let prev = crypto.createHash('sha256').update('temporal-core/genesis').digest('hex');
  const out = [];
  for (let i = 0; i < envelope.entries.length; i++) {
    const e = envelope.entries[i];
    const expect = digestEntry(e, prev);
    if (e.digest !== expect) {
      return { ok: false, code: 'DIGEST_CHAIN_BROKEN', detail: `entry ${i} digest mismatch (expected ${expect.slice(0, 12)}…, got ${String(e.digest).slice(0, 12)}…)` };
    }
    prev = e.digest;
    out.push({
      content: e.content, createdAt: e.createdAt, author: e.author,
      authorityClass: e.authorityClass, classification: e.classification,
      authorityClassPreserved: true, // explicit: import is not a promotion step
    });
  }
  return { ok: true, entries: out, continuity: envelope.continuity ?? null, chainVerified: true };
}

module.exports = { makeClock, timeline, importanceScore, consolidate, restoreBatch, exportEnvelope, importEnvelope, ENVELOPE_SCHEMA_VERSION, AUTHORITY_CLASSES };