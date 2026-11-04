import React, { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { Avatar, useBotSkins } from './Avatar';
import { useTheme } from '../theme';
import { useAppStore, type AppBot, type AppGroup } from '../state/store';

/**
 * The group's picture.
 *
 * The desktop shows a group as up to three of its members piled into one picture,
 * the admin in front, and the phone draws the same pile with the same layout — so a
 * group looks like itself on both screens, and the phone's own icon can be the same
 * pile.
 *
 * The layout tables are the desktop's, copied rather than re-invented: the desktop
 * keeps them in `miniapp/client/octopus.js` (`groupMark`), and a picture that is
 * nearly the same is not the same.
 */

/** Where each member sits in the pile: left, top and size, as fractions of the mark. */
export type GroupLayout = readonly (readonly [number, number, number])[];

/** The desktop's own layouts, one per number of members. */
export const GROUP_LAYOUTS: Record<number, GroupLayout> = {
  0: [],
  1: [[0.08, 0.08, 0.84]],
  2: [
    [0, 0, 0.66],
    [0.36, 0.34, 0.64],
  ],
  3: [
    [0.2, 0, 0.6],
    [0, 0.44, 0.54],
    [0.46, 0.44, 0.54],
  ],
};

/** A member of a pile, as far as the picture needs to know. */
export interface GroupMarkMember {
  botId?: string;
  name: string;
  skin?: string;
  color?: string;
  avatar?: string;
  /** The picture to draw, when the caller already holds one. */
  picture?: string;
}

/**
 * The members of a group, in the order the desktop stacks them.
 *
 * The admin leads the pile — the desktop puts the admin first and draws it in
 * front — and the rest follow in the order the group lists them.
 */
export function groupMembers(group: AppGroup | undefined, bots: AppBot[]): AppBot[] {
  if (!group) return [];
  const byId = new Map(bots.map((bot) => [bot.botId, bot]));
  const admin = group.admin ? byId.get(group.admin) : undefined;
  const rest = group.memberIds
    .filter((id) => id !== group.admin)
    .map((id) => byId.get(id))
    .filter((bot): bot is AppBot => Boolean(bot));
  return admin ? [admin, ...rest] : rest;
}

/** The members of a group, with the looks the roster gives them. */
export function useGroupMark(group: AppGroup | undefined): GroupMarkMember[] {
  const bots = useAppStore((state) => state.bots);
  const skins = useBotSkins(bots);
  return useMemo(() => toMarkMembers(group, bots, skins), [group, bots, skins]);
}

/** The pile of every group, by group id: for the screens that list them all. */
export function useGroupPiles(): Record<string, GroupMarkMember[]> {
  const groups = useAppStore((state) => state.groups);
  const bots = useAppStore((state) => state.bots);
  const skins = useBotSkins(bots);
  return useMemo(() => {
    const piles: Record<string, GroupMarkMember[]> = {};
    for (const group of groups) piles[group.groupId] = toMarkMembers(group, bots, skins);
    return piles;
  }, [groups, bots, skins]);
}

/** The members of a group as the picture needs them: id, name, look and picture. */
function toMarkMembers(
  group: AppGroup | undefined,
  bots: AppBot[],
  skins: Record<string, string>,
): GroupMarkMember[] {
  return groupMembers(group, bots).map((bot) => ({
    botId: bot.botId,
    name: bot.name,
    skin: bot.skin ?? skins[bot.botId],
    color: bot.color,
    avatar: bot.avatar,
  }));
}

/**
 * The pile of members that is a group's picture.
 *
 * Each member is drawn whole, the way the desktop draws it, with a halo in the
 * colour of the ground the pile sits on: without it two members that overlap would
 * melt into one shape.
 */
export function GroupMark({
  members,
  size = 40,
  haloColor,
  style,
}: {
  members: GroupMarkMember[];
  size?: number;
  /** The colour of the halo: the ground the pile sits on. */
  haloColor?: string;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const list = members.slice(0, 3);
  const slots = GROUP_LAYOUTS[list.length] ?? [];
  const ground = haloColor ?? theme.colors.bg;

  // A group with no members has no picture: the desktop draws a soft disc, and so
  // does the phone.
  if (list.length === 0) {
    return (
      <View
        style={[
          styles.base,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.colors.tag,
          },
          style,
        ]}
      />
    );
  }

  return (
    <View
      // The pile is decoration next to the group's name: the name is what is read.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.base, { width: size, height: size }, style]}
    >
      {list.map((member, index) => {
        const [x, y, s] = slots[index];
        const piece = size * s;
        return (
          <View
            key={member.botId ?? member.name}
            style={{
              position: 'absolute',
              left: x * size,
              top: y * size,
              width: piece,
              height: piece,
              // The desktop puts the first member in front of the pile.
              zIndex: 3 - index,
            }}
          >
            <Avatar
              name={member.name}
              botId={member.botId}
              skin={member.skin}
              color={member.color}
              avatar={member.avatar}
              picture={member.picture}
              size={piece}
              halo
              haloColor={ground}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    position: 'relative',
  },
});
