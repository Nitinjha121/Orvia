/**
 * Generates `theme.css` from `src/tokens.ts`.
 * Emits `:root` and `[data-theme]` CSS variables, inline Tailwind `@theme` mappings,
 * and base styles so theme switching functions at runtime without CSS recompilation.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tokens, type ColorScale } from '../src/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const colorVars = (scale: ColorScale, indent = '  ') =>
  Object.entries(scale)
    .map(([k, v]) => `${indent}--orvia-color-${kebab(k)}: ${v};`)
    .join('\n');

const flatVars = (prefix: string, obj: Record<string, string>, indent = '  ') =>
  Object.entries(obj)
    .map(([k, v]) => `${indent}--orvia-${prefix}-${kebab(k)}: ${v};`)
    .join('\n');

const themeInline = [
  ...Object.keys(tokens.color.light).map(
    (k) => `  --color-${kebab(k)}: var(--orvia-color-${kebab(k)});`,
  ),
  '',
  ...Object.keys(tokens.radius).map((k) => `  --radius-${kebab(k)}: var(--orvia-radius-${kebab(k)});`),
  '',
  ...Object.keys(tokens.font).map((k) => `  --font-${kebab(k)}: var(--orvia-font-${kebab(k)});`),
  '',
  ...Object.keys(tokens.shadow).map((k) => `  --shadow-${kebab(k)}: var(--orvia-shadow-${kebab(k)});`),
  '',
  ...Object.keys(tokens.space).map((k) => `  --spacing-${kebab(k)}: var(--orvia-space-${kebab(k)});`),
  '',
  ...Object.keys(tokens.ease).map((k) => `  --ease-${kebab(k)}: var(--orvia-ease-${kebab(k)});`),
].join('\n');

const css = `/* ───────────────────────────────────────────────────────────────────────────
 *  GENERATED FILE — DO NOT EDIT.
 *  Source: packages/theme/src/tokens.ts
 *  Rebuild: pnpm theme:build
 * ─────────────────────────────────────────────────────────────────────────── */

@import "tailwindcss";

/* Dark mode is driven by an explicit attribute so the user can pin a theme,
   with prefers-color-scheme as the fallback when they have not chosen. */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

/* ── 1. Raw token variables ────────────────────────────────────────────────── */
:root {
${colorVars(tokens.color.light)}

${flatVars('radius', tokens.radius)}

${flatVars('font', tokens.font)}

${flatVars('space', tokens.space)}

${flatVars('shadow', tokens.shadow)}

${flatVars('duration', tokens.duration)}

${flatVars('ease', tokens.ease)}

${flatVars('chart', tokens.chart)}
}

:root[data-theme="dark"] {
${colorVars(tokens.color.dark)}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${colorVars(tokens.color.dark, '    ')}
  }
}

/* ── 2. Tailwind utility registration ──────────────────────────────────────── */
@theme inline {
${themeInline}
}

/* ── 3. Base ───────────────────────────────────────────────────────────────── */
@layer base {
  * { border-color: var(--orvia-color-border); }

  html { color-scheme: light dark; }

  body {
    background-color: var(--orvia-color-bg);
    color: var(--orvia-color-fg);
    font-family: var(--orvia-font-sans);
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  :focus-visible {
    outline: 2px solid var(--orvia-color-brand);
    outline-offset: 2px;
  }

  /* Selection gets its OWN colour, not brand-muted.
   *
   * brand-muted is a surface token, and the report's ideal-answer code block
   * paints its background with it — so selecting that code highlighted it in
   * the colour it already was: 1.00:1, invisible. On surface-alt blocks it was
   * 1.08:1, a tint you had to hunt for. Verified in Chromium in both themes.
   * A highlight has to differ from every surface it can land on, which is why
   * this is a dedicated token. */
  ::selection {
    background: var(--orvia-color-selection-bg);
    color: var(--orvia-color-selection-fg);
  }
}
`;

const out = resolve(here, '../theme.css');
writeFileSync(out, css, 'utf8');
console.log(`[theme] wrote ${out} (${css.length} bytes)`);
