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
 * Names of products, and the technology of the tech stack that covers one (tech_stack: its names,
 * aliases and descriptions): a stack drawing's parts (src/stacktech.js), the gaps of topic maps
 * built before Clef said what threads are about (src/topicmap.js productsOf), the ground truth's
 * scoring (scripts/truth.mjs).
 */

/**
 * Names Clairic gives that say nothing about which product: the platforms the inbox reads, and
 * what every site has. A name of one of them, alone, is left out.
 */
export const GENERIC = new Set(`api, apis, cdn, json, html, css, javascript, js, website, web, site, sites, dns, http, https, ssl,
tls, url, urls, cache, caching, email, mail, git, slack, teams, microsoft teams, discord, browser,
cloud, saas, paas, ai, llm, llms, sdk, cli, ui, ux, edge delivery, edge delivery services, eds, aem,
adobe, adobe experience manager, experience manager, franklin, helix, microsoft, google, amazon,
apple, cms, crm, erp, pim, seo, sem, cwv, core web vitals, lcp, cls, inp, cors, csp, jwt, oauth,
saml, sso, oidc, mfa, 2fa, graphql, rest, rest api, openapi, webhook, webhooks, xml, yaml, csv, pdf,
doc, docs, documentation, spreadsheet, sheet, sheets, document, documents, repo, repository, code,
config, configuration, dev, prod, production, stage, staging, qa, uat, test, sandbox, environment,
server, backend, frontend, spa, ssr, database, db, log, logs, dashboard, report, reports, analytics,
monitoring, search, index, query, feed, feeds, image, images, video, asset, assets, content, block,
blocks, component, components, template, templates, page, pages, header, footer, nav, navigation,
form, forms, plugin, extension, app, application, bot, bots, agent, agents, ai agent, chatbot,
integration, integrations, ticket, tickets, jira ticket, support, poc, demo, meeting, call, chat,
channel, team, staff, user, users, customer, account, org, organization, tenant, role, roles,
permission, permissions, access, token, tokens, api key, api keys, ip, ips, vpn, waf, origin,
domain, domains, certificate, cert, node, pdp, pdps, plp, plps, sku, skus, faq, faqs, ootb, vip,
dom, etl, idp, emea, apac, amer, kpi, sla, eta, chrome, safari, firefox, mozilla, devtools,
chrome devtools, slack connect, zoom, webex, google meet, microsoft graph, jira, confluence,
experience league, edge, main, preview, live, publish, embed, worker, source, service, global,
basic, authoring, author, authors, linux, windows, macos, ios, android, devops, release, blocker,
library, media, console, portal, editor, platform, tool, tools, framework`
  .split(/\s*,\s*/).filter(Boolean));

/** A product's name as a key: lower case, words only, without "Adobe" or "AEM" before it. */
export function productKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9.+#]+/g, ' ')
    .replace(/\b(?:adobe|aem)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const within = (phrase, key) => ` ${phrase} `.includes(` ${key} `);

/**
 * A name as a key, with "AEM" or "Adobe" kept where it is generic without them: "Adobe
 * Analytics" is a product, "analytics" a word. What GENERIC is checked against.
 */
export function nameKey(name) {
  const key = productKey(name);
  if (key && key.length > 2 && !GENERIC.has(key)) {
    return key;
  }
  const raw = String(name || '').toLowerCase().replace(/[^a-z0-9.+#]+/g, ' ').trim();
  return raw === key ? key : raw;
}

/**
 * The tech stack as names to match a product against: each entry's id, name and aliases (the
 * names it also goes by, migration 0057), and the names
 * its description gives, cut at commas, "or", "such as" and brackets ("a consent manager such as
 * OneTrust or Cookiebot" names OneTrust and Cookiebot).
 */
export function techIndex(rows) {
  const by = new Map();
  for (const r of rows) {
    const phrases = by.get(r.tech) || {
      tech: r.tech, name: r.name, names: new Set(), phrases: new Set(),
    };
    // A name that is generic without "AEM" or "Adobe" ("AEM Author") keeps them.
    [r.tech, r.name, ...String(r.aliases || '').split(',')].map(nameKey).filter(Boolean)
      .forEach((k) => phrases.names.add(k));
    // The names a description gives: what is written as a name ("OneTrust", "Web SDK"), not
    // the words around them ("the content source", "a consent manager").
    String(r.description || '').split(/,|\(|\)|:|\bor\b|\band\b|\bsuch as\b|\blike\b|\balso called\b|\bincluding\b|;/i)
      .filter((p) => /\p{Lu}/u.test(p))
      .map((p) => productKey(p).replace(/^(?:a|an|the|its|own)\s+/, ''))
      .filter((k) => k.length > 1 && !GENERIC.has(k))
      .forEach((k) => phrases.phrases.add(k));
    by.set(r.tech, phrases);
  }
  return [...by.values()];
}

/**
 * The tech stack entry that covers a product, or null: one whose id or name is the product's,
 * or is in it as words ("Akamai Property Manager" is Akamai's), or whose description names it:
 * as one of its names ("OneTrust" is the consent manager's), or, for a name of two words or
 * more, in one ("Asset Picker" in "Asset Selector or Asset Picker"). A word alone ("tools",
 * "experience") is not a name.
 */
export function coveredBy(name, index) {
  const key = productKey(name);
  if (!key) {
    return null;
  }
  const own = nameKey(name);
  const exact = index.find((t) => t.names.has(key) || t.names.has(own));
  if (exact) {
    return exact.tech;
  }
  const several = key.includes(' ');
  const named = index.find((t) => [...t.phrases]
    .some((p) => p === key || (several && within(p, key))));
  if (named) {
    return named.tech;
  }
  // A name inside another needs it written as a name ("Akamai CDN"; not "en-to launch").
  const written = /\p{Lu}|\./u.test(String(name));
  const part = written && index.find((t) => [...t.names]
    .some((n) => n.length > 3 && !GENERIC.has(n) && within(key, n)));
  return part ? part.tech : null;
}
