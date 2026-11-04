import React, { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useAppStore } from '../state/store';
import { useTheme } from '../theme';

/**
 * Bot avatar.
 *
 * MiniMax gives every Bot an octopus, and each one has a look: a blue plush, a pink
 * glass, a bag of smileys, a moon rock. Those are image assets that live on the
 * desktop, and the desktop is where they stay: the phone asks for the picture of the
 * look a Bot wears and shows the very image the desktop shows.
 *
 * Without a desktop — or for a Bot the desktop has no picture for — the same motif is
 * drawn in code: a soft body with two eyes, tinted by the Bot's look, with the
 * material's own texture on top. A picture that cannot be loaded falls back to it too,
 * so a face is never a broken frame.
 */

/** What a look is made of. */
interface Skin {
  /** The body's own colour. */
  body: string;
  /** The body's shadow, under the light. */
  deep: string;
  /** The highlight's opacity: a glass ball catches more light than a plush one. */
  gloss: number;
  /** The extra marks the material carries. */
  texture: 'plain' | 'holes' | 'pixels' | 'smiles' | 'craters';
}

/** The official MiniMax Bot looks, plus the legacy colours they replaced. */
export const SKINS: Record<string, Skin> = {
  // The eleven official skins.
  fuzzy: { body: '#7fb3f5', deep: '#4e86d9', gloss: 0.18, texture: 'plain' },
  bubble: { body: '#f6b4e6', deep: '#de84c4', gloss: 0.24, texture: 'plain' },
  glass: { body: '#f3a6d0', deep: '#c96fa6', gloss: 0.34, texture: 'plain' },
  gold: { body: '#f2c14e', deep: '#c79525', gloss: 0.26, texture: 'plain' },
  jade: { body: '#74cfae', deep: '#43a183', gloss: 0.18, texture: 'plain' },
  plush: { body: '#f0a58f', deep: '#d2765c', gloss: 0.14, texture: 'plain' },
  waffle: { body: '#e0b46b', deep: '#b98b3f', gloss: 0.14, texture: 'holes' },
  pixel: { body: '#9aa0a6', deep: '#6e747a', gloss: 0.1, texture: 'pixels' },
  smiley: { body: '#ffd166', deep: '#e0ae3f', gloss: 0.2, texture: 'smiles' },
  toys: { body: '#ef8354', deep: '#c96337', gloss: 0.2, texture: 'plain' },
  moon: { body: '#b8b8d1', deep: '#8d8dab', gloss: 0.16, texture: 'craters' },

  // The legacy colours, each mapped to the look it reads as.
  ocean: { body: '#5aa9e6', deep: '#3c86c0', gloss: 0.2, texture: 'plain' },
  sky: { body: '#8ecae6', deep: '#6ba9c9', gloss: 0.2, texture: 'plain' },
  teal: { body: '#4ecdc4', deep: '#2fa9a1', gloss: 0.2, texture: 'plain' },
  green: { body: '#7bc96f', deep: '#57a44b', gloss: 0.16, texture: 'plain' },
  lime: { body: '#cde77f', deep: '#a5c45a', gloss: 0.16, texture: 'plain' },
  yellow: { body: '#ffd166', deep: '#e0b040', gloss: 0.2, texture: 'plain' },
  orange: { body: '#f4845f', deep: '#d2683f', gloss: 0.2, texture: 'plain' },
  red: { body: '#e07a5f', deep: '#bc5a42', gloss: 0.18, texture: 'plain' },
  pink: { body: '#f28cab', deep: '#ce6589', gloss: 0.2, texture: 'plain' },
  violet: { body: '#b088f9', deep: '#8e63d4', gloss: 0.22, texture: 'plain' },
  indigo: { body: '#6c63ff', deep: '#4f47d6', gloss: 0.22, texture: 'plain' },
  graphite: { body: '#8a8f98', deep: '#6c717a', gloss: 0.14, texture: 'plain' },
};

