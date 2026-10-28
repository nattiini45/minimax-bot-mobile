/**
 * Copies the built protocol into the Mini App artifact.
 *
 * A Mini App node artifact must be self-contained: it runs inside MiniMax Code with no
 * node_modules resolution, exactly like the official MiniMax Bot plugin ("built-ins
 * only"). Vendoring the compiled protocol keeps the plugin self-contained while the
 * protocol itself stays a single source of truth in `packages/protocol`.
 */
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const source = resolve(packageRoot, '../protocol/dist');
const target = join(packageRoot, 'miniapp/node/protocol');

async function main() {
  try {
    await readdir(source);
  } catch {
    throw new Error(
      `Protocol build not found at ${source}. Run \`npm run build -w @minimax-bot/protocol\` first.`,
    );
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });

  // The compiled protocol ships .d.ts files that are useless inside the plugin.
  const files = await readdir(target);
  await Promise.all(
    files
      .filter((file) => file.endsWith('.d.ts') || file.endsWith('.d.ts.map') || file.endsWith('.tsbuildinfo'))
      .map((file) => rm(join(target, file), { force: true })),
  );

  console.log(`synced protocol -> ${target}`);
}

await main();
