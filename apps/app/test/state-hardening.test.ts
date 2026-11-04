import AsyncStorage from '@react-native-async-storage/async-storage';
import { createFrame } from '@minimax-bot/protocol';
import { connectRelay, disconnectRelay, loadOutbox, unpairPhone, useAppStore } from '../src/state/store';

const A = { relayUrl: 'https://relay-a.example', accountId: 'default', deviceId: 'a', deviceToken: 'ta', deviceName: 'Phone' };
const B = { ...A, relayUrl: 'https://relay-b.example', deviceId: 'b', deviceToken: 'tb' };
const originalFetch = global.fetch;
const originalSocket = global.WebSocket;
let sockets: Socket[] = [];
class Socket {
  readyState = 0;
  sent: any[] = [];
  onopen?: () => void;
  onclose?: (event: { code: number }) => void;
  onmessage?: (event: { data: string }) => void;
  constructor(readonly url: string) { sockets.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  end() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
}
const tick = async () => { for (let i = 0; i < 2000; i++) await Promise.resolve(); };
const evt = (type: string, payload: unknown, seq?: number) => ({ ...createFrame({ type, payload, source: 'bridge' }), ...(seq === undefined ? {} : { seq }) });
async function connected(session = A, bridgeOnline = true) {
  useAppStore.getState().setSession(session);
  const phone = connectRelay(session);
  await tick();
  const socket = sockets.at(-1)!;
  socket.open();
  socket.deliver(createFrame({ type: 'hello.ok', source: 'relay', payload: { seq: 0, bridgeOnline, truncated: false } }));
  await tick();
  return { socket, phone };
}
beforeEach(async () => {
  jest.useFakeTimers();
  disconnectRelay();
  for (const pending of Object.values(useAppStore.getState().pendingOp)) clearTimeout(pending.timer);
  useAppStore.setState(useAppStore.getInitialState(), true);
  await AsyncStorage.clear();
  sockets = [];
  global.WebSocket = Socket as unknown as typeof WebSocket;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ticket: 'ticket' }) })) as unknown as typeof fetch;
});
afterEach(async () => {
  useAppStore.getState().setSession(null);
  disconnectRelay();
  await tick();
  jest.restoreAllMocks();
  jest.useRealTimers();
  global.fetch = originalFetch;
  global.WebSocket = originalSocket;
});

test.each([B, { ...A, deviceToken: 'new-credential' }, { ...A, deviceId: 'new-subject' }])('ownership changes clear private state and never dispatch an old outbox', async (next) => {
  useAppStore.getState().setSession(A);
  useAppStore.getState().sendChatMessage('bot:b1', 'private A');
  const result = useAppStore.getState().requestAsync('op.forget', {}).catch(e => e.message);
  useAppStore.getState().applyFrame(evt('evt.permission_requested', { request: { requestId: 'r' } }));
  useAppStore.setState({ pictures: { b1: 'private' }, usage: { totals: { turns: 10 } } as never });
  await connected(next);
  expect(useAppStore.getState().messages).toEqual({});
  expect(useAppStore.getState().approvals).toEqual([]);
  expect(useAppStore.getState().pictures).toEqual({});
  expect(useAppStore.getState().usage).toBeNull();
  expect(useAppStore.getState().pendingOp).toEqual({});
  expect(await result).toMatch(/session|account|link/i);
  expect(sockets.at(-1)!.sent.some(f => f.payload?.text === 'private A')).toBe(false);
});

test('same owner reconnect preserves unsent text and awaits an acknowledgement', async () => {
  useAppStore.getState().setSession(A);
  useAppStore.getState().sendChatMessage('bot:b1', 'keep me');
  const opId = useAppStore.getState().outbox[0]!.opId;
  const { socket } = await connected({ ...A, relayUrl: 'wss://relay-a.example:443/' });
  expect(socket.sent.filter(f => f.opId === opId)).toHaveLength(1);
  expect(useAppStore.getState().outbox.some(f => f.opId === opId)).toBe(true);
  socket.deliver(evt('ack', { opId }));
  expect(useAppStore.getState().outbox.some(f => f.opId === opId)).toBe(false);
});

