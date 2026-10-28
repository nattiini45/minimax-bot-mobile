import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

import {
  DARK_COLORS,
  FONT_FAMILY,
  FONT_SIZE,
  FONT_WEIGHT,
  LIGHT_COLORS,
  MIN_INPUT_FONT_SIZE,
  MOTION,
  RADIUS,
  SPACE,
  type ThemeColors,
} from './tokens';

export interface Theme {
  colors: ThemeColors;
  radius: typeof RADIUS;
  space: typeof SPACE;
  fontSize: typeof FONT_SIZE;
  fontWeight: typeof FONT_WEIGHT;
  motion: typeof MOTION;
  font: typeof FONT_FAMILY;
  minInputFontSize: number;
  dark: boolean;
}

export function buildTheme(dark: boolean): Theme {
  return {
    colors: dark ? DARK_COLORS : LIGHT_COLORS,
    radius: RADIUS,
    space: SPACE,
    fontSize: FONT_SIZE,
    fontWeight: FONT_WEIGHT,
    motion: MOTION,
    font: FONT_FAMILY,
    minInputFontSize: MIN_INPUT_FONT_SIZE,
    dark,
  };
}

const ThemeContext = createContext<Theme>(buildTheme(false));

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => buildTheme(scheme === 'dark'), [scheme]);
  return React.createElement(ThemeContext.Provider, { value: theme }, children);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export * from './tokens';
