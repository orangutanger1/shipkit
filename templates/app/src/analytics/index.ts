// The seam an SDK plugs into. `track` accepts only events design/ux.json
// declares, because src/analytics/events.ts is generated from it — so an event
// nobody specified is a typecheck error rather than a string no funnel joins.
import type { AppEvent } from './events';

export function track(event: AppEvent, props?: Record<string, string | number | boolean>) {
	if (__DEV__) console.log('[analytics]', event, props ?? {});
	// Wire your SDK here. The event vocabulary is fixed by design/ux.json and
	// `ship analytics` reads the same names.
}
