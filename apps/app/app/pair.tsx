import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '../src/components/Button';
import { Card, SectionHeader } from '../src/components/primitives';
import { notifySuccess, tapMedium } from '../src/native/haptics';
import { pairWithCode, relayStatus } from '../src/net/pairing';
import { isValidRelayUrl } from '../src/net/relay-url';
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

  const pair = async () => {
    setBusy(true);
    setErrorState(null);
    try {
      if (!isValidRelayUrl(relayUrl)) {
        setErrorState('Enter the relay address, for example https://relay.example.workers.dev');
        setError('The relay address is not a valid URL.');
        return;
      }
      const deviceId = `phone_${Math.random().toString(36).slice(2, 12)}`;
      const account = accountId.trim() || 'default';

      // A relay holds one room per account. If no desktop is online on the
      // account, the phone has the wrong one — and a pairing code for another
      // room would not help. Say so, instead of failing on the code.
      const status = await relayStatus(relayUrl.trim(), account);
      if (status && !status.bridgeOnline) {
        setErrorState(`No desktop is online on account "${account}". Check the account id in the MiniMax Bot Bridge window.`);
        setError('No desktop is online on that account.');
        return;
      }

      const result = await pairWithCode({
        url: relayUrl.trim(),
        accountId: account,
        code: code.trim(),
        deviceId,
        deviceName: 'Phone',
        clientVersion: '0.1.0',
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
          onChangeText={setRelayUrl}
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
            disabled={!relayUrl.trim() || code.trim().length !== 6}
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
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
});
