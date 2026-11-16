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
 * The layers of a customer's stack, top to bottom: fixed, so every customer's stack reads the
 * same way. Each technology of the tech stack is in one (`tech_stack.layer`, migration 0068),
 * and the list by customer names the likeliest of each, in this order, beside the customer
 * (ui/inbox.js `stackLine`).
 */

export const LAYERS = [
  { id: 'edge', name: 'Edge', hint: 'in front of the site: CDN, WAF and bot protection, code at the edge' },
  { id: 'site', name: 'Site', hint: 'what serves the pages: Edge Delivery, AEM publish, a legacy site or storefront' },
  { id: 'content', name: 'Content', hint: 'where authors write and assets live: Document Authoring, SharePoint, Universal Editor, AEM author, Assets, translation' },
  { id: 'code', name: 'Code', hint: 'code hosting, builds and serverless code: GitHub, App Builder, CI jobs' },
  { id: 'commerce', name: 'Commerce and data', hint: 'commerce, product and order data, payments, search, feeds, ERP, PIM, CRM' },
  { id: 'martech', name: 'Marketing and insights', hint: 'analytics, tags, consent, personalization, monitoring, SEO' },
  { id: 'identity', name: 'Identity', hint: 'how people sign in: SSO, Adobe IMS' },
  { id: 'other', name: 'Other', hint: 'anything else the team works with' },
];
export const LAYER_IDS = LAYERS.map((l) => l.id);

const layerById = new Map(LAYERS.map((l) => [l.id, l]));
const key = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The layer a name means, by its id or its name ("Commerce and data", "commerce"), or null. */
export function layerOf(name) {
  const k = key(name);
  return LAYERS.find((l) => l.id === k || key(l.name) === k) || null;
}

/** The layer of each technology, `{ [tech]: layer }`, from tech_stack rows (`layer` set). */
export function techLayers(rows) {
  const out = {};
  for (const r of rows || []) {
    if (r.layer && layerById.has(r.layer) && !out[r.tech]) {
      out[r.tech] = r.layer;
    }
  }
  return out;
}
