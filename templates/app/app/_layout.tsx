import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { initPurchases } from '../src/purchases';

export default function RootLayout() {
	// Configure before any screen can ask for entitlements: the SDK rejects
	// getCustomerInfo() outright until configure() has run at least once.
	useEffect(() => {
		initPurchases();
	}, []);

	return (
		<>
			<StatusBar style="auto" />
			<Stack screenOptions={{ headerShown: false }} />
		</>
	);
}
