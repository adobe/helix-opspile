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

/*
 * The thread header's button to the customer's stack drawing (ui/inbox.js, stackButton): there
 * where the customer has a drawing, in a team's inbox as in the personal view, and the tech
 * stack's dropdown names the drawing only where there is none. The page's own code, in pieces,
 * run in Node with what they need of the rest of the page stubbed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SCRIPTS } from './ui.js';

const html = SCRIPTS['inbox.js'];

/** A piece of the page's script, from the line starting with `from` up to `to`, run in Node. */
function piece(from, to, expose, globals = {}) {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `${from} … ${to} not found`);
  // eslint-disable-next-line no-new-func
  return new Function(...Object.keys(globals), `${html.slice(a, b)}\nreturn { ${expose} };`)(
    ...Object.values(globals),
  );
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const VOCAB = {
  stack: [{ id: 'edge', name: 'Edge' }, { id: 'site', name: 'Site' }, { id: 'content', name: 'Content' }],
};
const PARTS = [
  { name: 'Akamai', tech: 'akamai/cdn', layer: 'edge' },
  { name: 'Edge Delivery', tech: 'adobe/aem-sites/edge-delivery', layer: 'site' },
  { name: 'Document Authoring', tech: 'adobe/aem-sites/document-authoring', layer: 'content' },
];

function load(listStacks = {}) {
  const state = { data: { vocab: VOCAB, stacks: listStacks } };
  const stack = piece('/** The customer\'s parts, in the drawing\'s order', '/** Pages of the inbox, merged', 'orgStack, stackLine', { state });
  return piece('function techMenu(data) {', '/** A link\'s favicon', 'techMenu, headStack, stackButton', {
    state,
    esc,
    ...stack,
    ...piece('/** Whether `org` is a customer of its own', '/** What GET /api/customers/profile', 'cardOrg, orgHref, withOrg', { esc }),
    customerName: (org) => ({ acme: 'ACME' }[org] || org),
    orgName: (t) => t.org_name || t.org,
    headTech: () => ({
      here: [{ id: 'akamai/cdn', name: 'Akamai', p: 0.9 }], also: [], topics: [], label: 'Akamai', count: 1,
    }),
    hmSection: (title, rows) => (rows.length ? `<h>${title}</h>${rows.join('')}` : ''),
    Follow: { button: () => '' },
    pct: (p) => `${Math.round(p * 100)}%`,
    headMenu: (name, { list }) => `<menu ${name}>${list}</menu>`,
  });
}

const thread = (org, stack) => ({
  thread: { org, org_name: org === 'acme' ? 'ACME' : org }, vocab: VOCAB, ...(stack ? { stack } : {}),
});

describe('the thread header\'s stack drawing', () => {
  it('has a button to the drawing where the customer has one, its key parts in the tooltip', () => {
    const page = load();
    const button = page.stackButton(thread('acme', PARTS));
    assert.match(button, /^<div class="hm stk"><button type="button" class="hmb" data-stack="acme" aria-haspopup="dialog" aria-expanded="false"/);
    assert.match(button, /title="ACME&#39;s tech stack: Akamai, Edge Delivery, Document Authoring\. Show the drawing"/);
    assert.match(button, /<span class="wf wf-layers" aria-hidden="true"><\/span><span class="lb">Stack drawing<\/span>/);
    // The dropdown leaves the drawing to the button.
    assert.doesNotMatch(page.techMenu(thread('acme', PARTS)), /stk-open/);
  });

  it('knows of the drawing from the list where the thread view does not say', () => {
    const page = load({ acme: PARTS });
    assert.equal(page.headStack(thread('acme')).length, 3);
    assert.match(page.stackButton(thread('acme')), /data-stack="acme"/);
  });

  it('has none without a drawing, or without a customer; the dropdown says so then', () => {
    const page = load();
    assert.equal(page.stackButton(thread('acme', [])), '');
    assert.equal(page.stackButton(thread('_unknown', PARTS)), '');
    assert.equal(page.stackButton(thread(null)), '');
    assert.match(page.techMenu(thread('acme', [])), /<button type="button" class="hmi stk-open" data-stack="acme"><span>ACME's stack drawing<\/span><\/button>/);
  });

  it('leads to the customer\'s profile in Customers at the dropdown\'s foot, not for threads of none', () => {
    const page = load();
    const menu = page.techMenu(thread('acme', PARTS));
    assert.match(menu, /<div class="hms"><a class="hmi foot" href="\/inbox\/admin\?tab=orgs&amp;org=acme"><span>ACME's profile<\/span><small>Customers<\/small><\/a><\/div><\/menu>$/);
    assert.doesNotMatch(page.techMenu(thread('_unassigned', PARTS)), /class="hmi foot"/);
    // Opening the dropdown focuses its first link, not the one at its foot.
    assert.match(html, /\.hmpop a\.hmi:not\(\.foot\)`\)\?\.focus\(\)/);
  });
});
