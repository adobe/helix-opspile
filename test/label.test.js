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
  isTitle, QUESTIONS, stateOf, tidyTitle, topicList, topicsOf, writeTitle,
} from '../src/label.js';

// Made-up thread and people only.
describe('what the models read', () => {
  it('shows the reactions a message got, and whether a customer or Adobe left them', () => {
    const thread = {
      source: 'slack', channel_name: 'acme-support', org: 'acme', root_at: '2026-10-21T10:00:00Z',
    };
    const messages = [
      {
        id: '1.1', at: '2026-10-21T10:00:00Z', body: 'The page is broken', author: { kind: 'person', name: 'Cy' },
      },
      {
        id: '1.2', at: '2026-10-21T10:05:00Z', body: 'Fixed it', author: { kind: 'person', name: 'Ada', staff: true },
      },
    ];
    const reactions = new Map([['1.2', [
      { emoji: 'white_check_mark', name: 'Cy', staff: false },
      { emoji: 'eyes', name: 'Bo', staff: true },
    ]]]);
    const state = stateOf(thread, messages, reactions);
    assert.match(state, /Fixed it\nReactions: ✅ by Cy \(customer\), 👀 by Bo \(Adobe staff\)/);
    assert.doesNotMatch(state, /broken\nReactions/);
  });
});

describe('thread titles', () => {
  it('tells the model to leave out the customer and the product, which the inbox shows', async () => {
    let system;
    const env = {
      AI: {
        run: async (model, { messages }) => {
          system = messages[0].content;
          return { response: '"Sidekick login fails after SSO change."' };
        },
      },
    };
    const title = await writeTitle(env, 'state', false, { org: 'acme-corp' });
    assert.equal(title, 'Sidekick login fails after SSO change');
    assert.match(system, /do not name the customer \(acme-corp\)/);
    assert.match(system, /Edge Delivery Services/);
  });

  it('removes the customer and the product when the model still names them', () => {
    const acme = { org: 'acme-corp' };
    assert.equal(tidyTitle('Acme Corp EDS Caching and Publishing', acme), 'Caching and Publishing');
    assert.equal(tidyTitle("acme-corp's EDS: cache purge", acme), 'Cache purge');
    assert.equal(tidyTitle('Updating images in Edge Delivery', acme), 'Updating images');
    assert.equal(tidyTitle('Configuring Git with Adobe Edge Delivery Services', acme), 'Configuring Git');
    assert.equal(tidyTitle('Cache purge for www.acme-corp.com', acme), 'Cache purge for www.acme-corp.com');
    assert.equal(tidyTitle('Using Edge Functions with Akamai', acme), 'Using Edge Functions with Akamai');
    assert.equal(tidyTitle('Acme Corp', acme), null);
    assert.equal(tidyTitle('Adding users to a team', { org: '_unassigned' }), 'Adding users to a team');
  });
});

describe('kinds and topics', () => {
  it('tells access problems apart from people joining or leaving, and meetings', () => {
    const kinds = Object.keys(QUESTIONS.kind.criteria);
    assert.deepEqual(kinds, ['incident', 'security', 'question', 'request', 'access', 'people', 'meeting', 'other']);
    assert.doesNotMatch(QUESTIONS.kind.criteria.access, /welcome/);
    assert.match(QUESTIONS.kind.criteria.people, /welcome/);
  });

  it('keeps the topics Clef is sure of, likeliest first', () => {
    const topics = topicsOf({
      'topic.cdn': { noul: 0.81 }, 'topic.seo': { noul: 0.95 }, 'topic.auth': { noul: 0.3 }, next_actor: {},
    });
    assert.deepEqual(topics, { cdn: 0.81, seo: 0.95 });
    assert.deepEqual(topicList(JSON.stringify(topics)), ['seo', 'cdn']);
    assert.equal(topicsOf({ 'topic.cdn': { noul: 0.2 } }), null);
    assert.deepEqual(topicList(null), []);
    assert.deepEqual(topicList('not json'), []);
  });
});

describe('titles that are not titles', () => {
  it('drops what the model writes when it found nothing to name', async () => {
    for (const t of ['None', 'No title available', 'No specific topic mentioned', 'Invalid title, please provide a description of the issue', 'General Inquiry']) {
      assert.equal(isTitle(t), false, t);
    }
    assert.equal(isTitle('Sidekick login fails after SSO change'), true);
    assert.equal(isTitle('No-cache header missing on PDF assets'), true);
    const env = { AI: { run: async () => ({ response: 'None' }) } };
    assert.equal(await writeTitle(env, 'state', false, { org: 'acme' }), null);
  });
});