test('bridge-offline hello holds mutations until actual bridge presence', async () => {
  useAppStore.getState().setSession(A);
  useAppStore.getState().sendChatMessage('bot:b1', 'wait');
  const { socket } = await connected(A, false);
  expect(socket.sent.some(f => f.type === 'op.send_message')).toBe(false);
  socket.deliver(evt('evt.bridge_status', { desktopOnline: true }));
  await tick();
  expect(socket.sent.filter(f => f.type === 'op.send_message')).toHaveLength(1);
});

test('written-but-unacknowledged text becomes recoverable uncertainty, never a blind new mutation', async () => {
  const { socket } = await connected();
  useAppStore.getState().sendChatMessage('bot:b1', 'possibly executed');
  await tick();
  const id = useAppStore.getState().messages['bot:b1']![0]!.messageId;
  const opId = socket.sent.find(f => f.type === 'op.send_message').opId;
  expect(useAppStore.getState().outbox.some(f => f.opId === opId)).toBe(true);
  socket.end();
  await jest.advanceTimersByTimeAsync(21000);
  const message = useAppStore.getState().messages['bot:b1']![0]! as any;
  expect(message.pending).toBe(false);
  expect(message.deliveryError).toMatch(/confirm|unknown|uncertain/i);
  expect(message.deliveryUncertain).toBe(true);
  expect(message.retryable).toBe(false);
  expect((useAppStore.getState() as any).retryMessage('bot:b1', id)).toBe(false);
  const next = sockets.at(-1)!; next.open();
  next.deliver(evt('hello.ok', { seq: 0, bridgeOnline: true }));
  expect(next.sent.some(f => f.type === 'op.send_message')).toBe(false);
  // A late commit still reconciles the recovered bubble by its stable message id.
  next.deliver(evt('evt.message_committed', { message: { messageId: id, chatId: 'bot:b1', role: 'user', text: 'possibly executed', ts: 5 } }));
  expect((useAppStore.getState().messages['bot:b1']![0] as any).deliveryError).toBeUndefined();
});

test('an unsent async mutation expires and can never execute on a later connection', async () => {
  useAppStore.getState().setSession(A);
  const outcome = useAppStore.getState().requestAsync('op.forget', { id: 'memory' }).catch(e => e.message);
  const opId = useAppStore.getState().outbox[0]!.opId;
  await jest.advanceTimersByTimeAsync(20001);
  expect(await outcome).toMatch(/not sent|timed out|time/i);
  const { socket } = await connected();
  expect(socket.sent.some(f => f.opId === opId)).toBe(false);
  expect(useAppStore.getState().pendingOp[opId]).toBeUndefined();
});

test('outbox eviction settles its optimistic text instead of a phantom pending bubble', () => {
  useAppStore.getState().setSession(A);
  for (let i = 0; i < 101; i++) useAppStore.getState().sendChatMessage('bot:b1', `text ${i}`);
  expect(useAppStore.getState().outbox).toHaveLength(100);
  const first = useAppStore.getState().messages['bot:b1']![0] as any;
  expect(first.text).toBe('text 0');
  expect(first.pending).toBe(false);
  expect(first.deliveryError).toBeTruthy();
  expect(first.retryable).toBe(true);
  expect(Object.keys(useAppStore.getState().optimisticByOp)).toHaveLength(100);
});

test('explicit rejection keeps recovery text and supports a guarded retry', async () => {
  const { socket } = await connected();
  useAppStore.getState().sendChatMessage('bot:b1', 'recover this', ['b2']);
  await tick();
  const opId = socket.sent.find(f => f.type === 'op.send_message').opId;
  socket.deliver(evt('err', { opId, message: 'Busy', retryable: true }));
  const message = useAppStore.getState().messages['bot:b1']![0] as any;
  expect(message.text).toBe('recover this');
  expect(message.deliveryError).toBe('Busy');
  expect(message.pending).toBe(false);
  expect((useAppStore.getState() as any).retryMessage('bot:b1', message.messageId)).toBe(true);
  expect((useAppStore.getState() as any).retryMessage('bot:b1', message.messageId)).toBe(false);
  await tick();
  expect(socket.sent.filter(f => f.type === 'op.send_message')[1].payload.mentions).toEqual(['b2']);
});

