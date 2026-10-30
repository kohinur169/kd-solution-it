// path: components/providers/theme-provider.tsx
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  applyThemeClass,
  DEFAULT_THEME_PREFERENCE,
  readStoredPreference,
  readSystemTheme,
  subscribeToStoredPreference,
  subscribeToSystemTheme,
  writeStoredPreference,
  type ResolvedTheme,
  type ThemePreference,
} from "./theme";

/**
 * The theme provider.
 *
 * The class on `<html>` is applied before the first paint by the script in `app/layout.tsx` and
 * afterwards by the effect below, so a stored choice survives a page load without a flash and a
 * change applies to the whole tree immediately.
 *
 * Two external values feed the provider through `useSyncExternalStore`:
 *   - the stored preference, which also changes in another tab;
 *   - the operating system theme, which matters while the preference is `system`.
 *
 * That primitive is what makes the server render (`system`) and the hydrated client agree: React
 * uses the server snapshot for the first client render and swaps in the real value afterwards,
 * with no `setState` in an effect and therefore no cascading render.
 */

export interface ThemeContextValue {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  const preference = useSyncExternalStore(
    subscribeToStoredPreference,
    readStoredPreference,
    () => DEFAULT_THEME_PREFERENCE,
  );

  const systemTheme = useSyncExternalStore(
    subscribeToSystemTheme,
    readSystemTheme,
    (): ResolvedTheme => "light",
  );

  // The one place the document is changed: an effect may synchronise an external system, which
  // is exactly what applying a class to `<html>` is.
  useEffect(() => {
    applyThemeClass(preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference): void => {
    writeStoredPreference(next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme: preference === "system" ? systemTheme : preference,
      setPreference,
    }),
    [preference, systemTheme, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Reads the theme context.
 *
 * Throws outside the provider on purpose: a component that silently received a default would
 * render a switcher that never changes anything.
 */
export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (value === undefined) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }

  return value;
}