/** The official skins, in the order the desktop lists them. */
export const SKIN_IDS = [
  'fuzzy',
  'bubble',
  'glass',
  'gold',
  'jade',
  'plush',
  'waffle',
  'pixel',
  'smiley',
  'toys',
  'moon',
] as const;

/**
 * A stable number for any string.
 *
 * The look a Bot gets must not change between launches, between screens, or between
 * the phone and the web build, so the seed is hashed rather than counted.
 */
function hash(seed: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value >>> 0;
}

/**
 * The look a Bot is drawn with.
 *
 * The team's roster does not always carry a look, so one is chosen from the Bot's own
 * id: the same Bot keeps the same octopus on every screen and after every restart.
 */
export function resolveSkin(options: {
  skin?: string;
  color?: string;
  seed?: string;
}): Skin {
  const named = SKINS[options.skin ?? ''] ?? SKINS[options.color ?? ''];
  if (named) return named;
  const index = hash(options.seed ?? 'bot') % SKIN_IDS.length;
  return SKINS[SKIN_IDS[index]];
}

/**
 * The look every Bot on a roster is drawn with.
 *
 * A roster that hashed its Bot ids onto eleven looks gave three of the six the same
 * octopus, which is worse than no octopus at all: a face has to belong to somebody.
 * So the looks are handed out around the palette instead, in an order the roster
 * does not control, and the starting point moves with the roster so two teams never
 * walk the same sequence.
 */
export function assignSkins(bots: { botId: string }[]): Record<string, string> {
  const ids = bots.map((bot) => bot.botId).filter(Boolean);
  if (ids.length === 0) return {};
  const ordered = [...ids].sort((left, right) => hash(left) - hash(right));
  const offset = hash(`roster:${ordered.join(',')}`) % SKIN_IDS.length;
  const assigned: Record<string, string> = {};
  ordered.forEach((id, index) => {
    assigned[id] = SKIN_IDS[(offset + index) % SKIN_IDS.length];
  });
  return assigned;
}

/** The looks a roster's Bots are drawn with, for the screens that show the roster. */
export function useBotSkins(bots: { botId: string }[]): Record<string, string> {
  return React.useMemo(() => assignSkins(bots), [bots]);
}

/** Whether a string is an image the phone can load. */
function isLoadableImage(value?: string): value is string {
  if (!value) return false;
  return /^(https?:\/\/|data:image\/)/i.test(value.trim());
}

export interface AvatarProps {
  name: string;
  skin?: string;
  color?: string;
  /** The Bot's id: the seed the look is chosen from when the roster names no look. */
  botId?: string;
  /** The Bot's own picture, when it has one. */
  avatar?: string;
  /**
   * The picture the desktop sent for this Bot, as a data URI.
   *
   * It comes from the store when the Bot's id is known; passing it in is for the
   * cases that know better than the store.
   */
  picture?: string;
  size?: number;
  /** Draws the accent ring: the main Bot, or the Bot whose chat is open. */
  ring?: boolean;
  /**
   * Draws the picture whole, with a halo in the ground's own colour.
   *
   * The desktop draws a Bot's artwork uncropped — `object-fit: contain`, the whole
   * octopus and not a disc cut out of it — and separates two members that overlap
   * with a soft edge in the colour of the ground they sit on. A stacked group
   * picture needs both, so the group mark asks for them.
   */
  halo?: boolean;
  /** The colour of the halo: the ground the mark sits on. */
  haloColor?: string;
  style?: ViewStyle;
}

/**
 * The octopus the phone draws when it has no artwork for a Bot.
 *
 * The same motif the desktop draws, in code: a soft body with two eyes, tinted by
 * the Bot's look, with the material's own texture on top.
 */
