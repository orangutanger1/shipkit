import { useEffect, useState } from 'react';
import Purchases, { type CustomerInfo } from 'react-native-purchases';
import { ENTITLEMENT } from './index';

/**
 * Live entitlement state for the UI.
 *
 * The update listener fires on purchase, restore and renewal — but not on
 * mount, so the initial read has to happen separately or an existing subscriber
 * sees the upgrade button for the whole first session.
 */
export function useIsPro(): boolean {
	const [isPro, setIsPro] = useState(false);

	useEffect(() => {
		let alive = true;
		Purchases.getCustomerInfo()
			.then((info) => {
				if (alive) setIsPro(info.entitlements.active[ENTITLEMENT] !== undefined);
			})
			.catch(() => {
				// Offline or unconfigured: stay false, the paywall will say so.
			});

		const listener = (info: CustomerInfo) =>
			setIsPro(info.entitlements.active[ENTITLEMENT] !== undefined);
		Purchases.addCustomerInfoUpdateListener(listener);
		return () => {
			alive = false;
			Purchases.removeCustomerInfoUpdateListener(listener);
		};
	}, []);

	return isPro;
}
