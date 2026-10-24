import { THEME, type ThemeColors } from "@osiris/shared/theme.ts";

/**
 * The PWA's palette in the terminal (Ink turns hex into the colors the terminal has: truecolor, 256 or 16). Light or
 * dark: `--theme`, else the terminal's background from COLORFGBG ("15;0" is light text on black), else dark.
 */
export function pickTheme(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): ThemeColors {
  const asked = argv.find((a) => a.startsWith("--theme="))?.slice(8);
  if (asked === "light" || asked === "dark") return THEME[asked];
  const bg = Number(env.COLORFGBG?.split(";").at(-1));
  return Number.isFinite(bg) && (bg === 7 || bg >= 9) ? THEME.light : THEME.dark;
}

export type { ThemeColors };
