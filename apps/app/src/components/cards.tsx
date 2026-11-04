import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { QuestionAnswer } from '@minimax-bot/protocol';

import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Card } from './primitives';
import { useTheme } from '../theme';
import type { AppPermission, AppQuestion } from '../state/store';
import { OwnerBoundary, useOwnerGuard } from '../state/OwnerBoundary';
import { own } from '../state/retention';
import { validPendingRequest } from '../state/render-requests';

/**
 * The cards a conversation is made of.
 *
 * A thread is not only words: a Bot asks for permission, asks a question and runs
 * tools, and each of those is something the user acts on. So each of them is a card —
 * a surface with a title, a body and the controls that answer it — and the card is
 * shown where it was asked, in the thread that is waiting for it.
 */

/** How a card names itself. */
export interface CardFrameProps {
  icon: IconName;
  title: string;
  subtitle?: string;
  tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success';
  children?: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * The frame every card shares: an icon, a title and a body.
 */
export function CardFrame({
  icon,
  title,
  subtitle,
  tone = 'neutral',
  children,
  footer,
}: CardFrameProps) {
  const theme = useTheme();
  const accent =
    tone === 'accent'
      ? theme.colors.accent
      : tone === 'warning'
        ? theme.colors.warning
        : tone === 'danger'
          ? theme.colors.danger
          : tone === 'success'
            ? theme.colors.success
            : theme.colors.muted;
  return (
    <Card style={styles.frame}>
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: theme.colors.accentSoft }]}>
          <Icon name={icon} size={16} color={accent} />
        </View>
        <View style={styles.headText}>
          <Text style={[styles.title, { color: theme.colors.ink }]} numberOfLines={2}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: theme.colors.muted }]} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      </View>
      {children}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </Card>
  );
}

/**
 * A permission the Bot asked for, with the two answers it can be given.
 *
 * The decision is made here, on the phone, and the card is disabled the moment it is
 * made: a second tap would be a second answer for the same request.
 */
export function ApprovalCard(props: React.ComponentProps<typeof ApprovalContent>) {
  if (!validPendingRequest(props.request, false)) return <CardFrame icon="approvals" title="Approval unavailable" />;
  return <OwnerBoundary><ApprovalContent key={props.request.requestId} {...props} /></OwnerBoundary>;
}

