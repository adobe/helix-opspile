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
 * The Topics page's space, as the global `TopicSpace`: where every bubble of the graph
 * (ui/topicgraph.js) is, which are drawn, how big, and what is inside a closed one. No drawing:
 * ui/topicview.js draws it with three.js; test/ui-topicspace.test.js checks it.
 *
 * - The topics are fixed: each where the map put it (`topics[].at`, src/topicspace.js: what its
 *   threads say once their people, products and customers are taken out), or, on a map from
 *   before, its area on a sphere and the area's topics around it.
 * - The products come next, each pulled to the few topics it shares the most threads with; then
 *   the people (and a customer whose people did not post), pulled to theirs (hardest), the
 *   products and the other people they share threads with. How hard two pull is how many threads they share
 *   against how many each has. A group (an area, a team, a customer, a product) is where its
 *   members are, by their threads.
 * - A group drawn closed shows what is in it: its children at their own size when they fit, else
 *   all scaled down alike and packed so that none overlaps another or the edge.
 * - While drawn, bubbles push each other apart (the bigger, the less it moves) and are pulled back,
 *   gently, to where they belong.
 */
globalThis.TopicSpace = (() => {
  /** The space's size: the farthest topic is this far from the middle. */
  const SCALE = 70;
  /**
   * How much room each kind takes (a sum of radii cubed): the same for topics, people and products,
   * so that one kind of many threads does not fill the space. Within a kind, a bubble's volume is
   * its threads'.
   */
  const ROOM = 0.02 * SCALE ** 3;
  const MIN_RADIUS = 0.6;
  /** A bubble's radius, for its kind's scale `k` (`scales`): its volume as its threads. */
  const radius = (n, k = 1) => Math.max(MIN_RADIUS, k * Math.cbrt(n.threads.length));
  /** Each kind's scale of the bubbles `items` drawn: each kind's take ROOM together. */
  function scales(items) {
    const sum = {};
    for (const n of items) sum[n.family] = (sum[n.family] || 0) + n.threads.length;
    return Object.fromEntries(Object.entries(sum).map(([f, t]) => [f, Math.cbrt(ROOM / Math.max(t, 1))]));
  }
  /**
   * How hard each kind pulls each other one into place (none: it does not), and how much more
   * the threads they share count than they would (`sharp`): the topics pull hardest, and their
   * pull goes mostly to the topics most of one's threads are in, so that what works on many
   * topics does not end in the middle of them all.
   */
  const PULL = {
    product: { topic: 3, product: 0.15 },
    person: { topic: 3, product: 0.5, person: 0.4 },
  };
  const SHARP = { topic: 3, product: 1.5, person: 1.5 };
  /** How many topics pull each: those it shares the most threads with. */
  const TOPICS_PULLING = 3;
  /** How far a spring holds two apart. */
  const REST = 6;
  const SETTLE = { product: 200, person: 160 };
  /** A group whose members are farther apart than this is drawn as a hub with spokes. */
  const HUB = 18;
  /** The share of a closed bubble its children may fill when scaled down to fit. */
  const DENSITY = 0.42;
  const SKIN = 0.94;

  const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];

  /** A group a click opens: children, and more than one (a customer, any). */
  function opens(n) {
    return Boolean(n.children?.length) && (n.type === 'org' || n.children.length > 1);
  }
  /** A group of one: its child stands for it, and it is never drawn. */
  const never = (n) => Boolean(n.children?.length) && !opens(n);
  /** What a leaf is pulled as: a topic, a product, or a person (a customer of no people too). */
  const kindOf = (n) => (n.family === 'topic' ? 'topic' : n.family);

  function random(seed) {
    let a = seed;
    return () => {
      a = (a * 16807) % 2147483647;
      return a / 2147483647 - 0.5;
    };
  }

  /** `count` points evenly on a sphere of radius `r` (a golden spiral). */
  function sphere(count, r = 1) {
    const turn = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: count }, (_, i) => {
      const y = count === 1 ? 0 : 1 - (2 * (i + 0.5)) / count;
      const ring = Math.sqrt(1 - y * y);
      return [Math.cos(i * turn) * ring * r, y * r, Math.sin(i * turn) * ring * r];
    });
  }

  /**
   * The topics' places on a map that has none of its own (built before src/topicspace.js): each
   * area's on a sphere, the biggest first, and its topics around it.
   */
  function topicsByArea(map, areas) {
    const by = new Map();
    map.topics.forEach((t, i) => {
      const a = areas[i] || '';
      if (!by.has(a)) by.set(a, []);
      by.get(a).push(i);
    });
    const groups = [...by.values()].sort((a, b) => b.length - a.length);
    const centres = sphere(groups.length, 0.75);
    const out = [];
    groups.forEach((list, g) => {
      const around = sphere(list.length, list.length === 1 ? 0 : 0.18);
      list.forEach((t, i) => { out[t] = add(centres[g], around[i]); });
    });
    return out;
  }

  /**
   * Where every node of `graph` (TopicGraph.build of all the map's threads, every kind shown) is:
   * a Map id → [x, y, z], for its leaves; a group's place is `centre`.
   */
  function places(map, graph) {
    const at = map.topics.some((t) => Array.isArray(t.at)) ? null : topicsByArea(map, graph.areas);
    const leaves = [...graph.all.values()].filter((n) => !n.children?.length);
    const pos = new Map();
    for (const n of leaves) {
      if (n.type === 'topic') {
        const t = map.topics[Number(n.key)];
        pos.set(n.id, scale((at ? at[Number(n.key)] : t?.at) || [0, 0, 0], SCALE));
      }
    }
    // Who shares threads with whom, and how much against how many each has.
    const index = new Map(leaves.map((n, i) => [n, i]));
    const on = new Map();
    for (const n of leaves) {
      for (const t of n.threads) {
        if (!on.has(t)) on.set(t, []);
        on.get(t).push(n);
      }
    }
    const shared = new Map();
    for (const list of on.values()) {
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) {
          const [i, j] = [index.get(list[a]), index.get(list[b])].sort((x, y) => x - y);
          const k = i * leaves.length + j;
          shared.set(k, (shared.get(k) || 0) + 1);
        }
      }
    }
    const near = leaves.map(() => []);
    for (const [k, s] of shared) {
      const i = Math.floor(k / leaves.length);
      const j = k % leaves.length;
      const w = s / Math.sqrt(leaves[i].threads.length * leaves[j].threads.length);
      near[i].push([leaves[j], w ** SHARP[kindOf(leaves[j])]]);
      near[j].push([leaves[i], w ** SHARP[kindOf(leaves[i])]]);
    }
    // Of the topics, each is pulled only to the few it shares the most with.
    near.forEach((list, i) => {
      if (kindOf(leaves[i]) === 'topic') return;
      const topics = list.filter(([m]) => kindOf(m) === 'topic').sort((a, b) => b[1] - a[1]);
      const drop = new Set(topics.slice(TOPICS_PULLING).map(([m]) => m));
      near[i] = list.filter(([m]) => !drop.has(m));
    });
    const rnd = random(7);
    const settle = (kind) => {
      const movers = leaves.filter((n) => kindOf(n) === kind);
      const pulls = PULL[kind];
      // First where its neighbours are, by how much it shares with each; nowhere, the middle.
      for (const n of movers) {
        let w = 0;
        let p = [0, 0, 0];
        for (const [m, x] of near[index.get(n)]) {
          const c = pulls[kindOf(m)];
          if (c && pos.has(m.id)) {
            p = add(p, pos.get(m.id), x * c);
            w += x * c;
          }
        }
        pos.set(n.id, add(w ? scale(p, 1 / w) : p, [rnd() * 8, rnd() * 8, rnd() * 8]));
      }
      // Then springs to them, a few units long, cooling.
      for (let it = 0; it < SETTLE[kind]; it += 1) {
        const alpha = 0.5 * (1 - it / SETTLE[kind]) + 0.02;
        for (const n of movers) {
          const here = pos.get(n.id);
          let f = [0, 0, 0];
          let total = 0;
          for (const [m, w] of near[index.get(n)]) {
            const c = pulls[kindOf(m)];
            const there = c && pos.get(m.id);
            if (there) {
              const d = sub(there, here);
              const l = len(d) || 1e-3;
              f = add(f, d, (c * w * (l - REST)) / l);
              total += c * w;
            }
          }
          if (total) pos.set(n.id, add(here, f, alpha / total));
        }
      }
    };
    settle('product');
    settle('person');
    return pos;
  }

  /** A group's place: where its leaves drawn are, by their threads; a leaf's its own. */
  function centre(n, all, pos) {
    if (!n.children?.length) return pos.get(n.id) || [0, 0, 0];
    let p = [0, 0, 0];
    let w = 0;
    const visit = (m) => {
      if (m.children?.length) {
        m.children.forEach((id) => all.get(id) && visit(all.get(id)));
      } else if (pos.has(m.id) && m.threads.length) {
        p = add(p, pos.get(m.id), m.threads.length);
        w += m.threads.length;
      }
    };
    visit(n);
    return w ? scale(p, 1 / w) : p;
  }

  /**
   * What is drawn: `items`, the bubbles, and `shells`, the groups opened (drawn around, or as a
   * hub of, what of theirs is). `open` the groups opened (a Set of ids), `shown` the kinds, `min`
   * the threads a bubble needs.
   */
  function drawn(graph, { open, shown, min = 1 }) {
    const items = [];
    const shells = [];
    const visit = (n) => {
      if (n.threads.length < Math.max(min, 1)) return;
      if (opens(n) && open.has(n.id)) {
        const before = items.length;
        n.children.map((id) => graph.all.get(id)).filter(Boolean).forEach(visit);
        if (items.length > before) shells.push(n);
      } else {
        items.push(n);
      }
    };
    [...graph.all.values()].filter((n) => !n.parent && !never(n) && shown.includes(n.family))
      .forEach(visit);
    return { items, shells };
  }

  /** Whether a group opened is drawn as a hub with spokes: its members far apart. */
  const hub = (n, spread) => n.type !== 'tag' && spread > HUB;

  /**
   * The children of a closed group, inside it: `radii` theirs (the group's is 1), the biggest
   * first. When they fill more than DENSITY of it, all are scaled down alike; then each is
   * pushed off the others and kept inside, smaller again when they do not fit. `[{ p, r }]`.
   */
  function pack(radii) {
    let rs = radii.slice();
    const vol = rs.reduce((a, r) => a + r ** 3, 0);
    const room = DENSITY * SKIN ** 3;
    if (vol > room) rs = rs.map((r) => r * Math.cbrt(room / vol));
    const seeds = sphere(rs.length, 1);
    const ps = seeds.map((p, i) => scale(p, rs.length === 1 ? 0 : 0.6 * Math.cbrt((i + 1) / rs.length)));
    for (let round = 0; round < 8; round += 1) {
      let worst = 0;
      for (let it = 0; it < 90; it += 1) {
        worst = 0;
        for (let i = 0; i < ps.length; i += 1) {
          for (let j = i + 1; j < ps.length; j += 1) {
            const d = sub(ps[j], ps[i]);
            const l = len(d) || 1e-4;
            const gap = rs[i] + rs[j] - l;
            if (gap > 0) {
              worst = Math.max(worst, gap / (rs[i] + rs[j]));
              const mi = rs[i] ** 3;
              const mj = rs[j] ** 3;
              const push = scale(d, gap / l);
              ps[i] = add(ps[i], push, -mj / (mi + mj));
              ps[j] = add(ps[j], push, mi / (mi + mj));
            }
          }
        }
        for (let i = 0; i < ps.length; i += 1) {
          const lim = Math.max(SKIN - rs[i], 0);
          const l = len(ps[i]);
          if (l > lim) ps[i] = scale(ps[i], lim / l);
        }
        if (worst < 0.01) break;
      }
      if (worst < 0.02) break;
      rs = rs.map((r) => r * 0.93);
    }
    return ps.map((p, i) => ({ p, r: rs[i] }));
  }

  /**
   * One step of pushing apart: `bodies` `{ to, home, r }` (`to` where it goes, `home` where it
   * belongs), overlapping ones moved apart by their overlap, the bigger (by volume) moving less,
   * then each pulled back towards home by `back` (a share of the way). Neighbours are found on
   * a grid, so many bodies cost little more than a few.
   */
  function collide(bodies, back = 0) {
    if (back) {
      for (const b of bodies) b.to = add(b.to, sub(b.home, b.to), back);
    }
    let biggest = 1;
    for (const b of bodies) biggest = Math.max(biggest, b.r);
    const cell = 2 * biggest + 0.5;
    const keyOf = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    const cellOf = (v) => Math.floor(v / cell);
    for (let it = 0; it < 2; it += 1) {
      const grid = new Map();
      bodies.forEach((b, i) => {
        const k = keyOf(cellOf(b.to[0]), cellOf(b.to[1]), cellOf(b.to[2]));
        const list = grid.get(k);
        if (list) list.push(i);
        else grid.set(k, [i]);
      });
      for (let i = 0; i < bodies.length; i += 1) {
        const a = bodies[i];
        const cx = cellOf(a.to[0]);
        const cy = cellOf(a.to[1]);
        const cz = cellOf(a.to[2]);
        for (let x = cx - 1; x <= cx + 1; x += 1) {
          for (let y = cy - 1; y <= cy + 1; y += 1) {
            for (let z = cz - 1; z <= cz + 1; z += 1) {
              for (const j of grid.get(keyOf(x, y, z)) || []) {
                if (j > i) {
                  const b = bodies[j];
                  const min = a.r + b.r + 0.5;
                  let dx = b.to[0] - a.to[0];
                  let dy = b.to[1] - a.to[1];
                  let dz = b.to[2] - a.to[2];
                  let l = Math.sqrt(dx * dx + dy * dy + dz * dz);
                  if (l < min) {
                    if (l < 1e-3) {
                      // On top of each other: apart in a direction of their own.
                      [dx, dy, dz] = [Math.cos(i + j), Math.sin(i * j), 0.3];
                      l = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    }
                    const ma = a.r ** 3;
                    const mb = b.r ** 3;
                    const k = (min - l) / l / (ma + mb);
                    a.to = [a.to[0] - dx * k * mb, a.to[1] - dy * k * mb, a.to[2] - dz * k * mb];
                    b.to = [b.to[0] + dx * k * ma, b.to[1] + dy * k * ma, b.to[2] + dz * k * ma];
                  }
                }
              }
            }
          }
        }
      }
    }
    return bodies;
  }

  return {
    SCALE, HUB, radius, scales, opens, never, places, centre, drawn, hub, pack, collide, sphere,
  };
})();
