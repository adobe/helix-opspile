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
 * The Topics page's map in three dimensions, as the global `TopicView`: the bubbles of
 * ui/topicgraph.js where ui/topicspace.js puts them, drawn with three.js, which the page imports
 * from THREE_PATH (src/ui-three.js, bundled; the Worker serves it) when it first draws.
 *
 * Each kind in its color of the page (ui/spectrum-topics.css, `--s2-type`, read from the
 * stylesheet): a leaf solid, a group glass with what is in it inside, a group opened a thin shell
 * around its members (an area's topics) or, when they are far apart (a team's people), a hub
 * with a spoke to each. A product no tech stack entry names is glass too, empty.
 *
 * - A click picks a bubble (the panel says what it is), and draws a line to each bubble it shares
 *   threads with; the rest fade. A click on nothing unpicks.
 * - Holding a group pops it: it swells while held, and its children come out of where they sat
 *   in it. Holding an opened group's shell, or one of its members, folds it back; it shrinks.
 * - A double-click shows only that bubble's threads; on nothing, all of them again.
 * - Drag to turn, scroll to zoom. It turns slowly by itself until it is touched, and again three
 *   minutes after (not for those who ask for less motion).
 * - At most MAX_LABELS names, the biggest groups and the most threads first (a pick and what it
 *   shares threads with before them), none over another; the one pointed at besides.
 */
