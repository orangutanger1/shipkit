// Apple Ads credential UX: org resolution, login, and the setup guide. The API
// layer lives in ads-client.mjs; this is everything a human has to get right
// before that layer can run.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { ShipError, c, good, heading, info, note, step, table, warn } from '../log.mjs';
import { ASC, asc, run as exec } from '../exec.mjs';
import { rowsOf } from './asc-report.mjs';
import { emit } from './output.mjs';
import { expandTilde } from './util.mjs';

export const orgOf = (cfg, flags) => flags.org ?? cfg?.ads?.orgId ?? process.env.ASC_ADS_ORG_ID ?? null;

export function requireOrg(cfg, flags) {
	const org = orgOf(cfg, flags);
	if (!org)
		throw new ShipError('no Apple Ads organization id', { hint: 'pass --org <id>, set ads.orgId in ship.config.json, or export ASC_ADS_ORG_ID — `asc ads acls --output json` lists the orgs this key can see' });
	return String(org);
}

export const LOGIN_LINE = [
	'asc ads auth login \\',
	'  --name "<profile name>" \\',
	'  --client-id "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --team-id "SEARCHADS.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --key-id "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \\',
	'  --private-key ~/.asc/asa-private.p8 \\',
	'  --org "<organization id>"',
];

export async function authState() {
	const res = await exec(ASC, ['ads', 'auth', 'status'], { allowFail: true });
	const text = `${res.stdout}${res.stderr}`.trim();
	const configured = res.code === 0 && !/no apple ads credentials/i.test(text) && !/active auth:\s*none/i.test(text);
	return { configured, text };
}

export function setupGuide() {
	heading('Not configured — how to fix it');
	process.stdout.write('\n');
	for (const line of LOGIN_LINE) process.stdout.write(`  ${c.cyan(line)}\n`);
	process.stdout.write('\n');
	info('Where each value comes from');
	note(`1. ${c.bold('app-ads.apple.com')} → Account Settings → User Management → Invite Users`);
	note('   Role: API Account Manager (read+write). API Account Read Only can pull');
	note('   reports but cannot create a campaign. API users are separate people in');
	note(`   Apple's model, so invite yourself even as the account admin — the invite needs an ${c.bold('Apple ID')}, not just any address.`);
	note(`2. Generate the key pair ${c.bold('yourself')} — Apple never gives you a private key:`);
	note(`   ${c.cyan('openssl ecparam -genkey -name prime256v1 -noout -out asa.pem')}`);
	note(`   ${c.cyan('openssl ec -in asa.pem -pubout -out asa.pub')}   ${c.dim('# this is what you paste')}`);
	note(`   ${c.cyan('openssl pkcs8 -topk8 -nocrypt -in asa.pem -out ~/.asc/asa-private.p8')}`);
	note(`   ${c.dim('--private-key must be PKCS#8: the file starts -----BEGIN PRIVATE KEY-----')}`);
	note(`3. Sign in ${c.bold('as that API user')} → Account Settings → API → paste the public key → Generate API Client.`);
	note('   That screen returns --client-id (starts SEARCHADS.), --team-id (often identical) and --key-id.');
	note(`4. ${c.bold('--org')} is the organization id shown in the URL / account picker;`);
	note('   after login `asc ads acls --output json` lists every org you can reach.');
	process.stdout.write('\n');
	note('`ship ads plan` works right now without any of this.');
}

