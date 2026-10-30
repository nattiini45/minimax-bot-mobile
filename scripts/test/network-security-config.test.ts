import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as checker from '../check-network-security-config.mjs';

// The plugin is CommonJS and loads Expo's config-plugin machinery, so it is
// required the way Node requires it rather than through the test runner.
const require = createRequire(import.meta.url);
const plugin = require('../../apps/app/plugins/with-local-relay-network.cjs');

/** The configuration the release build ships: cleartext is not permitted anywhere. */
const RELEASE = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
`;

/** The configuration the debug build ships: cleartext on the loopback interface only. */
const LOCAL_RELAY = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">localhost</domain>
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
`;

const GOOD_MANIFEST = `<manifest>
    <application android:networkSecurityConfig="@xml/network_security_config" />
</manifest>
`;

describe('the network security config the release build ships', () => {
  it('passes when cleartext is forbidden outright', () => {
    expect(checker.checkNetworkSecurityConfig(RELEASE, GOOD_MANIFEST)).toEqual([]);
  });

  it('fails when cleartext is permitted to the loopback interface', () => {
    // This is the whole finding: the release build may not carry the exception.
    const problems = checker.checkNetworkSecurityConfig(LOCAL_RELAY, GOOD_MANIFEST);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('cleartext');
  });

  it('fails when cleartext is permitted to another host', () => {
    const bad = LOCAL_RELAY.replace(
      '<domain includeSubdomains="false">127.0.0.1</domain>',
      '<domain includeSubdomains="false">192.168.1.10</domain>',
    );
    const problems = checker.checkNetworkSecurityConfig(bad, GOOD_MANIFEST);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('192.168.1.10');
  });

  it('fails when the base config allows cleartext', () => {
    const bad = RELEASE.replace(
      '<base-config cleartextTrafficPermitted="false" />',
      '<base-config cleartextTrafficPermitted="true" />',
    );
    const problems = checker.checkNetworkSecurityConfig(bad, GOOD_MANIFEST);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('forbid cleartext');
  });

  it('fails when the manifest does not point at the config', () => {
    const problems = checker.checkNetworkSecurityConfig(
      RELEASE,
      '<manifest><application /></manifest>',
    );

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('manifest');
  });

  it('fails when the manifest permits cleartext', () => {
    const manifest = `<manifest>
    <application android:networkSecurityConfig="@xml/network_security_config" android:usesCleartextTraffic="true" />
</manifest>
`;
    const problems = checker.checkNetworkSecurityConfig(RELEASE, manifest);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('manifest');
  });

  it('does not count a domain mentioned in a comment', () => {
    const withComment = RELEASE.replace(
      '<network-security-config>',
      '<!-- <domain includeSubdomains="false">example.com</domain> -->\n<network-security-config>',
    );

    expect(checker.checkNetworkSecurityConfig(withComment, GOOD_MANIFEST)).toEqual([]);
  });

  it('names the host when a domain-config is never closed', () => {
    // Android's schema gives a domain-config the default
    // `cleartextTrafficPermitted="true"`, so one that is not closed still
    // grants the exception. The gate has to see it, and has to say which host.
    const unclosed = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">example.com</domain>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
`;
    const problems = checker.checkNetworkSecurityConfig(unclosed, GOOD_MANIFEST);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('example.com');
  });

  it('names the host when the tags are written in another case', () => {
    const otherCase = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <DOMAIN-CONFIG cleartextTrafficPermitted="true">
        <DOMAIN includeSubdomains="false">example.com</DOMAIN>
    </DOMAIN-CONFIG>
    <BASE-CONFIG cleartextTrafficPermitted="false" />
</network-security-config>
`;
    const problems = checker.checkNetworkSecurityConfig(otherCase, GOOD_MANIFEST);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('example.com');
  });

  it('fails when the manifest names another config', () => {
    const manifest = `<manifest>
    <application android:networkSecurityConfig="@xml/other_config" />
</manifest>
`;
    const problems = checker.checkNetworkSecurityConfig(RELEASE, manifest);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('manifest');
  });
});

