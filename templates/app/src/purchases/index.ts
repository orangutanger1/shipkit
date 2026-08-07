import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';

/**
 * The entitlement every paid feature checks. It must match the entitlement
 * identifier in the RevenueCat dashboard exactly — a typo here does not throw,
 * it just makes every user look free forever.
 */
export const ENTITLEMENT = 'pro';

/**
 * Configure RevenueCat once, before anything asks for entitlements.
 *
 * The key is public by design (it is an SDK key, not a secret), which is why it
 * rides in EXPO_PUBLIC_RC_IOS_KEY. When it is missing the SDK still "works" but
 * every offering comes back empty, so the paywall renders blank rather than
 * failing — warn loudly instead of letting that ship.
 */
export function initPurchases(): void {
	const apiKey = process.env.EXPO_PUBLIC_RC_IOS_KEY;
	if (!apiKey) {
		console.warn('EXPO_PUBLIC_RC_IOS_KEY missing, paywall will be empty');
		return;
	}
	Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.DEBUG : LOG_LEVEL.ERROR);
	Purchases.configure({ apiKey });
}

/** Current entitlement state. Never throws — offline must not mean "locked out loudly". */
export async function isPro(): Promise<boolean> {
	try {
		const info = await Purchases.getCustomerInfo();
		return info.entitlements.active[ENTITLEMENT] !== undefined;
	} catch {
		return false;
	}
}

/** Shows the paywall unless the user already has the entitlement. True == they now do. */
export async function presentPaywall(): Promise<boolean> {
	const result = await RevenueCatUI.presentPaywallIfNeeded({
		requiredEntitlementIdentifier: ENTITLEMENT,
	});
	return result === PAYWALL_RESULT.PURCHASED || result === PAYWALL_RESULT.RESTORED;
}

/**
 * Restore is not optional: App Review rejects any app with a purchase and no
 * visible way to restore one on a new device.
 */
export async function restore(): Promise<boolean> {
	const info = await Purchases.restorePurchases();
	return info.entitlements.active[ENTITLEMENT] !== undefined;
}
