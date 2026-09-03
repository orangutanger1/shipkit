// App Store keyword research — barrel.
// appstore-client.mjs: the throttled, cached, retrying iTunes HTTP layer.
// appstore-score.mjs: candidate filtering, demand, competition, packing.
export {
	CACHE_TTL_MS,
	LOCALE_MARKETS,
	MIN_INTERVAL_MS,
	StorefrontWall,
	gateFor,
	gateWait,
	harvest,
	hints,
	lookup,
	marketFor,
	topResults,
	useCache,
} from './appstore-client.mjs';
export {
	brandCollisions,
	commodity,
	demand,
	demandTable,
	packKeywords,
	pickCandidates,
	progressLine,
	saturation,
	score,
	scoreAll,
} from './appstore-score.mjs';
