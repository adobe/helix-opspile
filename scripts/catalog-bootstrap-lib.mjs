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
 * The teams' catalogs (src/catalog.js) as the tech stack in D1 has them: each technology's file,
 * at the path that is its id from now on, in the knowledge base of the team that supports it,
 * listing its D1 id in `moved_from`, so that the compile rewrites what D1 keeps under it once.
 * `PLACES` says where each goes; one it does not name is the admin team's, under a category of
 * its product. The Adobe Managed CDN is a feature of its own (plan G3): its two names stop being
 * Edge Delivery's.
 */

import { compileCatalog } from '../src/catalog.js';

/** D1 id → [team, path under products/ without .md]. */
export const PLACES = {
  // Experience Manager Sites: its features, with the Edge Delivery team, but those of their own.
  eds: ['helix', 'adobe/aem-sites/edge-delivery'],
  da: ['helix', 'adobe/aem-sites/document-authoring'],
  ue: ['helix', 'adobe/aem-sites/universal-editor'],
  aemcs: ['helix', 'adobe/aem-sites/cloud-service'],
  aem65: ['helix', 'adobe/aem-sites/aem-65'],
  aemcontent: ['helix', 'adobe/aem-sites/content-fragments'],
  msm: ['helix', 'adobe/aem-sites/msm'],
  edgefunctions: ['helix', 'adobe/aem-sites/edge-functions'],
  contentai: ['helix', 'adobe/aem-sites/content-ai'],
  sidekick: ['helix', 'adobe/aem-sites/sidekick'],
  byom: ['helix', 'adobe/aem-sites/byom'],
  productbus: ['helix', 'adobe/aem-sites/product-bus'],
  rum: ['helix', 'adobe/aem-sites/operational-telemetry'],
  xw: ['experience-workspace', 'adobe/aem-sites/experience-workspace'],
  ema: ['ema', 'adobe/aem-sites/modernization-agent'],
  aemdesktop: ['helix', 'adobe/aem-desktop'],
  // The Adobe Managed CDN team: Fastly, which customers bring.
  fastly: ['cdn', 'fastly/cdn'],
  // The product teams'.
  commerce: ['commerce', 'adobe/commerce'],
  aco: ['commerce', 'adobe/commerce-optimizer'],
  assets: ['assets', 'adobe/aem-assets/assets'],
  dm: ['assets', 'adobe/aem-assets/dynamic-media'],
  aso: ['aso', 'adobe/aem-sites-optimizer'],
  llmo: ['abv', 'adobe/brand-visibility'],
  forms: ['aem-forms', 'adobe/aem-forms'],
  opspile: ['opspile', 'adobe/enterprise-support'],
  // Adobe's that no team here supports: the admin team's.
  adobeims: ['admin', 'adobe/developer-platform/ims'],
  appbuilder: ['admin', 'adobe/developer-platform/app-builder'],
  analytics: ['admin', 'adobe/analytics'],
  target: ['admin', 'adobe/target'],
  rtcdp: ['admin', 'adobe/real-time-cdp'],
  ajo: ['admin', 'adobe/journey-optimizer'],
  campaign: ['admin', 'adobe/campaign'],
  workfront: ['admin', 'adobe/workfront'],
  genstudio: ['admin', 'adobe/genstudio'],
  brandconcierge: ['admin', 'adobe/brand-concierge'],
  coworker: ['admin', 'adobe/cx-enterprise-coworker'],
  // Other companies', one product each.
  akamai: ['admin', 'akamai/cdn'],
  cloudflare: ['admin', 'cloudflare/cdn'],
  cloudfront: ['admin', 'amazon/cloudfront'],
  github: ['admin', 'github/github'],
  sharepoint: ['admin', 'microsoft/sharepoint'],
  gdrive: ['admin', 'google/drive'],
  webtools: ['admin', 'google/site-tools'],
  figma: ['admin', 'figma/figma'],
  semrush: ['admin', 'semrush/semrush'],
  // Kinds of product any vendor makes: catch-alls, until a team lists a vendor's.
  bitbucket: ['admin', 'categories/other-git'],
  waf: ['admin', 'categories/waf'],
  scriptsecurity: ['admin', 'categories/script-security'],
  embeds: ['admin', 'categories/video-and-embeds'],
  translation: ['admin', 'categories/translation'],
  tagmanager: ['admin', 'categories/tag-manager'],
  search: ['admin', 'categories/site-search'],
  reviews: ['admin', 'categories/ratings-and-reviews'],
  feeds: ['admin', 'categories/product-feeds'],
  monitoring: ['admin', 'categories/monitoring'],
  sso: ['admin', 'categories/identity-provider'],
  erp: ['admin', 'categories/erp-and-pim'],
  consent: ['admin', 'categories/consent-manager'],
  cloud: ['admin', 'categories/cloud-platform'],
  crm: ['admin', 'categories/crm'],
  aiagents: ['admin', 'categories/ai-assistant'],
};

/** The products that group features, and the vendors whose name is not their slug's. */
const PRODUCTS = {
  'adobe/aem-sites': 'Experience Manager Sites',
  'adobe/aem-assets': 'Experience Manager Assets',
  'adobe/developer-platform': 'Adobe Developer platform',
};
const VENDORS = {
  adobe: 'Adobe', github: 'GitHub', amazon: 'Amazon', google: 'Google', microsoft: 'Microsoft',
};

