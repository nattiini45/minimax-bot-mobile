import { describe, expect, it } from 'vitest';

import {
  AGENT_BACKED_OPS,
  BRIDGE_LOCAL_OPS,
  EVENT_TYPES,
  OP_TOOL,
  OP_TYPES,
  TEAM_TOOLS,
  generatePairingCode,
  isEventType,
  isOpType,
  isValidClientMessageId,
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
    const tools = new Set(TEAM_TOOLS);
    for (const tool of [
      'list_team',
      'message_bot',
      'dispatch_tasks',
      'get_tasks',
      'cancel_tasks',
      'post_group',
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

  it('maps the 21-tool surface exactly once', () => {
    expect(TEAM_TOOLS).toHaveLength(21);
    expect(new Set(TEAM_TOOLS).size).toBe(21);
  });

  it('never classifies one operation as both tool backed and agent backed', () => {
    const toolOps = new Set<string>(Object.keys(OP_TOOL));
    for (const op of AGENT_BACKED_OPS) {
      expect(toolOps.has(op)).toBe(false);
    }
  });

  it('classifies every operation exactly once', () => {
    const classified = [
      ...Object.keys(OP_TOOL),
      ...AGENT_BACKED_OPS,
      ...BRIDGE_LOCAL_OPS,
    ] as string[];
    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified).size).toBe(OP_TYPES.length);
  });
});

describe('pairing codes', () => {  it('generates six digits', () => {
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

describe('client chosen message ids', () => {
  it('accepts a short, unambiguous id', () => {
    expect(isValidClientMessageId('local_abc123')).toBe(true);
    expect(isValidClientMessageId('m-1')).toBe(true);
    expect(isValidClientMessageId('A_b-9')).toBe(true);
  });

  it('refuses an id the bridge must not store', () => {
    expect(isValidClientMessageId('')).toBe(false);
    expect(isValidClientMessageId('has space')).toBe(false);
    expect(isValidClientMessageId('has/slash')).toBe(false);
    expect(isValidClientMessageId('has:colon')).toBe(false);
    expect(isValidClientMessageId('x'.repeat(65))).toBe(false);
    expect(isValidClientMessageId(undefined)).toBe(false);
    expect(isValidClientMessageId(42)).toBe(false);
  });
});