test.each(['permission', 'question'] as const)('written %s decisions remain quarantined after timeout until authoritative resolution', async kind => {
  const { socket } = await connected();
  const type = kind === 'permission' ? 'op.respond_permission' : 'op.answer_question';
  useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: 'r', steps: [] } }));
  const answer = () => kind === 'permission' ? useAppStore.getState().respondPermission('r', 'allowOnce') : useAppStore.getState().answerQuestion('r', []);
  answer(); await tick();
  expect(socket.sent.filter(f => f.type === type)).toHaveLength(1);
  const opId = socket.sent.find(f => f.type === type).opId;
  await jest.advanceTimersByTimeAsync(21000);
  expect(useAppStore.getState().decided.r).toBe('uncertain');
  expect(useAppStore.getState().decidedOps.r).toBe(opId);
  expect(useAppStore.getState()[kind === 'permission' ? 'approvals' : 'questions']).toHaveLength(1);
  expect(useAppStore.getState().lastError).toMatch(/confirm|unknown|uncertain/i);
  answer(); await tick();
  expect(socket.sent.filter(f => f.type === type)).toHaveLength(1);
  socket.deliver(evt(kind === 'permission' ? 'evt.permission_resolved' : 'evt.question_answered', { requestId: 'r' }));
  expect(useAppStore.getState().decided.r).toBeUndefined();
  expect(useAppStore.getState().decidedOps.r).toBeUndefined();
});

test.each(['permission', 'question'] as const)('AGENT_OUTCOME_UNKNOWN quarantines a %s answer while NOT_DISPATCHED permits retry', async kind => {
  const { socket } = await connected();
  const type = kind === 'permission' ? 'op.respond_permission' : 'op.answer_question';
  useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: 'r', steps: [] } }));
  const answer = () => kind === 'permission' ? useAppStore.getState().respondPermission('r', 'allowOnce') : useAppStore.getState().answerQuestion('r', []);
  answer(); await tick();
  const opId = socket.sent.find(f => f.type === type).opId;
  socket.deliver(evt('err', { opId, code: 'AGENT_OUTCOME_UNKNOWN', message: 'No definitive outcome', retryable: false }));
  answer(); await tick();
  expect(useAppStore.getState().decided.r).toBe('uncertain');
  expect(socket.sent.filter(f => f.type === type)).toHaveLength(1);
  socket.deliver(evt('err', { opId, code: 'NOT_DISPATCHED', message: 'Definitely not dispatched', retryable: true }));
  expect(useAppStore.getState().decided.r).toBeUndefined();
  answer(); await tick();
  expect(socket.sent.filter(f => f.type === type)).toHaveLength(2);
});

test('an unsent journal reservation wakes a replacement ready transport without resending a written message', async () => {
  const first = await connected();
  const save = AsyncStorage.setItem;
  let release!: () => void; let blocked = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
    if (!blocked && key === 'minimax-bot.outbox' && JSON.parse(value).some((i: any) => i.type === 'op.send_message' && i.sentAt !== undefined)) { blocked = true; await held; }
    return save(key, value);
  });
  useAppStore.getState().sendChatMessage('bot:b1', 'resume this unsent request');
  await tick(); expect(blocked).toBe(true);
  const next = await connected();
  release(); await tick();
  expect(first.socket.sent.some(f => f.type === 'op.send_message')).toBe(false);
  expect(next.socket.sent.filter(f => f.type === 'op.send_message')).toHaveLength(1);
  const opId = next.socket.sent.find(f => f.type === 'op.send_message').opId;
  const last = await connected();
  expect(last.socket.sent.some(f => f.opId === opId)).toBe(false);
});

