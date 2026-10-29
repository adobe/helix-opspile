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

import { CLEF } from './label.js';
import { icoToPng } from './ico.js';
import { domainList } from './lookup.js';

/*
 * Org icons (#18): the favicon an org is shown with, and the icons the admin pages offer for it.
 *
 * An org's icon is a domain (its favicon, through Google's favicon service) or an https image
 * URL. Without one, it is the favicon of its usual mail domain: the most common one among the
 * people outside Adobe who post in its channels.
 *
 * To find one, `findIcons` guesses the org's websites (its mail domains, `<slug>.com`,
 * `<name>.com`, each with and without `www.`), fetches what Google has as their favicons and
 * the icons the sites name themselves (`<link rel="icon">`, `apple-touch-icon`), and asks Clef
 * whether each image is the org's logo. An .ico of bitmaps is read as a PNG (src/ico.js); an
 * SVG, which Clef does not read, is offered without its verdict. Google answers 404 with a
 * globe for a domain it knows no favicon of; those are not candidates.
 */

/** Google's favicon service, 64 px: 200 with the favicon, 404 with a globe when it has none. */
export const googleFavicon = (domain) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;

/** A domain an icon can be: letters, digits, dots and dashes, ending in a TLD. */
export const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

/** Mail domains that say nothing about the org: free mail, and Microsoft's tenant domains. */
const NOT_ORG = /(^|\.)(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|aol|proton|protonmail)\.[a-z.]+$|\.onmicrosoft\.com$/i;
/** Second-level labels under a country code that are not the org's (`auspost.com.au`). */
const CC_SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'gv']);

const MAX_HOSTS = 10;
const MAX_SITE_ICONS = 4;
const MAX_CANDIDATES = 8;
/** Clef reads at most this many images per question set. */
const IMAGES_PER_ASK = 4;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const FETCH_MS = 4000;
/** Clef's probability from which a candidate counts as the org's icon. */
export const FITS = 0.5;
const CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
// Sites are asked as a browser would ask: many answer a bot's user agent with an error page.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
  + ' Chrome/130.0.0.0 Safari/537.36';
const ACCEPT = {
  html: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  image: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5',
};

/** The org's part of a domain: `non.acme.com` is `acme.com`, `shop.acme.com.au` `acme.com.au`. */
export function registrable(domain) {
  const labels = String(domain).toLowerCase().split('.');
  const cc = labels.length > 2 && labels.at(-1).length === 2 && CC_SLD.has(labels.at(-2));
  return labels.slice(cc ? -3 : -2).join('.');
}

/** Whether a mail domain can be an org's website: not staff's, free mail or a tenant domain. */
export function orgDomain(env, domain) {
  const d = String(domain || '').toLowerCase();
  return DOMAIN.test(d) && !NOT_ORG.test(d) && !domainList(env.STAFF_DOMAINS).includes(d)
    && !domainList(env.STAFF_DOMAINS).includes(registrable(d));
}

/**
 * The hosts an org's website may be on, likeliest first: its mail domains (and their org
 * parts), then `<slug>.com`, the slug without dashes, its first word (`acme-labs` is
 * `acme.com`), and the display name in letters and digits; each without and with `www.`.
 */
export function candidateHosts(env, { slug, name, domains = [] }) {
  const bases = [];
  const add = (d) => {
    const base = String(d || '').toLowerCase().replace(/^www\./, '');
    if (DOMAIN.test(base) && !bases.includes(base)) {
      bases.push(base);
    }
  };
  for (const d of domains.filter((x) => orgDomain(env, x))) {
    add(registrable(d));
    add(d);
  }
  const s = String(slug || '').toLowerCase();
  const words = s.split('-').filter(Boolean);
  add(`${s}.com`);
  add(`${words.join('')}.com`);
  if (words.length > 1 && words[0].length >= 3) {
    add(`${words[0]}.com`);
  }
  const n = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
  if (n.length >= 2) {
    add(`${n}.com`);
  }
  return bases.flatMap((b) => [b, `www.${b}`]).slice(0, MAX_HOSTS);
}

// ---- images -----------------------------------------------------------------------------

/** What an image's bytes are: png, jpeg, webp, gif, ico, svg, or null. */
export function sniff(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return 'jpeg';
  }
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') { return 'webp'; }
  if (b.length >= 6 && String.fromCharCode(...b.slice(0, 3)) === 'GIF') {
    return 'gif';
  }
  if (b.length >= 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    return 'ico';
  }
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase();
  // An SVG may start with an XML declaration, a doctype or a comment.
  if (head.startsWith('<') && /<svg[\s>]/.test(head)) {
    return 'svg';
  }
  return null;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** `fetch`, given up after FETCH_MS. */
function get(url, accept) {
  return fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(FETCH_MS),
  });
}

/** The first `max` bytes of a response, or null when it is longer. */
async function bytesOf(res, max) {
  const n = Number(res.headers.get('content-length'));
  if (n > max) {
    return null;
  }
  const b = new Uint8Array(await res.arrayBuffer());
  return b.length > max ? null : b;
}

