/**
 * Builds the community Mini App package for the MiniMax Code MiniApps registry.
 *
 * The registry (https://github.com/MiniMax-AI/MiniMax-Code-MiniApps) accepts one shape: a
 * complete Mini App plugin directory under `plugins/<github-username>/<plugin-id>/`. This
 * script produces exactly that directory from the bridge package, so the published copy is
 * generated from the source instead of maintained by hand.
 *
 * What it leaves out, and why:
 * - `artifacts/`, `scripts/`, `tsconfig.json`: development-only. The runtime payload is
 *   `miniapp/client` and `miniapp/node`; nothing else runs.
 * - Type declarations and source maps under `miniapp/node`: they never run, and the maps
 *   point at sources the registry does not carry.
 * - `test/` becomes `tests/`: the registry's convention keeps the suite beside the payload.
 *
 * What it adds:
 * - `package.json`: the workspace manifest carries workspace-only fields; the published
 *   manifest is the small one the package contract asks for.
 * - `docs/`: the pairing and protocol documents, with every path that leaves the package
 *   rewritten to an absolute link into the source repository.
 *
 * Usage:
 *   node packages/bridge/scripts/package-for-registry.mjs [--out <dir>]
 */
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');

const PLUGIN_ID = 'minimax-bot-bridge';
const SOURCE_REPO = 'https://github.com/nattiini45/minimax-bot-mobile/blob/main';

/** Files copied verbatim from the bridge package. */
const VERBATIM_FILES = ['icon.png', 'icon-dark.png', 'LICENSE', 'LICENSE-MINIMAX.txt'];

/** The files above that are binary and must be copied byte for byte. */
const BINARY_FILES = ['icon.png', 'icon-dark.png'];

/** Documents copied from the repository root, with their workspace links rewritten. */
const DOCS = ['PROTOCOL.md', 'PAIRING.md'];

/**
 * Tests that stay in the workspace.
 *
 * `artifact-closed.test.mjs` proves that the *build* produces a self-contained artifact: it
 * needs the protocol sources, the sync script, the TypeScript compiler and a workspace
 * tsconfig. None of that exists in the published package, and none of it is about how the
 * plugin behaves — so the published suite leaves it behind.
 */
const WORKSPACE_ONLY_TESTS = ['artifact-closed.test.mjs'];

/**
 * @param {string[]} args
 * @returns {string}
 */
function outputDir(args) {
  const index = args.indexOf('--out');
  if (index === -1) return resolve(repoRoot, 'dist/registry', PLUGIN_ID);
  const value = args[index + 1];
  if (!value) throw new Error('--out needs a directory');
  return resolve(repoRoot, value);
}

/**
 * The path with every symlink in its existing part resolved.
 *
 * The destination need not exist yet, so the nearest existing ancestor is resolved and the
 * rest is appended unchanged.
 *
 * @param {string} path Absolute path.
 * @returns {Promise<string>}
 */
async function canonical(path) {
  const rest = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) return path;
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Refuses an output directory the recursive removal could harm.
 *
 * The destination is wiped before it is filled, so it must not be, hold or sit inside any
 * source the package is built from. Inside the repository only `dist/` qualifies: it is
 * ignored and generated. Outside the repository any directory that does not contain it does.
 * Two paths are checked: where the destination really lands (every symlink resolved), and
 * the entry the removal deletes and the writes recreate (the parent resolved, the last
 * component kept). `rm` removes a final-component symlink rather than following it, so the
 * output ends up at that entry, not at the link's target.
 *
 * @param {string} requested Absolute destination, as given.
 */
async function assertSafeOutput(requested) {
  const root = await canonical(repoRoot);
  const dist = join(root, 'dist');
  const entry = join(await canonical(dirname(requested)), basename(requested));
  const target = await canonical(requested);
  for (const out of new Set([entry, target])) assertSafeTarget(out, root, dist);
}

/**
 * @param {string} out Canonical destination.
 * @param {string} root Canonical repository root.
 * @param {string} dist The repository's `dist/`.
 */
