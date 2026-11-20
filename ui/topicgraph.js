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
 * the filters, its nodes and the lines between them. ui/topics.js lays it out and draws it;
 * test/ui-topicgraph.test.js checks it.
 *
 * Three kinds, each a hierarchy of bubbles: the topics in their **areas** (and "Not in an
 * area"), the people in their **teams** (Adobe's) or their **customers** (everyone else's, and a
 * customer whose people did not post is a bubble of its own), and the features in their
 * **products** (Adobe's) or **vendors** (the others'). A group is drawn until it is opened
 * (`open`), and then its children are, in its place; a group of one child is that child. A
 * customer stays a bubble even with one person, as it is whom the threads are for.
 *
 * A line joins two that share threads, at least `min`. With the topics shown they are the hubs:
 * a line joins a topic (or an area) to the others; without them any two kinds. One kind alone is
 * joined to itself: people and products by the threads they share, topics by the Adobe people
 * they share, `min` people each with `min` threads in both. A node without a line is not drawn,
 * but a topic or an area is. The groups, and the people and products of most threads drawn,
 * have a name on the graph; the rest on pointing.
 */
globalThis.TopicGraph = (() => {
  /** People and products with a name on the graph, the most threads first. */
  const NAMED = 14;
  /** The kinds, each with the types of its nodes, the group first. */
  const FAMILIES = {
    topic: ['tag', 'topic'], person: ['team', 'org', 'person'], product: ['product'],
  };
  const FAMILY = Object.fromEntries(Object.entries(FAMILIES)
    .flatMap(([f, types]) => types.map((t) => [t, f])));
  /** The area "Not in an area" stands for. */
  const NONE = '_none';
  const isCustomer = (map, slug) => Boolean(slug) && !slug.startsWith('_')
    && map.orgs[slug]?.type !== 'internal';
  /** The map's products (maps from before them have none). */
  const productsOf = (map) => map.products || {};
  /** A thread's product id as the graph has it: the product its entry is part of, or itself. */
  const productOf = (map, id) => {
    const p = productsOf(map)[id];
    return p?.product ? `group:${p.product}` : id;
  };

  /** The most counted key of `counts`, or `fallback`. */
  const most = (counts, fallback) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
  const add = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

  /**
   * Each topic's area: the one it was found in (maps of version 2), else the tag most of its
   * threads have, else none (NONE).
   */
  function topicAreas(map) {
    const counts = map.topics.map(() => new Map());
    for (const t of map.threads) {
      for (const g of t.tags || []) add(counts[t.topic] || new Map(), g);
    }
    return map.topics.map((topic, i) => (topic.area !== undefined
      ? topic.area || NONE : most(counts[i], NONE)));
  }

  /**
   * Who each person is (`{ staff, team }` or `{ staff: false, org }`): as the map says (version 2),
   * else, for Adobe's people, the team of most of their threads.
   */
  function peopleOf(map) {
    if (map.peopleOf) return map.peopleOf;
    const teams = new Map();
    for (const t of map.threads) {
      for (const p of Object.keys(t.staff || {})) {
        if (!teams.has(p)) teams.set(p, new Map());
        add(teams.get(p), t.team);
      }
    }
    return Object.fromEntries([...teams].map(([p, c]) => [p, { staff: true, team: most(c, null) }]));
  }

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
   * The graph of `map` for `team` (all teams when empty), the kinds `shown`, the threads a line
   * needs (`min`) and the groups opened (`open`, their ids): every node of the team's threads,
   * groups and children (`all`, by id), those drawn (`nodes`), the lines (`edges`:
   * `{ a, b, w }`), who is joined to whom (`neighbors`), the threads, and each topic's area
   * (`areas`). A node has its `family` (the kind), `one` (what it is, in a word), its `parent`
   * (a group's id) or its `children` (a group's: ids), and `open` when it is a group opened.
   */
  function build(map, {
    team = '', shown, min = 1, open = [], teamName = (slug) => slug,
  }) {
    const threads = map.threads.filter((t) => !team || t.team === team);
    const products = productsOf(map);
    const areas = topicAreas(map);
    const who = peopleOf(map);
    const opened = new Set(open);
    const all = new Map();
    const node = (type, key, label, one, parent = null) => {
      const id = `${type}:${key}`;
      let n = all.get(id);
      if (!n) {
        n = {
          id, type, family: FAMILY[type], key: String(key), label, one, threads: [], parent,
        };
        all.set(id, n);
      }
      return n;
    };
    const group = (type, key, label, one) => {
      const n = node(type, key, label, one);
      n.children = n.children || [];
      return n;
    };
    const child = (g, n) => {
      if (!g) return n;
      n.parent = g.id;
      if (!g.children.includes(n.id)) g.children.push(n.id);
      return n;
    };
    // Every thread's nodes, of every kind, its groups and their children (a group counts a thread
    // once however many of its children it has).
    const onOf = new Map();
    for (const t of threads) {
      const on = new Set();
      const area = areas[t.topic] || NONE;
      const tag = group('tag', area, area === NONE ? 'Not in an area' : map.tags[area] || area, 'Area');
      on.add(tag);
      on.add(child(tag, node('topic', t.topic, map.topics[t.topic]?.label || `Topic ${t.topic + 1}`, 'Topic')));
      for (const p of Object.keys(t.staff || {})) {
        const slug = who[p]?.team;
        const g = slug ? group('team', slug, teamName(slug), 'Team') : null;
        if (g) on.add(g);
        on.add(child(g, node('person', p, map.people[p] || `#${p}`, 'Person')));
      }
      const org = isCustomer(map, t.org) ? group('org', t.org, map.orgs[t.org]?.name || t.org, 'Customer') : null;
      if (org) on.add(org);
      for (const p of Object.keys(t.customers || {})) {
        const slug = who[p]?.org;
        const g = isCustomer(map, slug) ? group('org', slug, map.orgs[slug]?.name || slug, 'Customer') : null;
        if (g) on.add(g);
        on.add(child(g, node('person', p, map.people[p] || `#${p}`, 'Person')));
      }
      // A tech stack entry in the product it is part of (Experience Manager Sites for Universal
      // Editor), or its vendor's (Google for Google Drive); a gap (on maps from before) as itself.
      for (const id of new Set(t.products || [])) {
        const p = products[id];
        const adobe = /^tech:adobe\//.test(id);
        const g = p?.product ? group('product', `group:${p.product}`, p.product, adobe ? 'Product' : 'Vendor') : null;
        if (g) on.add(g);
        const leaf = child(g, node('product', id, p?.name || id, g ? (adobe ? 'Feature' : 'Technology') : 'Product'));
        leaf.gap = !p?.tech;
        on.add(leaf);
      }
      for (const n of on) n.threads.push(t);
      onOf.set(t, on);
    }
    // A group of one child is that child; a customer stays, as whom the threads are for.
    const shows = (g) => g.type === 'org' || g.children.length > 1;
    for (const n of all.values()) {
      if (n.children) n.open = opened.has(n.id) && n.children.length > 0;
      if (n.parent && !shows(all.get(n.parent))) n.parent = null;
    }
    /** What stands for `n` on the graph: its group when that is closed, else itself. */
    const drawnAs = (n) => {
      if (n.children && (n.open || !shows(n))) return null;
      const g = n.parent && all.get(n.parent);
      return g && !g.open ? g : n;
    };
    const hub = shown.includes('topic');
    const alone = shown.length === 1;
    const joined = (a, b) => (a.family === b.family ? alone
      : !hub || a.family === 'topic' || b.family === 'topic');
    const weights = new Map();
    // Threads per person and node, for joining topics by their people.
    const through = alone && shown[0] === 'topic' ? new Map() : null;
    for (const t of threads) {
      const vis = [...new Set([...onOf.get(t)].map(drawnAs).filter(Boolean))]
        .filter((n) => shown.includes(n.family));
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
    const nodes = [...all.values()].filter((n) => shown.includes(n.family) && drawnAs(n) === n
      && (neighbors.has(n.id) || n.family === 'topic'));
    for (const n of nodes) {
      if (n.type === 'tag' || n.type === 'team' || n.type === 'topic') n.named = true;
    }
    for (const family of ['person', 'product']) {
      nodes.filter((n) => n.family === family).sort((a, b) => b.threads.length - a.threads.length)
        .slice(0, NAMED).forEach((n) => { n.named = true; });
    }
    return {
      all, nodes, edges, neighbors, threads, areas,
    };
  }

  return {
    build, isCustomer, productOf, FAMILIES, NONE,
  };
})();
