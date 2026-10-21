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
 * Deterministic extraction of structured tokens from message bodies. Rules are exact
 * and cheap, so they run on every relabel; loose facts are left to Clairic.
 */

const MAX_PER_FIELD = 20;

const URL_RE = /https?:\/\/[^\s<>()[\]"'`|]+[^\s<>()[\]"'`|.,;:!?]/g;
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;
// A ticket key (ABC-123) only counts inside a link to a tracker, or when the text calls
// it a ticket; on its own the pattern matches too many other things.
const TRACKER_RE = /\/(?:browse|issues?|tickets?)\/([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g;
const TICKET_WORD_RE = /\b(?:ticket|jira|issue|case)\s*#?:?\s*([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/gi;
// Edge Delivery hosts: <ref>--<site>--<org>.aem.page / .aem.live (and hlx.*).
// A segment is letters, digits and single dashes, so `--` always separates segments.
const SEG = '(?:[a-z0-9]|-(?!-))+';
const EDS_RE = new RegExp(`\\b(?:${SEG}--)?(${SEG})--(${SEG})\\.(?:aem|hlx)\\.(?:page|live)\\b`, 'gi');
const REPO_RE = /\bgithub\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/g;

function collect(text, re, pick) {
  const out = [];
  for (const m of String(text || '').matchAll(re)) {
    const v = pick(m);
    if (v) {
      out.push(v);
    }
  }
  return out;
}

/**
 * @param {string[]} bodies message bodies (markdown)
 * @returns {{ field: string, value: string }[]} unique facts
 */
export function ruleFacts(bodies) {
  const text = bodies.join('\n');
  const fields = {
    cve: collect(text, CVE_RE, (m) => m[0].toUpperCase()),
    ticket: [
      ...collect(text, TRACKER_RE, (m) => m[1]),
      ...collect(text, TICKET_WORD_RE, (m) => m[1].toUpperCase()),
    ],
    site: collect(text, EDS_RE, (m) => `${m[2].toLowerCase()}/${m[1].toLowerCase()}`),
    repo: collect(text, REPO_RE, (m) => `${m[1]}/${m[2].replace(/\.git$/i, '')}`.toLowerCase())
      .filter((r) => !/^(orgs|settings|features|marketplace|login)\//.test(r)),
    url: collect(text, URL_RE, (m) => m[0]),
  };
  const facts = [];
  for (const [field, values] of Object.entries(fields)) {
    for (const value of [...new Set(values)].slice(0, MAX_PER_FIELD)) {
      facts.push({ field, value });
    }
  }
  return facts;
}