function assertSafeTarget(out, root, dist) {
  const inside = (child, parent) => {
    const path = relative(parent, child);
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
  };
  if (inside(root, out)) {
    throw new Error(`--out ${out} is or contains the repository; refusing to delete it`);
  }
  if (inside(out, root) && !(inside(out, dist) && out !== dist)) {
    throw new Error(`--out ${out} is inside the repository but not under ${dist}; refusing to delete it`);
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrites a path that pointed into the workspace.
 *
 * A path inside the bridge stays a path inside the package; every other path becomes an
 * absolute link into the source repository, because the registry copy does not carry the
 * relay, the phone client or the protocol sources.
 *
 * @param {string} repoRelative Path relative to the repository root.
 * @returns {string}
 */
function rewritePath(repoRelative) {
  if (repoRelative.startsWith('packages/bridge/')) {
    return repoRelative.slice('packages/bridge/'.length);
  }
  return `${SOURCE_REPO}/${repoRelative}`;
}

/**
 * Rewrites a link target that pointed into the workspace.
 *
 * The documents are published under `docs/`, so a link into the bridge is made relative to
 * that folder; every other link goes to the source repository.
 *
 * @param {string} repoRelative Path relative to the repository root.
 * @returns {string}
 */
function rewriteLink(repoRelative) {
  const path = rewritePath(repoRelative);
  return path.startsWith(SOURCE_REPO) ? path : `../${path}`;
}

/**
 * Rewrites the workspace references in a document.
 *
 * @param {string} text
 * @returns {string}
 */
function rewriteDocument(text) {
  // Markdown links: [label](target)
  let out = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label, target) => {
    if (!/^(?:\.\.\/)?(?:packages|apps|scripts|docs)\//u.test(target)) return match;
    const repoRelative = target.replace(/^\.\.\//u, '');
    return `[${label}](${rewriteLink(repoRelative)})`;
  });

  // Inline code spans that hold a workspace path.
  out = out.replace(/`([^`\n]+)`/gu, (match, value) => {
    if (!/^(?:\.\.\/)?(?:packages|apps|scripts|docs)\//u.test(value)) return match;
    return `\`${rewritePath(value.replace(/^\.\.\//u, ''))}\``;
  });

  return out;
}

/**
 * Fails when a published document still points into the workspace.
 *
 * A relative link must resolve to a file the package carries, read from the document's own
 * folder; a code span must not hold a relative path at all.
 *
 * @param {string} text
 * @param {string} name
 * @param {string} docsDir The folder the document is published in.
 */
