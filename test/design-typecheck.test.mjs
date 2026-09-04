// The generated app is TypeScript under `strict`; shipkit is JSDoc-typed .mjs,
// where the types live in comments TypeScript ignores once the file is .ts.
//
// Nothing else in this suite ever compiles what the emitters write, which is how
// src/theme/qa-params.ts shipped with nine implicit-any errors that only an app
// repo running its own `tsc` would ever see. This file is that compiler.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { QA_PARAMS_SOURCE, emitCatalog, emitEvents, emitQaParams } from '../src/lib/design-support.mjs';
import { DEFAULT_SYSTEM, emitTokens } from '../src/lib/design-tokens.mjs';
import { uxSpec } from './fixtures/artifacts.mjs';

const TSC = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));

// The `check` job installs nothing — shipkit has no runtime dependencies and no
// lockfile — so tsc is only here for someone who ran `npm install`. CI gates the
// same thing from the `smoke` job, which fetches tsc over npx and compiles a real
// scaffold, so skipping here loses no coverage.
const NO_TSC = existsSync(TSC) ? false : 'typescript is a devDependency; the smoke job gates this in CI';

/** templates/app/tsconfig.json extends expo's base, which is not installable here.
 * `strict` is the setting that matters and the one the app sets itself.
 * @type {(files: Record<string, string>) => {code: number, out: string}}
 */
function typecheck(files) {
	const dir = mkdtempSync(join(tmpdir(), 'shipkit-tsc-'));
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			strict: true, noEmit: true, target: 'ES2022', lib: ['ES2023'],
			module: 'esnext', moduleResolution: 'bundler', skipLibCheck: true,
		},
		include: ['*.ts'],
	}));
	const r = spawnSync(TSC, ['-p', dir], { encoding: 'utf8' });
	return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the emitted QA sanitizer typechecks under the app repo strict TypeScript', { skip: NO_TSC }, () => {
	const src = readFileSync(QA_PARAMS_SOURCE, 'utf8');
	const { code, out } = typecheck({ 'qa-params.ts': emitQaParams(src, { source: 'src/lib/qa-params.mjs' }) });
	assert.equal(code, 0, out);
});

test('every other generated module typechecks too', { skip: NO_TSC }, () => {
	const { code, out } = typecheck({
		'tokens.ts': emitTokens(DEFAULT_SYSTEM, { source: 'design/system.json' }),
		'events.ts': emitEvents(uxSpec, { source: 'design/ux.json' }),
		'catalog.ts': emitCatalog(uxSpec, { source: 'design/ux.json' }),
	});
	assert.equal(code, 0, out);
});