test('decision quarantine survives a projection hole and hydration but is retired by authoritative replies', async () => {
  const { socket } = await connected();
  for (const kind of ['permission', 'question']) useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: kind, steps: [] } }));
  useAppStore.getState().respondPermission('permission', 'allowOnce');
  useAppStore.getState().answerQuestion('question', []);
  await tick(); await jest.advanceTimersByTimeAsync(20001);
  const original = socket.sent.filter(f => ['op.respond_permission', 'op.answer_question'].includes(f.type));
  expect(original).toHaveLength(2);
  useAppStore.getState().applyFrame(evt('hello.ok', { seq: 50, bridgeOnline: true, truncated: true }));
  for (const kind of ['permission', 'question']) useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: kind, steps: [] } }));
  expect(useAppStore.getState().decided).toEqual({ permission: 'uncertain', question: 'uncertain' });
  const session = useAppStore.getState().session!;
  const records = await loadOutbox();
  expect(records.filter(i => i.decisionUncertain)).toHaveLength(2);
  disconnectRelay(); useAppStore.setState({ ...useAppStore.getInitialState(), outbox: records }, true);
  useAppStore.getState().setSession(session);
  const next = await connected(session);
  for (const kind of ['permission', 'question']) useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: kind, steps: [] } }));
  useAppStore.getState().respondPermission('permission', 'deny');
  useAppStore.getState().answerQuestion('question', []);
  await tick();
  expect(next.socket.sent.some(f => ['op.respond_permission', 'op.answer_question'].includes(f.type))).toBe(false);
  next.socket.deliver(evt('ack', { opId: original.find(f => f.type === 'op.respond_permission').opId }));
  next.socket.deliver(evt('evt.question_answered', { requestId: 'question' }));
  expect(useAppStore.getState().decided).toEqual({});
  expect((await loadOutbox()).filter(i => i.decisionUncertain)).toEqual([]);
});

test.each(['permission', 'question'] as const)('a %s that expires before a held journal ever writes is safely retryable', async kind => {
  const { socket } = await connected();
  const type = kind === 'permission' ? 'op.respond_permission' : 'op.answer_question';
  useAppStore.getState().applyFrame(evt(`evt.${kind}_requested`, { request: { requestId: 'held', steps: [] } }));
  const save = AsyncStorage.setItem; let release!: () => void; let blocked = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
    if (!blocked && key === 'minimax-bot.outbox' && JSON.parse(value).some((i: any) => i.type === type && i.sentAt !== undefined)) { blocked = true; await held; }
    return save(key, value);
  });
  const answer = () => kind === 'permission' ? useAppStore.getState().respondPermission('held', 'allowOnce') : useAppStore.getState().answerQuestion('held', []);
  answer(); await tick(); expect(blocked).toBe(true);
  await jest.advanceTimersByTimeAsync(20001);
  expect(useAppStore.getState().decided.held).toBeUndefined();
  release(); await tick();
  expect(socket.sent.some(f => f.type === type)).toBe(false);
  answer(); await tick();
  expect(socket.sent.filter(f => f.type === type)).toHaveLength(1);
});

test.each([{ reason: { not: 'text' } }, { toolInput: [] }, { toolName: { invalid: true } }])('malformed permission rendering fields cannot enter state: %j', async malformed => {
  const { socket, phone } = await connected();
  socket.deliver(evt('evt.permission_requested', { request: { requestId: 'bad', ...malformed } }, 1));
  expect(phone.resumePoint).toBe(0);
  expect(useAppStore.getState().approvals).toEqual([]);
});

test.each([
  { steps: 'not-an-array' },
  { steps: [{ id: 's', question: 'Q', selectionMode: 'single', options: null }] },
  { steps: [{ id: 's', question: { private: 'object' }, selectionMode: 'single', options: [] }] },
  { steps: [{ id: 's', question: 'Q', selectionMode: 'single', options: [{ id: 'o', label: { nested: true } }] }] },
])('malformed question rendering data is rejected before store/cursor commit: %j', async malformed => {
  const { socket, phone } = await connected();
  socket.deliver(evt('evt.question_requested', { request: { requestId: 'bad', ...malformed } }, 1));
  expect(phone.resumePoint).toBe(0);
  expect(useAppStore.getState().questions).toEqual([]);
  socket.deliver(evt('evt.question_requested', { request: { requestId: 'after', steps: [] } }, 2));
  expect(phone.resumePoint).toBe(0);
  const next = await connected();
  next.socket.deliver(evt('evt.question_requested', { request: { requestId: 'good', chatId: 'bot:__proto__', title: 'Valid', steps: [], futureField: { allowed: true } } }, 1));
  expect(next.phone.resumePoint).toBe(1);
  expect(useAppStore.getState().questions.map(q => q.requestId)).toEqual(['good']);
});

