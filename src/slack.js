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

import { text } from './http.js';

/**
 * Slack Events API endpoint.
 *
 * Stub: answers the one-time `url_verification` handshake and acknowledges everything
 * else without storing it. Request signature verification (SLACK_SIGNING_SECRET) and the
 * write to the raw pile are tracked as follow-up issues.
 */
export async function slackEvents(request) {
  const body = await request.json().catch(() => null);
  if (body && body.type === 'url_verification' && typeof body.challenge === 'string') {
    return text(body.challenge);
  }
  return text('', 200);
}