function ApprovalContent({
  request,
  onDecide,
  decided,
}: {
  request: AppPermission;
  onDecide: (decision: 'allowOnce' | 'deny') => void;
  decided?: string;
}) {
  const theme = useTheme();
  const isCurrentOwner = useOwnerGuard();
  const settled = decided !== undefined;
  const uncertain = decided === 'uncertain';
  const pending = decided === 'pending';
  return (
    <CardFrame
      icon="approvals"
      tone={settled ? 'neutral' : 'warning'}
      title={uncertain ? 'Approval delivery uncertain' : pending ? 'Sending decision' : settled ? 'Permission answered' : `${request.toolName} needs your approval`}
      subtitle={settled ? undefined : request.reason}
    >
      {request.toolInput ? (
        <View style={[styles.code, { backgroundColor: theme.colors.code, borderColor: theme.colors.line }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Text style={[styles.codeText, { color: theme.colors.ink }]}>{request.toolInput}</Text>
          </ScrollView>
        </View>
      ) : null}
      {settled ? (
        <Text style={[styles.answered, { color: theme.colors.muted }]}>
          {uncertain ? 'The desktop has not confirmed this decision. Check the desktop; do not answer again.' : pending ? 'Waiting for the desktop to confirm delivery.' : decided === 'deny' ? 'You denied this.' : 'You allowed this once.'}
        </Text>
      ) : (
        <View style={styles.actions}>
          <Button
            label="Deny"
            variant="danger"
            size="sm"
            onPress={() => { if (isCurrentOwner()) onDecide('deny'); }}
            accessibilityHint="Refuses the tool call"
          />
          <Button
            label="Allow once"
            variant="primary"
            size="sm"
            onPress={() => { if (isCurrentOwner()) onDecide('allowOnce'); }}
            accessibilityHint="Lets the tool run this once"
          />
        </View>
      )}
    </CardFrame>
  );
}

/**
 * A question the Bot asked, with its options as things to tap.
 *
 * A question with options is a question with a right answer to tap, not one to type:
 * the options are buttons, and a free-text answer is there as well, because the Host
 * accepts one for every step.
 *
 * A questionnaire can have more than one step, and the run that is waiting for it
 * wants an answer for each of them, so every step is shown and every step is answered.
 * A step the user leaves alone is answered as skipped rather than left out.
 */
export function QuestionCard(props: React.ComponentProps<typeof QuestionContent>) {
  if (!validPendingRequest(props.request, true)) return <CardFrame icon="approvals" title="Question unavailable" />;
  return <OwnerBoundary><QuestionContent key={props.request.requestId} {...props} /></OwnerBoundary>;
}

function QuestionContent({
  request,
  onAnswer,
  decided,
}: {
  request: AppQuestion;
  onAnswer: (answers: QuestionAnswer[]) => void;
  decided?: string;
}) {
  const theme = useTheme();
  const isCurrentOwner = useOwnerGuard();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});

  const steps = request.steps ?? [];

  const toggle = (step: AppQuestion['steps'][number], optionId: string) => {
    setPicked((state) => {
      const current = own(state, step.id) ?? [];
      if (step.selectionMode === 'multiple') {
        return {
          ...state,
          [step.id]: current.includes(optionId)
            ? current.filter((id) => id !== optionId)
            : [...current, optionId],
        };
      }
      // A step that takes one answer holds one option: picking another replaces it,
      // and picking the one it holds lets it go.
      return { ...state, [step.id]: current.includes(optionId) ? [] : [optionId] };
    });
    // A chosen option and a typed answer are the same answer in two forms, so the
    // other one goes when one of them is given.
    setTyped((state) => {
      const next = { ...state };
      delete next[step.id];
      return next;
    });
  };

  const type = (step: AppQuestion['steps'][number], value: string) => {
    setTyped((state) => ({ ...state, [step.id]: value }));
    setPicked((state) => {
      const next = { ...state };
      delete next[step.id];
      return next;
    });
  };

  const answers = useMemo<QuestionAnswer[]>(
    () =>
      steps.map((step) => {
        const options = own(picked, step.id) ?? [];
        if (options.length) {
          return { stepId: step.id, selectedOptionIds: options, selectedOther: false };
        }
        const text = (own(typed, step.id) ?? '').trim();
        if (text) {
          return { stepId: step.id, selectedOptionIds: [], selectedOther: true, otherText: text };
        }
        return { stepId: step.id, selectedOptionIds: [], selectedOther: false, skipped: true };
      }),
    [picked, steps, typed],
  );

  const answered = answers.some((answer) => !answer.skipped);

  if (decided !== undefined) {
    return (
      <CardFrame icon="approvals" title={decided === 'uncertain' ? 'Answer delivery uncertain' : decided === 'pending' ? 'Sending answer' : 'Answered'} subtitle={request.title} tone="neutral">
        <Text style={[styles.answered, { color: theme.colors.muted }]}>
          {decided === 'uncertain' ? 'The desktop has not confirmed this answer. Check the desktop; do not answer again.' : decided === 'pending' ? 'Waiting for the desktop to confirm delivery.' : 'You answered this.'}
        </Text>
      </CardFrame>
    );
  }

  if (steps.length === 0) {
    return (
      <CardFrame icon="approvals" title={request.title ?? 'The Bot asked a question'} tone="accent" />
    );
  }

  return (
    <CardFrame
      icon="approvals"
      tone="accent"
      title={request.title ?? steps[0]?.question ?? 'The Bot asked a question'}
      subtitle={steps.length > 1 ? `${steps.length} questions` : steps[0]?.description}
    >
      {steps.map((step, index) => {
        const chosen = own(picked, step.id) ?? [];
        return (
          <View key={step.id} style={styles.step}>
            {steps.length > 1 ? (
              <Text style={[styles.stepCount, { color: theme.colors.muted }]}>
                {index + 1} of {steps.length}
              </Text>
            ) : null}
            <Text style={[styles.question, { color: theme.colors.ink }]}>{step.question}</Text>
            {steps.length > 1 && step.description ? (
              <Text style={[styles.stepNote, { color: theme.colors.muted }]}>{step.description}</Text>
            ) : null}
            <View style={styles.options}>
              {step.options.map((option) => {
                const selected = chosen.includes(option.id);
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => toggle(step, option.id)}
                    style={[
                      styles.option,
                      {
                        backgroundColor: selected ? theme.colors.accentSoft : theme.colors.sunken,
                        borderColor: selected ? theme.colors.accent : theme.colors.line,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={option.label}
                  >
                    <Text style={[styles.optionLabel, { color: theme.colors.ink }]}>{option.label}</Text>
                    {option.description ? (
                      <Text style={[styles.optionNote, { color: theme.colors.muted }]}>{option.description}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={own(typed, step.id) ?? ''}
              onChangeText={(value) => type(step, value)}
              placeholder="Or write your own answer"
              placeholderTextColor={theme.colors.subtleText}
              style={[
                styles.input,
                { color: theme.colors.ink, backgroundColor: theme.colors.sunken, borderColor: theme.colors.line },
              ]}
              accessibilityLabel={`Your answer to: ${step.question}`}
            />
          </View>
        );
      })}
      <View style={styles.actions}>
        <Button
          label="Send answer"
          variant="primary"
          size="sm"
          disabled={!answered}
          onPress={() => { if (isCurrentOwner()) onAnswer(answers); }}
        />
      </View>
    </CardFrame>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: 14,
    gap: 10,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  badge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headText: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
  },
  code: {
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
  },
  codeText: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  answered: {
    fontSize: 12,
  },
  footer: {
    marginTop: 2,
  },
  options: {
    gap: 6,
  },
  step: {
    gap: 6,
  },
  stepCount: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  question: {
    fontSize: 14,
    fontWeight: '500',
  },
  stepNote: {
    fontSize: 12,
  },
  option: {
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 2,
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '500',
  },
  optionNote: {
    fontSize: 12,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  activity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  activityName: {
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  activityNote: {
    fontSize: 11,
  },
});