test('a replay hole clears obsolete requests/decisions but preserves unsent user text', () => {
  useAppStore.getState().setSession(A);
  useAppStore.getState().sendChatMessage('bot:b1', 'unsent');
  useAppStore.getState().applyFrame(evt('evt.permission_requested', { request: { requestId: 'r' } }));
  useAppStore.getState().applyFrame(evt('evt.question_requested', { request: { requestId: 'q', steps: [] } }));
  useAppStore.getState().respondPermission('r', 'allowOnce');
  useAppStore.getState().answerQuestion('q', []);
  useAppStore.getState().applyFrame(evt('hello.ok', { seq: 100, bridgeOnline: true, truncated: true }));
  const state = useAppStore.getState();
  expect(state.approvals).toEqual([]);
  expect(state.questions).toEqual([]);
  expect(state.decided).toEqual({});
  expect(state.decidedOps).toEqual({});
  expect(state.messages['bot:b1']![0]!.text).toBe('unsent');
  expect(state.outbox.some(f => f.type === 'op.respond_permission' || f.type === 'op.answer_question')).toBe(false);
});

test('malformed dictionary keys are rejected without crashing and valid prefixed keys work', () => {
  expect(() => useAppStore.getState().applyFrame(evt('evt.message_committed', { message: { chatId: '__proto__', messageId: 'bad', role: 'assistant', text: 'x', ts: 1 } }))).not.toThrow();
  expect(Object.hasOwn(useAppStore.getState().messages, '__proto__')).toBe(false);
  useAppStore.getState().applyFrame(evt('evt.message_committed', { message: { chatId: 'bot:__proto__', messageId: 'ok', role: 'assistant', text: 'x', ts: 1 } }));
  expect(useAppStore.getState().messages['bot:__proto__']).toHaveLength(1);
});

test('slow snapshots preserve only changes made after their request plus local recovery text', async () => {
  const { socket } = await connected();
  useAppStore.getState().applyFrame(evt('evt.message_committed', { message: { chatId: 'bot:b1', messageId: 'deleted', role: 'assistant', text: 'old', ts: 1 } }));
  const outcome = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
  const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
  useAppStore.getState().sendChatMessage('bot:b1', 'local');
  socket.deliver(evt('evt.message_committed', { message: { chatId: 'bot:b1', messageId: 'new', role: 'assistant', text: 'live', ts: 2 } }));
  socket.deliver(evt('ack', { opId, result: { messages: [] } }));
  await outcome;
  expect(useAppStore.getState().messages['bot:b1']!.map(m => m.text).sort()).toEqual(['live', 'local']);
});

test('live history is globally and per-chat bounded, preserving pending text', () => {
  useAppStore.getState().setSession(A);
  useAppStore.getState().sendChatMessage('bot:b1', 'pending');
  for (let i = 0; i < 1000; i++) useAppStore.getState().applyFrame(evt('evt.message_committed', { message: { chatId: 'bot:b1', messageId: `m${i}`, role: 'assistant', text: 'x', ts: i } }));
  expect(useAppStore.getState().messages['bot:b1']!.length).toBeLessThanOrEqual(201);
  expect(useAppStore.getState().messages['bot:b1']!.some(m => m.text === 'pending')).toBe(true);
  for (let c = 0; c < 20; c++) for (let i = 0; i < 200; i++) useAppStore.getState().applyFrame(evt('evt.message_committed', { message: { chatId: `bot:c${c}`, messageId: `c${c}m${i}`, role: 'assistant', text: 'x', ts: i } }));
  expect(Object.values(useAppStore.getState().messages).flat().length).toBeLessThanOrEqual(2001);
});