/** The Adobe Managed CDN (plan G3): its own feature, the Adobe Managed CDN team's. */
export const MANAGED_CDN = {
  team: 'cdn',
  id: 'adobe/aem-sites/managed-cdn',
  title: 'Adobe Managed CDN',
  description: 'the CDN Adobe runs in front of Edge Delivery or AEM as a Cloud Service',
  aliases: ['Adobe Managed CDN', 'Managed CDN', 'Adobe CDN'],
  layer: 'edge',
};

const yamlString = (s) => (/^[\w .,()/@+&'-]+$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)
  && !/: /.test(s) ? s : JSON.stringify(s));
const list = (xs) => `[${xs.map(yamlString).join(', ')}]`;

function concept(fields, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) {
      // eslint-disable-next-line no-continue
      continue;
    }
    lines.push(`${k}: ${Array.isArray(v) ? list(v) : yamlString(String(v))}`);
  }
  lines.push('---', '', body, '');
  return lines.join('\n');
}

const typeOf = (id) => {
  const segs = id.split('/');
  if (segs[0] === 'categories') {
    return 'Category';
  }
  return segs.length === 3 ? 'Feature' : 'Product';
};

/**
 * The files of each team's catalog from `rows` (tech_stack): `{ [team]: { [path]: text } }`,
 * and what is left out (`skipped`: an id `PLACES` has no place for, which is the admin team's
 * as a category). A team's own row of an admin team's id (an override) is left in D1.
 */
export function bootstrapFiles(rows) {
  const teams = {};
  const put = (team, path, text) => {
    teams[team] = teams[team] || {};
    teams[team][`products/${path}.md`] = text;
  };
  const skipped = [];
  const byTech = new Map();
  for (const r of rows) {
    const list2 = byTech.get(r.tech) || [];
    list2.push(r);
    byTech.set(r.tech, list2);
  }
  for (const [tech, defs] of byTech) {
    const own = defs.find((d) => d.team === 'admin') || defs[0];
    let place = PLACES[tech];
    if (!place) {
      place = [own.team, `categories/${tech.replace(/_/g, '-')}`];
      skipped.push(tech);
    }
    const [team, id] = place;
    let aliases = String(own.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);
    if (tech === 'eds') {
      const its = new Set(MANAGED_CDN.aliases.map((m) => m.toLowerCase()));
      aliases = aliases.filter((a) => !its.has(a.toLowerCase()));
    }
    put(team, id, concept({
      type: typeOf(id),
      title: own.name,
      description: own.description,
      aliases,
      layer: own.layer,
      enabled: own.enabled ? null : 'false',
      moved_from: [tech],
    }, `${own.name}, as the tech stack had it before the catalog.`));
  }
  put(MANAGED_CDN.team, MANAGED_CDN.id, concept({
    type: 'Feature',
    title: MANAGED_CDN.title,
    description: MANAGED_CDN.description,
    aliases: MANAGED_CDN.aliases,
    layer: MANAGED_CDN.layer,
  }, 'Adobe runs it; the customer points their domain at it. Customers who run their own CDN in front have one of the CDN products instead.'));
  // Each team that has features of a product, or products of a vendor, names them.
  for (const [team, files] of Object.entries(teams)) {
    const ids = Object.keys(files).map((p) => p.slice('products/'.length, -3));
    for (const product of new Set(ids.filter((i) => i.split('/').length === 3).map((i) => i.split('/').slice(0, 2).join('/')))) {
      put(team, product, concept({
        type: 'Product', title: PRODUCTS[product] || product, description: PRODUCTS[product] || product,
      }, 'Its features, one file each, are in the directory of the same name.'));
    }
    for (const vendor of new Set(ids.map((i) => i.split('/')[0]).filter((v) => v !== 'categories' && VENDORS[v]))) {
      put(team, vendor, concept({ type: 'Vendor', title: VENDORS[vendor] }, `${VENDORS[vendor]}'s products the team supports are in the directory of the same name.`));
    }
  }
  return { teams, skipped };
}

/**
 * What the files compile into, against `rows`: per old id, its new id and what changed, so a
 * dry run shows the compile keeps every technology as it was (but for its id, its product and
 * what G3 moves).
 */
export function compare(rows, teams) {
  const compiled = new Map();
  for (const [team, files] of Object.entries(teams)) {
    const given = Object.entries(files).map(([path, text]) => ({ path, text }));
    const { rows: out, moves, skipped } = compileCatalog(given);
    if (skipped.length) {
      throw new Error(`${team}: not catalog files: ${skipped.join(', ')}`);
    }
    out.forEach((r) => compiled.set(r.tech, { ...r, team }));
    moves.forEach((m) => compiled.set(`old:${m.old}`, m.tech));
  }
  const report = [];
  for (const r of rows.filter((x) => x.team === 'admin' || !rows.some((y) => y.tech === x.tech && y.team === 'admin'))) {
    const id = compiled.get(`old:${r.tech}`);
    const c = compiled.get(id);
    if (!c) {
      report.push({ old: r.tech, missing: true });
      // eslint-disable-next-line no-continue
      continue;
    }
    const changed = ['name', 'description', 'layer', 'aliases', 'enabled']
      .filter((k) => String(k === 'enabled' ? Boolean(r[k]) : r[k] || '') !== String(k === 'enabled' ? c[k] : c[k] || ''));
    report.push({
      old: r.tech, tech: id, team: c.team, product: [r.product, c.product], changed,
    });
  }
  return { report, rows: compiled };
}
