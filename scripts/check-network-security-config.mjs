#!/usr/bin/env node
/**
 * Checks the network security configs the Android build generated.
 *
 * There are two of them, and they carry different invariants:
 *
 *   - The **release** configuration (`src/main`) may not permit cleartext at all.
 *     A relay on the developer's own machine is a development convenience, and
 *     the credential that rides over it — the device token — must never travel in
 *     the clear in a build that anybody can install.
 *   - The **debug** configuration (`src/debug`) permits cleartext on the loopback
 *     interface and nowhere else, so the local-relay workflow keeps working.
 *
 * A gate that only prints what it found is not a gate, so this fails the build
 * when the release configuration would let cleartext out anywhere, and when the
 * development configuration has lost the exception it is supposed to carry.
 *
 * Usage:
 *   node scripts/check-network-security-config.mjs \
 *     <release-network_security_config.xml> <AndroidManifest.xml> \
 *     <debug-network_security_config.xml>
 */

import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const LOOPBACK_DOMAINS = ['localhost', '127.0.0.1'];

/**
 * The opening tags of the domain-configs in a config, with their attributes.
 *
 * The opening tags are counted rather than the whole elements on purpose: a
 * domain-config that is never closed still counts, because Android's schema
 * gives a domain-config the default `cleartextTrafficPermitted="true"`. An
 * unterminated one is an exception, and the gate must not overlook it.
 *
 * @param {string} xml the config, without its comments
 * @returns {string[]} the attributes of each opening tag
 */
function domainConfigTagsOf(xml) {
  return [...xml.matchAll(/<domain-config(?![-\w])([^>]*)>/gi)].map(([, attributes]) => attributes);
}

/**
 * The domains named in a config, with their attributes.
 *
 * @param {string} xml the config, without its comments
 * @returns {{ value: string, includeSubdomains: boolean }[]}
 */
function domainTagsOf(xml) {
  // The lookahead keeps `<domain-config` out of this: a hyphen is a word
  // boundary, so `<domain\b` would match it as well.
  return [...xml.matchAll(/<domain(?![-\w])([^>]*?)\/?>([^<]*)/gi)].map(([, attributes, value]) => ({
    value: value.trim(),
    includeSubdomains: /includeSubdomains\s*=\s*"true"/i.test(attributes),
  }));
}

/**
 * The base-configs in a config, with their attributes.
 *
 * @param {string} xml the config, without its comments
 * @returns {string[]} the attributes of each base-config
 */
function baseConfigTagsOf(xml) {
  return [...xml.matchAll(/<base-config(?![-\w])([^>]*?)\/?>/gi)].map(([, attributes]) => attributes);
}

/**
 * The problems with the configuration the release build ships.
 *
 * @param {string} netconf the generated `network_security_config.xml` of the main source set
 * @param {string} manifest the generated `AndroidManifest.xml`
 * @returns {string[]}
 */
export function checkNetworkSecurityConfig(netconf, manifest) {
  const problems = [];
  // The generated file carries a comment explaining itself. It is not part of
  // the config, so it is removed before anything is counted.
  const xml = netconf.replace(/<!--[\s\S]*?-->/g, '');

  // The release build may not permit cleartext anywhere, so it may not carry a
  // domain-config at all: every one of them is an exception.
  const domainConfigs = domainConfigTagsOf(xml);
  if (domainConfigs.length > 0) {
    const hosts = domainTagsOf(xml)
      .map((domain) => domain.value)
      .filter((value) => value.length > 0);
    problems.push(
      hosts.length > 0
        ? `the release config permits cleartext for ${hosts.join(', ')}`
        : 'the release config carries a domain-config, and every domain-config is an exception',
    );
  }

  const baseConfigs = baseConfigTagsOf(xml);
  if (baseConfigs.length !== 1) {
    problems.push(`expected exactly one base-config, found ${baseConfigs.length}`);
  }
  for (const attributes of baseConfigs) {
    if (!/cleartextTrafficPermitted\s*=\s*"false"/i.test(attributes)) {
      problems.push('the base-config does not forbid cleartext');
    }
  }
  if (/cleartextTrafficPermitted\s*=\s*"true"/i.test(xml)) {
    problems.push('cleartext is permitted');
  }

  if (!/android:networkSecurityConfig\s*=\s*"@xml\/network_security_config"/.test(manifest)) {
    problems.push('the manifest does not point at the network security config');
  }
  // The manifest attribute is ignored on Android 7 and above while a network
  // security config is present, but a manifest that permits cleartext is a
  // manifest that stops being safe the day the config goes missing.
  if (/android:usesCleartextTraffic\s*=\s*"true"/.test(manifest)) {
    problems.push('the manifest permits cleartext');
  }

  return problems;
}

