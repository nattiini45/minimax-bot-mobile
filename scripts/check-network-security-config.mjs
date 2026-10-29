#!/usr/bin/env node
/**
 * Checks the network security config the Android build generated.
 *
 * The app is allowed to speak cleartext to a relay on the developer's own machine
 * and to nothing else. The config plugin writes that exception; this checks it.
 *
 * A gate that only prints what it found is not a gate, so this fails the build
 * when the generated config would let cleartext out to anywhere other than the
 * loopback interface, or when the manifest does not point at it.
 *
 * Usage:
 *   node scripts/check-network-security-config.mjs <network_security_config.xml> <AndroidManifest.xml>
 */

import { readFileSync } from 'node:fs';

const LOOPBACK_DOMAINS = ['localhost', '127.0.0.1'];

/**
 * The problems with a generated config, as a list of sentences.
 *
 * @param {string} netconf the generated `network_security_config.xml`
 * @param {string} manifest the generated `AndroidManifest.xml`
 * @returns {string[]}
 */
export function checkNetworkSecurityConfig(netconf, manifest) {
  const problems = [];
  // The generated file carries a comment explaining the exception. It is not part
  // of the config, so it is removed before anything is counted.
  const xml = netconf.replace(/<!--[\s\S]*?-->/g, '');

  const domainConfigs = [...xml.matchAll(/<domain-config\b([^>]*)>([\s\S]*?)<\/domain-config>/g)];
  if (domainConfigs.length !== 1) {
    problems.push(
      `expected exactly one domain-config, found ${domainConfigs.length}`,
    );
  }

  for (const [, attributes, body] of domainConfigs) {
    if (!/cleartextTrafficPermitted="true"/.test(attributes)) {
      problems.push('the domain-config does not permit cleartext');
    }
    const domains = [...body.matchAll(/<domain\b([^>]*)>([^<]*)<\/domain>/g)].map(
      ([, domainAttributes, value]) => ({
        value: value.trim(),
        includeSubdomains: /includeSubdomains="true"/.test(domainAttributes),
      }),
    );
    const names = domains.map((domain) => domain.value);
    for (const expected of LOOPBACK_DOMAINS) {
      if (!names.includes(expected)) {
        problems.push(`the cleartext exception does not cover ${expected}`);
      }
    }
    for (const domain of domains) {
      if (!LOOPBACK_DOMAINS.includes(domain.value)) {
        problems.push(
          `the cleartext exception covers ${domain.value}, which is not the loopback interface`,
        );
      }
      if (domain.includeSubdomains) {
        problems.push(
          `the cleartext exception covers the subdomains of ${domain.value}`,
        );
      }
    }
  }

  const baseConfigs = [...xml.matchAll(/<base-config\b([^>]*?)\/?>/g)];
  if (baseConfigs.length !== 1) {
    problems.push(`expected exactly one base-config, found ${baseConfigs.length}`);
  }
  for (const [, attributes] of baseConfigs) {
    if (!/cleartextTrafficPermitted="false"/.test(attributes)) {
      problems.push('the base-config does not forbid cleartext');
    }
  }
  if (/cleartextTrafficPermitted="true"/.test(xml.replace(/<domain-config\b[^>]*>/g, ''))) {
    problems.push('cleartext is permitted outside the loopback exception');
  }

  if (!/android:networkSecurityConfig="@xml\/network_security_config"/.test(manifest)) {
    problems.push('the manifest does not point at the network security config');
  }

  return problems;
}

function main() {
  const [netconfPath, manifestPath] = process.argv.slice(2);
  if (!netconfPath || !manifestPath) {
    console.error(
      'Usage: node scripts/check-network-security-config.mjs <network_security_config.xml> <AndroidManifest.xml>',
    );
    process.exit(2);
  }

  const problems = checkNetworkSecurityConfig(
    readFileSync(netconfPath, 'utf8'),
    readFileSync(manifestPath, 'utf8'),
  );

  if (problems.length > 0) {
    console.error('the generated network security config is wrong:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log('the network security config allows cleartext on the loopback interface only');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main();
}
