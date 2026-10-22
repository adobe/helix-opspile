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
 * Tells the team's room (a Durable Object) about a change, so connected inboxes update.
 * Best effort: the index in D1 is the record, the room only fans out.
 */
export async function notifyRoom(env, team, event) {
  if (!env.ROOMS || !team) {
    return;
  }
  try {
    const room = env.ROOMS.get(env.ROOMS.idFromName(team));
    await room.fetch('https://room/notify', { method: 'POST', body: JSON.stringify(event) });
  } catch (e) {
    console.warn(JSON.stringify({ route: 'normalize', room: team, error: e.message }));
  }
}
