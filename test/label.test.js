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
  askClef, clairicFacts, FIELDS, MAX_GAPS, MAX_QUESTIONS, productFacts, TOPIC_MIN, TOPICS,
  isTitle, namedIn, QUESTIONS, stateOf, topicList, topicsOf, writeTitle,
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

  it('asks again, once, when the model still names the customer or the product', async () => {
    const acme = { org: 'acme-corp' };
    assert.deepEqual(namedIn('Acme Corp EDS Caching and Publishing', acme), ['Acme Corp', 'EDS']);
    assert.deepEqual(namedIn("acme-corp's EDS: cache purge", acme), ["acme-corp's", 'EDS']);
    assert.deepEqual(namedIn('Configuring Git with Adobe Edge Delivery Services', acme), ['Adobe Edge Delivery Services']);
    assert.deepEqual(namedIn('Cache purge for www.acme-corp.com', acme), []);
    assert.deepEqual(namedIn('Using Edge Functions with Akamai', acme), []);
    assert.deepEqual(namedIn('Adding users to a team', { org: '_unassigned' }), []);

    const asked = [];
    const answers = ['Headless options in EDS without App Builder', 'Headless JSON options without App Builder'];
    const env = {
      AI: {
        run: async (model, { messages }) => {
          asked.push(messages);
          return { response: answers.shift() };
        },
      },
    };
    assert.equal(await writeTitle(env, 'state', false, acme), 'Headless JSON options without App Builder');
    assert.equal(asked.length, 2);
    assert.equal(asked[1][2].content, 'Headless options in EDS without App Builder');
    assert.match(asked[1][3].content, /"EDS"/);
  });

  it('keeps the title whole when the model names the product again', async () => {
    const answers = ['Migrating AEM pages to EDS', 'Migrating AEM pages to Edge Delivery'];
    const env = { AI: { run: async () => ({ response: answers.shift() }) } };
    assert.equal(await writeTitle(env, 'state', false, {}), 'Migrating AEM pages to Edge Delivery');
  });

  it('keeps the first title when asking again fails or finds nothing', async () => {
    let n = 0;
    const env = {
      AI: {
        run: async () => {
          n += 1;
          if (n > 1) {
            throw new Error('rate limited');
          }
          return { response: 'Sidekick login on EDS fails' };
        },
      },
    };
    assert.equal(await writeTitle(env, 'state', false, {}), 'Sidekick login on EDS fails');
    const none = ['Sidekick login on EDS fails', 'None'];
    const env2 = { AI: { run: async () => ({ response: none.shift() }) } };
    assert.equal(await writeTitle(env2, 'state', false, {}), 'Sidekick login on EDS fails');
  });
});

