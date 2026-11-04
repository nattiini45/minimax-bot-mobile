import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { useReducedMotion } from './useReducedMotion';
import { useTheme } from '../theme';

/** One thing a picker can be set to. */
export interface PickerOption {
  /** What is sent when it is chosen. */
  value: string;
  /** What it is called on screen. */
  label: string;
  /** A line under the label: what the choice means. */
  description?: string;
  /**
   * The desktop does not offer this any more.
   *
   * It is still shown, so a setting that was made on the desktop is not silently lost
   * when the phone cannot offer it.
   */
  flagged?: boolean;
}

/**
 * A choice out of a list.
 *
 * The desktop decides what the choices are: a model, a reasoning effort, a skill. The
 * phone only shows them, so a setting can never be typed into something the desktop
 * does not understand.
 */
export function Picker({
  label,
  value,
  options,
  onChange,
  emptyLabel = 'Not available on this desktop',
  accessibilityLabel,
}: {
  label: string;
  /** The value that is in force. */
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  emptyLabel?: string;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const current = options.find((option) => option.value === value);

  return (
    <View>
      <Text style={[styles.label, { color: theme.colors.muted }]}>{label}</Text>
      <Pressable
        onPress={() => { if (options.length) setOpen(true); }}
        disabled={options.length === 0}
        accessibilityHint={options.length === 0 ? emptyLabel : undefined}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityState={{ expanded: open, disabled: options.length === 0 }}
        style={({ pressed }) => [
          styles.value,
          {
            backgroundColor: theme.colors.bg,
            borderColor: theme.colors.line,
            opacity: options.length ? (pressed ? 0.7 : 1) : 0.6,
          },
        ]}
      >
        <Text
          style={[styles.valueText, { color: theme.colors.ink }]}
          numberOfLines={1}
        >
          {options.length ? (current?.label ?? value) : emptyLabel}
        </Text>
        <Icon name="chevron" size={16} color={theme.colors.subtle} style={styles.chevron} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType={reducedMotion ? 'none' : 'slide'}
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={() => setOpen(false)}
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.line },
          ]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: theme.colors.line }]}>
            <Text style={[styles.sheetTitle, { color: theme.colors.ink }]}>{label}</Text>
            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [
                styles.close,
                { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
              ]}
            >
              <Icon name="close" size={18} color={theme.colors.muted} />
            </Pressable>
          </View>
          <ScrollView>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={option.label}
                  style={({ pressed }) => [
                    styles.option,
                    {
                      backgroundColor: pressed ? theme.colors.hover : 'transparent',
                      borderBottomColor: theme.colors.line,
                    },
                  ]}
                >
                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, { color: theme.colors.ink }]}>
                      {option.label}
                    </Text>
                    {option.description ? (
                      <Text style={[styles.optionDescription, { color: theme.colors.muted }]}>
                        {option.description}
                      </Text>
                    ) : null}
                    {option.flagged ? (
                      <Text style={[styles.optionDescription, { color: theme.colors.warning }]}>
                        The desktop does not offer this any more.
                      </Text>
                    ) : null}
                  </View>
                  {selected ? <Icon name="check" size={18} color={theme.colors.accent} /> : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginTop: 14,
  },
  value: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  valueText: {
    flex: 1,
    fontSize: 15,
  },
  chevron: {
    transform: [{ rotate: '45deg' }],
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '75%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  optionText: {
    flex: 1,
  },
  optionLabel: {
    fontSize: 15,
  },
  optionDescription: {
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
});
