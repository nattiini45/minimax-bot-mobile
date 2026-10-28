/**
 * MiniMax Bot design tokens.
 *
 * Every value here is taken from the official MiniMax Bot product skin
 * (`miniapp/client/app.css`, which states: "visual language follows DS Bot's team
 * surface, adapted to MiniMax Code"). The React Native theme in `index.ts` is generated
 * from this file, so the native app and the desktop Mini App stay in step.
 */

export interface ThemeColors {
  bg: string;
  sidebar: string;
  surface: string;
  bubble: string;
  user: string;
  userInk: string;
  ink: string;
  muted: string;
  subtle: string;
  line: string;
  lineStrong: string;
  hover: string;
  active: string;
  tag: string;
  star: string;
  danger: string;
  success: string;
  warning: string;
  scrim: string;
  shadowPop: string;
  shadowPill: string;
  ring: string;
}

export const LIGHT_COLORS: ThemeColors = {
  bg: '#fcfcfc',
  sidebar: '#f7f7f7',
  surface: '#ffffff',
  bubble: '#efefef',
  user: '#0a0a0a',
  userInk: '#fcfcfc',
  ink: '#141414',
  muted: '#6e6e6e',
  subtle: '#a1a1a1',
  line: 'rgba(20, 20, 20, 0.08)',
  lineStrong: 'rgba(20, 20, 20, 0.16)',
  hover: 'rgba(119, 119, 119, 0.09)',
  active: 'rgba(119, 119, 119, 0.16)',
  tag: 'rgba(20, 20, 20, 0.06)',
  star: '#ff9800',
  danger: '#e5323f',
  success: '#12a150',
  warning: '#e46a12',
  scrim: 'rgba(10, 10, 10, 0.28)',
  shadowPop: '0 8px 28px -6px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.05)',
  shadowPill: '0 2px 8px -1px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)',
  ring: '#f7f7f7',
};

export const DARK_COLORS: ThemeColors = {
  bg: '#141414',
  sidebar: '#1b1b1b',
  surface: '#1f1f1f',
  bubble: '#262626',
  user: '#f2f2f2',
  userInk: '#141414',
  ink: '#f2f2f2',
  muted: '#9a9a9a',
  subtle: '#6b6b6b',
  line: 'rgba(255, 255, 255, 0.08)',
  lineStrong: 'rgba(255, 255, 255, 0.16)',
  hover: 'rgba(160, 160, 160, 0.12)',
  active: 'rgba(160, 160, 160, 0.2)',
  tag: 'rgba(255, 255, 255, 0.09)',
  star: '#ff9800',
  danger: '#f05561',
  success: '#2fc06b',
  warning: '#f08a3c',
  scrim: 'rgba(10, 10, 10, 0.5)',
  shadowPop: '0 10px 32px -6px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3)',
  shadowPill: '0 2px 10px -1px rgba(0, 0, 0, 0.5)',
  ring: '#1b1b1b',
};

/** Radii observed in the skin. */
export const RADIUS = {
  xs: 5,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 14,
  card: 14,
  bubble: 18,
  pill: 999,
} as const;

/** Type scale observed in the skin. */
export const FONT_SIZE = {
  micro: 11,
  caption: 12,
  footnote: 13,
  body: 14,
  bodyLarge: 15,
  callout: 16,
  headline: 17,
  title: 18,
  titleLarge: 19,
  display: 20,
  displayLarge: 21,
  hero: 23,
  heroLarge: 24,
  code: 40,
} as const;

/** Weights observed in the skin. */
export const FONT_WEIGHT = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

/**
 * Motion.
 *
 * The skin uses `120ms ease` for colour, opacity and transform, `150ms ease` for some
 * transforms and `200ms ease` for padding. Native transitions use the same durations so
 * the app does not feel slower or faster than the desktop surface.
 */
export const MOTION = {
  fast: 120,
  base: 150,
  slow: 200,
  ease: 'ease',
} as const;

/** Spacing scale. */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const FONT_FAMILY = {
  sans: 'ui-sans-serif, -apple-system, system-ui, "PingFang SC", "Segoe UI", Helvetica, Arial, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Minimum input size, so iOS never zooms the page on focus. */
export const MIN_INPUT_FONT_SIZE = 16;
