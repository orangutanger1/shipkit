import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { t } from '../src/i18n';
import { initPurchases } from '../src/purchases';
import { ThemeProvider } from '../src/theme/provider';
import { Screen, Text, Button } from '../src/theme/primitives';

export default function RootLayout() {
	// Configure before any screen can ask for entitlements: the SDK rejects
	// getCustomerInfo() outright until configure() has run at least once.
	useEffect(() => {
		initPurchases();
	}, []);

	return (
		<ThemeProvider>
			<StatusBar style="auto" />
			<Stack screenOptions={{ headerShown: false }} />
		</ThemeProvider>
	);
}

/**
 * Exported from the root layout, so a render error anywhere in the tree lands
 * here instead of on the white screen a release build shows by default — there
 * is no LogBox in TestFlight. `error.message` stays untranslated on purpose: it
 * is the one line that makes a user's bug report actionable.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	return (
		<Screen>
			<Text role="title">{t('error.title')}</Text>
			<Text role="body" color="textMuted">{error.message}</Text>
			<Button variant="secondary" onPress={retry}>{t('error.action.retry')}</Button>
		</Screen>
	);
}