describe('Clairic facts', () => {
  const STATE = [
    'Channel: acme-eds on Slack', 'Customer: acme-corp', '',
    '[2026-10-01T10:00:00Z] Dana Ops (Adobe staff):',
    'Is Akamai purging? Check Universal Editor and the Sidekick.', '',
    '[2026-10-01T11:00:00Z] Kim Lee (customer, acme-corp):',
    'Kim here: our GTM tag, ACME-Corp sl and Akamai again.',
  ].join('\n');
  const at = (word, from = STATE.indexOf('\n\n')) => {
    const i = STATE.indexOf(word, from);
    return [i, i + word.length];
  };

  const TECH = [
    { tech: 'akamai', name: 'Akamai', description: 'Akamai as CDN' },
    {
      tech: 'tagmanager', name: 'Tag manager', description: 'a tag manager', aliases: 'GTM, Google Tag Manager',
    },
  ];

  it('takes the products from the messages, not the header, the authors or the customer', () => {
    const spans = [at('Slack', 0), at('acme-corp', 0), at('Dana Ops'), at('Akamai'),
      at('Universal Editor'), at('Sidekick.'), at('Kim', STATE.indexOf('Kim here')), at('GTM'),
      at('ACME-Corp'), at('sl '), at('Akamai', STATE.indexOf('again') - 8)];
    const facts = productFacts({
      type: 'list', confidence: 1e-7, spans, value: [],
    }, STATE, { org: 'acme-corp' }, TECH);
    // The tech stack's first, once each (GTM is the tag manager's alias), then the others.
    assert.deepEqual(facts.map((f) => f.value), ['Akamai', 'GTM', 'Universal Editor', 'Sidekick']);
    assert.ok(facts.every((f) => f.field === 'product' && f.confidence === null));
    // Without spans, the values; at most a few the tech stack does not have.
    const many = productFacts({ value: Array.from({ length: 30 }, (_, i) => `Toolbox ${String.fromCharCode(65 + i)}`) }, STATE);
    assert.equal(many.length, MAX_GAPS);
    assert.deepEqual(productFacts(undefined, STATE), []);
  });

  it('keeps Adobe products whose names are generic words without "Adobe" or "AEM"', () => {
    const tech = [
      {
        tech: 'analytics', name: 'Analytics', description: 'Adobe Analytics', aliases: 'Adobe Analytics, CJA',
      },
      {
        tech: 'assets', name: 'Assets', description: 'AEM Assets', aliases: 'AEM Assets, DAM',
      },
      {
        tech: 'forms', name: 'Forms', description: 'AEM Forms', aliases: 'AEM Forms',
      },
      {
        tech: 'aemcs', name: 'AEM Cloud Service', description: 'AEM as a Cloud Service', aliases: 'AEM Author, AEM Publish',
      },
    ];
    const names = ['Adobe Analytics', 'AEM Assets', 'AEM Forms', 'AEM Author', 'analytics', 'assets', 'forms'];
    const text = `Channel: c on Slack\nCustomer: acme\n\n[t] Dana Ops (Adobe staff):\n${names.join(', ')}`;
    const spans = names.map((n) => {
      const i = text.lastIndexOf(n);
      return [i, i + n.length];
    });
    assert.deepEqual(
      productFacts({ spans }, text, { org: 'acme' }, tech).map((f) => f.value),
      ['Adobe Analytics', 'AEM Assets', 'AEM Forms', 'AEM Author'],
    );
  });

  it('counts spans in code points, as Clairic does, and drops pieces of words', () => {
    const state = 'Channel: c on Slack\nCustomer: acme\n\n[t] Dana Ops (Adobe staff):\n🚀 🎉 Akamai and Bazaarvoice, and Azure Storage';
    const cp = (word, from = 0) => {
      const i = Array.from(state).join('').indexOf(word, from);
      const before = Array.from(state.slice(0, i)).length;
      return [before, before + Array.from(word).length];
    };
    const [z0, z1] = cp('zure Storage');
    const facts = productFacts({ spans: [cp('Akamai'), cp('Bazaarvoice'), [z0, z1]] }, state, { org: 'acme' }, TECH);
    assert.deepEqual(facts.map((f) => f.value), ['Akamai', 'Bazaarvoice']);
  });

  it('keeps names that look like products, not words, ids, headers or people', () => {
    const state = 'Channel: c on Slack\nCustomer: acme\n\n[t] Dana Ops (Adobe staff):\n';
    const names = ['Release', 'compute_execution_time', 'YwcCRmwU5Lk6WjXlqbJ0Jp', 'Cache-Control',
      'AI-powered', 'Adobe Team', 'Deploy Optimizations to', 'vCPU limit', 'EDS URL', 'BLOCKER',
      'PDP', 'experience', 'Edge', 'Feroot', 'Datawrapper', 'Experience Context'];
    const text = `${state}${names.join(', ')}; then release it.`;
    const spans = names.map((n) => {
      const i = text.indexOf(n, text.indexOf('\n\n'));
      return [i, i + n.length];
    });
    assert.deepEqual(
      productFacts({ spans }, text, { org: 'acme' }, TECH).map((f) => f.value),
      ['Feroot', 'Datawrapper', 'Experience Context'],
    );
  });

  it('keeps the other fields above their confidence, and not the products list', () => {
    assert.deepEqual(clairicFacts({
      products: { type: 'list', confidence: 0.99, value: ['Akamai'] },
      problem: { value: 'Purge fails', confidence: 0.7 },
      error: { value: null, confidence: 1 },
      deadline: { value: '2026-11-01', confidence: 0.5 },
    }), [{ field: 'problem', value: 'Purge fails', confidence: 0.7 }]);
    assert.deepEqual([FIELDS.products.type, FIELDS.products.items], ['list', 'text']);
  });
});

describe('asking Clef', () => {
  it('asks each group in calls of its own, at most MAX_QUESTIONS each', async () => {
    const calls = [];
    const env = {
      AI: {
        async run(model, { questions }) {
          calls.push(Object.keys(questions));
          return { model: 'clef', answers: Object.fromEntries(Object.keys(questions).map((q) => [q, { noul: 1 }])) };
        },
      },
    };
    const q = (prefix, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, {}]));
    const { answers } = await askClef(env, 'state', q('t', 19), q('tech', 30));
    assert.deepEqual(calls.map((c) => c.length), [19, 24, 6]);
    assert.ok(calls[0].every((k) => k.startsWith('t') && !k.startsWith('tech')));
    assert.equal(Object.keys(answers).length, 49);
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

  it('reads the topics of a label from before as they are now', () => {
    // go-live is part of the project; commerce and integrations are products, the tech stack's.
    assert.deepEqual(topicList('{"golive":0.9,"cdn":0.85,"commerce":0.95}'), ['project', 'cdn']);
    assert.deepEqual(topicList('{"project":0.95,"golive":0.9,"integrations":0.8}'), ['project']);
  });

  it('asks only about concerns, in the order they were measured in, at one cut', () => {
    assert.deepEqual(Object.keys(TOPICS), ['authoring', 'auth', 'project', 'cdn', 'domains',
      'performance', 'publishing', 'seo', 'urls', 'code', 'frontend', 'errors', 'limits',
      'security', 'roadmap']);
    assert.equal(TOPIC_MIN, 0.55);
    // QUESTIONS and the topics fit one call of their own, as they were measured.
    assert.ok(Object.keys(QUESTIONS).length + Object.keys(TOPICS).length <= MAX_QUESTIONS);
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
