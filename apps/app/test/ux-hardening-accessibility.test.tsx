import React from 'react';
import renderer from 'react-test-renderer';
import { Linking, Platform } from 'react-native';
const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (element: React.ReactElement) => string };
import { Bubble } from '../src/components/Bubble';
import { Markdown } from '../src/components/Markdown';

let tree: renderer.ReactTestRenderer;
async function draw(element: React.ReactElement) {
  await renderer.act(async () => { tree = renderer.create(element); });
  return tree;
}
afterEach(() => { renderer.act(() => tree?.unmount()); jest.restoreAllMocks(); });
it('keeps the assistant answer readable and offers a normal press reaction action', async () => {
  const react = jest.fn();
  const tree = await draw(<Bubble role="assistant" text="The answer is forty two." onLongPress={react} />);
  expect(tree.root.findAll(n => n.props.accessibilityLabel === 'React to this message' && n.props.onLongPress)).toHaveLength(0);
  const action = tree.root.findAll(n => n.props.accessibilityLabel === 'React to this message' && n.props.onPress)[0]!;
  expect(action).toBeDefined();
  renderer.act(() => action.props.onPress());
  expect(react).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(tree.toJSON())).toContain('The answer is forty two.');
  const longPress = tree.root.findAll(n => n.props.onLongPress && n.props.onAccessibilityAction)[0]!;
  renderer.act(() => longPress.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
  expect(react).toHaveBeenCalledTimes(2);
});
it('activates the explicit reaction action through the installed web Enter-key responder', async () => {
  const react = jest.fn();
  const tree = await draw(<Bubble role="assistant" text="A keyboard-readable answer" onLongPress={react} />);
  const action = tree.root.findAll(n => n.props.accessibilityLabel === 'React to this message' && n.props.onPress)[0]!;
  const PressResponder = require('react-native-web/dist/cjs/modules/usePressEvents/PressResponder');
  const responder = new PressResponder({ onPress: action.props.onPress });
  const previousDocument = global.document;
  let keyup!: (event: unknown) => void;
  global.document = { addEventListener: jest.fn((type, callback) => { if (type === 'keyup') keyup = callback; }), removeEventListener: jest.fn() } as unknown as Document;
  const target = { tagName: 'DIV', getAttribute: (key: string) => key === 'role' ? 'button' : null };
  const event = { key: 'Enter', target, currentTarget: target, nativeEvent: { key: 'Enter' }, persist: jest.fn(), preventDefault: jest.fn(), stopPropagation: jest.fn() };
  try {
    responder.getEventHandlers().onKeyDown(event);
    expect(keyup).toBeDefined();
    keyup(event);
    expect(react).toHaveBeenCalledTimes(1);
  } finally {
    responder.reset();
    global.document = previousDocument;
  }
});
it('renders a safe web link as a keyboard-focusable anchor and retains pointer activation', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const tree = await draw(<Markdown text="[Read docs](https://example.invalid/docs)" />);
  const link = tree.root.findAll(n => n.props.accessibilityRole === 'link')[0]!;
  expect(link).toBeDefined();
  const WebText = require('react-native-web/dist/cjs/exports/Text');
  const html = renderToStaticMarkup(React.createElement(WebText, link.props));
  expect(html).toMatch(/<a\b/);
  expect(html).toContain('href="https://example.invalid/docs"');
  expect(html).not.toContain('tabindex="-1"');
  expect(link.props.onPress).toBeUndefined(); // Let the browser follow the anchor exactly once.
  jest.replaceProperty(Platform, 'OS', 'ios');
  await renderer.act(async () => { tree.update(<Markdown text="[Read docs](https://example.invalid/docs)" />); });
  const nativeLink = tree.root.findAll(n => n.props.accessibilityRole === 'link' && n.props.onPress)[0]!;
  await renderer.act(async () => { nativeLink.props.onPress(); });
  expect(open).toHaveBeenCalledWith('https://example.invalid/docs');
});
it.each(['javascript:alert', 'file:///secret', 'data:text/html,unsafe'])('keeps %s inert', async url => {
  const tree = await draw(<Markdown text={`[Unsafe](${url})`} />);
  expect(tree.root.findAll(n => n.props.href || n.props.onPress || n.props.accessibilityRole === 'link')).toHaveLength(0);
});
