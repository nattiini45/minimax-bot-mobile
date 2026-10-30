import { botPath, chatPath, groupPath } from '../src/nav/paths';

/**
 * The routes the phone navigates to.
 *
 * The ids in these paths come from the relay: they are the bot ids and group ids the
 * team tools report. An id is a piece of text from somewhere else, so it is encoded
 * before it goes into a path.
 */

describe('the routes the phone navigates to', () => {
  it('encodes an id that would otherwise change the route', () => {
    // A slash or a traversal segment in an id must not address another route.
    expect(botPath('bot/../../pair')).toBe('/bot/bot%2F..%2F..%2Fpair');
    expect(groupPath('g/1')).toBe('/group/g%2F1');
    expect(chatPath('bot:a/b')).toBe('/chat/bot%3Aa%2Fb');
  });

  it('leaves an ordinary id as it is', () => {
    expect(botPath('bot_b1')).toBe('/bot/bot_b1');
    expect(groupPath('grp_g1')).toBe('/group/grp_g1');
    expect(chatPath('bot:bot_b1')).toBe('/chat/bot%3Abot_b1');
  });
});
