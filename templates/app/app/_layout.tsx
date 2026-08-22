import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '../src/i18n';
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

/**
 * Exported from the root layout, so a render error anywhere in the tree lands
 * here instead of on the white screen a release build shows by default — there
 * is no LogBox in TestFlight. `error.message` stays untranslated on purpose: it
 * is the one line that makes a user's bug report actionable.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
	return (
		<View style={styles.screen}>
			<Text style={styles.title}>{t('error.title')}</Text>
			<Text style={styles.detail}>{error.message}</Text>
			<Pressable accessibilityRole="button" onPress={retry} style={styles.retry}>
				<Text style={styles.retryLabel}>{t('error.action.retry')}</Text>
			</Pressable>
		</View>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F1113', padding: 32, gap: 12 },
	title: { color: '#F6F7F8', fontSize: 22, fontWeight: '600' },
	detail: { color: '#9AA3AB', fontSize: 14, textAlign: 'center' },
	retry: { paddingVertical: 12 },
	retryLabel: { color: '#3D7BFF', fontSize: 16, fontWeight: '600' },
});
