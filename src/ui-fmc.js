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
 * The FMC visualization runner for the browser: src/fmc.js with ELK's layered layout (elkjs,
 * which runs in the page, without a worker), and a drawing of a customer's stack with it
 * (src/fmc-stack.js).
 *
 * The page does not load this file: scripts/ui-markdown.mjs bundles it, with elkjs, into
 * src/ui-fmc.bundle.js, which the Worker serves at /inbox/fmc.js, and the inbox imports that
 * when it first shows a stack (ui/stack.js). scripts/fmc-gallery.mjs's page imports it too.
 */

/* global document, getComputedStyle */
import ELK from 'elkjs/lib/elk.bundled.js';
import { render as renderWith } from './fmc.js';
import { stackDiagram } from './fmc-stack.js';

let elk = null;

/**
 * A measure of text as `el`'s drawing writes it: its font, at the size its labels have
 * (`.fmc-text`, and `.fmc-code` for code), by a canvas. `{ measure, size }`, for `render`.
 */
export function measurer(el) {
  const svgNs = 'http://www.w3.org/2000/svg';
  const probe = document.createElementNS(svgNs, 'svg');
  probe.setAttribute('class', 'fmc fmc-probe');
  probe.setAttribute('aria-hidden', 'true');
  const text = document.createElementNS(svgNs, 'text');
  text.setAttribute('class', 'fmc-text');
  const code = document.createElementNS(svgNs, 'tspan');
  code.setAttribute('class', 'fmc-code');
  text.append(code);
  probe.append(text);
  el.append(probe);
  const sans = getComputedStyle(text);
  const mono = getComputedStyle(code);
  const size = parseFloat(sans.fontSize) || 12;
  const fonts = { sans: `${sans.fontWeight} ${size}px ${sans.fontFamily}`, mono: `${mono.fontWeight} ${size}px ${mono.fontFamily}` };
  probe.remove();
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  const measure = (s, { mono: m = false, size: px = size } = {}) => {
    const key = `${m ? 'm' : 's'}${px}|${s}`;
    if (!cache.has(key)) {
      ctx.font = m ? fonts.mono : fonts.sans;
      cache.set(key, (ctx.measureText(String(s)).width * px) / size);
    }
    return cache.get(key);
  };
  return { measure, size };
}

/** Lays a diagram out with ELK and draws it (src/fmc.js `render`): `{ svg, model, ms }`. */
export function render(diagram, options = {}) {
  elk = elk || new ELK();
  return renderWith(diagram, { elk, ...options });
}

/** A customer's stack (src/stack.js `stackView`) drawn: `{ svg, model, ms }`. */
export function drawStack(view, options = {}) {
  return render(stackDiagram(view, options), { focusable: true, ...options });
}

export { stackDiagram };
