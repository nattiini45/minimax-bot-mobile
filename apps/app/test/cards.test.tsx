import React from 'react';
import renderer from 'react-test-renderer';

import { ApprovalCard, QuestionCard } from '../src/components/cards';
import type { AppQuestion } from '../src/state/store';

/**
 * The cards a conversation is made of.
 *
 * A Bot asks for permission, asks a question and runs tools, and each of those is
 * something the user acts on. So each of them is a card with the controls that answer
 * it, and the card is shown where it was asked.
 *
 * The answers these cards give are handed to the run that is waiting for them, so the
 * shape matters as much as the look: a step that was chosen is a list of option ids, a
 * step that was typed is a free-text answer, and a step that was left alone is a skip.
 */

let mounted: renderer.ReactTestRenderer | null = null;

async function render(element: React.ReactElement): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(element);
  });
  mounted = tree;
  return tree;
}

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
});

/**
 * The control that carries a label.
 *
 * The controls are found by what they say and what they do, not by their type: the
 * renderer's view of a native component is not the component the test imported.
 */
function control(tree: renderer.ReactTestRenderer, label: string) {
  const found = tree.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
  );
  return found[0];
}

/** The options a question offers, in the order they are shown. */
function options(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(
    (node) =>
      node.props?.accessibilityState?.selected !== undefined &&
      typeof node.props?.onPress === 'function',
  );
}

/** The field a free-text answer is written in. */
function answerField(tree: renderer.ReactTestRenderer) {
  const found = tree.root.findAll((node) => typeof node.props?.onChangeText === 'function');
  return found[0];
}

function press(element: renderer.ReactTestInstance) {
  renderer.act(() => {
    element.props.onPress();
  });
}

function write(element: renderer.ReactTestInstance, value: string) {
  renderer.act(() => {
    element.props.onChangeText(value);
  });
}

/** A questionnaire with two steps and one step that takes more than one answer. */
const QUESTION: AppQuestion = {
  requestId: 'q-1',
  sessionId: 'sess-1',
  title: 'The Bot asks',
  steps: [
    {
      id: 's1',
      question: 'Which one?',
      description: 'Pick a lane.',
      selectionMode: 'single',
      options: [
        { id: 'a', label: 'A', description: 'The first.' },
        { id: 'b', label: 'B' },
      ],
    },
    {
      id: 's2',
      question: 'And then?',
      selectionMode: 'multiple',
      options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
    },
  ],
};

describe('a question the Bot asked', () => {
  it('shows every step and every option', async () => {
    const tree = await render(<QuestionCard request={QUESTION} onAnswer={() => {}} />);
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('Which one?');
    expect(text).toContain('And then?');
    expect(text).toContain('The first.');
  });

  it('answers with the options that were chosen, and skips what was left alone', async () => {
    const answers: unknown[] = [];
    const tree = await render(
      <QuestionCard request={QUESTION} onAnswer={(value) => answers.push(value)} />,
    );

    // The first option of the first step.
    press(options(tree)[0]!);
    press(control(tree, 'Send answer')!);

    expect(answers).toEqual([
      [
        { stepId: 's1', selectedOptionIds: ['a'], selectedOther: false },
        { stepId: 's2', selectedOptionIds: [], selectedOther: false, skipped: true },
      ],
    ]);
  });

  it('takes more than one answer where the question allows it', async () => {
    const answers: unknown[] = [];
    const tree = await render(
      <QuestionCard request={QUESTION} onAnswer={(value) => answers.push(value)} />,
    );

    // The first option of the second step, then the second one.
    const all = options(tree);
    press(all[2]!);
    press(all[3]!);
    press(control(tree, 'Send answer')!);

    expect(answers).toEqual([
      [
        { stepId: 's1', selectedOptionIds: [], selectedOther: false, skipped: true },
        { stepId: 's2', selectedOptionIds: ['x', 'y'], selectedOther: false },
      ],
    ]);
  });

  it('takes an answer that is written rather than chosen', async () => {
    const answers: unknown[] = [];
    const tree = await render(
      <QuestionCard request={QUESTION} onAnswer={(value) => answers.push(value)} />,
    );

    write(answerField(tree)!, 'something else');
    press(control(tree, 'Send answer')!);

    expect(answers).toEqual([
      [
        { stepId: 's1', selectedOptionIds: [], selectedOther: true, otherText: 'something else' },
        { stepId: 's2', selectedOptionIds: [], selectedOther: false, skipped: true },
      ],
    ]);
  });

  it('shows that it was answered once it was', async () => {
    const tree = await render(
      <QuestionCard request={QUESTION} onAnswer={() => {}} decided="answered" />,
    );
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('Answered');
    expect(text).not.toContain('Send answer');
  });
});

describe('a permission the Bot asked for', () => {
  const REQUEST = {
    requestId: 'perm-1',
    sessionId: 'sess-1',
    toolName: 'shell',
    toolInput: 'rm -rf build',
    reason: 'writes a file',
  };

  it('names the tool and shows what it wants to do', async () => {
    const tree = await render(<ApprovalCard request={REQUEST} onDecide={() => {}} />);
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('shell');
    expect(text).toContain('rm -rf build');
    expect(text).toContain('writes a file');
  });

  it('offers the two answers, and gives the one that was chosen', async () => {
    const decisions: string[] = [];
    const tree = await render(
      <ApprovalCard request={REQUEST} onDecide={(decision) => decisions.push(decision)} />,
    );

    press(control(tree, 'Allow once')!);

    expect(decisions).toEqual(['allowOnce']);
  });

  it('cannot be answered twice', async () => {
    const tree = await render(
      <ApprovalCard request={REQUEST} onDecide={() => {}} decided="allowOnce" />,
    );
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('Permission answered');
    expect(text).not.toContain('Allow once');
  });
});
