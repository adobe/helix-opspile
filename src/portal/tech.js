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
 * The technologies a lobby picks from. They are the inbox's tech stack (`tech_stack`, the
 * entries marked for the portal), which the portal asks the inbox for (`OPSPILE.technologies`)
 * and keeps in its own database for an hour. Until the inbox has answered once (a portal
 * deployed before the inbox is bound to it), the list below stands in: Adobe's technologies of
 * the teams' catalogs as the catalog bootstrap wrote them (src/catalog.js, ids as paths).
 */

export const DEFAULT_TECH = [
  ['adobe/aem-sites/edge-delivery', 'Edge Delivery', 'Experience Manager Sites'],
  ['adobe/aem-sites/cloud-service', 'AEM Cloud Service', 'Experience Manager Sites'],
  ['adobe/aem-sites/aem-65', 'AEM 6.5 or AMS', 'Experience Manager Sites'],
  ['adobe/aem-sites/document-authoring', 'Document Authoring', 'Experience Manager Sites'],
  ['adobe/aem-sites/universal-editor', 'Universal Editor', 'Experience Manager Sites'],
  ['adobe/aem-sites/experience-workspace', 'Experience Workspace', 'Experience Manager Sites'],
  ['adobe/aem-sites/sidekick', 'AEM Sidekick', 'Experience Manager Sites'],
  ['adobe/aem-sites/managed-cdn', 'Adobe Managed CDN', 'Experience Manager Sites'],
  ['adobe/aem-sites/content-fragments', 'Content Fragments and AEM APIs', 'Experience Manager Sites'],
  ['adobe/aem-sites/msm', 'MSM and language copies', 'Experience Manager Sites'],
  ['adobe/aem-sites/edge-functions', 'AEM Edge Functions', 'Experience Manager Sites'],
  ['adobe/aem-sites/operational-telemetry', 'Operational telemetry', 'Experience Manager Sites'],
  ['adobe/aem-sites-optimizer', 'Sites Optimizer', 'Sites Optimizer'],
  ['adobe/aem-assets/assets', 'Assets', 'Experience Manager Assets'],
  ['adobe/aem-assets/dynamic-media', 'Dynamic Media', 'Experience Manager Assets'],
  ['adobe/aem-forms', 'Forms', 'Forms'],
  ['adobe/commerce', 'Commerce', 'Commerce'],
  ['adobe/commerce-optimizer', 'Commerce Optimizer', 'Commerce Optimizer'],
  ['adobe/analytics', 'Analytics', 'Analytics'],
  ['adobe/target', 'Target', 'Target'],
  ['adobe/real-time-cdp', 'Real-Time CDP', 'Real-Time CDP'],
  ['adobe/journey-optimizer', 'Journey Optimizer', 'Journey Optimizer'],
  ['adobe/campaign', 'Campaign', 'Campaign'],
  ['adobe/workfront', 'Workfront', 'Workfront'],
  ['adobe/genstudio', 'GenStudio and Firefly', 'GenStudio and Firefly'],
  ['adobe/developer-platform/app-builder', 'App Builder', 'Adobe Developer platform'],
].map(([tech, name, product], position) => ({
  tech, name, product, position,
}));

/** The list is asked for again when it is this old. */
export const TECH_MAX_AGE_MS = 60 * 60 * 1000;

const MAX_TECH = 200;
const clean = (v, n) => String(v ?? '').trim().slice(0, n);

/** The technologies as the lobby shows them, in order: `[{ tech, name, product }]`. */
export async function listTech(env) {
  const { results } = await env.DB.prepare(`SELECT tech, name, product FROM tech
    ORDER BY position, name`).all();
  return results && results.length ? results
    : DEFAULT_TECH.map(({ tech, name, product }) => ({ tech, name, product }));
}

/** Whether the inbox is asked again: never yet, or an hour ago. */
export async function techStale(env, now = Date.now()) {
  const at = await env.DB.prepare("SELECT value FROM meta WHERE key = 'tech_at'").first('value');
  return !at || Date.parse(at) < now - TECH_MAX_AGE_MS;
}

/**
 * Asks the inbox for its technologies and keeps them, in its order. An empty answer, or none
 * (the inbox is not bound, or failed), leaves the list as it is. `{ result, tech? }`.
 */
export async function refreshTech(env, now = Date.now()) {
  if (!env.OPSPILE) {
    return { result: 'unbound' };
  }
  const answer = await env.OPSPILE.technologies();
  const list = (Array.isArray(answer) ? answer : [])
    .map((t) => ({
      // An id is a catalog path (adobe/aem-sites/edge-delivery), as long as the inbox's ids are.
      tech: clean(t && t.tech, 160),
      name: clean(t && t.name, 120),
      product: clean(t && t.product, 120),
    }))
    .filter((t) => t.tech && t.name).slice(0, MAX_TECH);
  if (!list.length) {
    return { result: 'empty' };
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tech'),
    ...list.map((t, i) => env.DB.prepare(`INSERT OR REPLACE INTO tech (tech, name, product,
      position) VALUES (?, ?, ?, ?)`).bind(t.tech, t.name, t.product || null, i)),
    env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('tech_at', ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).bind(new Date(now).toISOString()),
  ]);
  return { result: 'refreshed', tech: list.length };
}
