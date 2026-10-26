#!/usr/bin/env node
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
 * Builds the opspile Teams app package (src/teamsbot.js), to upload to the tenant's org
 * catalog (Teams admin center, or "Submit to your org" in Teams):
 *
 *   MS_CLIENT_ID=… PUBLIC_ORIGIN=https://… node scripts/teams-app.mjs [out.zip]
 *
 * (or with both in `.env`). The app is the opspile Entra app: its bot is MS_CLIENT_ID, and so
 * is `webApplicationInfo.id`, which lets the app install itself in a team through Graph
 * (`TeamsAppInstallation.ReadWriteSelfForTeam.All`). The bot is notification-only, in teams
 * only. The package holds ids of the deployment, so it is written outside the repo by default
 * and never committed.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { ICONS } from '../src/icons.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const app = process.env.MS_CLIENT_ID;
const origin = String(process.env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
if (!app || !/^https:\/\//.test(origin)) {
  console.error('set MS_CLIENT_ID and PUBLIC_ORIGIN (https://…)');
  process.exit(1);
}
const [, , target] = process.argv;
const out = target || join(tmpdir(), 'opspile-teams-app.zip');
const { host } = new URL(origin);

export const manifest = {
  $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.19/MicrosoftTeams.schema.json',
  manifestVersion: '1.19',
  version: process.env.TEAMS_APP_VERSION || '1.0.0',
  id: app,
  developer: {
    name: 'Adobe',
    websiteUrl: origin,
    privacyUrl: 'https://www.adobe.com/privacy.html',
    termsOfUseUrl: 'https://www.adobe.com/legal/terms.html',
  },
  name: { short: 'opspile', full: 'opspile ops inbox' },
  description: {
    short: 'Replies of the Adobe ops team\'s thread agents',
    full: 'opspile is the inbox of an Adobe ops team. Where the team allows it, its thread agents'
      + ' answer in channel threads through this bot. It does not take commands.',
  },
  icons: { color: 'color.png', outline: 'outline.png' },
  accentColor: '#EB1000',
  bots: [{
    botId: app,
    scopes: ['team'],
    isNotificationOnly: true,
    supportsFiles: false,
    supportsCalling: false,
    supportsVideo: false,
  }],
  permissions: ['identity', 'messageTeamMembers'],
  validDomains: [host],
  webApplicationInfo: { id: app },
};

/** A PNG of `size`² pixels, each `pixel(x, y)` → [r, g, b, a]. */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** The outline icon: white on transparent, a stack of three cards (a pile). */
const outline = png(32, (x, y) => {
  const card = (top) => x >= 5 && x <= 26 && (y === top || y === top + 1);
  const on = card(8) || card(15) || card(22) || ((x === 5 || x === 26) && y >= 8 && y <= 23);
  return on ? [255, 255, 255, 255] : [0, 0, 0, 0];
});

/** A zip of `{ name: Buffer }`, stored (no compression), as Teams reads it. */
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    local.push(head, n, data);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc32(data), 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += head.length + n.length + data.length;
  }
  const size = central.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

writeFileSync(out, zip({
  'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)),
  'color.png': Buffer.from([ICONS['/icon-192.png'].base64].flat().join(''), 'base64'),
  'outline.png': outline,
}));
console.log(`wrote ${out}`);
