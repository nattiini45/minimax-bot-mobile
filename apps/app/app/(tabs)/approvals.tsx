import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../src/components/Button';
import { Card, EmptyState, SectionHeader } from '../../src/components/primitives';
import { notifyWarning, tapMedium } from '../../src/native/haptics';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/**
 * Approvals.
 *
 * A turn that stops for a permission check or a questionnaire belongs to the desktop,
 * not to the socket, so it stays here until it is answered — even if the app was closed.
 */
export default function ApprovalsScreen() {
  const theme = useTheme();
  const approvals = useAppStore((state) => state.approvals);
  const questions = useAppStore((state) => state.questions);
  const decided = useAppStore((state) => state.decided);
  const respondPermission = useAppStore((state) => state.respondPermission);
  const request = useAppStore((state) => state.request);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader title={`Permissions (${approvals.length})`} />
      {approvals.length === 0 ? (
        <Card>
          <EmptyState icon="✓" title="Nothing waiting" body="Approval requests appear here." />
        </Card>
      ) : (
        approvals.map((approval) => (
          <Card key={approval.requestId} style={styles.item}>
            <Text style={[styles.itemTitle, { color: theme.colors.ink }]}>{approval.toolName}</Text>
            <Text style={[styles.itemMeta, { color: theme.colors.muted }]}>{approval.reason}</Text>
            {approval.toolInput ? (
              <View style={[styles.code, { backgroundColor: theme.colors.bg, borderColor: theme.colors.line }]}>
                <Text style={[styles.codeText, { color: theme.colors.ink }]}>{approval.toolInput}</Text>
              </View>
            ) : null}
            <View style={styles.actions}>
              <Button
                label={decided[approval.requestId] ? 'Decided' : 'Deny'}
                variant="ghost"
                size="sm"
                disabled={Boolean(decided[approval.requestId])}
                onPress={() => {
                  tapMedium();
                  respondPermission(approval.requestId, 'deny');
                }}
              />
              <Button
                label={decided[approval.requestId] ? 'Decided' : 'Allow once'}
                variant="primary"
                size="sm"
                disabled={Boolean(decided[approval.requestId])}
                onPress={() => {
                  tapMedium();
                  respondPermission(approval.requestId, 'allowOnce');
                }}
              />
            </View>
          </Card>
        ))
      )}

      {questions.length > 0 ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title={`Questions (${questions.length})`} />
          {questions.map((question) => (
            <Card key={question.requestId} style={styles.item}>
              <Text style={[styles.itemTitle, { color: theme.colors.ink }]}>
                {question.title ?? 'The team needs an answer'}
              </Text>
              {question.steps.map((step) => (
                <View key={step.id} style={styles.step}>
                  <Text style={[styles.stepQuestion, { color: theme.colors.ink }]}>{step.question}</Text>
                  {step.options.map((option) => (
                    <Button
                      key={option.id}
                      label={option.label}
                      variant="secondary"
                      size="sm"
                      style={styles.option}
                      onPress={() => {
                        notifyWarning();
                        request('op.answer_question', {
                          requestId: question.requestId,
                          answers: [
                            {
                              stepId: step.id,
                              selectedOptionIds: [option.id],
                              selectedOther: false,
                            },
                          ],
                        });
                      }}
                    />
                  ))}
                </View>
              ))}
            </Card>
          ))}
        </>
      ) : null}
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
  item: {
    marginBottom: 10,
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  itemMeta: {
    fontSize: 13,
    marginTop: 3,
    lineHeight: 19,
  },
  code: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  codeText: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  step: {
    marginTop: 12,
  },
  stepQuestion: {
    fontSize: 14,
    fontWeight: '500',
    marginBottom: 8,
  },
  option: {
    alignSelf: 'flex-start',
    marginBottom: 6,
  },
});