/**
 * An image, as `{ type, base64 }`: one Clef can read (PNG, JPEG, WebP; an .ico as a PNG), or an
 * SVG (`type` image/svg+xml), which the page shows but Clef does not see. Null for a 404
 * (Google's globe), an error or a GIF. A busy server (429, 5xx, a failed connection) is asked
 * once more.
 */
async function image(url, again = true) {
  try {
    const res = await get(url, ACCEPT.image);
    if (again && (res.status === 429 || res.status >= 500)) {
      return image(url, false);
    }
    if (!res.ok) {
      return null;
    }
    let b = await bytesOf(res, MAX_IMAGE_BYTES);
    let type = b && sniff(b);
    if (type === 'ico') {
      b = await icoToPng(b);
      type = b && 'png';
    }
    if (type === 'svg') {
      return { type: 'image/svg+xml', base64: base64(b) };
    }
    return ['png', 'jpeg', 'webp'].includes(type) ? { type: `image/${type}`, base64: base64(b) } : null;
  } catch (e) {
    return again && e.name !== 'TimeoutError' ? image(url, false) : null;
  }
}

/** An https URL of `href` on the page at `base`, or null. */
function httpsUrl(href, base) {
  try {
    const url = new URL(href.replace(/&amp;/g, '&'), base);
    return url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The icons a page names (`<link rel="icon">`, `shortcut icon`, `apple-touch-icon`), as
 * absolute https URLs: the large ones first, SVGs (which Clef does not read) after the others.
 */
export function pageIcons(html, base) {
  const out = [];
  for (const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const attr = (k) => (new RegExp(`\\b${k}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag) || [])
      .slice(2).find((v) => v !== undefined);
    const rel = String(attr('rel') || '').toLowerCase();
    const href = attr('href');
    const icon = href && /(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel);
    const svg = icon && (/svg/i.test(attr('type') || '') || /\.svg(\?|#|$)/i.test(href));
    const url = icon && httpsUrl(href, base);
    if (url) {
      const size = Math.max(0, ...String(attr('sizes') || '').split(/\s+/).map((x) => parseInt(x, 10) || 0));
      out.push({ url: url.href, size: svg ? -1 : size || (rel.includes('apple') ? 180 : 0) });
    }
  }
  return [...new Map(out.map((x) => [x.url, x])).values()].sort((a, b) => b.size - a.size)
    .map((x) => x.url);
}

/** A page's `<title>`, in one line of at most 120 characters, or null. */
export function pageTitle(html) {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(String(html));
  const t = m && m[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return t || null;
}

/**
 * What the site at `host` is (after redirects): its address, its title (a parked domain says
 * it is for sale there) and the icons it names, or nothing.
 */
async function siteIcons(host) {
  try {
    const res = await get(`https://${host}/`, ACCEPT.html);
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || '')) {
      return { host, icons: [] };
    }
    const b = await bytesOf(res, MAX_HTML_BYTES);
    const at = new URL(res.url || `https://${host}/`);
    const html = b ? new TextDecoder().decode(b) : '';
    const icons = pageIcons(html, at);
    icons.push(new URL('/favicon.ico', at).href);
    return {
      host,
      site: at.host,
      title: pageTitle(html),
      icons: [...new Set(icons)].slice(0, MAX_SITE_ICONS),
    };
  } catch {
    return { host, icons: [] };
  }
}

/**
 * The icons found for an org's hosts, each `{ icon, src, host, via, title, image }`: `icon` is
 * what the org's icon would be set to (the domain for Google's favicon, else the image's URL),
 * `src` where the page shows it from, `title` the title of the site's home page when it could
 * be read. The same image twice is one candidate, its first.
 */
export async function gatherIcons(hosts) {
  const bare = hosts.filter((h) => !h.startsWith('www.'));
  const [google, sites] = await Promise.all([
    Promise.all(hosts.map(async (host) => ({
      icon: host, src: googleFavicon(host), host, via: 'favicon', image: await image(googleFavicon(host)),
    }))),
    Promise.all(bare.map(siteIcons)),
  ]);
  const titles = new Map(sites.filter((s) => s.title).map((s) => [s.host, s.title]));
  for (const c of google) {
    c.title = titles.get(c.host.replace(/^www\./, '')) || null;
  }
  const seen = new Set();
  const own = await Promise.all(sites.filter((s) => s.site && !seen.has(s.site) && seen.add(s.site))
    .flatMap((s) => s.icons.map(async (url) => ({
      icon: url, src: url, host: s.site, via: 'site', title: s.title || null, image: await image(url),
    }))));
  const images = new Set();
  // Google's favicons first (a domain is the simplest icon), then what the sites name.
  return [...google, ...own].filter((c) => c.image && !images.has(c.image.base64)
    && images.add(c.image.base64));
}

// ---- Clef ---------------------------------------------------------------------------------

/** A candidate as Clef is told about it: where it is from, and the title of that site. */
function describe(c) {
  let what = `the favicon of ${c.host}`;
  if (c.via === 'site') {
    const u = new URL(c.icon);
    what = `an icon the website ${c.host} names, ${u.host}${u.pathname.slice(0, 80)}`;
  }
  return c.title ? `${what} (the site's title: "${c.title}")` : what;
}

/**
 * Clef's probability that each of up to four candidates is the org's icon: that its website is
 * the org's (a question about the name, which Clef knows more about than about logos) and
 * that its image is a real logo, not a placeholder (a question about the image).
 */
async function askClef(env, org, batch) {
  const who = org.name ? `"${org.name}" (slug ${org.slug})` : `"${org.slug}"`;
  const mail = org.domains && org.domains.length ? ` Its people write from ${org.domains.join(', ')}.` : '';
  const state = `We pick the icon an ops inbox shows for the organization ${who}, a ${org.type || 'customer'} of Adobe.${mail}`
    + ` The ${batch.length} images are candidate icons, found on websites whose names resemble the`
    + ` organization's, in this order:\n${batch.map((c, i) => `${i + 1}. ${describe(c)}`).join('\n')}`;
  const questions = {};
  batch.forEach((c, i) => {
    questions[`site${i}`] = {
      type: 'noul',
      instructions: `Is ${c.host} the website of the organization ${who} itself, rather than of a`
        + ' different organization with a similar name, of an agency or partner it works with, or a'
        + ' parked or for-sale domain?',
    };
    questions[`stock${i}`] = {
      type: 'noul',
      instructions: `Is image ${i + 1} a generic or stock icon that is nobody's brand: a browser's`
        + ' default globe, a blank or broken image, a website builder\'s, CMS\'s or hosting'
        + ' provider\'s default icon, or a domain-parking or for-sale page\'s icon?',
    };
  });
  const res = await env.AI.run(CLEF, {
    model: 'clef',
    images: batch.map((c) => ({ content_type: c.image.type, base64: c.image.base64 })),
    state,
    questions,
  });
  const a = (res && res.answers) || {};
  return batch.map((c, i) => {
    const p = Math.sqrt(Number(a[`site${i}`] && a[`site${i}`].noul)
      * (1 - Number(a[`stock${i}`] && a[`stock${i}`].noul)));
    return Number.isFinite(p) ? p : null;
  });
}

const isSvg = (c) => c.image && c.image.type === 'image/svg+xml';

/**
 * Candidates with Clef's probability `p`, likeliest first: null for an SVG (Clef does not read
 * them) and when Clef failed, which come last.
 */
export async function rankIcons(env, org, candidates) {
  const raster = candidates.filter((c) => !isSvg(c));
  const batches = [];
  for (let i = 0; i < raster.length; i += IMAGES_PER_ASK) {
    batches.push(raster.slice(i, i + IMAGES_PER_ASK));
  }
  const ps = await Promise.all(batches.map((b) => askClef(env, org, b).catch((e) => {
    console.log(JSON.stringify({ route: 'favicons', error: String(e && e.message) }));
    return b.map(() => null);
  })));
  const p = new Map(raster.map((c, i) => [c, ps.flat()[i]]));
  return candidates.map((c) => ({ ...c, p: p.get(c) ?? null }))
    .sort((a, b) => (b.p ?? -1) - (a.p ?? -1));
}

// Found icons by org, for an hour: opening an org again does not fetch and ask again.
const found = new Map();

/** Forgets the icons found (for tests). */
export function forgetIcons() {
  found.clear();
}

/**
 * Icons for an org (`{ slug, name, type, domains }`), likeliest first: `{ icon, src, host,
 * via, p }`, `p` Clef's probability that it is the org's (`FITS` and up: it is). `fresh`
 * looks again instead of answering what was found in the last hour.
 */
export async function findIcons(env, org, { fresh = false } = {}) {
  const key = JSON.stringify([org.slug, org.name, org.domains]);
  const hit = found.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
    return hit.icons;
  }
  const hosts = candidateHosts(env, org);
  const candidates = (await gatherIcons(hosts)).slice(0, MAX_CANDIDATES);
  const ranked = env.AI && candidates.some((c) => !isSvg(c)) ? await rankIcons(env, org, candidates)
    : candidates.map((c) => ({ ...c, p: null }));
  const icons = ranked.map(({ image: img, ...c }) => (isSvg({ image: img })
    ? { ...c, svg: true } : c));
  if (found.size >= CACHE_MAX) {
    found.delete(found.keys().next().value);
  }
  found.set(key, { at: Date.now(), icons });
  return icons;
}

/**
 * GET /api/admin/favicon?domain=: Google's favicon of a domain, or 404 when Google has none
 * (it answers its globe then, which a page cannot tell from a favicon), so that the admin
 * pages show which orgs have no icon.
 */
export async function faviconProxy(domain) {
  const d = String(domain || '').toLowerCase();
  if (!DOMAIN.test(d)) {
    return new Response('not a domain', { status: 400 });
  }
  const res = await fetch(googleFavicon(d), {
    redirect: 'follow',
    cf: { cacheTtl: 86400, cacheEverything: true },
  }).catch(() => null);
  if (!res || !res.ok) {
    return new Response(null, { status: 404, headers: { 'cache-control': 'private, max-age=3600' } });
  }
  return new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') || 'image/png',
      'cache-control': 'private, max-age=86400',
    },
  });
}