async function assertNoWorkspacePaths(text, name, docsDir) {
  const dangling = [];
  for (const match of text.matchAll(/\]\((\.\.\/[^)\s]+)\)/gu)) {
    const target = match[1].replace(/#.*$/u, '');
    if (!(await exists(resolve(docsDir, target)))) dangling.push(match[1]);
  }
  const spans = [...text.matchAll(/`(\.\.\/[^`\n]+)`/gu)].map((match) => match[1]);
  const leftovers = [...dangling, ...spans];
  if (leftovers.length > 0) {
    throw new Error(`${name} still points into the workspace: ${leftovers.join(', ')}`);
  }
}

/**
 * Writes the published manifest.
 *
 * The workspace manifest names the package `@minimax-bot/bridge` and carries the scripts that
 * only work inside the workspace. The published manifest is the contract's shape.
 *
 * @param {string} out
 * @param {Record<string, unknown>} manifest The plugin manifest, for name and version.
 */
async function writePublishedManifest(out, manifest) {
  const published = {
    name: manifest.name,
    version: manifest.version,
    private: true,
    description: manifest.description,
    license: 'MIT',
    author: manifest.author,
    type: 'module',
    mcode: {
      schemaVersion: 2,
      miniApp: './miniapp/miniapp.json',
    },
    scripts: {
      test: 'node --test',
    },
  };
  await writeFile(join(out, 'package.json'), `${JSON.stringify(published, null, 2)}\n`, 'utf8');
}

/**
 * Copies a text file and normalises its line endings to LF.
 *
 * The registry has no `.gitattributes`, so a Windows checkout would otherwise carry CRLF
 * into the published package. The package that is committed and the package that is built
 * here have to be the same bytes.
 *
 * @param {string} from
 * @param {string} to
 */
async function copyText(from, to) {
  const text = await readFile(from, 'utf8');
  await writeFile(to, text.replace(/\r\n/gu, '\n'), 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  const out = outputDir(args);

  // The shared protocol is vendored into the payload at build time. Without it the
  // package would not start, so this is a build error, not a packaging choice.
  const protocolEntry = join(packageRoot, 'miniapp/node/protocol/index.js');
  if (!(await exists(protocolEntry))) {
    throw new Error(
      `Vendored protocol not found at ${protocolEntry}. Run \`npm run build -w @minimax-bot/protocol\` and \`npm run sync:protocol -w @minimax-bot/bridge\` first.`,
    );
  }

  await assertSafeOutput(out);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  // Identity.
  await mkdir(join(out, '.minimax-plugin'), { recursive: true });
  await copyText(
    join(packageRoot, '.minimax-plugin/plugin.json'),
    join(out, '.minimax-plugin/plugin.json'),
  );
  const manifest = JSON.parse(
    await readFile(join(out, '.minimax-plugin/plugin.json'), 'utf8'),
  );
  await writePublishedManifest(out, manifest);

  // Runtime payload: the client page, the Node entry and everything they import.
  await mkdir(join(out, 'miniapp'), { recursive: true });
  await copyText(join(packageRoot, 'miniapp/miniapp.json'), join(out, 'miniapp/miniapp.json'));
  await mkdir(join(out, 'miniapp/client'), { recursive: true });
  for (const entry of await readdir(join(packageRoot, 'miniapp/client'), { withFileTypes: true })) {
    if (entry.isFile()) {
      await copyText(join(packageRoot, 'miniapp/client', entry.name), join(out, 'miniapp/client', entry.name));
    }
  }
  await mkdir(join(out, 'miniapp/node'), { recursive: true });
  for (const entry of await readdir(join(packageRoot, 'miniapp/node'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs')) {
      await copyText(join(packageRoot, 'miniapp/node', entry.name), join(out, 'miniapp/node', entry.name));
    }
  }
  await mkdir(join(out, 'miniapp/node/protocol'), { recursive: true });
  for (const entry of await readdir(join(packageRoot, 'miniapp/node/protocol'), { withFileTypes: true })) {
    // Only the compiled JavaScript is runtime. Declarations and source maps are not.
    if (entry.isFile() && entry.name.endsWith('.js')) {
      await copyText(
        join(packageRoot, 'miniapp/node/protocol', entry.name),
        join(out, 'miniapp/node/protocol', entry.name),
      );
    }
  }

  // Legal and artwork attribution. The icons are binary and are copied byte for byte.
  for (const file of VERBATIM_FILES) {
    if (BINARY_FILES.includes(file)) {
      await cp(join(packageRoot, file), join(out, file));
      continue;
    }
    await copyText(join(packageRoot, file), join(out, file));
  }

  // The plugin's own README: the registry's `README.md` is this file.
  await copyText(join(packageRoot, 'README.md'), join(out, 'README.md'));
  await copyText(join(packageRoot, 'README.zh-CN.md'), join(out, 'README.zh-CN.md'));

  // The test suite, under the registry's name for it.
  await mkdir(join(out, 'tests'), { recursive: true });
  for (const entry of await readdir(join(packageRoot, 'test'), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (WORKSPACE_ONLY_TESTS.includes(entry.name)) continue;
    await copyText(join(packageRoot, 'test', entry.name), join(out, 'tests', entry.name));
  }

  // Documents, with their workspace links rewritten.
  await mkdir(join(out, 'docs'), { recursive: true });
  for (const name of DOCS) {
    const source = await readFile(join(repoRoot, 'docs', name), 'utf8');
    const rewritten = rewriteDocument(source);
    await assertNoWorkspacePaths(rewritten, name, join(out, 'docs'));
    await writeFile(join(out, 'docs', name), rewritten.replace(/\r\n/gu, '\n'), 'utf8');
  }

  // A binary file that is copied as text is corrupted, and nothing downstream says so.
  // The icon is the one binary the package carries, so it is checked byte for byte.
  for (const file of BINARY_FILES) {
    const [source, copied] = await Promise.all([
      readFile(join(packageRoot, file)),
      readFile(join(out, file)),
    ]);
    if (!source.equals(copied)) {
      throw new Error(`${file} was not copied byte for byte`);
    }
  }

  // A summary, so a drift in size is visible.
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      files += 1;
      bytes += (await stat(path)).size;
    }
  };
  await walk(out);

  console.log(`packaged ${PLUGIN_ID} -> ${out}`);
  console.log(`  ${files} files, ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`  source tree: ${relative(repoRoot, out) || out}`);
}

await main();
