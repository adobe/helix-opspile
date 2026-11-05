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
 * The Topics page's graph, as the global `TopicGraph`: from a topic map (src/topicmap.js) and
 * the filters, its nodes (people, topics, tags, customers) and the lines between them. ui/topics.js
 * lays it out and draws it; test/ui-topicgraph.test.js checks it.
 *
 * A line joins two that share threads, at least `min`. With the topics shown they are the hubs: a
 * line joins a topic to the others, and a person to a customer; without them any two kinds. One
 * kind alone is joined to itself: people and tags by the threads they share, topics and customers
 * (one to a thread, so never two in one) by the people they share, `min` people each with `min`
 * threads in both. A node without a line is not drawn, but a topic is.
 */
globalThis.TopicGraph = (() => {
  const isCustomer = (map, slug) => Boolean(slug) && !slug.startsWith('_')
    && map.orgs[slug]?.type !== 'internal';

  /** Counts each pair of `ids` (sorted) in `weights`. */
  function pairs(ids, weights, joined = () => true) {
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        if (joined(ids[i], ids[j])) {
          const key = [ids[i].id, ids[j].id].sort().join('|');
          weights.set(key, (weights.get(key) || 0) + 1);
        }
      }
    }
  }

  /**
   * The graph of `map` for `team` (all teams when empty), the kinds `shown` and the threads a
   * line needs (`min`): every node of the team's threads (`all`, by id), those drawn (`nodes`),
   * the lines (`edges`: `{ a, b, w }`), who is joined to whom (`neighbors`) and the threads.
   */
  function build(map, { team = '', shown, min = 1 }) {
    const threads = map.threads.filter((t) => !team || t.team === team);
    const all = new Map();
    const node = (type, key, label) => {
      const id = `${type}:${key}`;
      let n = all.get(id);
      if (!n) {
        n = {
          id, type, key: String(key), label, threads: [],
        };
        all.set(id, n);
      }
      return n;
    };
    const hub = shown.includes('topic');
    const alone = shown.length === 1;
    const joined = (a, b) => (a.type === b.type ? alone : (!hub || a.type === 'topic'
      || b.type === 'topic' || (a.type === 'person' && b.type === 'org')
      || (a.type === 'org' && b.type === 'person')));
    const weights = new Map();
    // Threads per person and node, for joining topics or customers by their people.
    const through = alone && (shown[0] === 'topic' || shown[0] === 'org') ? new Map() : null;
    for (const t of threads) {
      const on = [node('topic', t.topic, map.topics[t.topic]?.label || `Topic ${t.topic + 1}`)];
      for (const p of Object.keys(t.staff || {})) on.push(node('person', p, map.people[p] || `#${p}`));
      for (const g of t.tags || []) on.push(node('tag', g, map.tags[g] || g));
      if (isCustomer(map, t.org)) on.push(node('org', t.org, map.orgs[t.org]?.name || t.org));
      for (const n of on) n.threads.push(t);
      const vis = on.filter((n) => shown.includes(n.type));
      if (through) {
        for (const p of Object.keys(t.staff || {})) {
          if (!through.has(p)) through.set(p, new Map());
          const counts = through.get(p);
          for (const n of vis) counts.set(n, (counts.get(n) || 0) + 1);
        }
      }
      pairs(vis, weights, joined);
    }
    if (through) {
      // The lines there would be with the people shown, and only `min` of them: most people
      // answer in many topics, and one in common says little. The more people, the thicker.
      for (const counts of through.values()) {
        pairs([...counts].filter(([, n]) => n >= min).map(([n]) => n), weights);
      }
    }
    const edges = [...weights].filter(([, w]) => w >= min).map(([key, w]) => {
      const [a, b] = key.split('|');
      return { a: all.get(a), b: all.get(b), w };
    });
    const neighbors = new Map();
    for (const e of edges) {
      if (!neighbors.has(e.a.id)) neighbors.set(e.a.id, new Set());
      if (!neighbors.has(e.b.id)) neighbors.set(e.b.id, new Set());
      neighbors.get(e.a.id).add(e.b.id);
      neighbors.get(e.b.id).add(e.a.id);
    }
    const nodes = [...all.values()].filter((n) => shown.includes(n.type)
      && (neighbors.has(n.id) || n.type === 'topic'));
    return {
      all, nodes, edges, neighbors, threads,
    };
  }

  return { build, isCustomer };
})();
