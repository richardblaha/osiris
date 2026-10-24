/**
 * The OSIRIS palette (richardblaha/osiris-theme, tokens.json v0.1.3), the one source of the clients' colors: the PWA's
 * `theme.css` holds the same values (a test checks it), the TUI and the VS Code panel take them from here.
 */
export interface ThemeColors {
  bgTitlebar: string;
  bgSidebar: string;
  bgEditor: string;
  bgTabInactive: string;
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

export const THEME: Record<"light" | "dark", ThemeColors> = {
  light: {
    bgTitlebar: "#ffffff",
    bgSidebar: "#f6f8fa",
    bgEditor: "#ffffff",
    bgTabInactive: "#eaeef2",
    bgHover: "#eaeef2",
    bgSelection: "#dde7f3",
    bgInput: "#ffffff",
    borderSubtle: "#eaeef2",
    borderStrong: "#d0d7de",
    textPrimary: "#1f2328",
    textSecondary: "#57606a",
    textMuted: "#8c959f",
    textInverse: "#ffffff",
    scrollbar: "#d0d7de",
    accentPrimary: "#0969da",
    accentSecondary: "#e01a76",
    stateInfo: "#0969da",
    stateSuccess: "#1a7f37",
    stateWarning: "#9a6700",
    stateError: "#cf222e",
  },
  dark: {
    bgTitlebar: "#0d1117",
    bgSidebar: "#161b22",
    bgEditor: "#0d1117",
    bgTabInactive: "#161b22",
    bgHover: "#21262d",
    bgSelection: "#21262d",
    bgInput: "#21262d",
    borderSubtle: "#21262d",
    borderStrong: "#30363d",
    textPrimary: "#e6edf3",
    textSecondary: "#8b949e",
    textMuted: "#565f6d",
    textInverse: "#04151a",
    scrollbar: "#30363d",
    accentPrimary: "#00f2fe",
    accentSecondary: "#ff2a85",
    stateInfo: "#00f2fe",
    stateSuccess: "#3fb950",
    stateWarning: "#d29922",
    stateError: "#ff5555",
  },
};

/** `bgTitlebar` → `--bg-titlebar`, the CSS variable of a token. */
export const cssVar = (token: keyof ThemeColors) => `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
