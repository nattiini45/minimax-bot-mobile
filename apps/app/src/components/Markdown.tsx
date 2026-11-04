import React from 'react';
import { Linking, Platform, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { useTheme } from '../theme';

/**
 * Markdown.
 *
 * The team answers in markdown, and a phone that prints the source of that answer
 * looks like a phone that cannot read it: `**Chief**`, `| Bot | Role |` and a row of
 * backticks are the answer's shape, not the answer. So the reply is rendered.
 *
 * The renderer covers the subset a team actually writes — headings, bold, italic,
 * inline code, fenced code, lists, quotes, rules, links and pipe tables — and
 * degrades to plain text for everything else. A reply that is a wall of markdown
 * source is a bug in the model, not a reason to show the source.
 */

interface Inline {
  type: 'text' | 'bold' | 'italic' | 'strike' | 'code' | 'link';
  text?: string;
  url?: string;
  children?: Inline[];
}

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'list'; items: { level: number; marker: string; text: string }[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }
  | { kind: 'table'; header: string[]; rows: string[][] };

/** A line that starts a list item, with the marker and the text after it. */
const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

/**
 * Splits the inline marks out of a line.
 *
 * The scan is left to right and never guesses: an unclosed marker is text, and an
 * escaped character is the character itself.
 */
function parseInline(input: string): Inline[] {
  const nodes: Inline[] = [];
  let buffer = '';
  let index = 0;

  const flush = () => {
    if (buffer) {
      nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }
  };

  while (index < input.length) {
    const char = input[index];

    // A backslash escapes the next character, so `\*` is a star and not a mark.
    if (char === '\\' && index + 1 < input.length) {
      buffer += input[index + 1];
      index += 2;
      continue;
    }

    if (char === '`') {
      const end = input.indexOf('`', index + 1);
      if (end > index + 1) {
        flush();
        nodes.push({ type: 'code', text: input.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      const strong = input[index + 1] === char;
      const marker = strong ? char + char : char;
      const after = index + marker.length;
      // An underscore inside a word is part of the word: `snake_case` is not italics.
      const wordInternal = char === '_' && index > 0 && /[\w]/.test(input[index - 1]);
      const end = wordInternal ? -1 : input.indexOf(marker, after);
      if (end >= after && input.slice(after, end).trim()) {
        flush();
        nodes.push({
          type: strong ? 'bold' : 'italic',
          children: parseInline(input.slice(after, end)),
        });
        index = end + marker.length;
        continue;
      }
    }

    if (char === '~' && input[index + 1] === '~') {
      const end = input.indexOf('~~', index + 2);
      if (end > index + 1) {
        flush();
        nodes.push({ type: 'strike', children: parseInline(input.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (char === '[') {
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(input.slice(index));
      if (link) {
        flush();
        nodes.push({ type: 'link', text: link[1], url: link[2] });
        index += link[0].length;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return nodes;
}

/** Splits a reply into the blocks it is made of. */
function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // A fenced code block keeps its own lines, marks and all.
    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: 'code', language: fence[1].trim(), text: body.join('\n') });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', lines: body });
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const table: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        const cells = lines[index]
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());
        // The row under the header is the separator, not a row of the table.
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
          table.push(cells);
        }
        index += 1;
      }
      const [header, ...rows] = table;
      if (header) blocks.push({ kind: 'table', header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const items: { level: number; marker: string; text: string }[] = [];
      while (index < lines.length) {
        const entry = LIST_ITEM.exec(lines[index]);
        if (!entry) break;
        items.push({
          level: Math.min(Math.floor(entry[1].length / 2), 3),
          marker: entry[2],
          text: entry[3],
        });
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    // Anything else is a paragraph. Its line breaks are kept: a reply that was
    // written on three lines was meant to be read on three lines.
    const body: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index];
      if (
        /^(#{1,6})\s+/.test(current) ||
        /^\s*```/.test(current) ||
        /^\s*>/.test(current) ||
        /^\s*\|/.test(current) ||
        LIST_ITEM.test(current) ||
        /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(current)
      ) {
        break;
      }
      body.push(current);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', lines: body });
  }

  return blocks;
}

export interface MarkdownProps {
  text: string;
  /** The caller's own text style: the bubble sets the colour and the size. */
  style?: StyleProp<TextStyle>;
}

export function Markdown({ text, style }: MarkdownProps) {
  const theme = useTheme();
  const blocks = React.useMemo(() => parseBlocks(text ?? ''), [text]);
  const mono = theme.font.mono;

  const renderInline = (nodes: Inline[], keyPrefix: string): React.ReactNode[] =>
    nodes.map((node, index) => {
      const key = `${keyPrefix}-${index}`;
      switch (node.type) {
        case 'bold':
          return (
            <Text key={key} style={styles.bold}>
              {renderInline(node.children ?? [], key)}
            </Text>
          );
        case 'italic':
          return (
            <Text key={key} style={styles.italic}>
              {renderInline(node.children ?? [], key)}
            </Text>
          );
        case 'strike':
          return (
            <Text key={key} style={styles.strike}>
              {renderInline(node.children ?? [], key)}
            </Text>
          );
        case 'code':
          return (
            <Text
              key={key}
              style={[styles.inlineCode, { backgroundColor: theme.colors.code, fontFamily: mono }]}
            >
              {node.text}
            </Text>
          );
        case 'link': {
          const url = node.url ?? '';
          // Only a web link is opened: a `file:` or `javascript:` URL has no business
          // being one tap away from a chat message.
          const openable = /^https?:\/\//i.test(url);
          return (
            <Text
              key={key}
              accessibilityRole={openable ? 'link' : undefined}
              {...(openable && Platform.OS === 'web' ? { href: url } : {})}
              style={openable ? { color: theme.colors.accent, textDecorationLine: 'underline' } : undefined}
              onPress={
                openable && Platform.OS !== 'web'
                  ? () => {
                      void Linking.openURL(url).catch(() => {
                        /* a link that will not open is not worth a crash */
                      });
                    }
                  : undefined
              }
            >
              {node.text}
            </Text>
          );
        }
        default:
          return <Text key={key}>{node.text}</Text>;
      }
    });

  return (
    <View>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case 'heading': {
            const size = block.level <= 1 ? 19 : block.level === 2 ? 17 : 15;
            return (
              <Text
                key={key}
                style={[
                  styles.heading,
                  {
                    color: theme.colors.ink,
                    fontSize: size,
                    // The first block of a reply does not need the room above it.
                    marginTop: index === 0 ? 0 : 10,
                  },
                ]}
              >
                {renderInline(parseInline(block.text), key)}
              </Text>
            );
          }
          case 'code':
            return (
              <View
                key={key}
                style={[styles.codeBox, { backgroundColor: theme.colors.code, borderColor: theme.colors.line }]}
              >
                <Text style={[styles.codeText, { color: theme.colors.ink, fontFamily: mono }]}>{block.text}</Text>
              </View>
            );
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View
                    key={`${key}-${itemIndex}`}
                    style={[styles.listItem, { marginLeft: item.level * 16 }]}
                  >
                    <Text style={[styles.marker, { color: theme.colors.subtleText }]}>
                      {/^\d/.test(item.marker) ? `${item.marker}` : '•'}
                    </Text>
                    <Text style={[styles.listText, { color: theme.colors.ink }]}>
                      {renderInline(parseInline(item.text), `${key}-${itemIndex}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={key} style={styles.quoteRow}>
                <View style={[styles.quoteBar, { backgroundColor: theme.colors.accent }]} />
                <View style={styles.quoteText}>
                  {block.lines.map((line, lineIndex) => (
                    <Text
                      key={`${key}-${lineIndex}`}
                      style={[styles.quoteLine, { color: theme.colors.muted }]}
                    >
                      {renderInline(parseInline(line), `${key}-${lineIndex}`)}
                    </Text>
                  ))}
                </View>
              </View>
            );
          case 'rule':
            return <View key={key} style={[styles.rule, { backgroundColor: theme.colors.line }]} />;
          case 'table': {
            const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
            return (
              <View key={key} style={[styles.table, { borderColor: theme.colors.line }]}>
                <View style={[styles.tableRow, { borderBottomColor: theme.colors.line }]}>
                  {Array.from({ length: columns }).map((_, column) => (
                    <Text
                      key={`${key}-h-${column}`}
                      style={[styles.tableCell, styles.tableHead, column === 0 ? styles.tableCellFirst : null, { color: theme.colors.ink }]}
                    >
                      {block.header[column] ?? ''}
                    </Text>
                  ))}
                </View>
                {block.rows.map((row, rowIndex) => (
                  <View
                    key={`${key}-r-${rowIndex}`}
                    style={[
                      styles.tableRow,
                      rowIndex === block.rows.length - 1
                        ? null
                        : { borderBottomColor: theme.colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
                    ]}
                  >
                    {Array.from({ length: columns }).map((_, column) => (
                      <Text
                        key={`${key}-r-${rowIndex}-${column}`}
                        style={[
                          styles.tableCell,
                          // The first column names the row and is usually the shorter
                          // one, so it gets a little less room than the rest.
                          column === 0 ? styles.tableCellFirst : null,
                          { color: theme.colors.muted },
                        ]}
                      >
                        {renderInline(parseInline(row[column] ?? ''), `${key}-r-${rowIndex}-${column}`)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          }
          default:
            return (
              <Text key={key} style={[styles.paragraph, style]}>
                {block.lines.map((line, lineIndex) => (
                  <Text key={`${key}-${lineIndex}`}>
                    {renderInline(parseInline(line), `${key}-${lineIndex}`)}
                    {lineIndex < block.lines.length - 1 ? '\n' : ''}
                  </Text>
                ))}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  paragraph: {
    fontSize: 15,
    lineHeight: 22,
  },
  heading: {
    fontWeight: '700',
    letterSpacing: -0.2,
    marginBottom: 4,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  strike: {
    textDecorationLine: 'line-through',
  },
  inlineCode: {
    fontSize: 13,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  codeBox: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginVertical: 6,
  },
  codeText: {
    fontSize: 13,
    lineHeight: 19,
  },
  list: {
    marginVertical: 4,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 3,
  },
  marker: {
    fontSize: 15,
    lineHeight: 22,
    minWidth: 14,
  },
  listText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 22,
  },
  quoteRow: {
    flexDirection: 'row',
    gap: 10,
    marginVertical: 4,
  },
  quoteBar: {
    width: 3,
    borderRadius: 2,
  },
  quoteText: {
    flex: 1,
  },
  quoteLine: {
    fontSize: 14,
    lineHeight: 20,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 10,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    overflow: 'hidden',
    marginVertical: 6,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  tableCell: {
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  tableCellFirst: {
    flex: 0.8,
  },
  tableHead: {
    fontWeight: '700',
  },
});