test('drafts are per-chat, inserts are consumed once, and logout clears both', async () => {
  useAppStore.getState().setSession(A);
  const state = useAppStore.getState() as any;
  state.setDraft('bot:b1', { text: 'draft', mentions: ['b2'] });
  state.insertIntoComposer('bot:b1', 'skill');
  const token = useAppStore.getState().composerInsert!.token;
  expect(state.consumeComposerInsert(token + 1)).toBeNull();
  expect(state.consumeComposerInsert(token)?.text).toBe('skill');
  expect(state.consumeComposerInsert(token)).toBeNull();
  state.clearError();
  useAppStore.getState().setSession(null);
  expect((useAppStore.getState() as any).drafts).toEqual({});
  expect(useAppStore.getState().composerInsert).toBeNull();
  await tick();
  expect(await loadOutbox()).toEqual([]);
});

test('unpair clears local state promptly even when remote revocation never resolves', async () => {
  await connected(); await tick();
  global.fetch = jest.fn(() => new Promise(() => {}));
  const result = unpairPhone();
  await jest.advanceTimersByTimeAsync(11000);
  expect(useAppStore.getState().session).toBeNull();
  expect(await result).toBe(false);
  expect(useAppStore.getState().lastError).toMatch(/revocation is unconfirmed/i);
});

test('send(false) keeps both decision types queued and duplicate taps are guarded', async () => {
  await connected(A, false);
  const state = useAppStore.getState();
  state.applyFrame(evt('evt.permission_requested', { request: { requestId: 'r' } }));
  state.applyFrame(evt('evt.question_requested', { request: { requestId: 'q', steps: [] } }));
  state.respondPermission('r', 'allowOnce');
  state.respondPermission('r', 'deny');
  state.answerQuestion('q', []);
  state.answerQuestion('q', []);
  expect(useAppStore.getState().outbox.filter(i => i.type === 'op.respond_permission')).toHaveLength(1);
  expect(useAppStore.getState().outbox.filter(i => i.type === 'op.answer_question')).toHaveLength(1);
  expect(useAppStore.getState().decided).toEqual({ r: 'allowOnce', q: 'answered' });
  await jest.advanceTimersByTimeAsync(20001);
  expect(useAppStore.getState().decided).toEqual({});
  expect(useAppStore.getState().outbox).toEqual([]);
});

test('unknown request ids cannot grow decision state', () => {
  for (let i = 0; i < 1000; i++) {
    useAppStore.getState().respondPermission(`missing${i}`, 'allowOnce');
    useAppStore.getState().answerQuestion(`missing${i}`, []);
  }
  expect(useAppStore.getState().decided).toEqual({});
  expect(useAppStore.getState().outbox).toEqual([]);
});

test('old socket callbacks cannot overwrite the next owner connection', async () => {
  const old = await connected(A);
  await connected(B);
  old.socket.open();
  old.socket.deliver(evt('evt.message_committed', { message: { chatId: 'bot:b1', messageId: 'old', role: 'assistant', text: 'secret', ts: 1 } }));
  old.socket.end();
  expect(useAppStore.getState().status).toBe('online');
  expect(useAppStore.getState().messages).toEqual({});
});

test('invalid chat application leaves the real transport cursor before that frame', async () => {
  const { phone, socket } = await connected();
  socket.deliver(evt('evt.message_committed', { message: { chatId: '__proto__', messageId: 'bad', role: 'assistant', text: 'x', ts: 1 } }, 1));
  expect(phone.resumePoint).toBe(0);
  expect(useAppStore.getState().status).toBe('offline');
});

test('latest history request wins and an authoritative empty snapshot removes unchanged old history', async () => {
  const { socket } = await connected();
  const first = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
  const firstId = Object.keys(useAppStore.getState().pendingOp)[0]!;
  const second = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
  const secondId = Object.keys(useAppStore.getState().pendingOp).find(id => id !== firstId)!;
  socket.deliver(evt('ack', { opId: secondId, result: { messages: [] } }));
  socket.deliver(evt('ack', { opId: firstId, result: { messages: [{ chatId: 'bot:b1', messageId: 'stale', role: 'assistant', text: 'stale', ts: 1 }] } }));
  await Promise.all([first, second]);
  expect(useAppStore.getState().messages['bot:b1'] ?? []).toEqual([]);
});

