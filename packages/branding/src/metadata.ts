/** Single source of truth for Osiris product identity, colours and links. */

export interface OsirisColors {
  /** Primary accent (cyan). */
  accent: string;
  /** Secondary accent (magenta). */
  accentAlt: string;
  backgroundDark: string;
  backgroundLight: string;
  foregroundDark: string;
  foregroundLight: string;
  error: string;
  warning: string;
  success: string;
}

export interface OsirisMetadata {
  productName: string;
  productNameLong: string;
  applicationName: string;
  bundleId: string;
  urlProtocol: string;
  version: string;
  colors: OsirisColors;
  fonts: {
    editor: string;
    ui: string;
  };
  links: {
    homepage: string;
    repository: string;
    issues: string;
    marketplace: string;
  };
}

export const metadata: OsirisMetadata = {
  productName: 'Osiris',
  productNameLong: 'Osiris IDE',
  applicationName: 'osiris',
  bundleId: 'io.osiris.ide',
  urlProtocol: 'osiris',
  version: '0.1.0',
  colors: {
    accent: '#00FFFF',
    accentAlt: '#FF00FF',
    backgroundDark: '#121212',
    backgroundLight: '#f5f5f5',
    foregroundDark: '#e0e0e0',
    foregroundLight: '#121212',
    error: '#FF0000',
    warning: '#FFBF00',
    success: '#00FF00',
  },
  fonts: {
    editor: "'Fira Code', 'Cascadia Code', Consolas, 'Droid Sans Mono', monospace",
    ui: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Ubuntu', 'Droid Sans', sans-serif",
  },
  links: {
    homepage: 'https://osiris-ide.org',
    repository: 'https://github.com/osiris-ide/osiris',
    issues: 'https://github.com/osiris-ide/osiris/issues',
    marketplace: 'https://open-vsx.org',
  },
};
