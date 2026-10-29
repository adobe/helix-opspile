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
  const REACTIONS = {
    rxDone: ['white_check_mark', 'heavy_check_mark', 'done', '✅', '✔️'],
    rxThumbs: ['+1', 'thumbsup', 'like', '👍'],
    rxEyes: ['eyes', '👀'],
    rxPlea: ['pray', '🙏'],
    rxAlarm: ['exclamation', 'fire', 'rotating_light', 'warning', 'bangbang', '❗', '🔥', '🚨'],
    rxSocial: ['joy', 'laughing', 'rolling_on_the_floor_laughing', 'smile', 'grin', 'heart', 'tada',
      'raised_hands', 'clap', 'laugh', '😂', '❤️', '🎉', '🙌', '👏'],
  };
  const THANKS = /\b(thanks|thank you|thx|ty|cheers|merci|danke|gracias|appreciate)\b/i;
  const ALARM = /\b(urgent|asap|down|outage|broken|blocked|blocker|critical|escalat\w*|not working|fails?|failing|error|5\d\d|prod(uction)? (issue|is))\b/i;

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
    // What the last message says, in words that matter for who moves next.
    const text = String(t.last_text || '');
    f.lastAsks = /\?\s*$|\?\s|\b(can you|could you|please|any update|how do|is there)\b/i.test(text) ? 1 : 0;
    f.lastThanks = THANKS.test(text) ? 1 : 0;
    f.lastAlarm = ALARM.test(text) ? 1 : 0;
    f.lastLength = Math.log1p(text.length) / 6;
    // Reactions, as the list shows them: a ✅ settles, 👀 says someone is on it, 🙏 pleads, ❗🔥
    // alarm, 😂🎉❤️ are social. Weak on their own, but what people click on may weigh them.
    const rx = new Map();
    for (const r of t.reactions || []) {
      const name = String(r.emoji || '').replace(/::skin-tone-\d/, '');
      rx.set(name, (rx.get(name) || 0) + (r.count || 0));
    }
    for (const [k, names] of Object.entries(REACTIONS)) {
      f[k] = names.some((n) => rx.get(n)) ? 1 : 0;
    }
    // A customer's first message that waits on us and nobody at Adobe has answered yet, and how
    // long it waits. (Without "waits on us", half of them are welcomes and FYIs.)
    const staffPosted = t.staffPosted ?? people.some((p) => p.staff);
    const first = us && Boolean(t.last_at) && !staffPosted && !checked ? 1 : 0;
    f.firstWaiting = first;
    f.firstWaitingLong = (first * Math.log1p(ageH)) / 5;
    // How sure Clef was of who moves next and of the kind.
    f.nextActorP = lab.next_actor_p ?? 0;
    f.kindP = lab.kind_p ?? 0;
    return f;
  }
  const NAMES = Object.keys(features({}, 0));

  // MODEL: written by `npm run rank -- train`, do not edit by hand.
  const MODEL = {
    trained: '2026-10-29',
    games: {
      clef: 6038,
      sonnet: 371,
      human: 102,
      haiku: 1,
      reply: 1171,
    },
    accuracy: {
      clef: 0.633,
      sonnet: 0.77,
      human: 0.594,
      haiku: 0,
      reply: 0.57,
    },
    weights: {
      recent6h: -0.3517,
      recent2d: 0.9503,
      recent2w: -2.4794,
      threadAge: -0.044,
      lastStaff: 0.0441,
      unseenByAdobe: -0.1473,
      waitsOnUs: 1.6418,
      waitsOnThem: 0.0585,
      waitsOnUsLong: -0.3433,
      urgency: -0.5341,
      unlabeled: -0.6574,
      resolved: -1.0685,
      checked: 0.7721,
      resolvedRecent: 1.1241,
      openUrgency: 2.9961,
      unseenUrgency: -1.4454,
      alert: -0.0978,
      seenByStaff: 0.5049,
      help: 0,
      draft: 1.1769,
      messages: 1.1576,
      customers: 0.4867,
      staff: -0.6156,
      partner: 0.0677,
      vendor: 0.2036,
      kind_incident: 0.4584,
      kind_security: 2.2851,
      kind_question: 0.3103,
      kind_request: 0.4851,
      kind_access: -0.1309,
      lastAsks: -0.1019,
      lastThanks: -0.1602,
      lastAlarm: 0.1351,
      lastLength: 0.8832,
      rxDone: -0.1662,
      rxThumbs: -0.1445,
      rxEyes: -0.3686,
      rxPlea: -0.7172,
      rxAlarm: -3.327,
      rxSocial: -0.333,
      firstWaiting: -0.7464,
      firstWaitingLong: -0.92,
      nextActorP: -0.1997,
      kindP: -0.002,
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
