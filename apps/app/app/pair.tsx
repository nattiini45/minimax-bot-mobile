import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '../src/components/Button';
import { Card, SectionHeader } from '../src/components/primitives';
import { notifySuccess, tapMedium } from '../src/native/haptics';
import { pairWithCode } from '../src/net/pairing';
import { resolvePairingTarget, untrustedRelayWarning } from '../src/net/pairing-target';
import { isValidRelayUrl, relayOrigin } from '../src/net/relay-url';
import { loadLastRelayUrl } from '../src/state/credential-store';
import { useTheme } from '../src/theme';
import { connectRelay, useAppStore } from '../src/state/store';

/**
 * Pairing.
 *
 * The desktop shows a six digit code; the phone types it here. The relay exchanges the
 * code for a device scoped token, and that token is the only credential this app holds.
 */
/**
 * The relay address the app offers by default.
 *
 * `EXPO_PUBLIC_RELAY_URL` is inlined into the bundle at build time, so a published
 * build can point at one relay without the user typing it. It stays editable: a
 * self-hosted relay is still one field away.
 */
const DEFAULT_RELAY_URL = process.env.EXPO_PUBLIC_RELAY_URL ?? '';

export default function PairScreen() {
  const theme = useTheme();
  const router = useRouter();
  const setSession = useAppStore((state) => state.setSession);
  const setError = useAppStore((state) => state.setError);

  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [accountId, setAccountId] = useState('default');
  const [code, setCode] = useState('');
  const [error, setErrorState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The relay this phone was last paired with, when it has paired before. */
  const [lastRelayUrl, setLastRelayUrl] = useState<string | null>(null);
  /** The origin the user has acknowledged, for this address only. */
  const [acknowledged, setAcknowledged] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadLastRelayUrl().then((url) => {
      if (!alive) return;
      setLastRelayUrl(url);
      // A build without a fixed address still knows the relay it was last paired with,
      // so the field starts where the phone was rather than empty.
      if (!DEFAULT_RELAY_URL && url) setRelayUrl(url);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The two addresses this phone can compare a destination against: the one this
   * build was made for, and the one it was last paired with.
   */
  const known = useMemo(
    () => ({
      buildOrigin: DEFAULT_RELAY_URL ? relayOrigin(DEFAULT_RELAY_URL) : null,
      lastOrigin: lastRelayUrl ? relayOrigin(lastRelayUrl) : null,
    }),
    [lastRelayUrl],
  );

  const target = useMemo(() => resolvePairingTarget(relayUrl, known), [relayUrl, known]);

  /**
   * Whether the code still needs to be acknowledged.
   *
   * The acknowledgement is for one address: changing the address takes it away, so a
   * confirmation for one relay never carries over to another.
   */
  const needsAcknowledgement = target.origin !== '' && !target.known && acknowledged !== target.origin;

  const pair = async () => {
    setBusy(true);
    setErrorState(null);
    try {
      if (!isValidRelayUrl(relayUrl)) {
        setErrorState('Enter the relay address, for example https://relay.example.workers.dev');
        setError('The relay address is not a valid URL.');
        return;
      }
      if (needsAcknowledgement) {
        setErrorState(untrustedRelayWarning(target));
        return;
      }
      const deviceId = `phone_${Math.random().toString(36).slice(2, 12)}`;
      const account = accountId.trim() || 'default';

      // There is no status check before pairing. The relay's status says whether
      // a desktop is attached to an account, and the account id is the room's
      // name - so a route that answered for any account would be a route that
      // could be used to find out which accounts exist. The relay refuses that
      // question without a credential, and the pairing attempt answers it
      // anyway: a code that no desktop is waiting for is refused as one.
      const result = await pairWithCode({
        url: relayUrl.trim(),
        accountId: account,
        code: code.trim(),
        deviceId,
        deviceName: 'Phone',
        clientVersion: '0.1.0',
        known,
        confirmed: acknowledged !== null && acknowledged === target.origin,
      });

      if (!result.ok || !result.deviceToken) {
        setErrorState(result.message ?? 'The relay refused the pairing request.');
        setError(result.message ?? 'Pairing failed.');
        return;
      }

      const session = {
        relayUrl: relayUrl.trim().replace(/\/+$/, ''),
        accountId: account,
        deviceId,
        deviceToken: result.deviceToken,
        deviceName: 'Phone',
      };
      setSession(session);
      connectRelay(session);
      notifySuccess();
      router.back();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Pairing failed.';
      setErrorState(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader title="Relay" />
      <Card>
        <Text style={[styles.hint, { color: theme.colors.muted }]}>
          The relay is the address of the small server that carries frames between this phone and
          your desktop. Ask the MiniMax Bot Bridge window for it, or set it up yourself.
        </Text>
        <TextInput
          value={relayUrl}
          onChangeText={(value) => {
            setRelayUrl(value);
            // The acknowledgement is for one address, so it does not follow the field.
            setAcknowledged(null);
          }}
          placeholder="https://relay.example.workers.dev"
          placeholderTextColor={theme.colors.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="Relay URL"
        />
        {target.origin ? (
          <Text style={[styles.hint, { color: theme.colors.muted }]}>
            The code is sent to {target.origin}.
          </Text>
        ) : null}
        {needsAcknowledgement ? (
          <View style={[styles.warning, { borderColor: theme.colors.warning }]}>
            <Text style={[styles.warningTitle, { color: theme.colors.warning }]}>A different relay</Text>
            <Text style={[styles.warningBody, { color: theme.colors.muted }]}>
              {untrustedRelayWarning(target)}
            </Text>
            <Button
              label={`Send the code to ${target.origin} anyway`}
              variant="secondary"
              onPress={() => {
                tapMedium();
                setAcknowledged(target.origin);
              }}
            />
          </View>
        ) : null}
        <Text style={[styles.hint, { color: theme.colors.muted }]}>
          The account id names the room your desktop and this phone share. The MiniMax Bot Bridge
          window shows it, next to the relay address.
        </Text>
        <TextInput
          value={accountId}
          onChangeText={setAccountId}
          placeholder="account id"
          placeholderTextColor={theme.colors.subtle}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="Account id"
        />
      </Card>

      <View style={{ height: 20 }} />
      <SectionHeader title="Pairing code" />
      <Card>
        <Text style={[styles.hint, { color: theme.colors.muted }]}>
          Open MiniMax Bot Bridge on your desktop and generate a code. It is valid for ninety
          seconds and can be used once.
        </Text>
        <TextInput
          value={code}
          onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          placeholderTextColor={theme.colors.subtle}
          keyboardType="number-pad"
          inputMode="numeric"
          autoComplete={undefined}
          style={[
            styles.code,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: 26,
            },
          ]}
          accessibilityLabel="Pairing code"
        />
        {error ? <Text style={[styles.error, { color: theme.colors.danger }]}>{error}</Text> : null}
        <View style={styles.actions}>
          <Button
            label="Pair"
            variant="primary"
            busy={busy}
            disabled={!relayUrl.trim() || code.trim().length !== 6 || needsAcknowledgement}
            onPress={() => {
              tapMedium();
              void pair();
            }}
          />
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  input: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 10,
  },
  code: {
    minHeight: 60,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 12,
    letterSpacing: 10,
    textAlign: 'center',
  },
  error: {
    fontSize: 13,
    marginTop: 8,
  },
  warning: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  warningBody: {
    fontSize: 13,
    lineHeight: 19,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
});
