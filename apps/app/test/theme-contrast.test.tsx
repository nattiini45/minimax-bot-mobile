import React from 'react';
import renderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as Native from 'react-native';
import { ThemeProvider, buildTheme } from '../src/theme';
import { Pill, SectionHeader } from '../src/components/primitives';

function rgb(color: string): number[] {
  if (color.startsWith('#')) return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  return color.match(/[\d.]+/g)!.map(Number);
}
function over(color: string, background: string) {
  const [r, g, b, a = 1] = rgb(color);
  const base = rgb(background);
  return [r, g, b].map((v, i) => v * a + base[i]! * (1 - a));
}
function luminance(channels: number[]) {
  return channels.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
}
function contrast(foreground: string, background: number[]) {
  const a = luminance(rgb(foreground));
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
afterEach(() => jest.restoreAllMocks());
it.each(['light', 'dark'] as const)('%s secondary text is readable on its actual surfaces', async scheme => {
  jest.spyOn(Native, 'useColorScheme').mockReturnValue(scheme);
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(<ThemeProvider><SectionHeader title="Bots" caption="2" /></ThemeProvider>); });
  const colors = buildTheme(scheme === 'dark').colors;
  for (const node of tree.root.findAllByType(Text)) {
    const foreground = StyleSheet.flatten(node.props.style).color;
    for (const surface of [colors.bg, colors.surface, colors.sunken, colors.bubble]) {
      expect(contrast(foreground, rgb(surface))).toBeGreaterThanOrEqual(4.5);
    }
  }
  await renderer.act(async () => tree.unmount());
});
it.each(['light', 'dark'] as const)('%s status pill text passes after compositing its translucent wash', async scheme => {
  jest.spyOn(Native, 'useColorScheme').mockReturnValue(scheme);
  const colors = buildTheme(scheme === 'dark').colors;
  for (const tone of ['neutral', 'accent', 'success', 'warning', 'danger'] as const) {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(<ThemeProvider><Pill label={tone} tone={tone} /></ThemeProvider>); });
    try {
      const text = tree.root.findByType(Text);
      const foreground = StyleSheet.flatten(text.props.style).color;
      const wash = StyleSheet.flatten(text.parent!.props.style).backgroundColor;
      for (const surface of [colors.bg, colors.surface]) expect(contrast(foreground, over(wash, surface))).toBeGreaterThanOrEqual(4.5);
    } finally { await renderer.act(async () => tree.unmount()); }
  }
});
