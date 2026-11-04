/**
 * MiniMax Bot design tokens.
 * Every value here is taken from the official MiniMax Bot product skin
 * (`miniapp/client/app.css`, which states: "visual language follows DS Bot's team
 * surface, adapted to MiniMax Code"). The React Native theme in `index.ts` is generated
 * from this file, so the native app and the desktop Mini App stay in step.
 *
 * The palette was reworked for the v0.2 pass: the family is still one neutral ramp plus
 * one accent, but the canvas is a cool gray rather than near-white, the surfaces are
 * white cards with hairline edges instead of white on white, and the accent now earns
 * its place on the one thing the user acts on (the send button, the active tab, the
 * main Bot's ring) instead of being one more gray.
 */

import { Platform } from 'react-native';

export interface ThemeColors {
  bg: string;
  sidebar: string;
  surface: string;
  /** The surface a recessed element sits on: the canvas. */
  sunken: string;
  bubble: string;
  user: string;
  userInk: string;
  ink: string;
  muted: string;
  subtle: string;
  /** Secondary text; decorative marks keep the quieter subtle colour. */
  subtleText: string;
  successText: string;
  warningText: string;
  dangerText: string;
  line: string;
  lineStrong: string;
  hover: string;
  active: string;
  tag: string;
  /** The one accent. Used for the action, the active state and the focus ring. */
  accent: string;
  /** Contrast-safe small accent text on translucent accent washes. */
  accentText: string;
  /** Ink that sits on the accent. */
  accentInk: string;
  /** A quiet wash of the accent, for chips and selected rows. */
  accentSoft: string;
  star: string;
  danger: string;
  success: string;
  warning: string;
  scrim: string;
  shadowPop: string;
  shadowPill: string;
  ring: string;
  /** A code block's ground. */
  code: string;
}

export const LIGHT_COLORS: ThemeColors = {
  bg: '#f2f4f7',
  sidebar: '#fafbfc',
  surface: '#ffffff',
  sunken: '#eef1f5',
  bubble: '#ffffff',
  user: '#101317',
  userInk: '#ffffff',
  ink: '#0d1117',
  muted: '#59606b',
  subtle: '#8b929e',
  subtleText: '#606975',
  successText: '#117332',
  warningText: '#915000',
  dangerText: '#b52a31',
  line: 'rgba(13, 17, 23, 0.08)',
  lineStrong: 'rgba(13, 17, 23, 0.14)',
  hover: 'rgba(15, 23, 42, 0.04)',
  active: 'rgba(15, 23, 42, 0.08)',
  tag: 'rgba(13, 17, 23, 0.055)',
  accent: '#2f6fed',
  accentText: '#245bc5',
  accentInk: '#ffffff',
  accentSoft: 'rgba(47, 111, 237, 0.1)',
  star: '#f5a524',
  danger: '#e5484d',
  success: '#16a34a',
  warning: '#d97706',
  scrim: 'rgba(10, 12, 16, 0.35)',
  shadowPop: '0 8px 28px -6px rgba(13, 17, 23, 0.14), 0 2px 6px rgba(13, 17, 23, 0.05)',
  shadowPill: '0 2px 8px -1px rgba(13, 17, 23, 0.06), 0 1px 2px rgba(13, 17, 23, 0.04)',
  ring: '#eef1f5',
  code: '#f4f6f9',
};

export const DARK_COLORS: ThemeColors = {
  bg: '#0c0e12',
  sidebar: '#101318',
  surface: '#14181e',
  sunken: '#090b0e',
  bubble: '#181d24',
  user: '#f2f4f7',
  userInk: '#0c0e12',
  ink: '#eceff3',
  muted: '#9aa3af',
  subtle: '#6b7480',
  subtleText: '#8d97a4',
  successText: '#3ecf6d',
  warningText: '#f0a13a',
  dangerText: '#f2555a',
  line: 'rgba(255, 255, 255, 0.09)',
  lineStrong: 'rgba(255, 255, 255, 0.17)',
  hover: 'rgba(255, 255, 255, 0.05)',
  active: 'rgba(255, 255, 255, 0.09)',
  tag: 'rgba(255, 255, 255, 0.07)',
  accent: '#5a8cff',
  accentText: '#6a98ff',
  accentInk: '#08111f',
  accentSoft: 'rgba(90, 140, 255, 0.16)',
  star: '#f5a524',
  danger: '#f2555a',
  success: '#3ecf6d',
  warning: '#f0a13a',
  scrim: 'rgba(4, 6, 10, 0.55)',
  shadowPop: '0 10px 32px -6px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.3)',
  shadowPill: '0 2px 10px -1px rgba(0, 0, 0, 0.5)',
  ring: '#1c2129',
  code: '#0f1319',
};

/** Radii observed in the skin. */
export const RADIUS = {
  xs: 5,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  xxl: 14,
  card: 16,
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

/**
 * The type faces.
 *
 * React Native takes one family name, not a stack, so the stack belongs to the web
 * build and the native build keeps the platform's own face — which is what it uses
 * by default anyway.
 */
export const FONT_FAMILY = {
  sans: Platform.select({
    web: 'ui-sans-serif, -apple-system, system-ui, "PingFang SC", "Segoe UI", Helvetica, Arial, sans-serif',
    default: undefined,
  }),
  mono: Platform.select({
    web: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    default: 'monospace',
  }),
};

/** Minimum input size, so iOS never zooms the page on focus. */
export const MIN_INPUT_FONT_SIZE = 16;

/**
 * Elevation.
 *
 * React Native has no CSS box-shadow, so the soft cards carry an iOS shadow and an
 * Android elevation instead. One elevation, one shadow: a second one says something.
 */
export const ELEVATION = {
  card: {
    shadowColor: '#0d1117',
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 1,
  },
  pop: {
    shadowColor: '#0d1117',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
} as const;
