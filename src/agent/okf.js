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
 * The Open Knowledge Format (OKF v0.2) as the knowledge bases use it: a directory of markdown
 * concepts with YAML frontmatter (`type` required), `index.md` per directory and `log.md` at
 * the root. Agents write concepts; the index and the log are written by code, so they are
 * always complete and never contradict the files.
 */

import { checkDot, dotInfo, isDiagram } from '../dot.js';
import { checkStack, STACK_PATH } from '../stack.js';

export const OKF_VERSION = '0.2';
export const RESERVED = new Set(['index.md', 'log.md']);

/**
 * Where the concepts of each type go, the same in every knowledge base, so that agents, people
 * and the inbox (src/kbpeople.js) find a concept by its type (docs/ARCHITECTURE.md, "Layout").
 * `org`: about one customer, so never in a team's. The agents' prompt lists them
 * (src/agent/tools.js), and their writes are held to them (`checkLayout`); other types go
 * anywhere, people's edits too.
 */
export const LAYOUT = [
  {
    type: 'Customer', dir: 'customer', org: true, what: 'who the customer is: business, brands and business units, contract, how they work with Adobe',
  },
  { type: 'Contact', dir: 'contacts', what: 'one person (below)' },
  {
    type: 'Site', dir: 'sites', org: true, what: 'one site or app: domains, repositories, CDN, environments',
  },
  { type: 'Tech Stack', dir: 'tech-stack', what: 'a platform, integration or tool in use, and how it is set up' },
  {
    type: 'Project', dir: 'projects', org: true, what: 'a migration, launch or other piece of work with a goal and dates',
  },
  { type: 'Known Issue', dir: 'issues', what: 'a problem that recurs: symptoms, cause, fix or workaround' },
  { type: 'Incident', dir: 'incidents', what: 'one outage or escalation: timeline, impact, resolution' },
  { type: 'Decision', dir: 'decisions', what: 'something agreed: what, who agreed, when and why' },
  { type: 'Playbook', dir: 'playbooks', what: 'the steps of a recurring task' },
  { type: 'Product Area', dir: 'product-areas', what: 'a part of an Adobe product: how it works, its limits, who owns it' },
  { type: 'Reference', dir: 'reference', what: 'anything else worth looking up: links, terms, facts' },
];

/** The directory of the people, one Contact concept per person. */
export const CONTACTS = 'contacts';

/**
 * The file name a person's Contact has, from their name: `Dana Ops` and `Ops, Dana` are
 * `dana-ops`, accents and what is in parentheses left out. Empty when nothing is left.
 */
export function personSlug(name) {
  let s = String(name || '').replace(/\([^)]*\)|<[^>]*>/g, ' ').trim();
  // Teams' `Last, First` (one comma, no more words after it than a first name has).
  const flip = /^([^,]+),\s*([^,]+)$/.exec(s);
  if (flip && flip[2].trim().split(/\s+/).length <= 2) {
    s = `${flip[2]} ${flip[1]}`;
  }
  return s.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[łŀ]/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** The frontmatter block and the body, or null when there is none. */
export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!m) {
    return null;
  }
  return { yaml: m[1], body: String(text).slice(m[0].length) };
}

/**
 * `systemprompt.md` at the root of a knowledge base: instructions that the agents of every
 * thread it applies to get appended to their system prompt. It is a concept of type
 * `System Prompt`, so the bundle stays conformant, but only the admin team writes it.
 */
export const SYSTEM_PROMPT = 'systemprompt.md';
export const SYSTEM_PROMPT_TYPE = 'System Prompt';

/**
 * Whether a file of a knowledge base is one of its entries: what the agents and people filed,
 * not the index, the log or the system prompt. The editor ranks knowledge bases by them.
 */
export const isEntry = (path) => path !== SYSTEM_PROMPT && !RESERVED.has(String(path).split('/').pop());

/** A system prompt with frontmatter, as a concept; text without frontmatter gets some. */
export function asSystemPrompt(content, title = 'Agent instructions') {
  const text = String(content || '');
  if (splitFrontmatter(text)) {
    return text;
  }
  return `---\ntype: ${SYSTEM_PROMPT_TYPE}\ntitle: ${title}\ndescription: Instructions appended to the system prompt of the agents that use this knowledge base.\n---\n\n${text.replace(/^\n+/, '')}`;
}

