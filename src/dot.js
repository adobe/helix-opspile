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
 * Diagrams in the knowledge bases: `.dot` files, Graphviz DOT with the FMC attributes the inbox's
 * renderer reads (src/fmc.js: `fmc` on nodes and clusters, `request` on channels). People write
 * them in the editor, which draws them as they type, and agents with kb_write.
 *
 * Graphviz cannot run in a Worker (it is WebAssembly compiled from bytes, which Workers refuse),
 * so a write is checked here instead: the DOT grammar (https://graphviz.org/doc/info/lang.html),
 * the edge operator of the graph's kind, the FMC kinds, and the size. What it says in a diagram
 * is Graphviz's to lay out: a file that passes is drawn, or the editor shows Graphviz's error.
 *
 * A diagram says what it is like a concept does, in DOT: its title is the graph's `label` (else
 * its file name), its description the `//` comment it starts with. The index lists it so.
 */

export const DOT_EXT = '.dot';
export const MAX_DOT = 64 * 1024;
export const MAX_DOT_NODES = 400;

/** The FMC kinds of nodes and of clusters (src/fmc.js). */
export const NODE_KINDS = ['agent', 'storage', 'channel', 'person', 'dots', 'invis', 'wall', 'caption'];
export const CLUSTER_KINDS = ['group', 'agent', 'storage', 'set', 'ushape'];
const REQUEST = /^(true|false|yes|no|1|0|back)$/i;
const KEYWORDS = new Set(['strict', 'graph', 'digraph', 'node', 'edge', 'subgraph']);

export const isDiagram = (path) => String(path || '').endsWith(DOT_EXT);

class DotError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
  }
}

/** The tokens of `text`: `{ t: 'id'|'str'|'html'|'edge'|'p', v, line, quoted }`. */
function tokens(text) {
  const out = [];
  let i = 0;
  let line = 1;
  const s = String(text);
  const n = s.length;
  const startOfLine = (k) => k === 0 || s[k - 1] === '\n';
  while (i < n) {
    const c = s[i];
    if (c === '\n') {
      line += 1;
      i += 1;
    } else if (/\s/.test(c)) {
      i += 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < n && s[i] !== '\n') {
        i += 1;
      }
    } else if (c === '#' && startOfLine(i)) {
      while (i < n && s[i] !== '\n') {
        i += 1;
      }
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      if (end < 0) {
        throw new DotError(line, 'a /* comment is not closed');
      }
      line += (s.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
    } else if (c === '"') {
      const at = line;
      let v = '';
      i += 1;
      while (i < n && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < n) {
          v += s[i + 1] === '"' ? '"' : `\\${s[i + 1]}`;
          if (s[i + 1] === '\n') {
            line += 1;
          }
          i += 2;
        } else {
          if (s[i] === '\n') {
            line += 1;
          }
          v += s[i];
          i += 1;
        }
      }
      if (i >= n) {
        throw new DotError(at, 'a "string" is not closed');
      }
      i += 1;
      out.push({
        t: 'id', v, line: at, quoted: true,
      });
    } else if (c === '<') {
      const at = line;
      let depth = 0;
      let k = i;
      for (; k < n; k += 1) {
        if (s[k] === '<') {
          depth += 1;
        } else if (s[k] === '>') {
          depth -= 1;
          if (!depth) {
            break;
          }
        } else if (s[k] === '\n') {
          line += 1;
        }
      }
      if (k >= n) {
        throw new DotError(at, 'an <html> label is not closed');
      }
      out.push({
        t: 'id', v: s.slice(i + 1, k), line: at, quoted: true,
      });
      i = k + 1;
    } else if ((c === '-' && (s[i + 1] === '>' || s[i + 1] === '-'))) {
      out.push({ t: 'edge', v: s.slice(i, i + 2), line });
      i += 2;
    } else if ('{}[];,=:'.includes(c)) {
      out.push({ t: 'p', v: c, line });
      i += 1;
    } else {
      const m = /^(?:-?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)|[A-Za-z_\u0080-\uffff][A-Za-z_0-9\u0080-\uffff]*)/.exec(s.slice(i, i + 200));
      if (!m) {
        throw new DotError(line, `unexpected "${c}"`);
      }
      out.push({ t: 'id', v: m[0], line });
      i += m[0].length;
    }
  }
  return out;
}