globalThis.TopicView = (() => {
  const THREE_PATH = '/inbox/three.js';
  const HOLD_MS = 650;
  const RESUME_MS = 3 * 60 * 1000;
  const MAX_LABELS = 10;
  const LINKS = 40;
  const TYPES = ['topic', 'tag', 'person', 'team', 'org', 'product'];

  let T = null;
  const v = {
    host: null, handlers: {}, renderer: null, scene: null, camera: null, controls: null,
    objs: new Map(), pickable: [], colors: {}, fly: null, lines: null, frame: 0,
    press: null, hovered: '', sel: '', find: '', related: new Map(), graph: null, pos: null,
    resume: 0, last: 0, tick: 0, spinning: true,
  };

  // ---- colors: the page's, per kind ---------------------------------------------------

  function readColors() {
    for (const type of TYPES) {
      const probe = v.host.querySelector(`.probe[data-type="${type}"]`);
      v.colors[type] = new T.Color(getComputedStyle(probe).color);
    }
  }
  const colorOf = (n) => v.colors[n.type] || v.colors.topic;

  // ---- materials ------------------------------------------------------------------------

  /** Glass: the kind's color at the rim, nearly clear in the middle. */
  function glass(color, strength) {
    return new T.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { color: { value: color }, strength: { value: strength }, fade: { value: 1 } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 color; uniform float strength; uniform float fade;
        varying vec3 vN; varying vec3 vV;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 2.2);
          float shine = pow(max(dot(reflect(-vV, vN), normalize(vec3(0.4, 0.8, 0.5))), 0.0), 24.0);
          gl_FragColor = vec4(color + vec3(0.3) * shine, (0.1 + 0.9 * rim) * strength * fade);
        }`,
    });
  }
  const solid = (color) => new T.MeshStandardMaterial({
    color, roughness: 0.45, metalness: 0.05, transparent: true, opacity: 1,
  });
  const setFade = (o, fade) => {
    const m = o.mesh.material;
    if (m.uniforms) m.uniforms.fade.value = fade;
    else m.opacity = fade;
  };

  // ---- the scene --------------------------------------------------------------------------

  async function mount(host, handlers) {
    if (v.host === host) return Boolean(v.renderer);
    dispose();
    v.host = host;
    v.handlers = handlers;
    try {
      T = T || await import(THREE_PATH);
      v.renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      v.renderer = null;
      return false;
    }
    const canvas = v.renderer.domElement;
    canvas.className = 'space';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Topics in their areas, people in their teams and customers, and products, in a space where the topics are by what their threads are about');
    host.prepend(canvas);
    v.labels = document.createElement('div');
    v.labels.className = 'lbls';
    v.labels.setAttribute('aria-hidden', 'true');
    host.append(v.labels);
    for (const type of TYPES) {
      const probe = document.createElement('span');
      probe.className = 'probe';
      probe.dataset.type = type;
      host.append(probe);
    }
    readColors();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      readColors();
      recolor();
    });
    v.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    v.scene = new T.Scene();
    v.camera = new T.PerspectiveCamera(45, 1, 0.1, 4000);
    v.camera.position.set(0, 40, 190);
    v.scene.add(new T.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new T.DirectionalLight(0xffffff, 1.4);
    sun.position.set(80, 120, 100);
    v.scene.add(sun);
    v.controls = new T.OrbitControls(v.camera, canvas);
    v.controls.enableDamping = true;
    v.controls.autoRotateSpeed = 0.25;
    v.spinning = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    v.controls.autoRotate = v.spinning;
    v.controls.addEventListener('start', () => {
      v.controls.autoRotate = false;
      v.fly = null;
      clearTimeout(v.resume);
    });
    v.controls.addEventListener('end', () => {
      clearTimeout(v.resume);
      if (v.spinning) v.resume = setTimeout(() => { v.controls.autoRotate = true; }, RESUME_MS);
    });
    v.sphere = new T.SphereGeometry(1, 36, 24);
    v.speck = new T.SphereGeometry(1, 16, 10);
    v.observer = new ResizeObserver(resize);
    v.observer.observe(host);
    resize();
    wire(canvas);
    v.last = performance.now();
    v.frame = requestAnimationFrame(loop);
    return true;
  }

  function dispose() {
    cancelAnimationFrame(v.frame);
    v.observer?.disconnect();
    v.renderer?.dispose();
    v.renderer?.domElement.remove();
    v.labels?.remove();
    Object.assign(v, {
      host: null, renderer: null, objs: new Map(), pickable: [], lines: null, graph: null,
    });
  }

  function resize() {
    if (!v.renderer) return;
    const w = v.host.clientWidth;
    const h = v.host.clientHeight;
    v.renderer.setSize(w, h);
    v.camera.aspect = w / Math.max(h, 1);
    v.camera.updateProjectionMatrix();
  }

  function recolor() {
    for (const o of v.objs.values()) {
      const m = o.mesh.material;
      if (m.uniforms) m.uniforms.color.value = colorOf(o.n);
      else m.color = colorOf(o.n);
      o.spokes?.material.color.copy(colorOf(o.n));
    }
  }

  // ---- what is drawn ---------------------------------------------------------------------

  const V3 = (a) => new T.Vector3(a[0], a[1], a[2]);

  function make(key, n, shell, from) {
    const color = colorOf(n);
    const group = TopicSpace.opens(n);
    let mat;
    if (shell) mat = glass(color, 0.3);
    else if (group) mat = glass(color, 0.95);
    else if (n.gap) mat = glass(color, 0.8);
    else mat = solid(color);
    const mesh = new T.Mesh(v.sphere, mat);
    mesh.userData.key = key;
    mesh.renderOrder = shell ? 2 : Number(group);
    v.scene.add(mesh);
    const label = document.createElement('span');
    label.className = `lbl${group || shell ? ' group' : ''}`;
    label.dataset.type = n.type;
    label.textContent = n.label;
    v.labels.append(label);
    const o = {
      key, n, shell, mesh, label, pos: from.clone(), to: from.toArray(), home: from.toArray(),
      s: 0, sTo: 0, puff: 1, puffTo: 1, rank: 0,
    };
    v.objs.set(key, o);
    v.pickable.push(mesh);
    return o;
  }

  function remove(key) {
    const o = v.objs.get(key);
    v.scene.remove(o.mesh);
    if (o.spokes) v.scene.remove(o.spokes);
    o.mesh.material.dispose();
    o.label.remove();
    v.objs.delete(key);
    v.pickable.splice(v.pickable.indexOf(o.mesh), 1);
  }

  /** The children of a closed group inside it, to scale or packed (TopicSpace.pack). */
  function specks(o) {
    const kids = o.n.children.map((id) => v.graph.all.get(id))
      .filter((c) => c && c.threads.length >= v.min)
      .sort((a, b) => b.threads.length - a.threads.length);
    const sig = `${o.n.threads.length}|${kids.map((c) => c.threads.length).join(',')}`;
    if (o.sig === sig) return;
    o.sig = sig;
    if (o.specks) o.mesh.remove(o.specks);
    o.specks = new T.Group();
    o.packed = new Map();
    const R = TopicSpace.radius(o.n);
    TopicSpace.pack(kids.map((c) => TopicSpace.radius(c) / R)).forEach(({ p, r }, i) => {
      const m = new T.Mesh(v.speck, solid(colorOf(kids[i])));
      m.position.set(p[0], p[1], p[2]);
      m.scale.setScalar(r);
      m.raycast = () => {};
      o.specks.add(m);
      o.packed.set(kids[i].id, { p, r });
    });
    o.mesh.add(o.specks);
  }

  /**
   * Draws `graph` (TopicGraph.build) with the places of `pos` (TopicSpace.places): the groups
   * opened (`open`, a Set), the kinds `shown`, the threads a bubble needs (`min`); `refit` flies
   * to show all of it.
   */
  function draw({
    graph, pos, open, shown, min, refit = false,
  }) {
    if (!v.renderer) return;
    v.graph = graph;
    v.pos = pos;
    v.min = min;
    const { items, shells } = TopicSpace.drawn(graph, { open, shown, min });
    const want = new Map();
    for (const n of items) {
      want.set(n.id, { n, to: TopicSpace.centre(n, graph.all, pos), r: TopicSpace.radius(n) });
    }
    const ancestors = (n) => {
      const out = [];
      for (let p = n.parent && graph.all.get(n.parent); p; p = p.parent && graph.all.get(p.parent)) out.push(p);
      return out;
    };
    for (const g of shells) {
      const c = TopicSpace.centre(g, graph.all, pos);
      const inside = items.filter((n) => ancestors(n).includes(g));
      let spread = 0;
      for (const n of inside) {
        const w = want.get(n.id);
        spread = Math.max(spread, Math.hypot(w.to[0] - c[0], w.to[1] - c[1], w.to[2] - c[2]) + w.r);
      }
      const hub = TopicSpace.hub(g, spread);
      want.set(`shell:${g.id}`, {
        n: g, shell: true, hub, inside: inside.map((n) => n.id), to: c, r: hub ? 2.2 : spread + 3,
      });
    }
    const named = new Set(items.filter((n) => TopicSpace.opens(n) || n.type === 'topic').map((n) => n.id));
    for (const family of ['person', 'product']) {
      items.filter((n) => !TopicSpace.opens(n) && n.family === family)
        .sort((a, b) => b.threads.length - a.threads.length).slice(0, 12)
        .forEach((n) => named.add(n.id));
    }
    for (const [key, w] of want) {
      let o = v.objs.get(key);
      if (!o || o.leaving) {
        if (o) remove(key);
        // Out of whatever stood for it: the speck it was in its group's bubble, or that bubble.
        const was = [w.n, ...ancestors(w.n)].map((a) => v.objs.get(a.id)).find((x) => x && !x.leaving);
        let from = was ? was.pos : V3(w.to);
        const speck = was && was.n !== w.n && was.packed && [w.n, ...ancestors(w.n)]
          .map((a) => was.packed.get(a.id)).find(Boolean);
        if (speck) from = was.pos.clone().addScaledVector(V3(speck.p), was.s);
        o = make(key, w.n, Boolean(w.shell), from);
        if (speck) o.s = speck.r * was.s;
      }
      o.n = w.n;
      if (Math.hypot(...o.home.map((x, i) => x - w.to[i])) > 1e-3) {
        o.home = w.to.slice();
        o.to = w.to.slice();
      }
      o.sTo = w.r;
      o.leaving = false;
      o.named = Boolean(w.shell) || named.has(w.n.id);
      o.rank = (w.shell ? 2e6 : 0) + (TopicSpace.opens(w.n) ? 1e6 : 0) + w.n.threads.length;
      if (w.shell) {
        o.hub = w.hub;
        o.inside = w.inside;
        o.mesh.material.uniforms.strength.value = w.hub ? 0.9 : 0.3 * Math.min(1, 16 / w.r);
        if (!o.spokes) {
          o.spokes = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({
            color: colorOf(w.n), transparent: true, opacity: 0.25,
          }));
          v.scene.add(o.spokes);
        }
        o.spokes.geometry.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(w.inside.length * 6), 3));
      } else if (TopicSpace.opens(w.n)) {
        specks(o);
      }
    }
    for (const [key, o] of v.objs) {
      if (!want.has(key) && !o.leaving) {
        // Back into what stands for it now.
        const into = ancestors(o.n).map((a) => want.get(a.id) || want.get(`shell:${a.id}`)).find(Boolean);
        if (into) o.to = into.to.slice();
        o.sTo = 0;
        o.leaving = true;
      }
    }
    if (refit) fit(want);
    focus({});
  }

  /**
   * Flies to show the bubbles drawn (or those of `want`): all but the farthest few, about their
   * middle, so one far off does not leave the rest small.
   */
  function fit(want = null) {
    if (!v.renderer) return;
    const list = want ? [...want.values()].map((w) => ({ p: w.to, r: w.r }))
      : [...v.objs.values()].filter((o) => !o.leaving).map((o) => ({ p: o.to, r: o.sTo }));
    if (!list.length) return;
    const mid = list.reduce((m, x) => m.add(V3(x.p)), new T.Vector3()).multiplyScalar(1 / list.length);
    const far = list.map((x) => V3(x.p).distanceTo(mid) + x.r).sort((a, b) => a - b);
    const radius = Math.max(far[Math.floor((far.length - 1) * 0.9)], 10);
    const fov = (v.camera.fov * Math.PI) / 360;
    const fill = Math.min(1, v.camera.aspect) * Math.tan(fov);
    v.fly = { target: mid, dist: radius / fill + radius * 0.1 };
  }

  // ---- focus: a pick, what it shares threads with; or what Find finds --------------------

  function focus({ sel = v.sel, find = v.find }) {
    if (!v.renderer) return;
    v.sel = sel;
    v.find = find;
    if (v.lines) {
      v.scene.remove(v.lines);
      v.lines = null;
    }
    const picked = sel && (v.objs.get(sel) || v.objs.get(`shell:${sel}`));
    const me = picked && !picked.leaving ? picked : null;
    v.related = new Map();
    let lit = null;
    if (me) {
      const mine = new Set(me.n.threads);
      for (const o of v.objs.values()) {
        if (o !== me && !o.leaving && !o.shell) {
          let s = 0;
          for (const t of o.n.threads) if (mine.has(t)) s += 1;
          if (s) v.related.set(o.key, s);
        }
      }
      const top = [...v.related].sort((a, b) => b[1] - a[1]).slice(0, LINKS).map(([k]) => v.objs.get(k));
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(top.length * 6), 3));
      v.lines = new T.LineSegments(geo, new T.LineBasicMaterial({ color: colorOf(me.n), transparent: true, opacity: 0.5 }));
      v.lines.userData.ends = [me, top];
      v.scene.add(v.lines);
      lit = new Set([me.key, ...v.related.keys()]);
    } else if (find) {
      const f = find.toLowerCase();
      lit = new Set([...v.objs.values()].filter((o) => o.n.label.toLowerCase().includes(f)).map((o) => o.key));
    }
    for (const o of v.objs.values()) {
      const dim = lit && !o.shell && !lit.has(o.key);
      setFade(o, dim ? 0.18 : 1);
      o.label.classList.toggle('dim', Boolean(dim));
      o.label.classList.toggle('sel', o === me);
      o.lit = Boolean(lit && lit.has(o.key));
    }
  }

  // ---- the pointer -----------------------------------------------------------------------

  const ray = () => new T.Raycaster();
  function hit(ev) {
    const box = v.renderer.domElement.getBoundingClientRect();
    const p = new T.Vector2(((ev.clientX - box.left) / box.width) * 2 - 1, -((ev.clientY - box.top) / box.height) * 2 + 1);
    const r = ray();
    r.setFromCamera(p, v.camera);
    const hits = r.intersectObjects(v.pickable, false).map((h) => v.objs.get(h.object.userData.key))
      .filter((o) => o && !o.leaving && o.s > 0.2);
    // What is inside a shell before the shell.
    return hits.find((o) => !o.shell) || hits[0] || null;
  }

  /** What holding `o` does: pops it, or folds its group (`{ act, group }`), or nothing. */
  function holdOf(o) {
    if (o.shell) return { act: 'fold', group: o.n };
    if (TopicSpace.opens(o.n)) return { act: 'pop', group: o.n };
    const g = o.n.parent && v.objs.get(`shell:${o.n.parent}`);
    return g && !g.leaving ? { act: 'fold', group: g.n } : null;
  }

  function wire(canvas) {
    canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const o = hit(ev);
      v.press = {
        o, x: ev.clientX, y: ev.clientY, t0: performance.now(), hold: o && holdOf(o), done: false,
      };
    });
    canvas.addEventListener('pointerup', (ev) => {
      const p = v.press;
      v.press = null;
      if (!p || p.done || Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 5) return;
      v.handlers.onPick(p.o ? p.o.n.id : '');
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (v.press && Math.hypot(ev.clientX - v.press.x, ev.clientY - v.press.y) > 5) v.press = null;
      const o = hit(ev);
      v.hovered = o ? o.key : '';
      canvas.classList.toggle('over', Boolean(o));
      v.handlers.onHover(o ? o.n.id : '', ev, o && holdOf(o));
    });
    canvas.addEventListener('pointerleave', (ev) => {
      v.press = null;
      v.hovered = '';
      v.handlers.onHover('', ev, null);
    });
    canvas.addEventListener('dblclick', (ev) => {
      const o = hit(ev);
      v.handlers.onOnly(o ? o.n.id : '');
    });
  }

  /** While a bubble is held: it swells (a pop) or shrinks (a fold), then it is done. */
  function holding(now) {
    for (const o of v.objs.values()) o.puffTo = 1;
    const p = v.press;
    if (!p || p.done || !p.hold) return;
    const k = Math.min((now - p.t0) / HOLD_MS, 1);
    const o = p.hold.act === 'pop' ? p.o : v.objs.get(`shell:${p.hold.group.id}`);
    if (!o) return;
    const ease = k * k * (3 - 2 * k);
    o.puffTo = p.hold.act === 'pop' ? 1 + 0.45 * ease + 0.04 * Math.sin(now / 40) * k : 1 - 0.35 * ease;
    if (k < 1) return;
    p.done = true;
    v.handlers.onFold(p.hold.group.id, p.hold.act);
  }

  // ---- every frame -----------------------------------------------------------------------

  function push(dt) {
    const bodies = [...v.objs.values()].filter((o) => !o.leaving && !o.shell);
    for (const o of bodies) o.r = o.sTo;
    TopicSpace.collide(bodies, 1 - Math.exp(-dt * 0.6));
    // An area's shell keeps its topics inside.
    for (const o of v.objs.values()) {
      if (o.shell && !o.hub && !o.leaving) {
        let r = 0;
        for (const id of o.inside) {
          const m = v.objs.get(id);
          if (m && !m.leaving) r = Math.max(r, Math.hypot(...m.to.map((x, i) => x - o.to[i])) + m.sTo);
        }
        o.sTo = r + 3;
      }
    }
  }

  function labels() {
    const w = v.host.clientWidth;
    const h = v.host.clientHeight;
    const kept = [];
    let shown = 0;
    const prio = (o) => (o.key === v.sel ? 1e12 : 0) + (o.lit ? 1e9 + (v.related.get(o.key) || 0) * 1e6 : 0) + o.rank;
    const list = [];
    for (const o of v.objs.values()) {
      if (!o.leaving && (o.named || o.lit || o.key === v.hovered)) list.push(o);
      else o.label.classList.remove('on');
    }
    list.sort((a, b) => prio(b) - prio(a));
    const p = new T.Vector3();
    for (const o of list) {
      const over = o.key === v.hovered;
      p.copy(o.pos).add(new T.Vector3(0, (o.shell && !o.hub ? o.s * 0.75 : o.s * o.puff) + 1.2, 0)).project(v.camera);
      const x = ((p.x + 1) / 2) * w;
      const y = ((1 - p.y) / 2) * h;
      // As wide as it was drawn, once it was; till then, by its letters.
      if (o.label.classList.contains('on') && !o.wide) o.wide = o.label.offsetWidth;
      const bw = (o.wide || o.n.label.length * 6.5) + 6;
      const bh = o.label.classList.contains('group') ? 18 : 15;
      const box = [x - bw / 2, y - bh, x + bw / 2, y];
      const free = p.z < 1 && x > 0 && x < w && y > 0 && y < h
        && !kept.some((k) => box[0] < k[2] && box[2] > k[0] && box[1] < k[3] && box[3] > k[1]);
      const show = over || (free && shown < MAX_LABELS && (o.named || o.lit));
      o.label.classList.toggle('on', show);
      o.label.classList.toggle('over', over);
      if (show) {
        o.label.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`;
        kept.push(box);
        if (!over) shown += 1;
      }
    }
  }

  function loop(now) {
    v.frame = requestAnimationFrame(loop);
    const dt = Math.min((now - v.last) / 1000, 0.2);
    v.last = now;
    const kp = 1 - Math.exp(-dt * 7);
    const ks = 1 - Math.exp(-dt * 8);
    v.tick += 1;
    if (v.tick % 2 === 0) push(dt * 2);
    holding(now);
    for (const [key, o] of v.objs) {
      o.pos.lerp(V3(o.to), kp);
      o.s += (o.sTo - o.s) * ks;
      o.puff += (o.puffTo - o.puff) * (1 - Math.exp(-dt * 18));
      if (o.leaving && o.s < 0.05) {
        remove(key);
      } else {
        o.mesh.position.copy(o.pos);
        o.mesh.scale.setScalar(Math.max(o.s * o.puff, 1e-3));
        if (o.spokes) {
          o.spokes.visible = o.hub && !o.leaving;
          if (o.spokes.visible) {
            const a = o.spokes.geometry.attributes.position;
            o.inside.forEach((id, i) => {
              const m = v.objs.get(id);
              const q = m ? m.pos : o.pos;
              a.setXYZ(i * 2, o.pos.x, o.pos.y, o.pos.z);
              a.setXYZ(i * 2 + 1, q.x, q.y, q.z);
            });
            a.needsUpdate = true;
          }
        }
      }
    }
    if (v.lines) {
      const [me, top] = v.lines.userData.ends;
      const a = v.lines.geometry.attributes.position;
      top.forEach((o, i) => {
        a.setXYZ(i * 2, me.pos.x, me.pos.y, me.pos.z);
        a.setXYZ(i * 2 + 1, o.pos.x, o.pos.y, o.pos.z);
      });
      a.needsUpdate = true;
    }
    if (v.fly) {
      v.controls.target.lerp(v.fly.target, kp);
      const dir = v.camera.position.clone().sub(v.controls.target).normalize();
      v.camera.position.lerp(v.controls.target.clone().addScaledVector(dir, v.fly.dist), kp);
      if (v.controls.target.distanceTo(v.fly.target) < 0.5) v.fly = null;
    }
    v.controls.update();
    v.renderer.render(v.scene, v.camera);
    labels();
  }

  /** Where bubble `id` is drawn, in the page (`{ x, y }`), or null: for scripts and tests. */
  function screen(id) {
    const o = v.objs.get(id) || v.objs.get(`shell:${id}`);
    if (!o || !v.renderer) return null;
    const p = o.pos.clone().project(v.camera);
    const box = v.renderer.domElement.getBoundingClientRect();
    return { x: box.left + ((p.x + 1) / 2) * box.width, y: box.top + ((1 - p.y) / 2) * box.height };
  }

  return {
    THREE_PATH, mount, draw, focus, fit, resize, screen,
  };
})();
