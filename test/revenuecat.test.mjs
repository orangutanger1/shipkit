// RC v2 answers pagination with next_page as an absolute URL. Appending it to
// BASE produced `https://api.revenuecat.com/v2https://…` and a TypeError, so
// every project past one page of products (25) failed `ship rc status|audit`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.REVENUECAT_V2_KEY = 'test-key';
const { listProducts } = await import('../src/lib/revenuecat.mjs');

test('pagination follows an absolute next_page URL instead of joining it onto BASE', async () => {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const body =
			calls.length === 1
				? { items: [{ id: 'prod_1' }], next_page: 'https://api.revenuecat.com/v2/projects/p1/products?starting_after=prod_1' }
				: { items: [{ id: 'prod_2' }] };
		return {
			ok: true,
			status: 200,
			text: async () => JSON.stringify(body),
		};
	};
	try {
		const items = await listProducts('p1');
		assert.deepEqual(items.map((i) => i.id), ['prod_1', 'prod_2']);
		// The second request must be the URL RC handed back, byte for byte.
		assert.equal(calls[1], 'https://api.revenuecat.com/v2/projects/p1/products?starting_after=prod_1');
	} finally {
		globalThis.fetch = original;
	}
});

test('a relative next_page still joins with BASE', async () => {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		const body =
			calls.length === 1
				? { items: [{ id: 'a' }], next_page: '/projects/p1/products?cursor=1' }
				: { items: [{ id: 'b' }] };
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	try {
		await listProducts('p1');
		assert.equal(calls[1], 'https://api.revenuecat.com/v2/projects/p1/products?cursor=1');
	} finally {
		globalThis.fetch = original;
	}
});