/** The leading `//` comment of `text`, one line: the diagram's description. */
function leadingComment(text) {
  const lines = [];
  for (const l of String(text).split(/\r?\n/)) {
    const m = /^\s*\/\/\s?(.*)$/.exec(l);
    if (!m) {
      break;
    }
    lines.push(m[1].trim());
  }
  return lines.join(' ').trim();
}

/**
 * The diagram in `text`, read: `{ directed, name, label, description, nodes, edges, clusters }`
 * (counts), or throws a DotError saying what is wrong and where.
 */
function read(text) {
  const toks = tokens(text);
  let k = 0;
  const peek = () => toks[k];
  const kw = (tok, w) => tok && tok.t === 'id' && !tok.quoted && tok.v.toLowerCase() === w;
  const last = () => (toks.length ? toks[toks.length - 1].line : 1);
  const expect = (v) => {
    const tok = toks[k];
    if (!tok || tok.v !== v || tok.quoted) {
      throw new DotError(tok ? tok.line : last(), `expected "${v}"${tok ? ` before "${tok.v}"` : ' at the end'}`);
    }
    k += 1;
    return tok;
  };
  const id = (what) => {
    const tok = toks[k];
    if (!tok || tok.t !== 'id') {
      throw new DotError(tok ? tok.line : last(), `expected ${what}${tok ? ` before "${tok.v}"` : ' at the end'}`);
    }
    k += 1;
    return tok;
  };
  const nodes = new Set();
  const out = {
    directed: false, name: '', label: '', nodes: 0, edges: 0, clusters: 0,
  };
  const checkAttr = (name, value, where, line) => {
    const v = String(value).toLowerCase();
    if (name === 'fmc') {
      const kinds = where === 'cluster' ? CLUSTER_KINDS : NODE_KINDS;
      if (where !== 'graph' && !kinds.includes(v)) {
        throw new DotError(line, `fmc on a ${where === 'cluster' ? 'subgraph' : 'node'} is one of ${kinds.join(', ')}, not "${value}"`);
      }
    }
    if (name === 'request' && !REQUEST.test(v)) {
      throw new DotError(line, `request is true, back or false, not "${value}"`);
    }
  };
  const attrList = (where) => {
    const attrs = {};
    while (peek() && peek().v === '[' && !peek().quoted) {
      k += 1;
      while (peek() && !(peek().v === ']' && !peek().quoted)) {
        const a = id('an attribute name');
        expect('=');
        const v = id(`a value for ${a.v}`);
        checkAttr(a.v, v.v, where, a.line);
        attrs[a.v] = v.v;
        if (peek() && (peek().v === ',' || peek().v === ';') && !peek().quoted) {
          k += 1;
        }
      }
      expect(']');
    }
    return attrs;
  };
  // A statement list, in the graph or a subgraph (`cluster`: whether it is a cluster's).
  let stmts;
  const subgraph = () => {
    let cluster = false;
    if (kw(peek(), 'subgraph')) {
      k += 1;
      if (peek() && peek().t === 'id') {
        cluster = /^cluster/.test(peek().v);
        k += 1;
      }
    }
    if (cluster) {
      out.clusters += 1;
    }
    expect('{');
    stmts(cluster ? 'cluster' : 'subgraph');
    expect('}');
  };
  const isSubgraph = () => kw(peek(), 'subgraph') || (peek() && peek().v === '{' && !peek().quoted);
  const nodeId = () => {
    const tok = id('a node');
    if (KEYWORDS.has(tok.v.toLowerCase()) && !tok.quoted) {
      throw new DotError(tok.line, `"${tok.v}" is a keyword of DOT: quote it to use it as a name`);
    }
    if (peek() && peek().v === ':' && !peek().quoted) {
      k += 1;
      id('a port');
      if (peek() && peek().v === ':' && !peek().quoted) {
        k += 1;
        id('a compass point');
      }
    }
    nodes.add(tok.v);
    return tok;
  };
  stmts = (where) => {
    while (peek() && !(peek().v === '}' && !peek().quoted)) {
      const tok = peek();
      if (kw(tok, 'graph') || kw(tok, 'node') || kw(tok, 'edge')) {
        k += 1;
        const which = tok.v.toLowerCase();
        let scope = which;
        if (which === 'graph') {
          scope = where === 'cluster' ? 'cluster' : 'graph';
        }
        const attrs = attrList(scope);
        if (which === 'graph' && where === 'graph' && attrs.label != null) {
          out.label = attrs.label;
        }
      } else if (tok.t === 'id' && toks[k + 1] && toks[k + 1].v === '=' && !toks[k + 1].quoted) {
        k += 2;
        const v = id(`a value for ${tok.v}`);
        checkAttr(tok.v, v.v, where === 'cluster' ? 'cluster' : 'graph', tok.line);
        if (where === 'graph' && tok.v === 'label') {
          out.label = v.v;
        }
      } else {
        // A node or an edge statement, from a node or a subgraph.
        if (isSubgraph()) {
          subgraph();
        } else {
          nodeId();
        }
        let edges = 0;
        while (peek() && peek().t === 'edge') {
          const op = peek();
          if ((op.v === '->') !== out.directed) {
            throw new DotError(op.line, `a ${out.directed ? 'digraph' : 'graph'} joins nodes with ${out.directed ? '->' : '--'}, not ${op.v}`);
          }
          k += 1;
          if (isSubgraph()) {
            subgraph();
          } else {
            nodeId();
          }
          edges += 1;
        }
        out.edges += edges;
        attrList(edges ? 'edge' : 'node');
      }
      if (peek() && peek().v === ';' && !peek().quoted) {
        k += 1;
      }
    }
  };
  if (kw(peek(), 'strict')) {
    k += 1;
  }
  const head = peek();
  if (!(kw(head, 'graph') || kw(head, 'digraph'))) {
    throw new DotError(head ? head.line : 1, 'a diagram starts with digraph (edges ->) or graph (edges --), then its name and {');
  }
  out.directed = kw(head, 'digraph');
  k += 1;
  if (peek() && peek().t === 'id') {
    out.name = id('a name').v;
  }
  expect('{');
  stmts('graph');
  expect('}');
  if (k < toks.length) {
    throw new DotError(toks[k].line, `nothing may follow the diagram's closing "}" ("${toks[k].v}")`);
  }
  out.nodes = nodes.size;
  if (out.nodes > MAX_DOT_NODES) {
    throw new DotError(1, `a diagram has at most ${MAX_DOT_NODES} nodes: split it`);
  }
  return out;
}

/** Why `text` is not a diagram the inbox can draw, or null. */
export function checkDot(text) {
  const s = String(text ?? '');
  if (s.length > MAX_DOT) {
    return `a diagram is at most ${MAX_DOT / 1024} KB; split it`;
  }
  try {
    read(s);
    return null;
  } catch (e) {
    if (e instanceof DotError) {
      return e.message;
    }
    throw e;
  }
}

/**
 * What the index says of a diagram: `{ title, description }`, from its graph `label` (`\n` made
 * a space) and leading comment; the title falls back to its file name.
 */
export function dotInfo(path, text) {
  let label = '';
  try {
    ({ label } = read(text));
  } catch {
    // An index is written of what is there: a broken diagram is listed by its name.
  }
  const name = String(path).split('/').pop().replace(/\.dot$/, '')
    .replace(/[-_]+/g, ' ');
  return {
    title: String(label || '').replace(/\\[nlr]/g, ' ').replace(/\s+/g, ' ').trim() || name,
    description: leadingComment(text),
  };
}