describe('the network security config the debug build ships', () => {
  it('passes when cleartext is allowed on the loopback interface only', () => {
    expect(checker.checkLocalRelayNetworkSecurityConfig(LOCAL_RELAY)).toEqual([]);
  });

  it('fails when the exception is missing, because the local relay is then out of reach', () => {
    const problems = checker.checkLocalRelayNetworkSecurityConfig(RELEASE);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('loopback');
  });

  it('fails when a host outside the loopback interface is allowed in the clear', () => {
    const bad = LOCAL_RELAY.replace(
      '<domain includeSubdomains="false">127.0.0.1</domain>',
      '<domain includeSubdomains="false">192.168.1.10</domain>',
    );
    const problems = checker.checkLocalRelayNetworkSecurityConfig(bad);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('192.168.1.10');
  });

  it('fails when a domain is allowed with its subdomains', () => {
    const bad = LOCAL_RELAY.replace(
      '<domain includeSubdomains="false">localhost</domain>',
      '<domain includeSubdomains="true">localhost</domain>',
    );
    const problems = checker.checkLocalRelayNetworkSecurityConfig(bad);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('subdomains');
  });

  it('fails when there is more than one domain-config', () => {
    const bad = LOCAL_RELAY.replace(
      '</network-security-config>',
      '    <domain-config cleartextTrafficPermitted="true">\n' +
        '        <domain includeSubdomains="false">example.com</domain>\n' +
        '    </domain-config>\n' +
        '</network-security-config>',
    );
    const problems = checker.checkLocalRelayNetworkSecurityConfig(bad);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('exactly one domain-config');
  });

  it('fails when the base config allows cleartext', () => {
    const bad = LOCAL_RELAY.replace(
      '<base-config cleartextTrafficPermitted="false" />',
      '<base-config cleartextTrafficPermitted="true" />',
    );
    const problems = checker.checkLocalRelayNetworkSecurityConfig(bad);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('forbid cleartext');
  });

  it('names the host when the exception is never closed', () => {
    const unclosed = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">example.com</domain>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
`;
    const problems = checker.checkLocalRelayNetworkSecurityConfig(unclosed);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('example.com');
  });

  it('fails when a domain is written as an empty element', () => {
    const bad = LOCAL_RELAY.replace(
      '<domain includeSubdomains="false">localhost</domain>',
      '<domain includeSubdomains="false" />',
    );
    const problems = checker.checkLocalRelayNetworkSecurityConfig(bad);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('localhost');
  });
});

describe('the two configurations', () => {
  it('does not let the loopback exception into the release build', () => {
    expect(checker.checkNetworkSecurityConfig(LOCAL_RELAY, GOOD_MANIFEST).length).toBeGreaterThan(0);
  });

  it('does not let the strict configuration into the development build', () => {
    expect(checker.checkLocalRelayNetworkSecurityConfig(RELEASE).length).toBeGreaterThan(0);
  });
});

describe('the config plugin', () => {
  it('writes a configuration that forbids cleartext', () => {
    const config = plugin.RELEASE_NETWORK_SECURITY_CONFIG;

    expect(typeof config).toBe('string');
    expect(checker.checkNetworkSecurityConfig(config, GOOD_MANIFEST)).toEqual([]);
  });

  it('writes a configuration that permits cleartext to the loopback interface only', () => {
    const config = plugin.LOCAL_RELAY_NETWORK_SECURITY_CONFIG;

    expect(typeof config).toBe('string');
    expect(checker.checkLocalRelayNetworkSecurityConfig(config)).toEqual([]);
    expect(checker.checkNetworkSecurityConfig(config, GOOD_MANIFEST).length).toBeGreaterThan(0);
  });

  describe('the files it writes', () => {
    let projectRoot: string;

    beforeEach(async () => {
      projectRoot = await mkdtemp(join(tmpdir(), 'network-security-config-'));
    });

    afterEach(async () => {
      await rm(projectRoot, { recursive: true, force: true });
    });

    it('puts the strict configuration in the main source set and the exception in the development ones', async () => {
      const written = await plugin.writeNetworkSecurityConfigs(projectRoot);

      // The main source set, the debug one, and the debugOptimized one that
      // React Native's Gradle plugin registers with a source set of its own.
      expect(written).toHaveLength(3);

      const release = await readFile(
        join(projectRoot, 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml'),
        'utf8',
      );
      const debug = await readFile(
        join(projectRoot, 'app', 'src', 'debug', 'res', 'xml', 'network_security_config.xml'),
        'utf8',
      );
      const debugOptimized = await readFile(
        join(
          projectRoot,
          'app',
          'src',
          'debugOptimized',
          'res',
          'xml',
          'network_security_config.xml',
        ),
        'utf8',
      );

      expect(release).toBe(plugin.RELEASE_NETWORK_SECURITY_CONFIG);
      expect(debug).toBe(plugin.LOCAL_RELAY_NETWORK_SECURITY_CONFIG);
      expect(debugOptimized).toBe(plugin.LOCAL_RELAY_NETWORK_SECURITY_CONFIG);

      // The main source set is the one every build inherits, so it is the one
      // that has to forbid cleartext.
      expect(checker.checkNetworkSecurityConfig(release, GOOD_MANIFEST)).toEqual([]);
      expect(checker.checkLocalRelayNetworkSecurityConfig(debug)).toEqual([]);
      expect(checker.checkLocalRelayNetworkSecurityConfig(debugOptimized)).toEqual([]);
    });
  });
});
