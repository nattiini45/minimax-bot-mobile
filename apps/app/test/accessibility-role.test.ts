import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The accessibility roles the app uses.
 *
 * React Native accepts a fixed set of roles, and a role outside it is not a warning:
 * the view manager throws when the view is created, and the app dies on the device.
 * The unit tests render with a mock that accepts anything, so nothing catches it —
 * it is caught here instead, by reading the sources.
 *
 * The list is the one React Native 0.88 declares
 * (`Libraries/Components/View/ViewAccessibility.d.ts`).
 */
const ROLES = new Set([
  'none',
  'button',
  'dropdownlist',
  'togglebutton',
  'link',
  'search',
  'image',
  'keyboardkey',
  'text',
  'adjustable',
  'imagebutton',
  'header',
  'summary',
  'alert',
  'checkbox',
  'combobox',
  'menu',
  'menubar',
  'menuitem',
  'progressbar',
  'radio',
  'radiogroup',
  'scrollbar',
  'spinbutton',
  'switch',
  'tab',
  'tabbar',
  'tablist',
  'timer',
  'list',
  'toolbar',
  'grid',
  'pager',
  'scrollview',
  'horizontalscrollview',
  'viewgroup',
  'webview',
  'drawerlayout',
  'slidingdrawer',
  'iconmenu',
]);

/** Every source file of the app, screens and components alike. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'android' || entry === 'ios') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const appRoot = join(__dirname, '..');

describe('the accessibility roles of the app', () => {
  it('are all roles React Native accepts', () => {
    const wrong: string[] = [];
    for (const file of sourceFiles(appRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/accessibilityRole\s*=\s*"([^"]+)"/g)) {
        const role = match[1]!;
        if (!ROLES.has(role)) wrong.push(`${file.slice(appRoot.length + 1)}: ${role}`);
      }
    }
    // A role outside the set crashes the app when the view is created.
    expect(wrong).toEqual([]);
  });

  it('are all roles React Native accepts when they are written as a variable', () => {
    const wrong: string[] = [];
    for (const file of sourceFiles(appRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/accessibilityRole\s*=\s*\{\s*'([^']+)'/g)) {
        const role = match[1]!;
        if (!ROLES.has(role)) wrong.push(`${file.slice(appRoot.length + 1)}: ${role}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