function DrawnOctopus({ look, size }: { look: Skin; size: number }) {
  const body = {
    width: size * 0.74,
    height: size * 0.6,
    bottom: size * 0.2,
    left: size * 0.13,
    borderTopLeftRadius: size * 0.37,
    borderTopRightRadius: size * 0.37,
    borderBottomLeftRadius: size * 0.3,
    borderBottomRightRadius: size * 0.3,
    backgroundColor: look.body,
  } as const;

  return (
    <>
      {/* The ground the octopus sits on, so the disc never reads as a flat swatch. */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: size * 0.52,
          backgroundColor: look.deep,
          opacity: 0.28,
        }}
      />

      {/* The body. */}
      <View style={[styles.body, body]}>
        <View
          style={{
            position: 'absolute',
            left: size * 0.1,
            top: size * 0.07,
            width: size * 0.26,
            height: size * 0.16,
            borderRadius: size * 0.13,
            backgroundColor: '#ffffff',
            opacity: look.gloss,
          }}
        />
        {look.texture === 'holes' ? (
          <>
            <View style={[styles.mark, { left: size * 0.16, top: size * 0.3, backgroundColor: look.deep, opacity: 0.5 }]} />
            <View style={[styles.mark, { left: size * 0.42, top: size * 0.36, backgroundColor: look.deep, opacity: 0.5 }]} />
            <View style={[styles.mark, { left: size * 0.62, top: size * 0.26, backgroundColor: look.deep, opacity: 0.5 }]} />
          </>
        ) : null}
        {look.texture === 'pixels' ? (
          <>
            <View style={[styles.pixel, { left: size * 0.14, top: size * 0.3 }]} />
            <View style={[styles.pixel, { left: size * 0.4, top: size * 0.38 }]} />
            <View style={[styles.pixel, { left: size * 0.66, top: size * 0.28 }]} />
          </>
        ) : null}
        {look.texture === 'smiles' ? (
          <>
            <View style={[styles.mark, { left: size * 0.2, top: size * 0.32, backgroundColor: look.deep, opacity: 0.55 }]} />
            <View style={[styles.mark, { left: size * 0.52, top: size * 0.36, backgroundColor: look.deep, opacity: 0.55 }]} />
            <View style={[styles.mark, { left: size * 0.68, top: size * 0.22, backgroundColor: look.deep, opacity: 0.55 }]} />
          </>
        ) : null}
        {look.texture === 'craters' ? (
          <>
            <View style={[styles.crater, { left: size * 0.13, top: size * 0.26, backgroundColor: look.deep, opacity: 0.4 }]} />
            <View style={[styles.crater, { left: size * 0.52, top: size * 0.34, backgroundColor: look.deep, opacity: 0.4 }]} />
          </>
        ) : null}
      </View>

      {/* The tentacles: three bumps under the body, so the silhouette is an octopus. */}
      <View style={[styles.tentacle, { left: size * 0.17, bottom: size * 0.08, width: size * 0.17, height: size * 0.17, borderRadius: size * 0.09, backgroundColor: look.body }]} />
      <View style={[styles.tentacle, { left: size * 0.41, bottom: size * 0.05, width: size * 0.18, height: size * 0.18, borderRadius: size * 0.09, backgroundColor: look.body }]} />
      <View style={[styles.tentacle, { left: size * 0.65, bottom: size * 0.09, width: size * 0.16, height: size * 0.16, borderRadius: size * 0.08, backgroundColor: look.body }]} />

      {/* The eyes. */}
      <View style={[styles.eye, { left: size * 0.33, top: size * 0.33, width: size * 0.1, height: size * 0.13 }]} />
      <View style={[styles.eye, { left: size * 0.55, top: size * 0.33, width: size * 0.1, height: size * 0.13 }]} />
      <View style={[styles.glint, { left: size * 0.352, top: size * 0.352 }]} />
      <View style={[styles.glint, { left: size * 0.572, top: size * 0.352 }]} />
    </>
  );
}

