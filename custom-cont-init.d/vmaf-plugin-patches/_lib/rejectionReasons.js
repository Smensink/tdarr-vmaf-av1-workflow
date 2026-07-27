'use strict';

/**
 * Shared constants + helpers for cross-plugin rejection-reason string matching.
 *
 * Background (2026-07-21): checkCQRangeRetry decides whether a candidate's rejection was
 * "size-terminal" (lower CQ can never help - it only increases output size) by substring-
 * matching the free-text `reason` string that selectBestParameters writes into
 * `args.variables.vmafRejectedResults[].reason` (see selectBestParameters/1.0.0/index.js,
 * the `rejectReason = ...` assignments feeding `evaluateSizeGate`'s max-ratio guard). When
 * that wording changed for the 2026-07-20 size-gate demotion (legacy 90% cap -> shadow +
 * hard 'emergency cutoff'), the old inline match on a single hardcoded string silently
 * stopped firing and had to be patched as an emergency fix to recognise the new wording
 * alongside the old. Centralising the token list and the OR-of-substrings check here means
 * a future wording change only needs to be reconciled in ONE place, and every consumer
 * picks it up automatically instead of needing its own coordinated patch.
 *
 * Pure refactor note: the token strings and `isSizeTerminalReason` logic below are byte-
 * for-byte equivalent to the inline check they replace. Do not change wording here without
 * also confirming selectBestParameters still emits it (see the producer-mapping comment
 * below) and re-running the migration regression test.
 *
 * Producer -> consumer map for this specific contract (as of 2026-07-21):
 *   - selectBestParameters/1.0.0/index.js emits SIZE_EMERGENCY_CUTOFF and SIZE_LEGACY_CAP
 *     wording (live, current) via its `evaluateSizeGate` max-ratio guard.
 *   - SIZE_INSUFFICIENT_BENEFIT is the retired pre-2026-07-20 wording; no live producer
 *     emits it any more, but historical job records / in-flight jobs started before the
 *     demotion may still carry it, so consumers keep recognising it.
 *   - checkCQRangeRetry/1.0.0/index.js is the only current consumer (its
 *     `sizeBenefitTerminal` check before deciding whether to keep descending in CQ).
 */

// Retired pre-2026-07-20 wording (selectBestParameters's old single max-ratio cap).
var SIZE_INSUFFICIENT_BENEFIT = 'insufficient size benefit';

// Demoted-gate era (2026-07-20 size-gate demotion) hard-reject wording: projection so far
// over source size that even worst-case projection error can't make the re-encode worthwhile.
var SIZE_EMERGENCY_CUTOFF = 'emergency cutoff';

// Demoted-gate era wording for the retired legacy cap firing again once the forced-full
// shadow label budget is exhausted (see selectBestParameters's evaluateSizeGate).
var SIZE_LEGACY_CAP = 'legacy cap';

// Every generation of the size-cap rejection wording that should be treated as
// "size-terminal" (lower CQ only increases output size, so retrying downward can never
// help). Order does not matter; matching is substring OR, identical to the inline check
// this module replaces.
var SIZE_TERMINAL_REASONS = [
  SIZE_INSUFFICIENT_BENEFIT,
  SIZE_EMERGENCY_CUTOFF,
  SIZE_LEGACY_CAP
];

/**
 * True if `reason` (a free-text rejection-reason string, e.g. from
 * `args.variables.vmafRejectedResults[].reason`) matches any known size-terminal wording.
 * Safe against null/undefined/non-string input (coerced to '' like the inline check did).
 */
function isSizeTerminalReason(reason) {
  var text = String(reason || '');
  for (var i = 0; i < SIZE_TERMINAL_REASONS.length; i++) {
    if (text.indexOf(SIZE_TERMINAL_REASONS[i]) !== -1) return true;
  }
  return false;
}

module.exports = {
  SIZE_INSUFFICIENT_BENEFIT: SIZE_INSUFFICIENT_BENEFIT,
  SIZE_EMERGENCY_CUTOFF: SIZE_EMERGENCY_CUTOFF,
  SIZE_LEGACY_CAP: SIZE_LEGACY_CAP,
  SIZE_TERMINAL_REASONS: SIZE_TERMINAL_REASONS,
  isSizeTerminalReason: isSizeTerminalReason
};
