export { tokens, type Tokens, type ColorScale } from './tokens.js';
import { tokens } from './tokens.js';

/**
 * Read a semantic colour at runtime as a `var()` reference.
 * Use this anywhere Tailwind classes can't reach — canvas, chart libraries,
 * inline SVG fills — so charts stay theme-aware instead of hardcoding hexes.
 *
 *   <Line stroke={cssColor('brand')} />
 */
export function cssColor(name: keyof typeof tokens.color.light): string {
  const kebab = name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `var(--orvia-color-${kebab})`;
}

export type ThemeName = 'light' | 'dark' | 'system';

/** Applies (or clears) the theme attribute the generated CSS keys off. */
export function applyTheme(theme: ThemeName, root: HTMLElement = document.documentElement) {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