export function Avatar({
  name,
  skin,
  color,
  botId,
  avatar,
  picture,
  size = 40,
  ring = false,
  halo = false,
  haloColor,
  style,
}: AvatarProps) {
  const theme = useTheme();
  const [imageFailed, setImageFailed] = useState(false);
  // The picture the desktop sent for this Bot, if it has sent one.
  const linked = useAppStore((state) => (botId ? state.pictures[botId] : undefined));
  const look = useMemo(() => resolveSkin({ skin, color, seed: botId ?? name }), [skin, color, botId, name]);
  // The desktop's picture comes first: it is the Bot as the desktop draws it. A Bot's
  // own picture is next, and the drawn octopus is what is left.
  const source = picture ?? linked ?? avatar;
  const showImage = isLoadableImage(source) && !imageFailed;
  // The ground the mark sits on: the halo takes its colour, so an overlapping piece
  // is separated by the surface it lies on rather than by a colour of its own.
  const ground = haloColor ?? theme.colors.bg;

  return (
    <View
      accessible
      accessibilityLabel={`${name} avatar`}
      style={[
        styles.base,
        // The halo reaches past the picture, so the mark is not cut off at its edge.
        halo ? styles.uncropped : null,
        {
          width: size,
          height: size,
          ...(halo
            ? {}
            : {
                borderRadius: size / 2,
                borderColor: ring ? theme.colors.accent : theme.colors.line,
                borderWidth: ring ? 2 : StyleSheet.hairlineWidth,
              }),
        },
        style,
      ]}
    >
      {showImage ? (
        halo ? (
          <>
            {/* The halo: the picture's own silhouette in the ground's colour, a hair
                larger than the picture, so two members that overlap stay two. */}
            <Image
              source={{ uri: source }}
              onError={() => setImageFailed(true)}
              tintColor={ground}
              style={[styles.picture, styles.haloEdge]}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
            <Image
              source={{ uri: source }}
              onError={() => setImageFailed(true)}
              style={styles.picture}
              resizeMode="contain"
              accessibilityIgnoresInvertColors
            />
          </>
        ) : (
          <Image
            source={{ uri: source }}
            onError={() => setImageFailed(true)}
            accessibilityIgnoresInvertColors
            style={{ width: '100%', height: '100%' }}
            resizeMode="cover"
          />
        )
      ) : halo ? (
        /* No artwork: the drawn octopus keeps its disc, and the ground shows as a
           ring around it so the piece still reads as separate. */
        <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: ground }]}>
          <View
            style={[
              styles.disc,
              { width: size * 0.84, height: size * 0.84, borderRadius: size * 0.42 },
            ]}
          >
            <DrawnOctopus look={look} size={size * 0.84} />
          </View>
        </View>
      ) : (
        <DrawnOctopus look={look} size={size} />
      )}
    </View>
  );
}

/**
 * The Bot's name, set in a disc of its own colour.
 *
 * Used where a face would be noise: a mention chip, a member strip.
 */
export function InitialDisc({
  name,
  size = 24,
  color,
  style,
}: {
  name: string;
  size?: number;
  color?: string;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  const look = resolveSkin({ color });
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <View
      accessible
      accessibilityLabel={`${name} avatar`}
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: look.body,
          borderColor: theme.colors.line,
        },
        style,
      ]}
    >
      <Text style={[styles.initial, { fontSize: size * 0.42, color: 'rgba(0,0,0,0.62)' }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  uncropped: {
    overflow: 'visible',
  },
  /** A picture drawn whole, the way the desktop draws it. */
  picture: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
  },
  /** The halo: the same silhouette a little larger, in the ground's colour. */
  haloEdge: {
    transform: [{ scale: 1.1 }],
  },
  /** A disc of its own, for the drawn octopus. */
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  body: {
    position: 'absolute',
    overflow: 'hidden',
  },
  tentacle: {
    position: 'absolute',
  },
  eye: {
    position: 'absolute',
    backgroundColor: 'rgba(10, 14, 22, 0.78)',
    borderRadius: 999,
  },
  glint: {
    position: 'absolute',
    width: 2.5,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  mark: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  pixel: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 1,
    backgroundColor: 'rgba(13, 17, 23, 0.22)',
  },
  crater: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  initial: {
    fontWeight: '600',
  },
});
