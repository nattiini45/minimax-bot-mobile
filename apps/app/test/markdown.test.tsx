import React from 'react';
import renderer from 'react-test-renderer';
import { Text } from 'react-native';

import { Markdown } from '../src/components/Markdown';

/**
 * The team's answers are written in markdown.
 *
 * The phone has to render them: an answer that arrives as `**Chief**` and a pipe
 * table is an answer the phone cannot read, and the whole point of the app is that
 * the phone can read what the team said.
 */

let mounted: renderer.ReactTestRenderer | null = null;

async function draw(text: string): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<Markdown text={text} />);
  });
  mounted = tree;
  return tree;
}

/** The rendered reply as text, for the assertions that only care about the words. */
async function words(text: string): Promise<string> {
  const tree = await draw(text);
  return JSON.stringify(tree.toJSON());
}

/** The nodes that can be pressed. */
function pressables(tree: renderer.ReactTestRenderer): unknown[] {
  return tree.root.findAll((node) => typeof node.props.onPress === 'function');
}

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
});

describe('a reply in markdown', () => {
  it('renders bold as bold, not as asterisks', async () => {
    const text = await words('**Chief** finished the review.');

    expect(text).toContain('Chief');
    expect(text).not.toContain('**');
    expect(text).toContain('finished the review.');
  });

  it('renders italic and strikethrough', async () => {
    const text = await words('*quick* and ~~old~~');

    expect(text).not.toContain('*quick*');
    expect(text).not.toContain('~~old~~');
  });

  it('renders an inline code span as code', async () => {
    const text = await words('Call `list_team` first.');

    expect(text).toContain('list_team');
    expect(text).not.toContain('`');
  });

  it('keeps a fenced code block exactly as it was written', async () => {
    const text = await words('```js\nconst a = 1;\nconst b = 2;\n```');

    expect(text).toContain('const a = 1;');
    expect(text).toContain('const b = 2;');
    expect(text).not.toContain('```');
  });

  it('renders a pipe table as a table', async () => {
    const text = await words('| Bot | Role |\n|---|---|\n| Chief | Team lead |\n| Engineer | Builds code |');

    expect(text).toContain('Bot');
    expect(text).toContain('Role');
    expect(text).toContain('Chief');
    expect(text).toContain('Builds code');
    expect(text).not.toContain('|---|');
  });

  it('renders a list as a list', async () => {
    const text = await words('- one\n- two\n- three');

    expect(text).not.toContain('- one');
    expect(text).toContain('one');
    expect(text).toContain('three');
  });

  it('renders a quote as a quote', async () => {
    const text = await words('> the team is busy');

    expect(text).not.toContain('> the team is busy');
    expect(text).toContain('the team is busy');
  });

  it('keeps the line breaks a reply was written with', async () => {
    const text = await words('first line\nsecond line');

    expect(text).toContain('\\n');
  });
});

describe('markdown that does not close', () => {
  it('does not eat the rest of the paragraph', async () => {
    const text = await words('a ** b');

    expect(text).toContain('a ** b');
  });

  it('does not close an italic that never ends', async () => {
    const text = await words('*unclosed emphasis');

    expect(text).toContain('unclosed emphasis');
  });

  it('leaves an underscore inside a word alone', async () => {
    const text = await words('call bot_4cd5d0a7 now');

    expect(text).toContain('bot_4cd5d0a7');
  });
});

describe('a link', () => {
  it('is opened when it is a web link', async () => {
    const tree = await draw('[the release](https://github.com/nattiini45/minimax-bot-mobile)');

    expect(pressables(tree).length).toBeGreaterThan(0);
  });

  it('is left inert when it is not a web link', async () => {
    const tree = await draw('[run this](file:///etc/passwd)');

    expect(pressables(tree)).toHaveLength(0);
  });
});

describe('an empty reply', () => {
  it('renders nothing', async () => {
    const tree = await draw('');

    expect(tree.root.findAllByType(Text)).toHaveLength(0);
  });
});
