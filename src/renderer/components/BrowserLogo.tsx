import type { ReactNode } from 'react';
import { siFirefoxbrowser } from 'simple-icons';
import { Icon } from './Icon';
import { Logo } from './Brand';

/** Browser publisher marks, kept in the bundle for offline use. */
export function BrowserLogo({ engine, size = 20 }: { engine: string; size?: number }): ReactNode {
  const key = engine.toLowerCase();
  if (key === 'joe') return <Logo size={size} />;
  if (['chrome', 'chromium', 'edge', 'brave'].includes(key)) {
    return <img src={`./brand/${key}.png`} width={size} height={size} alt="" style={{ objectFit: 'contain', flex: 'none' }} />;
  }
  if (key === 'firefox') return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ flex: 'none', fill: `#${siFirefoxbrowser.hex}` }}><path d={siFirefoxbrowser.path} /></svg>;
  return <Icon name="browsers" size={size} />;
}
