#!/usr/bin/env node
// One-off recovery: rebuild clean monthly digest files from the polluted
// archive (the 09-30 writeDay bug appended day bodies without '## date'
// headers and re-appended whole batches on every run).
//
// Parsing rules (learned from the archive):
// - Blocks are delimited by 'feed: <stamp>' lines; stamp = feed snapshot.
// - A block sitting under a '## YYYY-MM-DD' header belongs to that day
//   regardless of stamp (some refreshes rewrote section bodies in place).
// - Blocks after the LAST header are stray backfill output. Within one run's
//   batch (same stamp, file order) blocks map to consecutive window days:
//     * batch of 14          -> full window, block i = stampDate-13+i
//     * shorter, but the other language's same-stamp batch has 14
//                            -> that language died mid-window (prefix)
//     * otherwise            -> genuine missing-day backfill (suffix:
//                               block i = stampDate-(len-1)+i)
// - Day edition = best header-anchored block (non-fallback, then latest
//   stamp, then latest position); if none, best batch-mapped block.
import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_DIR = join(root, 'digests');
const dayHeaderRe = /^## (\d{4}-\d{2}-\d{2})\s*$/;
const feedRe = /^feed:\s*(.+?)\s*$/;
const h1Re = /^# (?:AI Builders Digest|Ai News)/;
const isFallback = (b) => /^keywords: 自动简报/m.test(b.body);

function tokenize(text) {
  const lines = text.split('\n');
  const headers = []; // { lineIdx, day }
  const blocks = []; // { startLine, stamp, body } in file order
  let buf = [];
  let bufStart = null;
  const flush = (feedLineIdx, stamp) => {
    const body = buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
    if (body) blocks.push({ startLine: bufStart, endLine: (feedLineIdx ?? lines.length) - 1, stamp, body });
    buf = [];
    bufStart = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const f = lines[i].match(feedRe);
    if (f) {
      flush(i, f[1]);
      continue;
    }
    const h = lines[i].match(dayHeaderRe);
    if (h) {
      flush(null, null); // header lines are block boundaries, not content
      headers.push({ lineIdx: i, day: h[1] });
      continue;
    }
    if (h1Re.test(lines[i])) continue;
    if (bufStart === null) bufStart = i;
    buf.push(lines[i]);
  }
  flush(null, null);
  return { headers, blocks };
}

function parseLang(text) {
  const { headers, blocks } = tokenize(text);
  const lastHeaderIdx = headers.length ? headers[headers.length - 1].lineIdx : -1;
  const anchored = new Map(); // day -> [block]
  const stray = []; // blocks after the last header
  for (const b of blocks) {
    if (b.startLine < lastHeaderIdx) {
      const h = [...headers].reverse().find((x) => x.lineIdx < b.startLine);
      if (!h) continue;
      if (!anchored.has(h.day)) anchored.set(h.day, []);
      anchored.get(h.day).push(b);
    } else {
      stray.push(b);
    }
  }
  return { anchored, stray };
}

function addDays(map, day, block) {
  if (!map.has(day)) map.set(day, []);
  map.get(day).push(block);
}

// Map stray blocks to their real days, using batch structure per stamp.
function mapStray(strayByLang, stampLensByLang) {
  const mapped = { zh: new Map(), en: new Map() };
  for (const lang of ['zh', 'en']) {
    // group stray blocks by exact stamp, preserving file order
    const groups = new Map();
    for (const b of strayByLang[lang]) {
      if (!b.stamp) continue;
      if (!groups.has(b.stamp)) groups.set(b.stamp, []);
      groups.get(b.stamp).push(b);
    }
    for (const [stamp, group] of groups) {
      const stampDate = stamp.slice(0, 10);
      const end = new Date(stampDate + 'T00:00:00Z').getTime();
      let startOffset;
      if (group.length === 14) startOffset = -13;
      else if ((stampLensByLang[lang === 'zh' ? 'en' : 'zh'].get(stamp) || 0) === 14) startOffset = -13; // died mid-window
      else startOffset = -(group.length - 1); // missing-day backfill, contiguous suffix
      group.forEach((b, i) => {
        const day = new Date(end + (startOffset + i) * 86400000).toISOString().slice(0, 10);
        addDays(mapped[lang], day, b);
      });
    }
  }
  return mapped;
}

