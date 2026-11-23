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

/**
 * What scripts/perf-ui.mjs finds on the inbox page. These are hooks the page keeps for its own
 * code: ids, data-* attributes, roles and ARIA states, and as few class names as it can, never
 * text. A restyle should not break the script. test/perf-ui.test.js checks that ui/inbox.js
 * and ui/inbox.html still write every one of them.
 */

/** The list of threads, and its rows: one per thread, keyed by it. A row folding away is inert. */
export const LIST = '#threads';
export const ROW = `${LIST} [data-thread]:not([inert])`;

/** The pane's messages: a message's data-id is `<thread>|<message>`. */
export const MESSAGE = '#pane [data-id]';
/** An expression: the thread whose messages the pane shows, or null. */
export const SHOWN = `(document.querySelector('${MESSAGE}')?.dataset.id.split('|')[0] || null)`;
/** A message (by its data-id), where the pointer hovers it: its bubble. */
export const BUBBLE = (id) => `#pane [data-id=${JSON.stringify(id)}] .bubble`;
/** The name over a message: pointing at it shows the profile card. */
export const AUTHOR = `${MESSAGE} .who [data-p]`;
export const CARD = '#pcard';

/** The rows of the filter `id` (data-f), each with its value in data-v. */
export const FACET = (id) => `#filters [data-f="${id}"][data-v]`;
/** "Clear" on the card of the filter `id`, once a value of it is picked. */
export const FACET_CLEAR = (id) => `#filters [data-f="${id}"] [data-clear]`;
/** Unread only, over the list (aria-pressed). */
export const UNREAD = `${LIST} [data-unread]`;
/** The view switch over the list: Personal (data-view=""), or a team's view (its slug). */
export const VIEW = (slug) => `${LIST} [role="radiogroup"] [role="radio"][data-view="${slug}"]`;
/** What a view fetches: its list is ready once this came in and the rows changed. */
export const VIEW_URL = (slug) => (slug ? `/api/inbox?team=${slug}` : '/api/inbox?view=personal');

/** The reply box; aria-expanded while it suggests @-mentions. */
export const REPLY = '#reply';
/** Where the pointer goes when the filter rail slid out over what a step clicks. */
export const HEADER = 'header';
/** npm run ui:dev's banner, removed before measuring. */
export const BANNER = '#dev-banner';

/** The fake teams of `npm run ui:dev` the script switches between (scripts/dev-ui-fixtures.mjs). */
export const TEAM = 'platform';
export const OTHER_TEAM = 'edge';
/** The filters it picks from. */
export const FACETS = ['customer', 'kind'];

/** Every selector as the script uses it, for test/perf-ui.test.js. */
export const SELECTORS = [
  LIST, ROW, MESSAGE, BUBBLE('x|y'), AUTHOR, CARD,
  ...FACETS.map(FACET), ...FACETS.map(FACET_CLEAR), UNREAD,
  VIEW(''), VIEW(TEAM), VIEW(OTHER_TEAM), REPLY, HEADER,
];
