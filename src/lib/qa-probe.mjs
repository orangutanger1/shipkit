// What one captured screen actually measured.
//
// A PNG can only be inspected by eye, and "does this look cramped" is not a
// gate. So the same page that produces the PNG is asked, in its own runtime,
// for the numbers: box sizes, computed colours, and whether anything overflowed
// its container. Those are arithmetic, and arithmetic is gateable.
//
// `probe` is handed to page.evaluate, which serialises it by source — so it
// closes over nothing, imports nothing, and every helper it uses is declared
// inside it. That constraint is why this file holds one long function.

/** @typedef {{label: string, w: number, h: number, x: number, y: number}} Box */
/** @typedef {{label: string, size: number, weight: number, fg: string|null, bg: string|null}} Text */
/** @typedef {{view: {w: number, h: number}, overflowX: number, tappables: Box[], texts: Text[], clipped: {label: string, over: number}[], blank: boolean}} Observation */

/**
 * Run inside the page. Returns one {@link Observation}.
 * @returns {any}
 */
export function probe() {
	const win = /** @type {any} */ (globalThis);
	const doc = win.document;
	const root = doc.documentElement;
	/** @type {(n: number) => number} */
	const round = (n) => Math.round(n * 100) / 100;

	/** `rgb(13, 27, 42)` / `rgba(…, a)` to `#rrggbb`. Null when fully transparent. */
	/** @param {any} value */
	function toHex(value) {
		const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(String(value ?? ''));
		if (!m || Number(m[4] ?? 1) === 0) return null;
		return `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}`;
	}

	/** The first opaque background up the tree — what text is really read against. */
	/** @param {any} el */
	function backdrop(el) {
		for (let node = el; node; node = node.parentElement) {
			const hex = toHex(win.getComputedStyle(node).backgroundColor);
			if (hex) return hex;
		}
		return toHex(win.getComputedStyle(doc.body).backgroundColor);
	}

	/** Text this element owns, not text it merely contains. */
	/** @param {any} el */
	function ownText(el) {
		let out = '';
		for (const node of el.childNodes) if (node.nodeType === 3) out += node.nodeValue ?? '';
		return out.trim();
	}

	/** @param {any} el @param {any} style */
	function isTappable(el, style) {
		const tag = el.tagName.toUpperCase();
		if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
		const role = String(el.getAttribute('role') ?? '');
		if (/^(button|link|tab|checkbox|switch|radio|menuitem)$/.test(role)) return true;
		// React Native Web renders Pressable as a focusable div; the cursor is
		// the only other signal that a plain box is meant to be tapped.
		return el.getAttribute('tabindex') !== null || style.cursor === 'pointer';
	}

	/** @param {any} el */
	function nameOf(el) {
		return (
			el.getAttribute('data-qa') ||
			el.getAttribute('aria-label') ||
			ownText(el).slice(0, 40) ||
			el.tagName.toLowerCase()
		);
	}

	const tappables = [];
	const texts = [];
	const clipped = [];
	let visible = 0;
	for (const el of doc.querySelectorAll('*')) {
		const style = win.getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
		const box = el.getBoundingClientRect();
		if (!box.width || !box.height) continue;
		const label = nameOf(el);
		const own = ownText(el);
		if (own) {
			visible += own.length;
			texts.push({
				label,
				size: round(Number.parseFloat(style.fontSize) || 0),
				weight: Number(style.fontWeight) || 400,
				fg: toHex(style.color),
				bg: backdrop(el),
			});
			// Text wider than its own box is text the layout could not hold —
			// which at an XL type step is the failure this whole tier exists for.
			if (el.scrollWidth > el.clientWidth + 1) clipped.push({ label, over: round(el.scrollWidth - el.clientWidth) });
		}
		if (isTappable(el, style)) tappables.push({ label, w: round(box.width), h: round(box.height), x: round(box.x), y: round(box.y) });
	}

	return {
		view: { w: root.clientWidth, h: root.clientHeight },
		overflowX: round(Math.max(0, root.scrollWidth - root.clientWidth)),
		tappables,
		texts,
		clipped,
		blank: visible === 0,
	};
}
