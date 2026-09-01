// Terminal rendering for the `ship ads` read-only views: report tables, the
// live-account snapshot, and the mining evidence. Pure output — the callers
// own data collection and exit codes.
import { c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { DASH, money, pct, round2 } from './fmt.mjs';
import { emit } from './output.mjs';

export function printReport({ flags, level, from, to, org, metrics, money$ }) {
	const spend = round2(metrics.reduce((s, r) => s + r.spend, 0));
	const installs = metrics.reduce((s, r) => s + r.installs, 0);
	const taps = metrics.reduce((s, r) => s + r.taps, 0);
	if (flags.json)
		return emit({
			from, to, org, level, rows: metrics,
			totals: { spend, taps, installs, cpi: installs ? round2(spend / installs) : null, cpt: taps ? round2(spend / taps) : null },
			monetisation: money$,
		});
	heading(`${level} report · ${from} → ${to} · org ${org}`);
	table(metrics, [
		{ header: level, get: (r) => r.name },
		{ header: 'spend', get: (r) => money(r.spend) }, { header: 'installs', get: (r) => String(r.installs) },
		{ header: 'CPI', get: (r) => (r.cpi === null ? DASH : money(r.cpi)) }, { header: 'taps', get: (r) => String(r.taps) },
		{ header: 'CPT', get: (r) => (r.cpt === null ? DASH : money(r.cpt)) },
		{ header: 'TTR', get: (r) => pct(r.ttr) }, { header: 'CVR', get: (r) => pct(r.conversionRate) },
	]);
	process.stdout.write('\n');
	info(`total ${c.bold(money(spend))} · ${c.bold(installs)} installs · blended CPI ${c.bold(installs ? money(spend / installs) : '—')} · CPT ${c.bold(taps ? money(spend / taps) : '—')}`);
	printMonetisationLine(money$);
	printReportNotes(level, metrics);
}

function printMonetisationLine(money$) {
	if (money$.available) {
		const line = `install→paid ${money$.installToPaid === null ? '—' : pct(money$.installToPaid)} · ${money$.subscriptions} subscription(s) · ${money(money$.revenue)} revenue · LTV/install ${money(money$.ltvPerInstall)}`;
		if (money$.proven) info(line);
		else warn(line);
		info(`${money$.label}: ${money$.cpiCeiling === null ? 'none — nothing has monetised' : money(money$.cpiCeiling)} per install`);
	} else note(`install→paid unknown — ${money$.reason}`);
}

function printReportNotes(level, metrics) {
	const dead = metrics.filter((r) => r.spend > 0 && r.installs === 0);
	if (dead.length) warn(`${dead.length} ${level}(s) spent with zero installs: ${dead.map((r) => r.name).join(', ')}`);
	if (level === 'campaign')
		note('`ship ads report --level ad-group` is where a bid regression shows up; campaign totals hide it');
	note('`ship ads mine` turns the search-term half of this report into keywords instead of a to-do list');
}

export function printSnapshot(account, { org, from, to, file }) {
	heading(`Live account · org ${org} · ${from} → ${to}`);
	for (const cp of account.campaigns) {
		process.stdout.write('\n');
		step(
			`${cp.name} · ${cp.id} · ${cp.status ?? '—'} · ${cp.dailyBudget === null ? 'no budget' : `${money(cp.dailyBudget)}/day`} · ${cp.adGroups.length} ad group(s), ${cp.negativeKeywords.length} negative(s)`,
		);
		table(cp.adGroups, [
			{ header: 'ad group', get: (g) => g.name }, { header: 'id', get: (g) => g.id },
			{ header: 'status', get: (g) => g.status ?? '' },
			{ header: 'bid', get: (g) => (g.defaultBidAmount === null ? '—' : money(g.defaultBidAmount)) },
			{ header: 'keywords', get: (g) => String(g.keywords.length) },
			{ header: 'spend', get: (g) => (g.performance ? money(g.performance.spend) : '—') },
			{ header: 'taps', get: (g) => (g.performance ? String(g.performance.taps) : '—') },
			{ header: 'installs', get: (g) => (g.performance ? String(g.performance.installs) : '—') },
		]);
	}
	process.stdout.write('\n');
	good(`wrote ${file}`);
	note('this is observed state; campaign-plan.json is desired state. `ship ads sync --dry-run` diffs them');
}

export function printMining({ decided, artifact, converting, gap, outFile, paid, locale, from, to, wantsApply, confirmed }) {
	heading(`Search-term mining · ${from} → ${to}`);
	info(
		`${artifact.rows} row(s) · target CPI ${money(decided.targetCpi)} (${decided.killRule.source}) · waste line ${money(decided.wasteThreshold)} · min ${decided.minTaps} taps · source ${c.dim(artifact.source)}`,
	);
	note(decided.killRule.derivation);
	const show = (title, rows, cols, empty) => {
		if (!rows.length) return note(empty);
		process.stdout.write('\n');
		step(title);
		table(rows, cols);
	};
	show(`${decided.negatives.length} negative keyword(s) proposed`, decided.negatives, [
		{ header: 'term', get: (n) => n.term },
		{ header: 'spend', get: (n) => money(n.spend) },
		{ header: 'taps', get: (n) => String(n.taps) },
		{ header: 'impr', get: (n) => String(n.impressions) },
		{ header: 'window', get: () => `${from} → ${to}` },
		{ header: 'served by', get: (n) => n.adGroupName ?? n.campaignName ?? '' },
	], 'no term is past both the waste line and the minimum tap count');
	show(`${decided.held.length} term(s) past the money line but held for evidence`, decided.held, [
		{ header: 'term', get: (h) => h.term },
		{ header: 'spend', get: (h) => money(h.spend) },
		{ header: 'taps', get: (h) => `${h.taps}/${h.needTaps}` },
		{ header: 'why', get: (h) => h.reason },
	]);
	show(`${decided.promotions.length} promotion(s) to Exact`, decided.promotions, [
		{ header: 'term', get: (p) => p.term },
		{ header: 'installs', get: (p) => String(p.installs) },
		{ header: 'CPI', get: (p) => money(p.cpi) },
		{ header: 'bid', get: (p) => money(p.bid) },
		{ header: 'served by', get: (p) => p.servedBy ?? '' },
	], 'nothing converted under target on broad or Search Match');
	process.stdout.write('\n');
	good(`wrote ${outFile}`);
	good(`${converting.length} converting term(s) → ${paid.file}`);
	printAsoGap(gap, locale);
	printApplyStatus({ wantsApply, confirmed, artifact, decided, outFile });
}

function printAsoGap(gap, locale) {
	if (gap.missing.length) {
		warn(
			`${gap.missing.length} converting term(s) are absent from the ${locale} listing: ${gap.missing.slice(0, 8).join(', ')}${gap.missing.length > 8 ? ', …' : ''}`,
		);
		note('a term that converts on paid and is missing from the organic listing is the highest-value ASO finding there is —');
		note(`you are renting traffic you could own: \`ship aso suggest --locale ${locale}\`, then \`ship meta keywords\``);
	} else if (!gap.staged) note(`no staged listing for ${locale} — cannot tell which paid winners the listing already covers`);
}

function printApplyStatus({ wantsApply, confirmed, artifact, decided, outFile }) {
	if (!wantsApply) note('`ship ads mine --apply --confirm` pushes it (preview first: `--apply --dry-run`)');
	else if (!confirmed) {
		warn(`--apply needs --confirm: ${decided.negatives.length} negation(s) are permanent and ${decided.promotions.length} promotion(s) spend money`);
		note(`the evidence for each is above and in ${outFile} — re-run with --confirm, or --apply --dry-run to preview the calls`);
	} else
		good(`${artifact.applied.dryRun ? 'dry-run: ' : ''}applied ${artifact.applied.negativesAdded} negative(s), ${artifact.applied.promoted} promotion(s)`);
}
