// Apple Search Ads decision core — barrel. The bid/kill/normalisation half is
// asa-core.mjs; the plan-vs-account reconciler is asa-reconcile.mjs. Both are
// pure; `ship ads` owns every line that talks to Apple.
export {
	BID,
	BASELINE_INSTALL_RATE,
	KILL_CONFIDENCE,
	assertBidSpread,
	bidFor,
	checkAdsConfig,
	demandFactor,
	lastModified,
	monetisation,
	normaliseAdGroup,
	normaliseCampaign,
	normaliseKeyword,
	parseAppleTime,
	pos,
	resolveBidding,
	resolveKillRule,
	tapsForConfidence,
} from './asa-core.mjs';
export { describeAction, reconcile } from './asa-reconcile.mjs';
