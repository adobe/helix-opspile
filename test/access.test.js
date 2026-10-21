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

import assert from 'node:assert/strict';
import {
  before, beforeEach, describe, it,
} from 'node:test';
import { accessEmail, resetKeyCache } from '../src/access.js';
import { inbox, viewer } from '../src/api.js';
import { indexMessage } from '../src/threads.js';
import { d1 } from './d1.js';

// A throwaway key pair and made-up team domain, audience and people.
const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'test-aud';
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
let keys;
let jwk;

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function sign(claims, { kid = 'k1', key = keys.privateKey, alg = 'RS256' } = {}) {
  const head = b64(JSON.stringify({ alg, kid }));
  const body = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(new Uint8Array(sig))}`;
}
const claims = (extra = {}) => ({
  aud: [AUD], iss: TEAM, exp: NOW / 1000 + 600, email: 'A@staff.example', ...extra,
});
const req = (jwt) => new Request('https://opspile.test/api/me', { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });
const fetchImpl = async () => Response.json({ keys: [jwk] });
const check = (jwt, e = env) => accessEmail(req(jwt), e, { fetchImpl, now: NOW });

before(async () => {
  keys = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
  }, true, ['sign', 'verify']);
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
});
beforeEach(() => resetKeyCache());

describe('accessEmail', () => {
  it('returns the email of a valid token', async () => {
    assert.equal(await check(await sign(claims())), 'a@staff.example');
  });

  it('rejects a missing, expired, foreign or forged token', async () => {
    assert.equal(await check(null), null);
    assert.equal(await check(await sign(claims({ exp: NOW / 1000 - 1 }))), null);
    assert.equal(await check(await sign(claims({ aud: ['other'] }))), null);
    assert.equal(await check(await sign(claims({ iss: 'https://evil.example' }))), null);
    assert.equal(await check(await sign(claims(), { kid: 'unknown' })), null);
    const other = await crypto.subtle.generateKey({
      name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256',
    }, true, ['sign', 'verify']);
    assert.equal(await check(await sign(claims(), { key: other.privateKey })), null);
    assert.equal(await check(await sign(claims(), { alg: 'none' })), null);
  });

  it('fails closed without configuration', async () => {
    assert.equal(await check(await sign(claims()), {}), null);
  });
});

describe('viewer and inbox', () => {
  const people = [
    {
      id: 1, email: 'a@staff.example', name: 'A', staff: 1, teams: ['helix'],
    },
    {
      id: 2, email: 'b@staff.example', name: 'B', staff: 1, teams: ['helix'],
    },
  ];
  const fresh = () => d1({ teams: [{ slug: 'helix', name: 'Helix' }, { slug: 'admin', name: 'Admin' }], people });

  it('ties a signed-in email to a person and their teams', async () => {
    const DB = fresh();
    const me = await viewer(req(await sign(claims())), { ...env, DB }, { fetchImpl, now: NOW });
    assert.deepEqual(me, {
      id: 1, name: 'A', email: 'a@staff.example', teams: [{ slug: 'helix', name: 'Helix' }], admin: false,
    });
    const nobody = await viewer(req(await sign(claims({ email: 'x@else.example' }))), { ...env, DB }, { fetchImpl, now: NOW });
    assert.equal(nobody, null);
  });

  it('lists the team\'s threads with read state', async () => {
    const DB = fresh();
    const base = {
      source: 'slack', tenant: 'E1', channelId: 'C1', org: 'acme', team: 'helix', kind: 'channel', counted: true, staff: false,
    };
    await indexMessage(DB, {
      ...base, rootId: '1', id: '1', thread: 't1', at: '2026-10-21T10:00:00Z', title: 'one', path: 'p1/',
    });
    await indexMessage(DB, {
      ...base, rootId: '2', id: '2', thread: 't2', at: '2026-10-21T11:00:00Z', title: 'two', path: 'p2/',
    });
    await indexMessage(DB, {
      ...base, rootId: '2', id: '3', thread: 't2', at: '2026-10-21T11:05:00Z', person: 2, staff: true, path: 'p2/',
    });
    const { threads, members } = await inbox({ DB }, { id: 1 }, 'helix');
    assert.deepEqual(members.map((m) => m.name), ['A', 'B']);
    const view = threads.map((t) => [t.thread, t.unread, t.seenByOthers, t.unseen, t.last_staff]);
    assert.deepEqual(view, [
      ['t2', true, true, false, 1],
      ['t1', true, false, true, 0],
    ]);
  });
});
