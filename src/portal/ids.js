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
 * The ids of the customer portal (src/portal/worker.js), which the inbox reads as the source
 * `portal` (src/portalsource.js). Both Workers import this file, so that each can name what
 * the other made without asking it.
 */

const hex = async (value) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** A mail address as the portal keys people by it: trimmed, lower case. */
export const mailOf = (email) => String(email || '').trim().toLowerCase();

/** The mail domain of an address, lower case, or null. */
export function domainOf(email) {
  const m = /^[^@\s]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(mailOf(email));
  return m ? m[1] : null;
}

/** Mail domains of everyone: they say nothing of a company, and never catch anyone. */
const PUBLIC_MAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'yandex.com', 'yandex.ru',
  'mail.ru', 'qq.com', '163.com', '126.com', 'zoho.com', 'hey.com', 'fastmail.com', 'mail.com',
  't-online.de', 'orange.fr', 'free.fr', 'libero.it', 'naver.com', 'tutanota.com', 'tuta.io',
  'mailbox.org', 'posteo.de', 'seznam.cz', 'rediffmail.com', 'yahoo.co.jp', 'daum.net']);
/** The same providers' country domains (`yahoo.co.uk`, `gmx.at`, `outlook.de`). */
const PUBLIC_BRANDS = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'yahoo', 'gmx',
  'yandex', 'icloud', 'protonmail', 'proton', 'aol', 'msn']);
/** Second-level labels of country domains (`acme.co.uk`): the company is the label before. */
const SECOND_LEVEL = new Set(['co', 'com', 'ac', 'gov', 'org', 'net', 'edu', 'ne', 'or', 'gv', 'ltd', 'plc']);

/**
 * A mail domain's labels and where its company label is (`mail.acme.co.uk`: `acme`), or null
 * for what is not a domain.
 */
export function domainParts(domain) {
  const labels = String(domain || '').toLowerCase().split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) {
    return null;
  }
  const at = labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2])
    && labels[labels.length - 1].length === 2 ? labels.length - 3 : labels.length - 2;
  return { labels, at };
}

/** Whether a mail domain is everyone's (gmail.com, outlook.com, yahoo.co.uk, …). */
export function isPublicMail(domain) {
  const parts = domainParts(domain);
  return !parts || PUBLIC_MAIL.has(parts.labels.slice(parts.at).join('.'))
    || PUBLIC_MAIL.has(parts.labels.join('.')) || PUBLIC_BRANDS.has(parts.labels[parts.at]);
}

/**
 * A person's account id in the portal: `u` and a hash of their mail address. The inbox works
 * it out for the person who replies or reacts from there, as the portal does when they do.
 */
export async function portalUserId(email) {
  return `u${(await hex(`user:${mailOf(email)}`)).slice(0, 20)}`;
}

/** The account id of a bot that posts in the portal (the inbox's app), by its name. */
export async function portalBotId(name) {
  return `b${(await hex(`bot:${String(name || '').trim().toLowerCase()}`)).slice(0, 20)}`;
}

const random = (n) => [...crypto.getRandomValues(new Uint8Array(n))]
  .map((b) => (b % 36).toString(36)).join('');

/**
 * A message id: `m`, the time in base 36 (nine digits, so ids sort by time until the year
 * 5188) and six random digits.
 */
export const messageId = (now = Date.now()) => `m${Math.floor(now).toString(36).padStart(9, '0')}${random(6)}`;

/** A channel id: `c` and twelve random digits. It says nothing about the customer. */
export const channelId = () => `c${random(12)}`;

/** What a message id looks like (src/post.js checks the root a reply names). */
export const MESSAGE_ID = /^m[0-9a-z]{15}$/;

/** What a channel id looks like. */
export const CHANNEL_ID = /^c[0-9a-z]{12}$/;

/** A file id: `f` and sixteen random digits. Whoever knows one still has to be let in. */
export const fileId = () => `f${random(16)}`;

/** What a file id looks like. */
export const FILE_ID = /^f[0-9a-z]{16}$/;

/** A file's name as a path segment: nothing in it ends a markdown link or a path. */
const segmentOf = (name) => encodeURIComponent(String(name || 'file'))
  .replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Where the portal serves a file: `/api/file/<id>/<name>`, under its origin. */
export const filePath = (id, name) => `/api/file/${id}/${segmentOf(name)}`;

/**
 * The portal file a link is to, whatever origin it names (the portal's own, which the inbox
 * does not know): `{ id, name }`, or null. Only what the link's message may have is opened:
 * the portal checks that the file is of the message's channel.
 */
export function portalFileRef(link) {
  const m = /^https:\/\/[^/?#\s]+\/api\/file\/(f[0-9a-z]{16})\/([^/?#\s]+)$/.exec(String(link || '').trim());
  if (!m) {
    return null;
  }
  try {
    return { id: m[1], name: decodeURIComponent(m[2]) };
  } catch {
    return { id: m[1], name: m[2] };
  }
}
