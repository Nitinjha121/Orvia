/**
 * Design tokens defining colors, radii, typography, and motion parameters.
 * CSS variables are generated via `pnpm theme:build`.
 * Palettes are calibrated for accessibility and color-vision deficiency contrast.
 */

/** Semantic colour roles. Both themes MUST define every key. */
export type ColorScale = {
  /** App background, furthest back */
  bg: string;
  /** Raised panels, cards */
  surface: string;
  /** Nested / secondary surfaces */
  surfaceAlt: string;
  /** Hover state for interactive surfaces */
  surfaceHover: string;

  /** Default hairline border */
  border: string;
  /** Emphasised border, focus outlines */
  borderStrong: string;

  /** Primary text */
  fg: string;
  /** Secondary text, labels */
  fgMuted: string;
  /** Tertiary text, timestamps, hints */
  fgSubtle: string;

  /**
   * Text selection. Explicit because the browser default is a pale blue chosen
   * against a white page, and it disappears on the code blocks in the report —
   * measured invisible on `brandMuted` and barely a tint on `surfaceAlt`, in
   * both themes. Held above 1.8:1 against both of those backgrounds so the
   * highlight reads as a highlight, while keeping text on it above 4.5:1.
   */
  selectionBg: string;
  selectionFg: string;

  /** Primary action colour */
  brand: string;
  /** Text/icon placed on top of `brand` */
  brandFg: string;
  /** Low-emphasis brand tint (badges, selected rows) */
  brandMuted: string;

  /** "Recording / session is live" — deliberately distinct from danger */
  live: string;
  liveMuted: string;

  /** Verdicts + scoring. Validated as a set — see the note on `tokens`. */
  success: string;
  successMuted: string;
  warning: string;
  warningMuted: string;
  danger: string;
  dangerMuted: string;
  info: string;
  infoMuted: string;

  /** Interview speaker attribution */
  speakerAi: string;
  speakerUser: string;
};

const light: ColorScale = {
  bg: '#fbfbfd',
  surface: '#ffffff',
  surfaceAlt: '#f4f5f8',
  surfaceHover: '#eceef3',

  border: '#e3e5ec',
  borderStrong: '#c7cbd6',

  fg: '#14161c',
  fgMuted: '#5a6070',
  fgSubtle: '#8b91a1',

  // vs surfaceAlt 2.14:1, vs brandMuted 1.98:1, text on it 7.76:1
  selectionBg: '#93a5fb',
  selectionFg: '#14161c',

  brand: '#4f46e5',
  brandFg: '#ffffff',
  brandMuted: '#ecebfd',

  live: '#e0245e',
  liveMuted: '#fdeaf0',

  success: '#0f8a5f',
  successMuted: '#e3f6ee',
  warning: '#c2820a',
  warningMuted: '#fdf1dd',
  danger: '#d1242f',
  dangerMuted: '#fceceb',
  info: '#1f6feb',
  infoMuted: '#e7f0fe',

  speakerAi: '#4f46e5',
  speakerUser: '#0f8a5f',
};

const dark: ColorScale = {
  bg: '#0b0c10',
  surface: '#131519',
  surfaceAlt: '#1b1e24',
  surfaceHover: '#23272f',

  border: '#272b33',
  borderStrong: '#3c424e',

  fg: '#eef0f4',
  fgMuted: '#a2a9b8',
  fgSubtle: '#6e7686',

  // vs surfaceAlt 2.53:1, vs brandMuted 2.48:1, text on it 5.79:1
  selectionBg: '#514cc4',
  selectionFg: '#eef0f4',

  brand: '#6d63e8',
  brandFg: '#ffffff',
  brandMuted: '#1e1c3a',

  live: '#ff5c8a',
  liveMuted: '#2e1420',

  success: '#19a271',
  successMuted: '#0f2b21',
  warning: '#c08812',
  warningMuted: '#2e2413',
  danger: '#ec5c72',
  dangerMuted: '#2e1817',
  info: '#5c9dff',
  infoMuted: '#111f36',

  speakerAi: '#6d63e8',
  speakerUser: '#19a271',
};

export const tokens = {
  color: { light, dark },

  radius: {
    xs: '4px',
    sm: '6px',
    md: '10px',
    lg: '14px',
    xl: '20px',
    full: '9999px',
  },

  font: {
    sans: "'InterVariable', Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
  },

  /**
   * Chart-specific values. Marks stay thin and chrome stays recessive so the
   * data is the only loud thing on the page.
   */
  chart: {
    lineWidth: '2px',
    markerRadius: '4px',
    /** Hairline, solid — never dashed; dashing reads as "projection". */
    gridWidth: '1px',
    areaOpacity: '0.10',
    /** Surface-coloured gap that separates touching marks. */
    markGap: '2px',
  },

  /** Vertical rhythm beyond Tailwind's default 4px scale */
  space: {
    gutter: '1.25rem',
    section: '2.5rem',
  },

  shadow: {
    sm: '0 1px 2px 0 rgb(0 0 0 / 0.06)',
    md: '0 4px 14px -2px rgb(0 0 0 / 0.10)',
    lg: '0 18px 40px -12px rgb(0 0 0 / 0.22)',
    /** Glow ring around the live orb while the AI is speaking */
    live: '0 0 0 6px var(--orvia-color-live-muted), 0 0 28px -4px var(--orvia-color-live)',
  },

  duration: {
    fast: '120ms',
    base: '200ms',
    slow: '380ms',
  },

  ease: {
    out: 'cubic-bezier(0.22, 1, 0.36, 1)',
    inOut: 'cubic-bezier(0.65, 0, 0.35, 1)',
  },
} as const;

export type Tokens = typeof tokens;