test('operation-type registry retires successful, failed and timed-out requests', async () => {
  await connected();
  const set = Map.prototype.set;
  let tracked: Map<unknown, unknown> | undefined;
  jest.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key, value) {
    if (value === 'op.list_tasks') tracked = this;
    return set.call(this, key, value);
  });
  for (let i = 0; i < 1000; i++) {
    const opId = useAppStore.getState().request('op.list_tasks', {});
    useAppStore.getState().applyFrame(evt(i % 2 ? 'ack' : 'err', { opId, result: { tasks: [] }, message: 'refused' }));
  }
  expect(tracked!.size).toBeLessThanOrEqual(4);
  await jest.advanceTimersByTimeAsync(20001);
  expect(tracked!.size).toBe(0);
});

test('failed recovery text survives hydration but never re-enters dispatch', async () => {
  const { socket } = await connected();
  useAppStore.getState().sendChatMessage('bot:b1', 'persist recovery', ['b2']);
  await tick();
  const opId = socket.sent.find(f => f.type === 'op.send_message').opId;
  socket.deliver(evt('err', { opId, message: 'Busy', retryable: true }));
  const session = useAppStore.getState().session!;
  const records = await loadOutbox();
  disconnectRelay();
  useAppStore.setState({ ...useAppStore.getInitialState(), outbox: records }, true);
  const next = await connected(session);
  expect(next.socket.sent.some(f => f.type === 'op.send_message')).toBe(false);
  expect(useAppStore.getState().messages['bot:b1']![0]).toEqual(expect.objectContaining({ text: 'persist recovery', pending: false, deliveryError: 'Busy', retryable: true, mentions: ['b2'] }));
  expect(useAppStore.getState().outbox.some(f => f.opId === opId)).toBe(false);
});

test('resolved picture callbacks cannot repopulate state after unlink and relink to the same owner', async () => {
  const { socket } = await connected();
  useAppStore.setState({ bots: [{ botId: 'b1', name: 'Bot', skin: 'skin' }] });
  useAppStore.getState().loadBotPicture('b1');
  const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
  socket.deliver(evt('ack', { opId, result: { mime: 'image/png', data: 'private' } }));
  useAppStore.getState().setSession(null);
  useAppStore.getState().setSession(A);
  await tick();
  expect(useAppStore.getState().pictures).toEqual({});
});

test('hydrated written messages expire to uncertainty even if no connection can be opened', async () => {
  await connected();
  useAppStore.getState().sendChatMessage('bot:b1', 'written before restart');
  await tick();
  const session = useAppStore.getState().session!;
  const records = await loadOutbox();
  disconnectRelay();
  useAppStore.setState({ ...useAppStore.getInitialState(), outbox: records }, true);
  useAppStore.getState().setSession(session);
  await jest.advanceTimersByTimeAsync(20001);
  expect(useAppStore.getState().messages['bot:b1']![0]!.deliveryUncertain).toBe(true);
  expect(useAppStore.getState().messages['bot:b1']![0]!.pending).toBe(false);
  expect(useAppStore.getState().outbox).toEqual([]);
});

test('late and duplicate acknowledgement clears uncertainty without reviving operation metadata', async () => {
  const { socket } = await connected();
  useAppStore.getState().sendChatMessage('bot:b1', 'late acknowledgement');
  await tick();
  const opId = socket.sent.find(f => f.type === 'op.send_message').opId;
  await jest.advanceTimersByTimeAsync(20001);
  expect(useAppStore.getState().messages['bot:b1']![0]!.deliveryUncertain).toBe(true);
  socket.deliver(evt('ack', { opId }));
  socket.deliver(evt('ack', { opId }));
  expect(useAppStore.getState().messages['bot:b1']![0]!.deliveryError).toBeUndefined();
  expect(useAppStore.getState().pendingOp).toEqual({});
});
