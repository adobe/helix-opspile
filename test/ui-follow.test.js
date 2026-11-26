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
import { PAGES, SCRIPTS } from './ui.js';

/**
 * ui/follow.js in Node: `Follow`, with a page that has no elements, and `request` answering what
 * `answer(body)` says, recording what was sent.
 */
function load(answer = () => ({ ok: true, status: 200, data: null })) {
  const document = {
    addEventListener: () => {},
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const sent = [];
  const said = [];
  // eslint-disable-next-line no-new-func
  const Follow = new Function('document', 'globalThis', `${SCRIPTS['follow.js']}\nreturn globalThis.Follow;`)(
    document,
    {},
  );
  Follow.init({
    request: async (method, path, body) => {
      sent.push({ method, path, body });
      return answer(body);
    },
    say: (text, undo) => said.push({ text, undo: Boolean(undo) }),
  });
  return { Follow, sent, said };
}

const STATE = {
  me: {
    tech: ['xw'], area: [], org: ['acme'], person: [7],
  },
  teams: { edge: { tech: ['xw'], area: ['seo'], org: [] }, platform: { tech: [], area: [], org: [] } },
  muted: { org: ['globex'] },
  may: ['edge'],
  names: { 'tech:xw': 'Experience Workspace', 'person:7': 'Ada' },
  teamNames: { edge: 'Edge ops', platform: 'Platform ops' },
};

describe('Follow (ui/follow.js)', () => {
  it('is on every page that shows what may be followed, with your menu\'s Following', () => {
    for (const page of ['inbox.html', 'admin.html', 'topics.html']) {
      const html = PAGES[page];
      assert.ok(html.indexOf('<script src="follow.js"></script>') > 0, page);
      // Before the suggestions, which draw its buttons, and the page's own script.
      assert.ok(html.indexOf('follow.js') < html.indexOf('followsuggest.js'), page);
      assert.ok(html.indexOf('followsuggest.js') < html.indexOf('type="module"'), page);
    }
    // No page draws a follow button of its own any more.
    for (const name of ['inbox.js', 'admin.js', 'topics.js', 'followsuggest.js', 'team.js']) {
      assert.doesNotMatch(SCRIPTS[name], /class="(hmfollow|fs-follow|ofollow|follow)[" ]/, name);
    }
  });

  it('draws nothing before the state, read-only, or for what cannot be followed', () => {
    const { Follow } = load();
    assert.equal(Follow.button({ kind: 'tech', id: 'xw', name: 'X' }), '');
    Follow.set(STATE);
    assert.equal(Follow.button({ kind: 'org', id: '_unassigned', name: 'U' }), '');
    assert.equal(Follow.button({ kind: 'person', id: 'a:slack:U1', name: 'Someone' }), '');
    assert.equal(Follow.button({ kind: 'team', id: 'edge', name: 'Edge' }), '');
    Follow.init({ readonly: true });
    assert.equal(Follow.button({ kind: 'tech', id: 'xw', name: 'X' }), '');
  });

  it('is a toggle for you, a split button for whom may follow for a team, and a customer has its Mute', () => {
    const { Follow } = load();
    Follow.init({ me: { teams: [{ slug: 'edge' }] } });
    Follow.set(STATE);
    const tech = Follow.button({ kind: 'tech', id: 'xw', name: 'Experience Workspace' });
    assert.match(tech, /data-fo-act="me" aria-pressed="true"/);
    assert.match(tech, />Following</);
    // Edge ops, which you follow for, follows it: the chevron says how many.
    assert.match(tech, /class="fo-follow split"/);
    assert.match(tech, /data-fo-act="who"[^>]*><span class="fo-n">1<\/span>/);
    assert.doesNotMatch(tech, /fo-mute/);
    // A person is yours only: no chevron.
    const person = Follow.button({ kind: 'person', id: 7, name: 'Ada' });
    assert.doesNotMatch(person, /fo-more/);
    assert.match(person, /aria-pressed="true"/);
    const org = Follow.button({ kind: 'org', id: 'globex', name: 'Globex' });
    assert.match(org, /data-fo-act="mute" aria-pressed="true"/);
    assert.match(org, />Muted</);
    assert.match(org, /data-fo-act="me" aria-pressed="false"[^>]*>Follow</);
    assert.doesNotMatch(Follow.button({ kind: 'org', id: 'globex', name: 'Globex' }, { mute: false }), /fo-mute/);
    // Without a team to follow for, a toggle only.
    Follow.set({ ...STATE, may: [] });
    assert.doesNotMatch(Follow.button({ kind: 'tech', id: 'xw', name: 'X' }), /fo-more/);
    assert.deepEqual(Follow.teams('tech', 'xw'), ['edge']);
    assert.equal(Follow.name('person', 7), 'Ada');
  });

  it('counts only the teams you are on, and on a team\'s page that team only', () => {
    const { Follow } = load();
    // The admin team may follow for every team, and is on none of these.
    Follow.init({ me: { teams: [{ slug: 'admin' }] } });
    const teams = {
      admin: { tech: [], area: [], org: [] },
      edge: { tech: ['xw', 'da'], area: [], org: [] },
      platform: { tech: ['da'], area: [], org: [] },
    };
    Follow.set({
      ...STATE, teams, may: ['admin', 'edge', 'platform'], teamNames: { ...STATE.teamNames, admin: 'Admin' },
    });
    // Elsewhere: Edge ops follows it, but you are not on it, so it is no count and no name.
    const any = Follow.button({ kind: 'tech', id: 'xw', name: 'Experience Workspace' });
    assert.match(any, /class="fo-follow split"/);
    assert.doesNotMatch(any, /class="fo-n"/);
    assert.doesNotMatch(any, /Edge ops/);
    // On Edge ops' page: its count says Edge ops follows it; Platform ops is not counted.
    const edge = Follow.button({ kind: 'tech', id: 'da', name: 'Document Authoring' }, { team: 'edge' });
    assert.match(edge, /data-fo-team="edge"/);
    assert.match(edge, /<span class="fo-n">1<\/span>/);
    assert.match(edge, /Followed by Edge ops/);
    assert.doesNotMatch(edge, /Platform ops/);
    assert.doesNotMatch(Follow.button({ kind: 'tech', id: 'xw', name: 'X' }, { team: 'platform' }), /class="fo-n"/);
    // A person is never a team's.
    assert.doesNotMatch(Follow.button({ kind: 'person', id: 7, name: 'Ada' }, { team: 'edge' }), /fo-more|data-fo-team/);
    // On the page of a team you are not on and may not follow for: a toggle only.
    Follow.init({ me: { teams: [{ slug: 'edge' }] } });
    Follow.set({ ...STATE, teams, may: [] });
    assert.doesNotMatch(Follow.button({ kind: 'tech', id: 'da', name: 'D' }, { team: 'platform' }), /fo-more/);
    // On your own team's page, though you do not manage it, the chevron shows it follows it.
    assert.match(Follow.button({ kind: 'tech', id: 'da', name: 'D' }, { team: 'edge' }), /<span class="fo-n">1<\/span>/);
  });

  it('follows a customer\'s person by their account, and a thread, as your own only', () => {
    const { Follow } = load();
    Follow.init({ me: { teams: [{ slug: 'edge' }] } });
    Follow.set({
      ...STATE,
      me: { ...STATE.me, account: ['slack:T1:U7'], thread: ['slack:T1:C1:1.1'] },
      names: { ...STATE.names, 'account:slack:T1:U7': 'Cy', 'thread:slack:T1:C1:1.1': 'Go-live' },
    });
    const account = Follow.button({ kind: 'account', id: 'slack:T1:U7', name: 'Cy' });
    assert.match(account, /aria-pressed="true"[^>]*>Following</);
    assert.doesNotMatch(account, /fo-more|fo-mute/);
    // A card's made-up key is no account.
    assert.equal(Follow.button({ kind: 'account', id: 'local:person:0::Cy', name: 'Cy' }), '');
    const thread = Follow.button({ kind: 'thread', id: 'slack:T1:C1:2.1', name: 'Outage' });
    assert.match(thread, /title="Follow to keep this thread in Personal\."/);
    assert.doesNotMatch(thread, /fo-more|fo-mute/);
    assert.equal(Follow.follows('thread', 'slack:T1:C1:1.1'), true);
    assert.equal(Follow.name('thread', 'slack:T1:C1:1.1'), 'Go-live');
  });

  it('sends every change as PUT /api/follows, says it with Undo, and takes back what failed', async () => {
    let next = null;
    const { Follow, sent, said } = load(() => next);
    Follow.set(STATE);
    const changes = [];
    Follow.on((c) => changes.push(c));
    const unfollowed = { ...STATE.teams, edge: { ...STATE.teams.edge, area: [] } };
    next = { ok: true, status: 200, data: { ...STATE, teams: unfollowed } };
    assert.equal(await Follow.toggle('area', 'seo', 'SEO', 'edge'), true);
    assert.deepEqual(sent.at(-1), {
      method: 'PUT',
      path: '/api/follows',
      body: {
        kind: 'area', target: 'seo', follow: false, team: 'edge',
      },
    });
    assert.deepEqual(said.at(-1), { text: 'Edge ops no longer follows SEO.', undo: true });
    assert.deepEqual(changes.at(-1), {
      kind: 'area', id: 'seo', name: 'SEO', team: 'edge', follow: false,
    });
    assert.equal(Follow.follows('area', 'seo', 'edge'), false);
    // Muting a customer you follow ends the follow, as the server does; it says so.
    next = { ok: true, status: 200, data: { ...STATE, me: { ...STATE.me, org: [] }, muted: { org: ['globex', 'acme'] } } };
    await Follow.mute('org', 'acme', 'ACME');
    assert.deepEqual(sent.at(-1).body, { kind: 'org', target: 'acme', mute: true });
    assert.match(said.at(-1).text, /^Muted ACME\. You no longer follow ACME\.$/);
    assert.equal(Follow.muted('org', 'acme'), true);
    assert.equal(Follow.follows('org', 'acme'), false);
    // A refusal leaves it as it was.
    next = { ok: false, status: 403, data: { error: 'you do not manage this team' } };
    assert.equal(await Follow.toggle('tech', 'da', 'Document Authoring', 'platform'), false);
    assert.equal(Follow.follows('tech', 'da', 'platform'), false);
    assert.deepEqual(said.at(-1), { text: 'Could not follow Document Authoring: you do not manage this team', undo: false });
  });
});
