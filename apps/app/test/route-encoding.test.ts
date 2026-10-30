import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The routes the phone navigates to.
 *
 * The ids in these paths come from the relay: they are the bot ids and group ids the
 * team tools report. An id is a piece of text from somewhere else, so it is encoded
 * before it goes into a path - an id that contains a slash or a traversal segment
 * would otherwise address a different route.
 *
 * This test reads the screens themselves, so it holds whatever the screens do rather
 * than whatever one of them does.
 */

/** The app's screens. */
const APP_DIR = join(__dirname, '..', 'app');

function screens(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...screens(full));
    else if (entry.endsWith('.tsx')) found.push(full);
  }
  return found;
}

describe('the routes the phone navigates to', () => {
  it('does not put an unencoded id into a route', () => {
    const offenders: string[] = [];
    for (const file of screens(APP_DIR)) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (!line.includes('router.push')) return;
        // A route is either a literal path or one of the path helpers. Anything else
        // is a path built by hand, and a hand-built path is where an id goes in
        // unencoded.
        const usesHelper = /\b(botPath|groupPath|chatPath)\(/.test(line);
        const isLiteral = /router\.push\(\s*'[^']*'\s*\)/.test(line);
        if (!usesHelper && !isLiteral) {
          offenders.push(`${file.replace(APP_DIR, 'app')}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
