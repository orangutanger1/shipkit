// The four components design/components.json describes. Generated screens
// compose these and nothing else, which is what lets `ship design review` gate
// styling: a screen that builds its own StyleSheet never mentions a token, so
// it would never trip a token rule.
import type { ReactNode } from 'react';
import { Pressable, SafeAreaView, ScrollView, Text as RNText, View } from 'react-native';
import { useTheme } from './provider';
import type { ColorToken, TypeRole } from './tokens';

export function Screen({ children, scroll = false }: { children: ReactNode; scroll?: boolean }) {
	const { colors, spacing } = useTheme();
	const inner = <View style={{ flex: 1, padding: spacing[5], gap: spacing[3] }}>{children}</View>;
	return (
		<SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
			{scroll ? <ScrollView>{inner}</ScrollView> : inner}
		</SafeAreaView>
	);
}

export function Text({ role = 'body', color = 'text', children }: {
	role?: TypeRole; color?: ColorToken; children: ReactNode;
}) {
	const { colors, type, scale } = useTheme();
	const step = type[role];
	return (
		<RNText style={{
			color: colors[color],
			fontSize: step.size * scale,
			lineHeight: step.lineHeight * scale,
			fontWeight: step.weight,
		}}>
			{children}
		</RNText>
	);
}

const FILL: Record<string, ColorToken> = { primary: 'accent', secondary: 'surface', destructive: 'danger' };
const LABEL: Record<string, ColorToken> = { primary: 'accentText', secondary: 'text', destructive: 'textInverse' };

export function Button({ variant = 'primary', disabled = false, onPress, children }: {
	variant?: 'primary' | 'secondary' | 'destructive';
	disabled?: boolean;
	onPress?: () => void;
	children: ReactNode;
}) {
	const { colors, spacing, radii, type, scale } = useTheme();
	return (
		<Pressable
			accessibilityRole="button"
			accessibilityState={{ disabled }}
			disabled={disabled}
			onPress={onPress}
			style={({ pressed }) => ({
				backgroundColor: colors[FILL[variant]],
				borderColor: colors.border,
				borderWidth: variant === 'secondary' ? 1 : 0,
				borderRadius: radii.md,
				paddingVertical: spacing[3],
				paddingHorizontal: spacing[4],
				// 44pt is the HIG minimum tap target, and `ship qa` measures it.
				minHeight: 44,
				alignItems: 'center',
				justifyContent: 'center',
				opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
			})}
		>
			<RNText style={{
				color: colors[LABEL[variant]],
				fontSize: type.headline.size * scale,
				lineHeight: type.headline.lineHeight * scale,
				fontWeight: type.headline.weight,
			}}>
				{children}
			</RNText>
		</Pressable>
	);
}

const STATE_COPY: Record<string, string> = {
	empty: 'Nothing here yet.',
	loading: 'Loading…',
	error: 'Something went wrong.',
	offline: 'You are offline.',
};

export function StateView({ kind }: { kind: 'empty' | 'loading' | 'error' | 'offline' }) {
	const { colors, spacing } = useTheme();
	return (
		<View style={{
			flex: 1, alignItems: 'center', justifyContent: 'center',
			padding: spacing[5], backgroundColor: colors.background,
		}}>
			<Text role="body" color="textMuted">{STATE_COPY[kind]}</Text>
		</View>
	);
}
