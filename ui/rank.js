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
 * The team order's model, as the global `Rank`: a linear score over what the inbox knows of a
 * thread (an entry of GET /api/inbox), learned from Clef's pairwise judgements of production
 * threads ("which of the two should the team turn to first?") by `npm run rank` (scripts/rank.mjs).
 * The score is in log-odds: `score(a) - score(b)` is how sure Clef would be that a comes first.
 *
 * Only what is the same for everyone on the team is a feature here; what is about the viewer
 * (mentioned, posted, 👀) the inbox adds on top. The training script runs this same file, so the
 * features it learned from are the ones the browser computes.
 */
globalThis.Rank = (() => {
  const H = 3600000;
  const KINDS = ['incident', 'security', 'question', 'request', 'access'];

  /** Staff 👀 since the customer last wrote, staff 🛟 at all: someone is on it, someone asks for eyes. */
  function steering(t) {
    const staff = (t.signals || []).filter((x) => x.staff);
    const since = (x) => t.last_staff === 1 || !t.last_at || (x.at && x.at >= t.last_at);
    return {
      seen: staff.some((x) => x.signal === 'seen' && since(x)),
      help: staff.some((x) => x.signal === 'help'),
    };
  }

  /** The features of an inbox entry at `now` (ms), by name. */
  function features(t, now = Date.now()) {
    const at = (s) => Date.parse(s || '') || 0;
    // As the list shows it: an alert's latest post, else the latest a person wrote.
    const last = at(t.kind === 'alert' ? t.any_at : t.last_at) || at(t.any_at) || now;
    const ageH = Math.max(0, (now - last) / H);
    const rootH = Math.max(0, (now - (at(t.root_at) || last)) / H);
    const lab = t.label || {};
    const checked = t.resolution?.verdict === 'resolved';
    const resolved = t.resolution?.verdict ? Number(checked) : (lab.resolved_p ?? 0);
    const urgency = lab.urgency ?? 0.5;
    const r48 = Math.exp(-ageH / 48);
    const us = t.waiting_on === 'us' ? 1 : 0;
    const kind = lab.label_kind;
    const alert = t.kind === 'alert' ? 1 : 0;
    const sig = steering(t);
    const people = t.participants || [];
    const f = {
      recent6h: Math.exp(-ageH / 6),
      recent2d: r48,
      recent2w: Math.exp(-ageH / 336),
      threadAge: Math.log1p(rootH / 24) / 3,
      lastStaff: t.last_staff ? 1 : 0,
      unseenByAdobe: t.unseenByAdobe ? 1 : 0,
      waitsOnUs: us,
      waitsOnThem: t.waiting_on === 'customer' || t.waiting_on === 'vendor' ? 1 : 0,
      waitsOnUsLong: (us * Math.log1p(ageH)) / 5,
      urgency: urgency / 3,
      unlabeled: t.label || alert ? 0 : 1,
      resolved,
      checked: checked ? 1 : 0,
      resolvedRecent: resolved * r48,
      openUrgency: ((1 - resolved) * urgency) / 3,
      unseenUrgency: ((t.unseenByAdobe ? 1 : 0) * urgency) / 3,
      alert,
      seenByStaff: sig.seen ? 1 : 0,
      help: sig.help ? 1 : 0,
      draft: t.draft ? 1 : 0,
      messages: Math.log1p(t.messages || 0) / 4,
      customers: Math.log1p(people.filter((p) => !p.staff).length) / 2,
      staff: Math.log1p(people.filter((p) => p.staff).length) / 2,
      partner: t.org_type === 'partner' ? 1 : 0,
      vendor: t.org_type === 'vendor' ? 1 : 0,
    };
    for (const k of KINDS) f[`kind_${k}`] = !alert && kind === k ? 1 : 0;
    return f;
  }
  const NAMES = Object.keys(features({}, 0));

  // MODEL: written by `npm run rank -- train`, do not edit by hand.
  const MODEL = {
    trained: '2026-10-29',
    threads: 200,
    games: 1597,
    accuracy: 0.847,
    classicAccuracy: 0.694,
    weights: {
      recent6h: 0.3235,
      recent2d: 1.1111,
      recent2w: -0.2024,
      threadAge: 0.0606,
      lastStaff: 0.1344,
      unseenByAdobe: 0.7497,
      waitsOnUs: 1.8836,
      waitsOnThem: -0.3224,
      waitsOnUsLong: -0.2318,
      urgency: 3.3287,
      unlabeled: -0.2868,
      resolved: -1.2063,
      checked: -0.8742,
      resolvedRecent: -0.6301,
      openUrgency: 0.846,
      unseenUrgency: -2.172,
      alert: 0.6096,
      seenByStaff: 0.6091,
      help: 0,
      draft: -0.6798,
      messages: 1.3033,
      customers: -0.2644,
      staff: -0.0703,
      partner: -0.3421,
      vendor: -0.4846,
      kind_incident: 0.4375,
      kind_security: 1.0074,
      kind_question: 0.2354,
      kind_request: 0.2574,
      kind_access: 0.3193,
    },
  };
  // END MODEL

  /** The score of an inbox entry, or null without a model. */
  function score(t, now = Date.now(), model = MODEL) {
    if (!model) return null;
    const f = features(t, now);
    let s = 0;
    for (const [k, w] of Object.entries(model.weights)) s += w * (f[k] || 0);
    return s;
  }

  /** What each feature adds to a thread's score, largest first (for the console). */
  function explain(t, now = Date.now(), model = MODEL) {
    if (!model) return [];
    const f = features(t, now);
    return Object.entries(model.weights).map(([k, w]) => [k, w * (f[k] || 0)])
      .filter(([, v]) => v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  }

  return {
    features, names: NAMES, score, explain, model: MODEL,
  };
})();