export async function status({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	const { configured, text } = await authState();
	if (!configured) {
		if (flags.json) return emit({ configured: false, org: orgOf(cfg, flags), detail: text, login: LOGIN_LINE.join('\n') });
		heading('Apple Search Ads');
		for (const line of text.split('\n')) note(line);
		setupGuide();
		return 0;
	}
	const [me, acls] = await Promise.all([asc(['ads', 'me'], { fallback: null, allowFail: true }), asc(['ads', 'acls'], { fallback: null, allowFail: true })]);
	const orgs = rowsOf(acls, { allowSingle: false });
	if (flags.json) return emit({ configured: true, me: me?.data ?? me, orgs });
	heading('Apple Search Ads');
	for (const line of text.split('\n')) note(line);
	const user = me?.data ?? me ?? {};
	if (user.parentOrgId || user.userId) info(`user ${c.bold(user.userId ?? '?')} · parent org ${c.bold(user.parentOrgId ?? '?')}`);
	heading(`Organizations (${orgs.length})`);
	table(orgs, [
		{ header: 'orgId', get: (o) => o.orgId ?? o.id ?? '' }, { header: 'name', get: (o) => o.orgName ?? o.parentOrgName ?? o.name ?? '' },
		{ header: 'currency', get: (o) => o.currency ?? '' }, { header: 'roles', get: (o) => (o.roleNames ?? o.roles ?? []).join(',') },
	]);
	const selected = orgOf(cfg, flags);
	if (selected) info(`ads.orgId = ${c.bold(selected)}`);
	else warn('no ads.orgId in ship.config.json — campaigns/report need --org');
	return 0;
}

async function resolvePrivateKey(keyPath) {
	const abs = resolve(expandTilde(String(keyPath)));
	if (!existsSync(abs))
		throw new ShipError(`private key not found: ${abs}`, {
			hint: 'You generated this key, not Apple — it is the private half of the public key pasted at Account Settings → API. If it is lost the client is unusable: generate a new pair and upload the new public key.',
		});
	const head = (await readFile(abs, 'utf8')).trimStart().split('\n')[0].trim();
	if (head !== '-----BEGIN PRIVATE KEY-----')
		throw new ShipError(`private key is not PKCS#8: first line is "${head}"`, {
			hint: `Apple Ads requires a PKCS#8 P-256 key. Convert it:\n  openssl pkcs8 -topk8 -nocrypt -in ${abs} -out ${abs.replace(/\.[^.]+$/, '')}-pkcs8.p8`,
		});
	return abs;
}

export async function login({ flags }) {
	const cfg = await loadConfig(undefined, { optional: true });
	const keyPath = flags['private-key'] ?? flags.privateKey;
	const missing = ['client-id', 'team-id', 'key-id'].filter((f) => !flags[f]);
	if (!keyPath) missing.push('private-key');
	if (missing.length)
		throw new ShipError(`ads login: missing ${missing.map((m) => `--${m}`).join(' ')}`, {
			hint: `${LOGIN_LINE.join('\n')}\n\nRun \`ship ads status\` for where each value comes from.`,
		});
	const abs = await resolvePrivateKey(keyPath);
	const name = flags.name ?? (cfg?.name ? `${cfg.name} ads` : 'ads');
	const args = [
		'ads', 'auth', 'login', '--name', String(name),
		'--client-id', String(flags['client-id']), '--team-id', String(flags['team-id']),
		'--key-id', String(flags['key-id']), '--private-key', abs,
	];
	const org = flags.org ?? cfg?.ads?.orgId;
	if (org) args.push('--org', String(org));
	step(`asc ${args.join(' ')}`);
	const res = await exec(ASC, args, { capture: false, mutating: true, allowFail: true });
	if (res.skipped) return 0;
	if (res.code !== 0)
		throw new ShipError(`asc ads auth login exited ${res.code}`, {
			hint: 'Common cause: the credentials belong to your admin login rather than the API-role user. Re-check step 2 in `ship ads status`.',
		});
	good('credentials stored');
	return 0;
}

export async function gate(cfg = null) {
	const { configured, text } = await authState();
	if (!configured)
		throw new ShipError('Apple Ads credentials are not configured', {
			hint: `${text}\n\n${LOGIN_LINE.join('\n')}\n\nRun \`ship ads status\` for where each value comes from.\n\`ship ads plan\` works offline in the meantime.`,
		});
	const want = cfg?.ads?.orgId;
	if (!want) return;
	const auth = await asc(['ads', 'auth', 'status'], { fallback: null });
	const active = auth?.active ?? {};
	const live = String(active.org_id ?? active.orgId ?? '');
	if (live && live !== String(want))
		throw new ShipError(`the active Apple Ads profile is org ${live}, but ads.orgId is ${want}`, {
			hint: `profile "${active.profile ?? '?'}" is the default — pass --org ${want}, switch the default with \`asc ads auth use\`, or correct ads.orgId in ${cfg.file}`,
		});
}
