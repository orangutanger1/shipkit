#!/usr/bin/env node
// Fake `asc` binary for status-biz tests: behaviour is chosen by FAKE_ASC_MODE
// so one script serves every collectAds branch without touching the network.
const mode = process.env.FAKE_ASC_MODE || 'no-auth';
const args = process.argv.slice(2);
const isReport = args.includes('reports');

const bodies = {
	'no-auth': { credentials: [] },
	'no-org': { credentials: [{ name: 'x' }], active: {} },
	full: isReport
		? {
				reportingDataResponse: {
					row: [
						{ total: { localSpend: { amount: 12.5 }, totalInstalls: 3, taps: 10, impressions: 100 } },
						{ granularity: [{ localSpend: 2.5, totalInstalls: 1, taps: 4, impressions: 40 }] },
					],
				},
			}
		: { credentials: [{ name: 'x' }], active: { org: '555' } },
	'zero-installs': isReport
		? { reportingDataResponse: { row: [{ total: { localSpend: { amount: 5 }, totalInstalls: 0, taps: 1, impressions: 10 } }] } }
		: { credentials: [{ name: 'x' }], active: { org: '555' } },
};

process.stdout.write(JSON.stringify(bodies[mode] ?? {}));
