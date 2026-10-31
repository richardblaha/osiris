import { OSIRIS_THEME } from "./theme-tokens.ts";

export { OSIRIS_THEME };

/**
 * The OSIRIS palette, the clients' colors: richardblaha/osiris-theme's tokens of the release in
 * `packages/shared/theme/` (`OSIRIS_THEME`, generated with every PWA's `theme.css` by
 * `pnpm --filter @osiris/shared theme [<tag>]`). The TUI and the VS Code panel take them from here. VS Code 2026
 * shape: the status bar sits in the background colour (bg.sidebar), never in the accent, and there are no
 * pill-shaped corners anywhere (radius.sm = 4px).
 */
export interface ThemeColors {
  bgTitlebar: string;
  bgSidebar: string;
  bgEditor: string;
  bgTabInactive: string;
  bgStatusbar: string;
  bgStatusbarText: string;
  bgHover: string;
  bgSelection: string;
  bgInput: string;
  borderSubtle: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  scrollbar: string;
  accentPrimary: string;
  accentSecondary: string;
  stateInfo: string;
  stateSuccess: string;
  stateWarning: string;
  stateError: string;
}

const colors = (s: "light" | "dark"): ThemeColors => {
  const { bg, border, text, scrollbar } = OSIRIS_THEME.themes[s];
  const { accent, state } = OSIRIS_THEME;
  return {
    bgTitlebar: bg.titlebar,
    bgSidebar: bg.sidebar,
    bgEditor: bg.editor,
    bgTabInactive: bg.tabInactive,
    bgStatusbar: bg.statusbar,
    bgStatusbarText: bg.statusbarText,
    bgHover: bg.hover,
    bgSelection: bg.selection,
    bgInput: bg.input,
    borderSubtle: border.subtle,
    borderStrong: border.strong,
    textPrimary: text.primary,
    textSecondary: text.secondary,
    textMuted: text.muted,
    textInverse: text.inverse,
    scrollbar,
    accentPrimary: accent.primary[s],
    accentSecondary: accent.secondary[s],
    stateInfo: state.info[s],
    stateSuccess: state.success[s],
    stateWarning: state.warning[s],
    stateError: state.error[s],
  };
};

export const THEME: Record<"light" | "dark", ThemeColors> = { light: colors("light"), dark: colors("dark") };

/** `bgTitlebar` → `--bg-titlebar`, the CSS variable of a token. */
export const cssVar = (token: keyof ThemeColors) => `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
