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
 * How busy a team or a customer is, as the lists of Teams and Customers rank them (ui/sidenav.js):
 * its threads with a person's message in the last `ACTIVE_DAYS` days (`recent`). threads.last_at
 * is indexed with the team and the org (threads_team, threads_org), so each count is a range.
 */

/** How far back a list's activity counts. */
export const ACTIVE_DAYS = 30;

/** The start of the lists' activity window, `ACTIVE_DAYS` before `now`, as last_at has it. */
export const activeSince = (now = Date.now()) => new Date(now - ACTIVE_DAYS * 86400000)
  .toISOString();
