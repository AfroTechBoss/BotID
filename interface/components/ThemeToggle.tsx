'use client';
import { useState } from 'react';
import { THEME_COOKIE, type Theme } from '@/lib/theme';

// The theme lives on <html data-theme> because that is what globals.css selects on, and it is put
// there by the server from the cookie this component writes. So the round trip is: click -> set
// the attribute for the current page, set the cookie for every page after it. A reload agrees
// with the toggle because both read the same cookie.
export default function ThemeToggle({ initial }: { initial: Theme }) {
  const [theme, setTheme] = useState<Theme>(initial);

  function apply(next: Theme) {
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    // A year, path=/ so it covers every route, Lax because nothing needs it cross-site. No
    // consent gate: this stores only what the reader just chose about how the page looks.
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }

  return (
    <span className="seg" style={{ fontSize: 11 }} role="group" aria-label="Colour theme">
      {(['dark', 'light'] as const).map((t) => (
        <label key={t} className="seg-opt" style={{ padding: '3px 9px', textTransform: 'capitalize' }}>
          <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => apply(t)} />
          {t}
        </label>
      ))}
    </span>
  );
}
