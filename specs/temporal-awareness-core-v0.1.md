# Spec: temporal-awareness core (proven time, bounded reads, weighted memory, portable inheritance) — v0.1

Provenance: distilled from a live autonomous agent's memory-system failures in one week
(Grok exchange + principal review; scar receipts in the appendix). Desk-private details
stripped — mechanisms and fix shapes are portable to any agent with a
journal/memory/timeline stack. No trading logic, no autonomous-authority change:
infrastructure spec only.

## The cut (desk-sized to the killer app)

Four primitives, one integration order (1 → 3 → 2 → 4): proven time is the spine
bounded reads and trustworthy timestamps hang from; consolidation needs the manifest
discipline bounded reads introduce; the inheritance envelope ships the result to a
successor.

### 1. Clock trust chain — `now()` → proven time (the spine fix)

- `now()` returns `{ t, source, confidence }`, source ∈ {injected, ntp, onchain-block}.
- Cheap verifiable option: cross-check the injected anchor against an onchain block
  timestamp (read-only RPC, any EVM chain). Divergence beyond threshold → flag +
  degrade to `unproven`; never silently assert.
- Code-level enforcement of timezone + relative-time rules: "today/yesterday" resolve
  ONLY from the proven anchor, never model memory; every ledger write carries
  time-source provenance; journal reads render in the configured zone.

**Acceptance:** a deliberately skewed clock is detected within one tick; zero unproven
timestamps presented as fact.

### 2. Importance-weighted consolidation

- Every entry carries an auditable importance score: provenance-derived baseline
  (law > fact > note), reinforcement count (re-confirmed laws gain weight),
  principal-anchored > agent-derived.
- Eviction = lowest score first, with an explicit eviction manifest (what left, why,
  where it is recoverable). Consolidation pass merges/reinforces instead of silently
  dropping.
- Batch restore is the supported path — one-by-one restore is a livelock (each save
  evicts the next-oldest; the restore never finishes). Code refuses the livelock shape.

**Acceptance:** a pinned law survives a flood of ephemeral notes; every eviction names
its victim and reason.

### 3. Bounded timeline reconstruction

- First-class primitive: `timeline(range | cursor)` →
  `{ events, totalCount, omittedCount, nextCursor }`. Truncation is always explicit;
  pagination is the default path, never an afterthought.

**Acceptance:** any reconstruction reports "N of M events, cursor for the rest"; zero
silent truncation in the read path.

### 4. Portable inheritance format (the successor's dependency)

- Versioned envelope: `{ schemaVersion, entries[{ content, createdAt (proven time),
  author, authorityClass ∈ {declared, verified, unverified}, classification, digest }],
  continuity{ objective, openLoops, constraints } }`.
- Digest-chained entries (tamper-evident); authority classes ride with entries so a
  successor never inherits an unverified note as policy.

**Acceptance:** export/import round-trip preserves author, authority class, timestamp
per entry; digest chain verifies on load; unverified entries arrive marked, never
silently promoted.

## MONEY-SAFETY / AUTHORITY HARD RULES

- Proven time is OBSERVATION: an onchain cross-check grants no transaction authority.
- The inheritance envelope is DATA: importing entries never promotes their authority
  class — an unverified note stays unverified on load, and `declared` entries carry
  provenance, never execution permission.
- No autonomous-authority change of any kind rides this spec.

## Deliberately NOT in this cut

- NTP/time-server integration (onchain cross-check is the cheap proven primitive; NTP
  is a v2 source plug-in).
- Automatic consolidation scheduling (the pass runs on-demand or on an explicit
  operator schedule — cadence is policy, not mechanism).
- Cross-agent memory merge / shared brain (inheritance is one-way export→import).
- Any trading-desk specifics (stripped by design; donor core stays community-clean).

## Scar-receipt appendix (review against the lived incidents)

| Gap | Scar |
|-----|------|
| 1 | unverified clock anchor; timezone-assumed journal reads; schedule-trim misdecision from misread time context |
| 2 | hard-won laws evicted next to weather notes; restore-never-ends livelock; manual archive as only rescue |
| 3 | 50-cap silent truncation on journal reads; reconstruction believed complete when it held a prefix |
| 4 | succession plan (token 0 → token 1) with no portable format behind it |