/**
 * The problems with the configuration the debug build ships.
 *
 * @param {string} netconf the generated `network_security_config.xml` of the debug source set
 * @returns {string[]}
 */
export function checkLocalRelayNetworkSecurityConfig(netconf) {
  const problems = [];
  const xml = netconf.replace(/<!--[\s\S]*?-->/g, '');

  const domainConfigs = domainConfigTagsOf(xml);
  if (domainConfigs.length !== 1) {
    problems.push(`expected exactly one domain-config, found ${domainConfigs.length}`);
  }
  if (domainConfigs.length === 0) {
    problems.push(
      'the development build does not permit cleartext to the loopback interface, so the local relay is out of reach',
    );
  }

  for (const attributes of domainConfigs) {
    if (!/cleartextTrafficPermitted\s*=\s*"true"/i.test(attributes)) {
      problems.push('the domain-config does not permit cleartext');
    }
  }

  // Every domain the config names is counted, not only the ones inside a
  // well-formed domain-config: a domain that no closing tag pairs with is
  // still a host the exception covers.
  const domains = domainTagsOf(xml);
  const names = domains.map((domain) => domain.value);
  for (const expected of LOOPBACK_DOMAINS) {
    if (!names.includes(expected)) {
      problems.push(`the cleartext exception does not cover ${expected}`);
    }
  }
  for (const domain of domains) {
    if (!LOOPBACK_DOMAINS.includes(domain.value)) {
      problems.push(
        `the cleartext exception covers ${domain.value || 'a domain with no host'}, which is not the loopback interface`,
      );
    }
    if (domain.includeSubdomains) {
      problems.push(`the cleartext exception covers the subdomains of ${domain.value}`);
    }
  }

  const baseConfigs = baseConfigTagsOf(xml);
  if (baseConfigs.length !== 1) {
    problems.push(`expected exactly one base-config, found ${baseConfigs.length}`);
  }
  for (const attributes of baseConfigs) {
    if (!/cleartextTrafficPermitted\s*=\s*"false"/i.test(attributes)) {
      problems.push('the base-config does not forbid cleartext');
    }
  }
  // What is left after the exception is taken out must not permit cleartext
  // either. A domain-config that is never closed leaves its own attribute
  // behind, and it is reported rather than overlooked.
  const outsideTheException = xml.replace(/<domain-config\b[^>]*>[\s\S]*?<\/domain-config>/gi, '');
  if (/cleartextTrafficPermitted\s*=\s*"true"/i.test(outsideTheException)) {
    problems.push('cleartext is permitted outside the loopback exception');
  }

  return problems;
}

/**
 * Reads a file, or answers `null` when it cannot be read.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function main() {
  const [releasePath, manifestPath, ...developmentPaths] = process.argv.slice(2);
  if (!releasePath || !manifestPath || developmentPaths.length === 0) {
    console.error(
      'Usage: node scripts/check-network-security-config.mjs ' +
        '<release-network_security_config.xml> <AndroidManifest.xml> ' +
        '<development-network_security_config.xml> [...]',
    );
    process.exit(2);
  }

  const problems = [];

  const release = readOrNull(releasePath);
  const manifest = readOrNull(manifestPath);

  if (release === null) {
    problems.push(`the release network security config is missing (${releasePath})`);
  } else if (manifest === null) {
    problems.push(`the manifest is missing (${manifestPath})`);
  } else {
    for (const problem of checkNetworkSecurityConfig(release, manifest)) {
      problems.push(`release: ${problem}`);
    }
  }

  // Every development variant has to keep the exception, or a relay on the
  // developer's own machine is out of reach in that build.
  for (const path of developmentPaths) {
    // The source set is what the message should name: the file sits in
    // `<source set>/res/xml/`.
    const label = basename(dirname(dirname(dirname(path))));
    const config = readOrNull(path);
    if (config === null) {
      problems.push(`the ${label} network security config is missing (${path})`);
      continue;
    }
    for (const problem of checkLocalRelayNetworkSecurityConfig(config)) {
      problems.push(`${label}: ${problem}`);
    }
  }

  if (problems.length > 0) {
    console.error('the generated network security config is wrong:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(
    'the release build forbids cleartext, and the development builds permit it on the loopback interface only',
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}
