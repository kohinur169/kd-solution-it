// path: components/providers/theme.ts

/**
 * Theme constants shared by the pre-paint script and the React provider.
 *
 * The script in `app/layout.tsx` and the provider in `theme-provider.tsx` must agree about three
 * things: where the preference is stored, which values are legal, and which class describes each
 * one. Keeping them in a single module means the two cannot drift, and the script text is built
 * from the same constants rather than repeating them as string literals.
 *
 * `applyThemeClass` is browser only: it touches `document`. It is called from a client component
 * effect and from the inline script, never during server rendering.
 */

/** The single storage key for the theme preference. */
export const THEME_STORAGE_KEY = "kd-solution-it.theme";

/** The legal preferences, in the order the switcher shows them. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The theme actually painted: a forced choice, or what the operating system reports. */
export type ResolvedTheme = "light" | "dark";

/** The default when nothing is stored. The operating system decides until a choice is made. */
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "system";

/** True when the value is one of the three preferences. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * Parses a stored value. Anything unrecognised falls back to `system`, so a hand edited or
 * corrupted `localStorage` entry cannot leave the document without a theme.
 */
export function parseThemePreference(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME_PREFERENCE;
}

/**
 * Applies a preference to the document.
 *
 * The class goes on `<html>`, because `.light` and `.dark` in `styles/tokens.css` set
 * `color-scheme`, and `color-scheme` on the root element is what makes every `light-dark()` token
 * resolve, including in form controls and scrollbars. `system` removes the class and clears the
 * inline style so the stylesheet's `light dark` declaration applies again.
 */
export function applyThemeClass(preference: ThemePreference): void {
  const root = document.documentElement;

  root.classList.remove("light", "dark");

  if (preference === "system") {
    root.style.colorScheme = "";
    return;
  }

  root.classList.add(preference);
  root.style.colorScheme = preference;
}

/**
 * The pre-paint script.
 *
 * It runs in `<head>` before the first paint, so a stored `dark` preference never flashes a
 * light page. It is deliberately small and wrapped in `try`/`catch`: a browser that blocks
 * `localStorage` (private mode, a strict policy) must still render the document, and the
 * provider will apply the operating system theme a moment later.
 *
 * STEP 059 adds the nonce based Content Security Policy; that STEP adds the `nonce` attribute to
 * the script element in `app/layout.tsx`, and this text does not change.
 */
export const THEME_SCRIPT = `(function(){try{var key=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var stored=window.localStorage.getItem(key);if(stored==="light"||stored==="dark"){var root=document.documentElement;root.classList.remove("light","dark");root.classList.add(stored);root.style.colorScheme=stored;}}catch(error){void error;}})();`;

/**
 * The theme preference as an external store.
 *
 * `useSyncExternalStore` is the right primitive here: the stored value lives outside React, it
 * can change in another tab, and the server has no `localStorage` at all. The server snapshot is
 * `system`, the client snapshot is the stored value, and React reconciles the two after
 * hydration without a mismatch warning and without a `setState` inside an effect.
 *
 * Browser only: every function below touches `window`, so it is called from a client component
 * and never during server rendering.
 */

const preferenceListeners = new Set<() => void>();

function notifyPreferenceListeners(): void {
  for (const listener of preferenceListeners) {
    listener();
  }
}

/** The stored preference, or the default when storage is blocked or empty. */
export function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

/** Stores a preference and notifies this document, which a `storage` event would not do. */
export function writeStoredPreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The choice still applies to this document; only the memory of it is lost.
  }

  notifyPreferenceListeners();
}

/** Subscribes to this document and to other tabs. */
export function subscribeToStoredPreference(onStoreChange: () => void): () => void {
  preferenceListeners.add(onStoreChange);

  const applyStoredPreference = (event: StorageEvent): void => {
    if (event.key === THEME_STORAGE_KEY) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", applyStoredPreference);

  return () => {
    preferenceListeners.delete(onStoreChange);
    window.removeEventListener("storage", applyStoredPreference);
  };
}

const darkSchemeQuery = "(prefers-color-scheme: dark)";

/** The theme the operating system currently reports. */
export function readSystemTheme(): ResolvedTheme {
  return window.matchMedia(darkSchemeQuery).matches ? "dark" : "light";
}

/** Subscribes to an operating system theme change. */
export function subscribeToSystemTheme(onStoreChange: () => void): () => void {
  const query = window.matchMedia(darkSchemeQuery);

  query.addEventListener("change", onStoreChange);

  return () => {
    query.removeEventListener("change", onStoreChange);
  };
}
