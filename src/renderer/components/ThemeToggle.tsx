import { useCallback, type ReactNode } from 'react';
import DarkMode from '@mui/icons-material/DarkMode';
import LightMode from '@mui/icons-material/LightMode';

/** Switch the application theme without reloading the workspace. */

export function ThemeToggle({
  theme,
  onChange,
}: {
  theme: 'dark' | 'light';
  onChange: (next: 'dark' | 'light') => void;
}): ReactNode {
  const dark = theme === 'dark';

  const toggle = useCallback(() => {
    onChange(dark ? 'light' : 'dark');
  }, [dark, onChange]);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      data-mode={theme}
      className="theme-toggle"
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      onClick={toggle}
    >
      <span className="tt-glyph tt-sun" aria-hidden="true"><LightMode sx={{ fontSize: 13 }} /></span>
      <span className="tt-glyph tt-moon" aria-hidden="true"><DarkMode sx={{ fontSize: 13 }} /></span>
      <span className="tt-knob" aria-hidden="true">
        {dark ? <DarkMode sx={{ fontSize: 14 }} /> : <LightMode sx={{ fontSize: 14 }} />}
      </span>
    </button>
  );
}
