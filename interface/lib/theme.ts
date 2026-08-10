// Shared by the server reader and the client toggle, so it must not import next/headers and must
// not carry a 'use client' directive. Anything exported from a 'use client' module becomes a
// client reference on the server — importing the cookie name from ThemeToggle handed cookies().get
// an undefined key, and every request read as dark no matter what the reader had chosen.
export type Theme = 'dark' | 'light';
export const THEME_COOKIE = 'botid-theme';
