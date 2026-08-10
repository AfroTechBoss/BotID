import { cookies } from 'next/headers';
import { THEME_COOKIE, type Theme } from './theme';

// Server-side read of the chosen theme. Dark for anyone who has never touched the toggle, and for
// any cookie value that is not exactly 'light' — the attribute must never carry an arbitrary
// string from a request into the markup.
export function readTheme(): Theme {
  return cookies().get(THEME_COOKIE)?.value === 'light' ? 'light' : 'dark';
}