/** The instructions of a system prompt file: its body, without frontmatter or comments. */
export function systemPromptBody(content) {
  const fm = splitFrontmatter(content);
  return (fm ? fm.body : String(content || '')).replace(/<!--[\s\S]*?-->/g, '').trim();
}
const MAX_FILE = 64 * 1024;

const unquote = (v) => {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return s;
};

/** A top-level scalar of the frontmatter (no YAML library: these keys are one line each). */
export function scalar(yaml, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(yaml);
  if (!m || !m[1].trim() || /^[|>]/.test(m[1].trim())) {
    return null;
  }
  return unquote(m[1].replace(/\s+#.*$/, ''));
}

/**
 * A top-level list of strings of the frontmatter, `key: [a, "b"]` or a block of `- a` lines
 * (or one scalar, as a list of one); empty when it has none.
 */
export function strings(yaml, key) {
  const lines = String(yaml).split(/\r?\n/);
  const at = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (at < 0) {
    return [];
  }
  const rest = lines[at].slice(key.length + 1).replace(/\s+#.*$/, '').trim();
  if (rest.startsWith('[')) {
    return rest.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  }
  if (rest) {
    return [unquote(rest)].filter(Boolean);
  }
  const out = [];
  for (let i = at + 1; i < lines.length && /^[ \t]+-[ \t]/.test(lines[i]); i += 1) {
    out.push(unquote(lines[i].replace(/^[ \t]+-[ \t]+/, '').replace(/\s+#.*$/, '')));
  }
  return out.filter(Boolean);
}

const ROSTERS = new Set(['people', 'contacts', 'team', 'teams', 'staff', 'roster', 'stakeholders', 'who-is-who', 'adobe', 'customer']);

/**
 * Why an agent's concept is not where its type goes (`LAYOUT`), or null. `kind`: the
 * knowledge base's, `org` or `team`. A Contact is one person, at `contacts/<personSlug>.md`.
 */
export function checkLayout(path, content, kind) {
  const fm = splitFrontmatter(content);
  const type = fm && scalar(fm.yaml, 'type');
  const row = type && LAYOUT.find((r) => r.type.toLowerCase() === type.trim().toLowerCase());
  if (!row) {
    return null;
  }
  if (row.type !== type) {
    return `the type is spelled "${row.type}"`;
  }
  if (row.org && kind === 'team') {
    return `a ${row.type} is about one customer: it goes to kb-org, not to a team's knowledge base`;
  }
  const p = String(path);
  if (!p.startsWith(`${row.dir}/`)) {
    return `${/^[AEIOU]/.test(row.type) ? 'an' : 'a'} ${row.type} goes in ${row.dir}/ (${p.split('/').pop()} there); move it, and fix the links to it you know of`;
  }
  if (row.type === 'Contact') {
    const name = p.slice(row.dir.length + 1).replace(/\.md$/, '');
    const slug = personSlug(scalar(fm.yaml, 'title'));
    // A list of people, whatever its file is called: "Customer contacts", "ACME people".
    const title = scalar(fm.yaml, 'title') || '';
    const many = /\b(contacts|people|roster|stakeholders|team)\b/i.exec(title.replace(/\([^)]*\)/g, ''));
    if (ROSTERS.has(name) || !slug || many) {
      const why = many ? ` (its title says "${many[1]}": a role or company goes in the description, or in parentheses after the name)` : '';
      return `a Contact is one person, with their full name as its title: one file per person (${CONTACTS}/dana-ops.md for "Dana Ops"), never a list of people in one file${why}`;
    }
    if (name !== slug) {
      return `a Contact's file is named after its title: ${CONTACTS}/${slug}.md`;
    }
  }
  return null;
}

/**
 * Why a file of a knowledge base is not acceptable, or null: a concept (`.md`, with
 * frontmatter) or a diagram (`.dot`, src/dot.js). Paths are bundle-relative and never the
 * reserved files, which code writes.
 */
export function checkConcept(path, content) {
  const p = String(path || '');
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.(md|dot)$/.test(p)) {
    return 'paths are lowercase, relative, end in .md (a concept) or .dot (a diagram), and use only a-z, 0-9, ".", "_" and "-"';
  }
  if (isDiagram(p)) {
    const why = checkDot(content);
    return why ? `not a diagram the inbox can draw: ${why}` : null;
  }
  if (RESERVED.has(p.split('/').pop())) {
    return `${p.split('/').pop()} is maintained automatically; write concept files only`;
  }
  if (content.length > MAX_FILE) {
    return `a concept is at most ${MAX_FILE / 1024} KB; split it`;
  }
  const fm = splitFrontmatter(content);
  if (!fm) {
    return 'a concept starts with YAML frontmatter between --- lines';
  }
  if (!scalar(fm.yaml, 'type')) {
    return 'the frontmatter needs a non-empty `type`';
  }
  // The stack drawing (src/stack.js) is one the inbox can always draw.
  if (p === STACK_PATH) {
    const why = checkStack(fm.body);
    if (why) {
      return `not a stack drawing: ${why}`;
    }
  }
  return null;
}

/**
 * Sets `generated: { by, at }` in a concept's frontmatter (OKF §5.2), replacing any earlier
 * value, so every write records who wrote it and when.
 */
export function stampGenerated(content, by, at) {
  const fm = splitFrontmatter(content);
  const lines = fm.yaml.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^generated:/.test(lines[i])) {
      // Skip an indented block mapping that belongs to it.
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        i += 1;
      }
    } else {
      out.push(lines[i]);
    }
  }
  out.push(`generated: { by: ${by}, at: ${at} }`);
  return `---\n${out.join('\n')}\n---\n${fm.body}`;
}

const titleOf = (path, yaml) => scalar(yaml, 'title')
  || path.split('/').pop().replace(/\.md$/, '').replace(/[-_]+/g, ' ');

/**
 * `index.md` for one directory (OKF §8): its concepts and subdirectories, with the concepts'
 * titles and descriptions, and its diagrams. `entries` are `{ name, dir?, yaml?, dot? }`, `dot`
 * a diagram's `{ title, description }` (src/dot.js `dotInfo`).
 */
export function renderIndex(dirPath, entries, { root = false } = {}) {
  const concepts = entries.filter((e) => !e.dir).sort((a, b) => a.name.localeCompare(b.name));
  const dirs = entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  if (root) {
    lines.push('---', `okf_version: "${OKF_VERSION}"`, '---', '');
  }
  lines.push(`# ${dirPath ? dirPath.split('/').pop() : 'Knowledge base'}`, '');
  for (const c of concepts) {
    const yaml = c.yaml || '';
    const desc = scalar(yaml, 'description');
    const type = scalar(yaml, 'type');
    if (c.dot) {
      lines.push(`* [${c.dot.title}](${c.name}) (Diagram)${c.dot.description ? ` - ${c.dot.description}` : ''}`);
    } else {
      lines.push(`* [${titleOf(c.name, yaml)}](${c.name})${type ? ` (${type})` : ''}${desc ? ` - ${desc}` : ''}`);
    }
  }
  if (dirs.length) {
    if (concepts.length) {
      lines.push('');
    }
    lines.push('# Directories', '');
    for (const d of dirs) {
      lines.push(`* [${d.name}](${d.name}/)${d.count ? ` - ${d.count} concept${d.count === 1 ? '' : 's'}` : ''}`);
    }
  }
  if (!concepts.length && !dirs.length) {
    lines.push('Nothing here yet.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * `log.md` with one more entry (OKF §9): date headings, newest first, one bullet per change.
 */
export function addLogEntry(existing, date, entry) {
  const heading = `## ${date}`;
  const text = String(existing || '').trim() ? String(existing) : '# Update log\n';
  const lines = text.replace(/\s+$/, '').split('\n');
  const bullet = `* ${entry}`;
  const at = lines.indexOf(heading);
  if (at >= 0) {
    lines.splice(at + 1, 0, bullet);
  } else {
    const first = lines.findIndex((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
    const block = [heading, bullet, ''];
    if (first >= 0) {
      lines.splice(first, 0, ...block);
    } else {
      lines.push('', ...block);
    }
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

export { dotInfo, isDiagram };
