// RevenueCat — the deterministic half of monetisation ops.
//
// Conversational and mutating RevenueCat work belongs to the MCP server at
// https://mcp.revenuecat.ai/mcp: it holds the write scopes and the chat context.
// This command is read-only on purpose, because gates and CI need a stable exit
// code rather than a conversation. `ship rc audit` is that gate — every check it
// runs is one that has shipped an empty paywall to a real user at least once.
import { homedir } from 'node:os';
import { loadConfig } from '../config.mjs';
import { fetchJSON } from '../exec.mjs';
import { Report, ShipError, c, heading, note, table } from '../log.mjs';
import {
	KEY_FILE,
	apiKey,
	auditProject,
	bundleOf,
	listApps,
	listEntitlements,
	listOfferings,
	listPackages,
	listProducts,
	listProjects,
	resolveProject,
} from '../lib/revenuecat.mjs';
import { WINBACK_PATTERN } from '../lib/paywall.mjs';
import { emit } from '../lib/output.mjs';
import { resolveSubcommand } from '../lib/util.mjs';

export const help = `
${c.bold('ship rc')} ${c.dim('— RevenueCat monetisation wiring')}

${c.dim('usage:')} ship rc [subcommand] [flags]

  ${c.cyan('status')}        ${c.dim('default')} project, apps, entitlements, offerings, product count
  ${c.cyan('projects')}      every project this API key can see
  ${c.cyan('offerings')}     offerings, plus the current one's packages and their products
  ${c.cyan('products')}      product catalogue: id, store identifier, type, app
  ${c.cyan('entitlements')}  entitlements: id, lookup key, display name
  ${c.cyan('audit')}         paywall gate — exits 1 on anything that renders an empty paywall

${c.bold('Flags')}
  ${c.cyan('--json')}   machine-readable output

${c.dim(`Key: REVENUECAT_V2_KEY, else ${KEY_FILE}`)}
${c.dim('Project selection: revenuecat.projectId in ship.config.json')}
${c.dim('Mutations (create offering, attach product, edit paywall) → MCP: https://mcp.revenuecat.ai/mcp')}
`;

/** A save/exit offer, by lookup key. It belongs behind "manage subscription", not on the paywall. */
const isWinback = (o) => WINBACK_PATTERN.test(String(o?.lookup_key ?? o?.id ?? ''));

/**
 * A package's products are one level below the package, not inlined in the
 * package list — an offering with packages can still sell nothing.
 */
