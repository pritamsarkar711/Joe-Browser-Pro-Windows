import { createTheme } from '@mui/material/styles';

/**
 * The Material theme, aligned to the application tokens in styles.css.
 *
 * One primary colour everywhere - the same cobalt the shell uses - flat surfaces, an 8px rhythm,
 * a smaller radius than Material's default, and the IBM Plex Sans stack. No gradients are
 * introduced here or anywhere else: elevation is drawn with solid surfaces and hairlines.
 *
 * The colours are READ from the stylesheet rather than copied into this file. A second copy of
 * the palette is a second palette: the day one of them is edited and the other is not, the
 * dialog says one thing and the page says another, and nobody can tell which one is right.
 * `styles.css` owns the tokens; this file asks the document what they currently are.
 */

export const PRIMARY = '#2f6bde';

/**
 * The value of a custom property on the document root.
 *
 * The theme is rebuilt whenever the mode changes, so it reads the values that are live at that
 * moment - the dark set before the switch, the light set after it.
 */
function token(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const shared = {
  shape: { borderRadius: 6 },
  spacing: 8,
  typography: {
    fontFamily: `'IBM Plex Sans', sans-serif`,
    fontSize: 14,
    button: { textTransform: 'none' as const, fontWeight: 600 },
  },
};

export function muiTheme(mode: 'dark' | 'light') {
  const dark = mode === 'dark';
  const accent = token('--accent', PRIMARY);
  return createTheme({
    ...shared,
    palette: {
      mode,
      // The status colours come from the stylesheet for the same reason the rest do: a failed
      // leak test must not render in the brand blue, or "it failed" and "it passed" look alike.
      success: { main: token('--ok', '#4ec38a') },
      warning: { main: token('--warn', '#f2a81b') },
      error: { main: token('--err', '#f26d76') },
      info: { main: token('--info', '#6ba8f5') },
      primary: {
        main: accent,
        light: token('--accent-hi', '#4f86ee'),
        dark: token('--accent-lo', '#2457b8'),
        contrastText: token('--on-accent', '#ffffff'),
      },
      background: {
        default: token('--bg', dark ? '#0e1014' : '#f6f7fa'),
        paper: token('--panel', dark ? '#171a20' : '#ffffff'),
      },
      divider: token('--line', dark ? '#262c36' : '#e1e6ef'),
      text: {
        primary: token('--text', dark ? '#eef1f6' : '#10151d'),
        secondary: token('--text-2', dark ? '#b9c1ce' : '#414d61'),
      },
    },
    components: {
      MuiCssBaseline: { styleOverrides: { html: { backgroundColor: 'var(--bg)' }, body: { backgroundColor: 'var(--bg)', color: 'var(--text)' } } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 6, fontWeight: 600, boxShadow: 'none' },
          sizeLarge: { height: 42 },
          sizeMedium: { height: 36 },
        },
      },
      MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiCard: { styleOverrides: { root: { backgroundImage: 'none', borderRadius: 10 } } },
      MuiDialog: {
        styleOverrides: { paper: { backgroundImage: 'none', borderRadius: 12 } },
      },
      MuiTextField: { defaultProps: { size: 'small' } },
      MuiTableCell: {
        styleOverrides: { root: { paddingTop: 10, paddingBottom: 10 } },
      },
      MuiChip: { styleOverrides: { root: { borderRadius: 6 } } },
    },
  });
}
