// All tunables in one place. See BRIEF §1.14 and §5: tune these from gauntlet + dogfood
// measurements (settle-time distributions, screencast cost), not taste.
export const defaults = {
  // --- settlement (GUIDANCE §4.2) ---
  quietMs: 300,            // Q: no attributed request / mutation / changed frame for this long => quiet
  noEffectMs: 500,         // nothing at all happened within this => verdict "no-effect"
  budgetMs: 3000,          // caps waiting for quiet; suspended while attributed requests are in flight
  maxBudgetMs: 20000,      // absolute cap even with requests in flight (hung request => "still-active")
  watchBudgetMs: 1500,     // default budget for watch()
  // --- attribution (GUIDANCE §4.4, BRIEF §1.13) ---
  taskTierSlackMs: 30,     // requests starting within this of the input task end still count as "task"
  ambientMinCount: 3,      // family occurrences needed before it can be classified ambient
  ambientMaxCv: 0.3,       // coefficient of variation of inter-arrival gaps for "regular cadence"
  chainedPollGapMs: 250,
  trailingAttributionMs: 1500, // requests this soon after a window closes (same root, no new window) tag "trailing"   // next poll starting within this of previous end => chained (long-poll)
  classifierWarmupMs: 90000, // idle observation before reports stop saying "classifier: immature" (EHRs use ~60s heartbeats; need ≥3 cycles — dogfood #1)
  idleObserveMs: 30000,    // `disco session new` idle observation (skippable); for minute-scale EHR heartbeats run `disco idle 120000` once (dogfood #1)
  // --- capture (GUIDANCE §3.4) ---
  bodyTextCap: 2_000_000,  // bytes of textual body kept in SQLite (and FTS); blob always keeps full
  bodyBlobCap: 50_000_000, // bytes beyond which we don't even fetch the body (marked "truncated")
  wsPayloadCap: 1_000_000,
  networkBufferTotal: 400_000_000, // Network.enable maxTotalBufferSize (raise so bodies aren't evicted)
  networkBufferPerResource: 100_000_000,
  unreadBodyGraceMs: 1200,  // fetch() responses whose body the page never reads emit no loadingFinished;
                            // after headers + this much silence the request is demoted to "unread" and
                            // released from settlement (DECISIONS #22)
  screencast: { format: "jpeg" as const, quality: 50, maxWidth: 960, maxHeight: 960, everyNthFrame: 1 },
  screencastPersistMinGapMs: 333, // ≈3 fps persistence cap for *changed* frames
  visualDecodeMinGapMs: 80,       // ≥12 fps cap on JPEG decode for tile signatures
  visualTilePx: 32,
  selfFeedbackMaxArea: 24000, // px²: clicked elements smaller than this may repaint themselves (pressed/
                              // focus states) without it counting as an "effect" (DECISIONS #23)
  selfFeedbackInflatePx: 12,
  visualTileDelta: 12,     // mean-RGB delta per tile to count as changed
  visualIgnoreLearnFrames: 24, // tile changing in this many of the last 32 idle frames => ignored
  observerBatchMs: 40,     // in-page mutation batch interval (well under quietMs)
  // --- report digest (GUIDANCE §4.3, BRIEF §1.18) ---
  digestMaxRequests: 8,
  digestMaxUiLines: 24,
  digestMaxUiLinesNav: 12, // navigations rebuild the whole screen; cap the aria delta harder (dogfood #1)
  digestMaxConsole: 5,
  // --- rpc ---
  rpcTimeoutMs: 60000,
};
export type Defaults = typeof defaults;