async function packageProducts(projectId, packageId) {
	const key = await apiKey();
	const body = await fetchJSON(
		`https://api.revenuecat.com/v2/projects/${projectId}/packages/${packageId}/products`,
		{ headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
	);
	return (body?.items ?? []).map((i) => i.product).filter(Boolean);
}

/** Resolve the project that every project-scoped subcommand operates on. */
async function context() {
	const cfg = await loadConfig();
	const want = cfg.revenuecat?.projectId;
	const project = await resolveProject(cfg);
	if (!project)
		throw new ShipError(
			want
				? `no RevenueCat project matches revenuecat.projectId "${want}"`
				: 'this API key sees several RevenueCat projects and none is selected',
			{ hint: `set revenuecat.projectId in ${cfg.file} — \`ship rc projects\` lists the ids` },
		);
	return { cfg, project };
}

async function projects({ flags }) {
	const list = await listProjects();
	if (flags.json) return emit(list.map((p) => ({ id: p.id, name: p.name })));
	heading(`RevenueCat projects (${list.length})`);
	table(list, [
		{ header: 'id', get: (p) => p.id },
		{ header: 'name', get: (p) => p.name },
	]);
	return 0;
}

async function status({ flags }) {
	const { cfg, project } = await context();
	const [apps, entitlements, offerings, products] = await Promise.all([
		listApps(project.id),
		listEntitlements(project.id),
		listOfferings(project.id),
		listProducts(project.id),
	]);
	const counts = new Map(
		await Promise.all(
			offerings.map(async (o) => [o.id, (await listPackages(project.id, o.id)).length]),
		),
	);
	const iosApp = apps.find((a) => a.type === 'app_store');
	const mismatch = iosApp && bundleOf(iosApp) && bundleOf(iosApp) !== cfg.bundleId;

	if (flags.json)
		return emit({
			project: { id: project.id, name: project.name },
			bundleId: cfg.bundleId,
			bundleMismatch: !!mismatch,
			apps: apps.map((a) => ({ id: a.id, type: a.type, bundle_id: bundleOf(a) || null })),
			entitlements: entitlements.map((e) => e.lookup_key),
			offerings: offerings.map((o) => ({
				lookup_key: o.lookup_key,
				is_current: !!o.is_current,
				packages: counts.get(o.id) ?? 0,
			})),
			products: products.length,
		});

	heading(`${project.name} ${c.dim(project.id)}`);
	note(`repo bundle id: ${cfg.bundleId}`);

	heading(`Apps (${apps.length})`);
	table(apps, [
		{ header: 'id', get: (a) => a.id },
		{ header: 'type', get: (a) => a.type },
		{ header: 'bundle id', get: (a) => bundleOf(a) || c.dim('—') },
	]);
	if (mismatch)
		note(c.yellow(`app_store app is ${bundleOf(iosApp)} but this repo builds ${cfg.bundleId}`));

	heading(`Entitlements (${entitlements.length})`);
	table(entitlements, [{ header: 'lookup key', get: (e) => e.lookup_key }]);
	if (cfg.revenuecat?.entitlement) note(`app expects: ${cfg.revenuecat.entitlement}`);

	heading(`Offerings (${offerings.length})`);
	table(offerings, [
		{ header: 'lookup key', get: (o) => o.lookup_key },
		{ header: 'current', get: (o) => (o.is_current ? c.green('yes') : c.dim('no')) },
		{ header: 'packages', get: (o) => counts.get(o.id) ?? 0 },
	]);

	heading('Products');
	note(`${products.length} configured`);
	return 0;
}

async function offerings({ flags }) {
	const { project } = await context();
	const list = await listOfferings(project.id);
	const current = list.find((o) => o.is_current);
	const packages = current ? await listPackages(project.id, current.id) : [];
	const detailed = await Promise.all(
		packages
			.slice()
			.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
			.map(async (p) => ({ ...p, products: await packageProducts(project.id, p.id) })),
	);

	if (flags.json)
		return emit({
			offerings: list.map((o) => ({
				id: o.id,
				lookup_key: o.lookup_key,
				is_current: !!o.is_current,
				display_name: o.display_name,
				winback: isWinback(o),
			})),
			current: current?.lookup_key ?? null,
			packages: detailed.map((p) => ({
				lookup_key: p.lookup_key,
				position: p.position ?? null,
				products: p.products.map((x) => ({
					id: x.id,
					store_identifier: x.store_identifier,
					app_id: x.app_id,
					type: x.type,
				})),
			})),
		});

	heading(`Offerings — ${project.name}`);
	table(list, [
		{ header: 'lookup key', get: (o) => o.lookup_key },
		{ header: 'current', get: (o) => (o.is_current ? c.green('yes') : c.dim('no')) },
		// A save offer served as the current offering *is* the paywall — worth
		// seeing next to the `current` column rather than inferring from a name.
		{ header: 'kind', get: (o) => (isWinback(o) ? c.yellow('win-back') : c.dim('paywall')) },
		{ header: 'display name', get: (o) => o.display_name ?? '' },
	]);

	if (!current) {
		note(c.yellow('no offering is current — the paywall renders empty on device'));
		return 0;
	}
	heading(`Packages in "${current.lookup_key}"`);
	table(detailed, [
		{ header: 'position', get: (p) => p.position ?? '' },
		{ header: 'lookup key', get: (p) => p.lookup_key },
		{
			header: 'products',
			get: (p) =>
				p.products.map((x) => x.store_identifier).join(', ') || c.red('none — will not render'),
		},
	]);
	return 0;
}

async function products({ flags }) {
	const { project } = await context();
	const list = (await listProducts(project.id)).slice().sort((a, b) => {
		const app = String(a.app_id).localeCompare(String(b.app_id));
		return app || String(a.store_identifier).localeCompare(String(b.store_identifier));
	});
	if (flags.json)
		return emit(
			list.map((p) => ({
				id: p.id,
				store_identifier: p.store_identifier,
				type: p.type,
				app_id: p.app_id,
			})),
		);
	heading(`Products — ${project.name} (${list.length})`);
	table(list, [
		{ header: 'id', get: (p) => p.id },
		{ header: 'store identifier', get: (p) => p.store_identifier ?? '' },
		{ header: 'type', get: (p) => p.type ?? '' },
		{ header: 'app id', get: (p) => p.app_id ?? c.dim('unattached') },
	]);
	return 0;
}

async function entitlements({ flags }) {
	const { project } = await context();
	const list = await listEntitlements(project.id);
	if (flags.json)
		return emit(
			list.map((e) => ({ id: e.id, lookup_key: e.lookup_key, display_name: e.display_name })),
		);
	heading(`Entitlements — ${project.name} (${list.length})`);
	table(list, [
		{ header: 'id', get: (e) => e.id },
		{ header: 'lookup key', get: (e) => e.lookup_key },
		{ header: 'display name', get: (e) => e.display_name ?? '' },
	]);
	return 0;
}

async function audit({ flags }) {
	const { cfg, project } = await context();
	// Which credential answered matters here: this gate's most confusing failure
	// was a healthy project behind another account's key.
	const via = project.keySource && project.keySource !== 'ambient' ? ` via ${project.keySource.replace(homedir(), '~')}` : '';
	const report = new Report(`RevenueCat — ${project.name} (${project.id})${via}`);
	for (const row of await auditProject(cfg, project)) report[row.level](row.name, row.detail);
	return report.print({ json: flags.json });
}

const SUB = { status, projects, offerings, products, entitlements, audit };

export async function run({ args, flags }) {
	const { fn, args: rest } = resolveSubcommand({ command: 'rc', args, subs: SUB, fallback: 'status' });
	return fn({ args: rest, flags });
}
