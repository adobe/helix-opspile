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

export const OKF_VERSION = '0.2';
export const RESERVED = new Set(['index.md', 'log.md']);
const MAX_FILE = 64 * 1024;

/** The frontmatter block and the body, or null when there is none. */
export function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!m) {
    return null;
  }
  return { yaml: m[1], body: String(text).slice(m[0].length) };
}

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
 * Why a concept file is not acceptable, or null. Paths are bundle-relative, markdown only,
 * and never the reserved files, which code writes.
 */
export function checkConcept(path, content) {
  const p = String(path || '');
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/.test(p)) {
    return 'paths are lowercase, relative, end in .md, and use only a-z, 0-9, ".", "_" and "-"';
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
 * titles and descriptions. `entries` are `{ name, dir?, yaml? }`.
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
    lines.push(`* [${titleOf(c.name, yaml)}](${c.name})${type ? ` (${type})` : ''}${desc ? ` - ${desc}` : ''}`);
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
