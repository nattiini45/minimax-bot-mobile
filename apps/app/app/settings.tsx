import { useRouter } from 'expo-router';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../src/components/Button';
import { Card, Pill, SectionHeader } from '../src/components/primitives';
import { NavRow } from '../src/components/ConnectionBanner';
import { tapMedium } from '../src/native/haptics';
import { useTheme } from '../src/theme';
import { disconnectRelay, useAppStore } from '../src/state/store';

const STATUS_LABEL: Record<string, string> = {
  idle: 'idle',
  connecting: 'connecting',
  online: 'online',
  offline: 'offline',
};

export default function SettingsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const session = useAppStore((state) => state.session);
  const status = useAppStore((state) => state.status);
  const bridgeOnline = useAppStore((state) => state.bridgeOnline);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const setSession = useAppStore((state) => state.setSession);
  const setError = useAppStore((state) => state.setError);

  const unpair = () => {
    tapMedium();
    disconnectRelay();
    setSession(null);
    setError(null);
    router.back();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader title="Connection" />
      <Card>
        <View style={styles.statusRow}>
          <Text style={[styles.statusLabel, { color: theme.colors.muted }]}>Relay</Text>
          <Pill
            label={STATUS_LABEL[status] ?? status}
            tone={status === 'online' ? 'success' : status === 'offline' ? 'danger' : 'neutral'}
          />
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusLabel, { color: theme.colors.muted }]}>Desktop</Text>
          <Pill label={bridgeOnline ? 'online' : 'offline'} tone={bridgeOnline ? 'success' : 'warning'} />
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusLabel, { color: theme.colors.muted }]}>Team tools</Text>
          <Pill
            label={diagnostics.teamToolsAvailable ? String(diagnostics.toolCount) : 'not linked'}
            tone={diagnostics.teamToolsAvailable ? 'success' : 'warning'}
          />
        </View>
        <View style={styles.statusRow}>
          <Text style={[styles.statusLabel, { color: theme.colors.muted }]}>Agent</Text>
          <Pill
            label={diagnostics.agentAvailable ? 'available' : 'unavailable'}
            tone={diagnostics.agentAvailable ? 'success' : 'warning'}
          />
        </View>
      </Card>

      {session ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title="Desktop" />
          <Card>
            <Text style={[styles.value, { color: theme.colors.ink }]}>{session.relayUrl}</Text>
            <Text style={[styles.value, { color: theme.colors.muted }]}>account {session.accountId}</Text>
            <Text style={[styles.value, { color: theme.colors.subtle }]}>device {session.deviceId}</Text>
          </Card>
        </>
      ) : null}

      <View style={{ height: 20 }} />
      <SectionHeader title="Actions" />
      <Card>
        <NavRow
          title={session ? 'Pair another phone' : 'Pair this phone'}
          subtitle="Generate a code on the desktop and type it in"
          onPress={() => router.push('/pair')}
        />
        {session ? (
          <View style={styles.danger}>
            <Button label="Unpair this phone" variant="danger" onPress={unpair} />
          </View>
        ) : null}
      </Card>

      <View style={{ height: 20 }} />
      <SectionHeader title="About" />
      <Card>
        <Text style={[styles.value, { color: theme.colors.ink }]}>MiniMax Bot</Text>
        <Text style={[styles.value, { color: theme.colors.muted }]}>
          A native client for the @minimax-bot team. The desktop stays in charge; this app is a
          projection of it.
        </Text>
        <Text style={[styles.value, { color: theme.colors.subtle }]}>Protocol version 1</Text>
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  statusLabel: {
    fontSize: 14,
  },
  value: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 6,
  },
  danger: {
    alignItems: 'flex-end',
    marginTop: 16,
  },
});
