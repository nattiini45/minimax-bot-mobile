import { describe, expect, it } from 'vitest';

import {
  EVENT_TYPES,
  OP_TOOL,
  OP_TYPES,
  generatePairingCode,
  isEventType,
  isOpType,
  isValidPairingCode,
} from '../src/index.js';

describe('opcode catalogue', () => {
  it('exposes every operation the plan requires', () => {
    const required = [
      'op.list_team',
      'op.send_message',
      'op.abort_turn',
      'op.dispatch',
      'op.list_tasks',
      'op.cancel_task',
      'op.list_helpers',
      'op.start_helper',
      'op.stop_helper',
      'op.recall',
      'op.remember',
      'op.forget',
      'op.create_bot',
      'op.update_bot',
      'op.delete_bot',
      'op.create_group',
      'op.update_group',
      'op.delete_group',
      'op.list_schedules',
      'op.create_schedule',
      'op.delete_schedule',
      'op.get_usage',
      'op.respond_permission',
      'op.answer_question',
      'op.react',
    ] as const;

    for (const op of required) {
      expect(OP_TYPES).toContain(op);
      expect(isOpType(op)).toBe(true);
    }
  });

  it('exposes every event the client renders', () => {
    const required = [
      'evt.team_snapshot',
      'evt.message_chunk',
      'evt.message_committed',
      'evt.tool_started',
      'evt.tool_finished',
      'evt.turn_finished',
      'evt.permission_requested',
      'evt.permission_resolved',
      'evt.question_requested',
      'evt.question_answered',
      'evt.task_updated',
      'evt.helper_updated',
      'evt.schedule_updated',
      'evt.bridge_status',
    ] as const;

    for (const evt of required) {
      expect(EVENT_TYPES).toContain(evt);
      expect(isEventType(evt)).toBe(true);
    }
  });

  it('does not treat an event as an operation', () => {
    expect(isOpType('evt.team_snapshot')).toBe(false);
    expect(isEventType('op.list_team')).toBe(false);
  });
});

describe('operation to tool mapping', () => {
  it('maps every team-backed operation to a team tool', () => {
    for (const [op, tool] of Object.entries(OP_TOOL)) {
      expect(tool).toMatch(/^[a-z_]+$/);
      expect(isOpType(op)).toBe(true);
    }
  });

  it('covers the whole team tool surface', () => {
    const tools = new Set(Object.values(OP_TOOL));
    for (const tool of [
      'list_team',
      'message_bot',
      'dispatch_tasks',
      'get_tasks',
      'cancel_tasks',
      'list_helpers',
      'start_helper',
      'stop_helper',
      'recall',
      'remember',
      'forget',
      'create_bot',
      'update_bot',
      'delete_bot',
      'create_group',
      'update_group',
      'delete_group',
      'list_schedules',
      'create_schedule',
      'delete_schedule',
    ]) {
      expect(tools.has(tool)).toBe(true);
    }
  });
});

describe('pairing codes', () => {
  it('generates six digits', () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
  });

  it('validates the format strictly', () => {
    expect(isValidPairingCode('123456')).toBe(true);
    expect(isValidPairingCode('12345')).toBe(false);
    expect(isValidPairingCode('1234567')).toBe(false);
    expect(isValidPairingCode('12345a')).toBe(false);
    expect(isValidPairingCode('')).toBe(false);
  });

  it('can be driven by an injected random source', () => {
    expect(generatePairingCode(() => 0)).toBe('000000');
    expect(generatePairingCode(() => 0.999999)).toBe('999999');
  });
});
