// The QA contract's render half, and the only place the query parameters are
// read. `ship qa` drives the web build through routes with qaTheme/qaState/
// qaLocale/qaTextScale set; a build that ignores them captures the same screen
// N times and fails checkDarkMode and checkStates for a reason that is the
// app's fault, not the harness's.
import { createContext, useContext, type ReactNode } from 'react';
import { Platform, useColorScheme } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { tokens, type ThemeName } from './tokens';
import { sanitizeQa } from './qa-params';

const THEMES = Object.keys(tokens.color) as ThemeName[];

// expo-router honours these parameters over a deep link on native too, so an
// ungated release build would accept a URL that puts any screen into any state
// — a paywall in its success state included. Web is where QA runs; __DEV__ is
// where a developer needs them. A shipped IPA gets neither.
const QA_ENABLED = Platform.OS === 'web' || __DEV__;

export function useQa() {
	const params = useLocalSearchParams();
	return sanitizeQa(params, { enabled: QA_ENABLED, themes: THEMES });
}

const ThemeContext = createContext<ThemeName>('light');

export function ThemeProvider({ children }: { children: ReactNode }) {
	const system = useColorScheme();
	const { theme } = useQa();
	const active = (theme ?? system ?? 'light') as ThemeName;
	return <ThemeContext.Provider value={active}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
	const name = useContext(ThemeContext);
	const { scale } = useQa();
	return {
		name,
		colors: tokens.color[name],
		type: tokens.type,
		spacing: tokens.spacing,
		radii: tokens.radii,
		scale,
	};
}
