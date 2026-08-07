import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { presentPaywall, restore } from '../src/purchases';
import { useIsPro } from '../src/purchases/useIsPro';

export default function Home() {
	const isPro = useIsPro();
	const [busy, setBusy] = useState(false);

	// presentPaywall rejects when RevenueCat is unconfigured, which is the normal
	// state before the first `eas build` — swallow it so the screen stays usable.
	const guard = (fn: () => Promise<unknown>) => async () => {
		if (busy) return;
		setBusy(true);
		try {
			await fn();
		} catch (err) {
			console.warn(err);
		} finally {
			setBusy(false);
		}
	};

	return (
		<SafeAreaView style={styles.screen}>
			<View style={styles.body}>
				<Text style={styles.title}>__NAME__</Text>
				<Text style={styles.subtitle}>
					{isPro ? 'Pro unlocked. Everything is yours.' : 'The free tier. There is more.'}
				</Text>

				{isPro ? null : (
					<Pressable
						accessibilityRole="button"
						style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
						onPress={guard(presentPaywall)}
					>
						<Text style={styles.buttonLabel}>{busy ? 'One moment…' : 'Upgrade to Pro'}</Text>
					</Pressable>
				)}

				<Pressable accessibilityRole="button" onPress={guard(restore)} style={styles.link}>
					<Text style={styles.linkLabel}>Restore purchases</Text>
				</Pressable>
			</View>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1, backgroundColor: '#0F1113' },
	body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
	title: { color: '#F6F7F8', fontSize: 34, fontWeight: '700', letterSpacing: -0.5 },
	subtitle: { color: '#9AA3AB', fontSize: 16, textAlign: 'center', marginBottom: 20 },
	button: {
		backgroundColor: '#3D7BFF',
		paddingVertical: 14,
		paddingHorizontal: 28,
		borderRadius: 14,
		minWidth: 220,
		alignItems: 'center',
	},
	buttonPressed: { opacity: 0.75 },
	buttonLabel: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
	link: { paddingVertical: 12 },
	linkLabel: { color: '#6B7480', fontSize: 14 },
});
