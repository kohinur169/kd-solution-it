// path: components/ui/theme-toggle.tsx
"use client";

import type { ReactNode } from "react";
import { THEME_PREFERENCES, type ThemePreference } from "@/components/providers/theme";
import { useTheme } from "@/components/providers/theme-provider";
import { getMessage, type MessagePath } from "@/lib/i18n/messages";

/**
 * The theme switcher.
 *
 * Three real buttons in a labelled group, so the control is one Tab stop per option, works with
 * Enter and Space for free, and announces its state through `aria-pressed` instead of relying on
 * colour alone. Every label comes from the string catalog: the switcher is user facing.
 *
 * The server renders `System` as pressed. The provider adopts the stored choice after hydration,
 * so the markup the browser hydrates matches the markup the server sent.
 */

const labelKeys: Readonly<Record<ThemePreference, MessagePath>> = {
  system: "shell.themeSystem",
  light: "shell.themeLight",
  dark: "shell.themeDark",
};

const groupClasses =
  "flex items-center gap-1 rounded-pill border border-border bg-background p-1";

const optionBaseClasses =
  "rounded-pill px-3 py-1 text-xs font-semibold transition-colors";

const activeOptionClasses = `${optionBaseClasses} bg-primary text-primary-foreground`;

const inactiveOptionClasses = `${optionBaseClasses} text-muted-foreground hover:text-foreground`;

export function ThemeToggle(): ReactNode {
  const { preference, setPreference } = useTheme();

  return (
    <div role="group" aria-label={getMessage("shell.themeLabel")} className={groupClasses}>
      {THEME_PREFERENCES.map((option) => {
        const isActive = option === preference;

        return (
          <button
            key={option}
            type="button"
            aria-pressed={isActive}
            className={isActive ? activeOptionClasses : inactiveOptionClasses}
            onClick={() => {
              setPreference(option);
            }}
          >
            {getMessage(labelKeys[option])}
          </button>
        );
      })}
    </div>
  );
}
