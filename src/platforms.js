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
 * The platforms opspile reads, by the `source` of their threads. `portal` is the customer
 * portal, a Worker of this repository (src/portal/), read as a platform all the same
 * (src/portalsource.js).
 */
export const PLATFORMS = ['slack', 'teams', 'discord', 'portal'];

const NAMES = {
  slack: 'Slack', teams: 'Microsoft Teams', discord: 'Discord', portal: 'Customer Portal',
};

/** A platform's name in prose: "Slack", "Microsoft Teams", "Discord", "Customer Portal". */
export const platformName = (source) => NAMES[source] || String(source || 'unknown');

/** The account people connect for a platform: "Slack", "Microsoft", "Discord". */
export const accountName = (source) => (source === 'teams' ? 'Microsoft' : platformName(source));
