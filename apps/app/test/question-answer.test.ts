import { createFrame } from '@minimax-bot/protocol';

import { useAppStore } from '../src/state/store';

/**
 * Answering a questionnaire from the phone.
 *
 * A questionnaire can have more than one step, and the run that is waiting for it wants
 * an answer for each of them: the options that were chosen, the free-text answer if
 * one was typed, or an explicit skip for a step the user left alone. An answer in any
 * other shape is refused by the run, so the phone has to send exactly this one.
 */

function reset() {
  // Each test owns its request capture; never inherit a previous test's action.
  useAppStore.setState(useAppStore.getInitialState(), true);
}

function event(type: string, payload: unknown) {
  return createFrame({ type, payload, source: 'bridge' });
}

function registerQuestion(stepIds = ['s1']) {
  useAppStore.getState().applyFrame(event('evt.question_requested', {
    request: {
      requestId: 'q-1', chatId: 'bot:b1', title: 'Which one?',
      steps: stepIds.map(id => ({
        id, question: `Question ${id}`, selectionMode: 'single',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowOther: true,
      })),
    },
  }));
}

function captureSent() {
  const sent: unknown[] = [];
  useAppStore.setState({
    request: ((type: string, payload: unknown) => {
      sent.push({ type, payload });
      return `op-${sent.length}`;
    }) as never,
  });
  return sent;
}

describe('answering a questionnaire', () => {
  beforeEach(reset);

  it('sends every step in the shape the run is waiting for', () => {
    const sent = captureSent();
    registerQuestion(['s1', 's2', 's3']);

    useAppStore.getState().answerQuestion('q-1', [
      { stepId: 's1', selectedOptionIds: ['a'], selectedOther: false },
      { stepId: 's2', selectedOptionIds: [], selectedOther: true, otherText: 'because' },
      { stepId: 's3', selectedOptionIds: [], selectedOther: false, skipped: true },
    ]);

    expect(sent).toEqual([
      {
        type: 'op.answer_question',
        payload: {
          requestId: 'q-1',
          answers: [
            { stepId: 's1', selectedOptionIds: ['a'], selectedOther: false },
            { stepId: 's2', selectedOptionIds: [], selectedOther: true, otherText: 'because' },
            { stepId: 's3', selectedOptionIds: [], selectedOther: false, skipped: true },
          ],
        },
      },
    ]);
    expect(useAppStore.getState().questions[0]?.steps.map(step => step.id)).toEqual(['s1', 's2', 's3']);
    expect(useAppStore.getState().decidedOps['q-1']).toBe('op-1');
  });

  it('does not answer the same question twice', () => {
    const sent = captureSent();
    registerQuestion();

    useAppStore.getState().answerQuestion('q-1', [
      { stepId: 's1', selectedOptionIds: ['a'], selectedOther: false },
    ]);
    useAppStore.getState().answerQuestion('q-1', [
      { stepId: 's1', selectedOptionIds: ['b'], selectedOther: false },
    ]);

    expect(sent).toEqual([{
      type: 'op.answer_question',
      payload: { requestId: 'q-1', answers: [{ stepId: 's1', selectedOptionIds: ['a'], selectedOther: false }] },
    }]);
    expect(useAppStore.getState().decided['q-1']).toBe('answered');
    expect(useAppStore.getState().decidedOps['q-1']).toBe('op-1');
    expect(useAppStore.getState().questions.map(request => request.requestId)).toEqual(['q-1']);
  });

  it('keeps the question on screen when the desktop refuses the answer', () => {
    const sent = captureSent();
    useAppStore.getState().applyFrame(
      event('evt.question_requested', {
        request: {
          requestId: 'q-1',
          title: 'Which one?',
          steps: [
            {
              id: 's1',
              question: 'Which one?',
              selectionMode: 'single',
              options: [{ id: 'a', label: 'A' }],
            },
          ],
        },
      }),
    );

    useAppStore.getState().answerQuestion('q-1', [
      { stepId: 's1', selectedOptionIds: ['a'], selectedOther: false },
    ]);
    expect(useAppStore.getState().decided['q-1']).toBe('answered');

    // The desktop refused the answer, so the question is still waiting for one and
    // the phone has to be able to give it again.
    useAppStore.getState().applyFrame(
      event('err', { opId: 'op-1', code: 'BUSY', message: 'Too many turns are already running.' }),
    );

    expect(useAppStore.getState().decided['q-1']).toBeUndefined();
    expect(useAppStore.getState().decidedOps['q-1']).toBeUndefined();
    expect(useAppStore.getState().questions.map(request => request.requestId)).toEqual(['q-1']);
    expect(useAppStore.getState().lastError).toBe('Too many turns are already running.');
    const retry = [{ stepId: 's1', selectedOptionIds: ['a'], selectedOther: false }];
    useAppStore.getState().answerQuestion('q-1', retry);
    useAppStore.getState().answerQuestion('q-1', retry);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ type: 'op.answer_question', payload: { requestId: 'q-1', answers: retry } });
    expect(useAppStore.getState().decidedOps['q-1']).toBe('op-2');
  });
});
