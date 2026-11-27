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
 * The bots installed in each Teams team opspile knows, so a reply can mention a bot before
 * anyone has mentioned it there. Messages teach opspile bots too (`recordBots` in the
 * normalizer); this fills in the ones nobody has used yet.
 */

import { cachedGraph } from './graph.js';

const APPS = 'installedApps?$expand=teamsAppDefinition($expand=bot)';
const BETA = 'https://graph.microsoft.com/beta';
const APP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An app definition's id: base64 of the app id, its version and its state.
const DEFINITION_ID = /^[A-Za-z0-9+/=_-]{1,300}$/;
/** The largest icon passed on; Teams asks for a 192 × 192 PNG. */
const MAX_ICON_BYTES = 1024 * 1024;
/** Image types an icon is passed on as; never SVG, which a browser could run. */
const ICON_TYPE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * The inbox's URL of a Teams app's color icon (`teamsBotIcon`), for the definition installed:
 * a new version of the app is a new definition, and so a new URL. Null without the ids.
 */
export function botIconPath(teamsAppId, definitionId) {
  if (!APP_ID.test(teamsAppId || '') || !DEFINITION_ID.test(definitionId || '')) {
    return null;
  }
  return `/api/bots/icon?app=${encodeURIComponent(teamsAppId)}&def=${encodeURIComponent(definitionId)}`;
}

/**
 * GET /api/bots/icon?app=&def=: the color icon of a Teams app's definition, for the inbox's
 * pictures of its bot (Teams gives a bot's messages none). Graph has it in beta only
 * (`appCatalogs/teamsApps/…/appDefinitions/…/colorIcon`, application permission
 * `AppCatalog.Read.All`): a store app's is a public URL, fetched without the token; an app of
 * the tenant's own is Graph's hosted content, fetched with it. Only PNG, JPEG, GIF and WebP
 * are passed on, cached a day at the edge and in the browser; 404 otherwise, so the inbox shows
 * the initials.
 */
export async function teamsBotIcon(env, url, { graph, cache } = {}) {
  const app = url.searchParams.get('app') || '';
  const def = url.searchParams.get('def') || '';
  const none = (reason) => {
    if (reason) {
      console.warn(JSON.stringify({ route: 'bots', icon: 'failed', reason }));
    }
    return Response.json({ error: 'no icon' }, { status: 404 });
  };
  if (!botIconPath(app, def)) {
    return none();
  }
  const store = cache === undefined ? (typeof caches !== 'undefined' && caches.default) || null : cache;
  const key = new Request(`https://opspile.cache/bots/icon/${app}/${encodeURIComponent(def)}`);
  const hit = store && await store.match(key);
  if (hit) {
    return hit;
  }
  const g = graph || await cachedGraph(env);
  const res = await g(`${BETA}/appCatalogs/teamsApps/${app}/appDefinitions/${encodeURIComponent(def)}/colorIcon`);
  if (!res.ok) {
    await res.body?.cancel();
    return none(`colorIcon ${res.status}`);
  }
  const { webUrl } = await res.json().catch(() => ({}));
  let target;
  try {
    target = new URL(webUrl);
  } catch {
    return none('no webUrl');
  }
  if (target.protocol !== 'https:') {
    return none('webUrl not https');
  }
  // The token goes to Graph only.
  const got = target.hostname === 'graph.microsoft.com'
    ? await g(target.href, { headers: { accept: 'image/*' } })
    : await fetch(target.href);
  const type = (got.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!got.ok || !ICON_TYPE.test(type)
    || Number(got.headers.get('content-length') || 0) > MAX_ICON_BYTES) {
    await got.body?.cancel();
    return none(`icon ${got.status} ${type}`.trim());
  }
  const bytes = await got.arrayBuffer();
  if (bytes.byteLength > MAX_ICON_BYTES) {
    return none('icon too large');
  }
  const out = new Response(bytes, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
  if (store) {
    const shared = new Response(bytes, { headers: { 'content-type': type, 'cache-control': 'max-age=86400' } });
    await store.put(key, shared);
  }
  return out;
}

/**
 * The bots among the apps installed in one Teams team, `{ id, name, icon }` by the bot's app
 * id (the id a mention carries), with the app's name (what Teams writes when someone mentions
 * it) and the inbox's URL of its icon (`botIconPath`). A failed request gives
 * `{ status, error }` instead.
 */
export async function installedBots(graph, groupId) {
  const bots = new Map();
  let next = `/teams/${encodeURIComponent(groupId)}/${APPS}`;
  while (next) {
    // eslint-disable-next-line no-await-in-loop
    const res = await graph(next);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: res.status, error: data.error ? `${data.error.code}: ${data.error.message}` : '' };
    }
    for (const { teamsAppDefinition: def } of data.value || []) {
      const id = def && def.bot && def.bot.id;
      if (id) {
        const icon = botIconPath(def.teamsAppId, def.id);
        bots.set(id, { id, name: def.displayName || null, ...(icon ? { icon } : {}) });
      }
    }
    next = data['@odata.nextLink'] || null;
  }
  return { bots: [...bots.values()] };
}

