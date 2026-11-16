/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  blockUsers, slackBlocksToMarkdown, slackLabels, slackToMarkdown,
} from '../src/slackmd.js';

const names = { U1: 'Ada' };
const user = (id) => names[id];

describe('slackToMarkdown', () => {
  it('converts emphasis, strike-through and quotes', () => {
    assert.equal(slackToMarkdown('*bold* and _it_ and ~gone~'), '**bold** and *it* and ~~gone~~');
    assert.equal(slackToMarkdown('_*both*_, *a _b_ c*, :x:*after an emoji*'), '***both***, **a *b* c**, :x:**after an emoji**');
    assert.equal(slackToMarkdown('&gt; quoted\n&gt; twice\nreply'), '> quoted\n> twice\n\nreply');
  });

  it('leaves what Slack shows as text text, escaped where markdown would read it', () => {
    // Slack takes no `*` inside a word or before a space; CommonMark would make 3 italic.
    assert.equal(slackToMarkdown('2*3*4, snake_case and * not bold *'), '2\\*3\\*4, snake_case and \\* not bold \\*');
    assert.equal(slackToMarkdown('• one\n- two\n1. three'), '• one\n\\- two\n1\\. three');
  });

  it('converts links, mentions and channel references', () => {
    assert.equal(
      slackToMarkdown('see <https://example.com|docs> and <https://example.org> <@U1> <@U2> <#C1|ops> <!here> <!subteam^S1|@oncall>', user),
      'see [docs](https://example.com) and [https://example.org](https://example.org) @Ada @U2 #ops @here @oncall',
    );
    assert.equal(slackToMarkdown('*<https://example.com/i|Errors & latency>*'), '**[Errors & latency](https://example.com/i)**');
  });

  it('keeps paragraphs and line breaks', () => {
    assert.equal(slackToMarkdown('one\ntwo\n\nthree\n *indented*'), 'one\ntwo\n\nthree\n**indented**');
  });

  it('leaves code alone', () => {
    assert.equal(slackToMarkdown('run `a *b* c` now'), 'run `a *b* c` now');
    assert.equal(slackToMarkdown('```\nif (a &lt; b) *x*\n```'), '```\nif (a < b) *x*\n```');
  });

  it('unescapes entities', () => {
    assert.equal(slackToMarkdown('a &amp; b &lt;c&gt;'), 'a & b \\<c>');
  });

  it('keeps what the person typed in code: the label, the URL or @name', () => {
    const md = slackToMarkdown('try (`<https://www.site.example|www.site.example>`) or `<@U1>`\n```<http://x.example/a>```', user);
    assert.match(md, /\(`www\.site\.example`\)/);
    assert.match(md, /`@Ada`/);
    assert.match(md, /```\nhttp:\/\/x\.example\/a\n```/);
  });
});

const section = (...elements) => ({ type: 'rich_text_section', elements });
const t = (text, style) => ({ type: 'text', text, ...(style ? { style } : {}) });

describe('slackBlocksToMarkdown', () => {
  it('writes rich text as Slack shows it: styles, mentions, lists, code and quotes', () => {
    const blocks = [{
      type: 'rich_text',
      elements: [
        section(
          t('Status: ', { bold: true }),
          { type: 'emoji', name: 'warning' },
          t('degraded\n', { bold: true }),
          { type: 'user', user_id: 'U1' },
          t(' see '),
          { type: 'link', url: 'https://example.com/a_b', text: 'the docs' },
          t(' in '),
          { type: 'channel', channel_id: 'C1' },
          t(', '),
          t('x', { code: true }),
          t(' and 2*3*4'),
        ),
        {
          type: 'rich_text_list', style: 'bullet', indent: 0, elements: [section(t('one')), section(t('two'))],
        },
        {
          type: 'rich_text_list', style: 'ordered', indent: 1, elements: [section(t('nested'))],
        },
        {
          type: 'rich_text_list', style: 'bullet', indent: 0, elements: [section(t('three'))],
        },
        { type: 'rich_text_preformatted', elements: [t('a < b\n  c\n')] },
        { type: 'rich_text_quote', elements: [t('quoted\nlines')] },
        section(t('one\n\ntwo')),
      ],
    }];
    assert.equal(
      slackBlocksToMarkdown(blocks, { user, ...slackLabels('<#C1|ops>') }),
      [
        '**Status:** :warning:**degraded**',
        '@Ada see [the docs](https://example.com/a_b) in #ops, `x` and 2\\*3\\*4',
        '',
        '- one',
        '- two',
        '  1. nested',
        '- three',
        '',
        '```',
        'a < b',
        '  c',
        '```',
        '',
        '> quoted',
        '> lines',
        '',
        'one',
        '',
        'two',
      ].join('\n'),
    );
    assert.deepEqual(blockUsers(blocks), ['U1']);
  });

  it('writes what apps send: headers, sections, fields, context, dividers and markdown', () => {
    assert.equal(
      slackBlocksToMarkdown([
        { type: 'header', text: { type: 'plain_text', text: 'Deploy *done*' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Service* is <https://example.com|up>' } },
        {
          type: 'section',
          fields: [{ type: 'mrkdwn', text: '*Region:*\neu' }, { type: 'mrkdwn', text: '*Took:*\n3 s' }],
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_by_ ops' }, { type: 'plain_text', text: 'today' }, { type: 'image', image_url: 'x' }],
        },
        { type: 'markdown', text: '**Done** in `1 s`' },
        { type: 'actions', elements: [] },
      ]),
      '**Deploy \\*done\\***\n\n**Service** is [up](https://example.com)\n\n**Region:** eu\n**Took:** 3 s\n\n---\n\n*by* ops · today\n\n**Done** in `1 s`',
    );
  });

  it('writes tables', () => {
    assert.equal(
      slackBlocksToMarkdown([{
        type: 'table',
        column_settings: [null, { align: 'right' }],
        rows: [
          [{ type: 'rich_text', elements: [section(t('Check', { bold: true }))] }, { type: 'raw_text', text: 'Count' }],
          [{ type: 'raw_text', text: 'a|b' }, { type: 'raw_text', text: '1' }],
        ],
      }]),
      '| **Check** | Count |\n| --- | ---: |\n| a\\|b | 1 |',
    );
  });

  it('finds the users the mrkdwn of apps\' blocks mentions, for their names', () => {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: 'Assigned to <@U1>' }, fields: [{ type: 'mrkdwn', text: 'cc <@U2|bo>' }] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'by <@W3>' }] },
      { type: 'table', rows: [[{ type: 'raw_text', text: 'x' }, { type: 'rich_text', elements: [section({ type: 'user', user_id: 'U4' })] }]] },
    ];
    assert.deepEqual(blockUsers(blocks), ['U1', 'U2', 'W3', 'U4']);
    assert.match(slackBlocksToMarkdown(blocks, { user }), /^Assigned to @Ada\n\ncc @bo/);
  });

  it('shows nothing for blocks that show nothing, so the text is read', () => {
    assert.equal(slackBlocksToMarkdown([{ type: 'actions', elements: [] }]), null);
    assert.equal(slackBlocksToMarkdown([]), null);
    assert.equal(slackBlocksToMarkdown(undefined), null);
  });
});