function pickAmong(day, cands) {
  if (!cands || !cands.length) return null;
  const dayTs = new Date(day + 'T00:00:00Z').getTime();
  const dist = (b) => Math.abs(new Date((b.stamp || '').slice(0, 10) + 'T00:00:00Z').getTime() - dayTs);
  const sameDate = cands.filter((b) => (b.stamp || '').slice(0, 10) === day);
  // tier 1: blocks from runs ON that day (authentic slot), LLM first;
  // tier 2: the rest, stamp date nearest the day first (originals beat
  // far-off-date re-renders), fallback beats nothing
  for (const pool of [sameDate, cands]) {
    const good = pool.filter((b) => !isFallback(b) && /^keywords:/m.test(b.body));
    const src = (good.length ? good : pool).slice();
    if (!src.length) continue;
    src.sort((a, b) => dist(a) - dist(b) || (b.stamp || '').localeCompare(a.stamp || ''));
    return src[0];
  }
  return null;
}

const raw = {};
const strayByLang = {};
const stampLensByLang = {};
for (const lang of ['zh', 'en']) {
  raw[lang] = { anchored: new Map(), stray: [] };
  for (const month of ['2026-09', '2026-10']) {
    let text;
    try {
      text = await readFile(join(DIGEST_DIR, `${month}.${lang}.md`), 'utf-8');
    } catch {
      continue;
    }
    const { anchored, stray } = parseLang(text);
    for (const [day, blocks] of anchored) addDays(raw[lang].anchored, day, ...blocks);
    raw[lang].stray.push(...stray);
  }
  strayByLang[lang] = raw[lang].stray;
  stampLensByLang[lang] = new Map();
  for (const b of strayByLang[lang]) {
    if (!b.stamp) continue;
    stampLensByLang[lang].set(b.stamp, (stampLensByLang[lang].get(b.stamp) || 0) + 1);
  }
}
const mapped = mapStray(strayByLang, stampLensByLang);

const allDays = [
  ...new Set([...raw.zh.anchored.keys(), ...raw.en.anchored.keys(), ...mapped.zh.keys(), ...mapped.en.keys()]),
].sort();

const files = new Map();
const report = [];
for (const day of allDays) {
  for (const lang of ['zh', 'en']) {
    const anchored = raw[lang].anchored.get(day) || [];
    const strayCands = mapped[lang].get(day) || [];
    const best = pickAmong(day, anchored) || pickAmong(day, strayCands);
    if (!best) {
      report.push(`${day} ${lang}: MISSING`);
      continue;
    }
    const file = `${day.slice(0, 7)}.${lang}.md`;
    const section = `## ${day}\n\n${best.body}\n\nfeed: ${best.stamp}\n`;
    files.set(file, (files.get(file) || `# AI Builders Digest — ${day.slice(0, 7)}\n`) + '\n' + section);
    const src = pickAmong(day, anchored) === best ? 'anchored' : 'stray-mapped';
    const hl = (best.body.match(/^headline:\s*(.+)\s*$/m) || [])[1] || '(no headline)';
    report.push(`${day} ${lang}: ${isFallback(best) ? 'FALLBACK' : 'llm'} stamp=${best.stamp || '(original)'} [${src}: a=${anchored.length} s=${strayCands.length}] ${hl.slice(0, 50)}`);
  }
}

for (const [file, content] of files) {
  await writeFile(join(DIGEST_DIR, file), content.trimEnd() + '\n', 'utf-8');
}
console.log(report.join('\n'));
console.log('---\nwritten:', [...files.keys()].join(', '));