/**
 * Lists the installed apps of every Teams team that has a channel in D1 and keeps
 * `bot_teams` in step: each installed bot gets a row (`installed` set, `at = ''` unless a
 * message showed it there), and a row only the list created goes when the bot is no longer
 * installed. Rows learned from messages stay, without `installed`.
 *
 * Stops at the first 401 or 403: the app lacks the Graph permission, and every other team
 * would fail the same way.
 */
export async function syncInstalledBots(env, { graph, now = Date.now() } = {}) {
  const tenant = env.MS_TENANT_ID;
  const { results } = await env.DB.prepare(`SELECT DISTINCT group_id FROM channels
    WHERE source = 'teams' AND tenant = ? AND group_id IS NOT NULL ORDER BY group_id`)
    .bind(tenant).all();
  const groups = (results || []).map((r) => r.group_id);
  const out = {
    teams: 0, bots: 0, removed: 0, failed: 0,
  };
  if (!groups.length) {
    return out;
  }
  const g = graph || await cachedGraph(env);
  const at = new Date(now).toISOString();
  const named = new Set();
  for (const groupId of groups) {
    // eslint-disable-next-line no-await-in-loop
    const { bots, status, error } = await installedBots(g, groupId);
    if (!bots) {
      if (status === 401 || status === 403) {
        throw new Error(`installedApps ${status} ${error}`.trim());
      }
      out.failed += 1;
      // eslint-disable-next-line no-continue
      continue;
    }
    for (const b of bots) {
      if (!named.has(b.id)) {
        named.add(b.id);
        // The app's name is how Teams mentions the bot; the name it posts under stays. Its
        // picture is the app's icon (Teams gives its messages none), of the version installed.
        // eslint-disable-next-line no-await-in-loop
        await env.DB.prepare(`INSERT INTO identities (source, tenant, user_id, kind, name, handle,
            fetched_at, avatar) VALUES ('teams', ?, ?, 'bot', ?, ?, ?, ?)
          ON CONFLICT (source, tenant, user_id) DO UPDATE SET
            name = COALESCE(identities.name, excluded.name),
            handle = COALESCE(excluded.handle, identities.handle),
            avatar = COALESCE(excluded.avatar, identities.avatar)`)
          .bind(tenant, b.id, b.name, b.name, at, b.icon || null).run();
      }
      // eslint-disable-next-line no-await-in-loop
      await env.DB.prepare(`INSERT INTO bot_teams (source, tenant, bot_id, group_id, at, installed)
          VALUES ('teams', ?, ?, ?, '', ?)
        ON CONFLICT (source, tenant, bot_id, group_id) DO UPDATE SET installed = excluded.installed`)
        .bind(tenant, b.id, groupId, at).run();
    }
    // Bots no longer installed: gone if only the list knew them, otherwise just not installed.
    // eslint-disable-next-line no-await-in-loop
    const { meta } = await env.DB.prepare(`DELETE FROM bot_teams
      WHERE source = 'teams' AND tenant = ? AND group_id = ? AND at = ''
        AND (installed IS NULL OR installed < ?)`).bind(tenant, groupId, at).run();
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(`UPDATE bot_teams SET installed = NULL
      WHERE source = 'teams' AND tenant = ? AND group_id = ? AND installed < ?`)
      .bind(tenant, groupId, at).run();
    out.teams += 1;
    out.bots += bots.length;
    out.removed += (meta && meta.changes) || 0;
  }
  return out;
}
