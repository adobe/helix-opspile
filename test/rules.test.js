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
import { classify, slug, UNASSIGNED } from '../src/rules.js';

// Made-up channel names and slugs only.
const rule = (id, target, field, pattern, value, extra = {}) => ({
  id, target, field, pattern, value, priority: 100, source: null, ...extra,
});

describe('classify', () => {
  const rules = [
    rule(1, 'org', 'name', '^aem-(.+)$', '$1'),
    rule(2, 'org', 'channel_id', '^C0TEST$', '_test', { priority: 10 }),
    rule(3, 'team', 'name', '^aem-', 'helix'),
    rule(4, 'team', 'channel_id', '^C0TEST$', 'admin', { priority: 10 }),
    rule(5, 'kind', 'name', '-alerts$', 'alert'),
    rule(6, 'org', 'group_name', '^Customer (.+)$', '$1', { source: 'teams' }),
    rule(7, 'org', 'connected', '^T0VENDOR$', 'vendor-x'),
  ];

  it('derives org and team from naming conventions', () => {
    const c = classify(rules, { source: 'slack', channelId: 'C1', name: 'aem-acme-corp' });
    assert.equal(c.org, 'acme-corp');
    assert.equal(c.team, 'helix');
    assert.equal(c.kind, 'channel');
    assert.deepEqual(c.matched, { org: 1, team: 3 });
  });

  it('lets a lower priority number win, e.g. an override by channel id', () => {
    const c = classify(rules, { source: 'slack', channelId: 'C0TEST', name: 'aem-opspile-test' });
    assert.equal(c.org, '_test');
    assert.equal(c.team, 'admin');
  });

  it('defaults to unassigned', () => {
    const c = classify(rules, { source: 'slack', channelId: 'C2', name: 'random' });
    assert.deepEqual([c.org, c.team, c.kind], [UNASSIGNED, UNASSIGNED, 'channel']);
  });

  it('sets the kind', () => {
    assert.equal(classify(rules, { source: 'slack', channelId: 'C3', name: 'aem-x-alerts' }).kind, 'alert');
  });

  it('respects the source of a rule', () => {
    const teams = { source: 'teams', channelId: '19:x', groupName: 'Customer Globex' };
    assert.equal(classify(rules, teams).org, 'globex');
    assert.equal(classify(rules, { ...teams, source: 'slack' }).org, UNASSIGNED);
  });

  it('matches any connected team', () => {
    const c = classify(rules, {
      source: 'slack', channelId: 'C4', name: 'shared', connected: ['T0OTHER', 'T0VENDOR'],
    });
    assert.equal(c.org, 'vendor-x');
  });

  it('ignores broken patterns', () => {
    const c = classify([rule(9, 'org', 'name', '(', 'x')], { source: 'slack', channelId: 'C', name: '(' });
    assert.equal(c.org, UNASSIGNED);
  });
});

describe('slug', () => {
  it('makes path-safe slugs', () => {
    assert.equal(slug('Acme Corp. (EMEA)'), 'acme-corp-emea');
    assert.equal(slug('Müller & Söhne'), 'muller-sohne');
    assert.equal(slug(''), UNASSIGNED);
  });
});
