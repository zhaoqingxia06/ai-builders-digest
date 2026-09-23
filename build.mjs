#!/usr/bin/env node
// Build the digest site: reads ~/.follow-builders/digests/YYYY-MM-DD.md and
// emits ~/.follow-builders/site/index.html — calendar heatmap on top, all
// digests below, heatmap cells link to each day's article. No dependencies.

import { readdir, readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to this script so the build runs both locally
// (~/.follow-builders/site = repo root) and inside GitHub Actions (repo
// checkout): digests/ and index.html live next to this file.
const scriptDir = dirname(fileURLToPath(import.meta.url)); // repo root
const DIGEST_DIR = join(scriptDir, 'digests');
const OUT = join(scriptDir, 'index.html');

// ---------- markdown-lite renderer (headings / bold / italic / links / hr) ----------

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s) {
  const links = [];
  let out = escapeHtml(s);
  // markdown links -> placeholders first so their URLs are not re-linked
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
    return `\u0001${links.length - 1}\u0001`;
  });
  // bare URLs
  out = out.replace(/(^|[\s（【>（])(https?:\/\/[^\s<）】\u0001]+)/g, (m, pre, url) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    return `${pre}\u0001${links.length - 1}\u0001`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\u0001])\*([^*\n\u0001]+)\*(?!\*)/g, '$1<em>$2</em>');
  // auto-bold impactful numbers (76%, 30¢, 40 亿, 1 亿美元, $100M, 1B+, 4 billion...)
  // never inside link placeholders or manually bolded keywords
  const numRe = /(\d+(?:\.\d+)?)(\s?(?:%|¢|亿美元|亿|万美元|万|倍))/g;
  const numReEn = /(\$\d+(?:\.\d+)?[MB]?|\d+(?:\.\d+)?\s?(?:billion|million)|\d+(?:\.\d+)?[MB]\+)/g;
  out = out
    .split(/(\u0001\d+\u0001|<strong>.*?<\/strong>)/)
    .map((p) => (/^(?:\u0001\d+\u0001|<strong>.*?<\/strong>)$/.test(p)
      ? p
      : p.replace(numRe, '<strong class="num">$1$2</strong>').replace(numReEn, '<strong class="num">$1</strong>')))
    .join('');
  out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]);
  return out;
}

// A bare-URL line becomes a compact "source" chip instead of a raw link paragraph.
const ICON_LINK =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25Zm-4.69 9.64a2 2 0 0 1 0-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83 0Z"></path></svg>';

// Parse the metadata lines at the top of a day's body (keywords / headline /
// deck / quote / quoteBy) and return them with the stripped body.
function parseKeywords(md) {
  const grab = (re) => {
    const m = md.match(re);
    return m ? m[1].trim() : '';
  };
  const meta = {
    kw: grab(/^keywords:\s*(.+)\s*$/m).split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3),
    headline: grab(/^headline:\s*(.+)\s*$/m),
    deck: grab(/^deck:\s*(.+)\s*$/m),
    quote: grab(/^quote:\s*(.+)\s*$/m),
    quoteBy: grab(/^quoteBy:\s*(.+)\s*$/m),
  };
  const body = md.replace(/^(?:keywords|headline|deck|quote|quoteBy):[^\n]*\n?/gm, '').replace(/^\n+/, '');
  return { ...meta, body };
}

function srcChip(url) {
  let label = '原文';
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (/^(x|twitter)\.com$/.test(h)) label = 'X 原文';
    else if (h.includes('youtu')) label = 'YouTube';
    else if (h === 'github.com') label = 'GitHub';
    else label = h;
  } catch {}
  return `<div class="src"><a class="src-link" href="${url}" target="_blank" rel="noopener" title="${url}">${ICON_LINK}<span>${label}</span></a></div>`;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let para = [];
  let list = [];
  let firstH1Skipped = false;
  const flush = () => {
    if (!para.length) return;
    // pure-URL lines (trailing or standalone) become source chips, not text
    const urls = [];
    while (para.length && /^https?:\/\/\S+$/.test(para[para.length - 1])) {
      urls.unshift(para.pop());
    }
    if (para.length) {
      let html = `<p>${inline(para.join(' '))}</p>`;
      // paragraphs led by a short bold label with content after it
      // ("**一句话要点**：..." / "**The takeaway**: ...") become callouts
      if (/^<p><strong>[^<]{2,16}<\/strong>[：:]\S/.test(html)) {
        html = `<p class="callout">${html.slice(3)}`;
      }
      out.push(html);
    }
    out.push(...urls.map(srcChip));
    para = [];
  };
  const flushList = () => {
    if (list.length) {
      out.push(`<ol>${list.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>`);
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); flushList(); continue; }
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flush(); flushList();
      if (m[1].length === 1 && !firstH1Skipped) { firstH1Skipped = true; continue; }
      const h = Math.min(m[1].length + 1, 5);
      out.push(`<h${h}>${inline(m[2])}</h${h}>`);
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flush(); flushList();
      out.push('<hr>');
    } else if (/^>\s?/.test(line)) {
      flush(); flushList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else if (/^\d+\.\s+/.test(line)) {
      flush();
      list.push(line.replace(/^\d+\.\s+/, ''));
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flush();
  flushList();
  return out.join('\n');
}

// ---------- calendar data ----------
// The 7-day sliding window is rendered client-side; we only embed the data.

const fmtKey = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

// ---------- assemble ----------

// Split a monthly digest file into per-day bodies keyed by 'YYYY-MM-DD'.
// Day sections start with a '## YYYY-MM-DD' line; every other '##' line
// (insights, 𝕏/TWITTER, PODCASTS) belongs to the current day's content.
function splitMonthly(md) {
  const days = new Map();
  let cur = null;
  let buf = [];
  const flush = () => {
    if (cur) days.set(cur, buf.join('\n').replace(/^\n+/, '').replace(/\s+$/, ''));
  };
  for (const line of md.split('\n')) {
    const m = line.match(/^## (\d{4}-\d{2}-\d{2})\s*$/);
    if (m) {
      flush();
      cur = m[1];
      buf = [];
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return days;
}

// ---------- avatars ----------

// tracked builder name (lowercase) -> X handle; file avatars/<handle>.jpg|png
const AVATARS = {
  'andrej karpathy': 'karpathy', 'swyx': 'swyx', 'josh woodward': 'joshwoodward',
  'boris cherny': 'bcherny', 'thibault sottiaux': 'thsottiaux', 'peter yang': 'petergyang',
  'nan yu': 'thenanyu', 'madhu guru': 'realmadhuguru', 'amanda askell': 'amandaaskell',
  'cat wu': '_catwu', 'thariq': 'trq212', 'google labs': 'googlelabs',
  'amjad masad': 'amasad', 'guillermo rauch': 'rauchg', 'alex albert': 'alexalbert__',
  'aaron levie': 'levie', 'ryo lu': 'ryolu_', 'garry tan': 'garrytan',
  'matt turck': 'mattturck', 'zara zhang': 'zarazhangrui', 'nikunj kothari': 'nikunj',
  'peter steinberger': 'steipete', 'dan shipper': 'danshipper',
  'aditya agarwal': 'adityaag', 'sam altman': 'sama',
  'claude blog': 'claudeai', 'anthropic engineering': 'anthropicai',
};

async function loadAvatarFiles() {
  const files = new Map(); // handle -> filename with extension
  try {
    for (const f of await readdir(join(scriptDir, 'avatars'))) {
      const m = f.match(/^(.+)\.(jpe?g|png)$/i);
      if (m) files.set(m[1].toLowerCase(), f);
    }
  } catch {}
  return files;
}

// Prepend the author's avatar to paragraphs that start with a bold name.
function injectAvatars(html, avatarFiles) {
  return html.replace(/<p>(<strong>[^<]{1,80}<\/strong>)/g, (m, strong) => {
    const plain = strong.replace(/<[^>]+>/g, '').toLowerCase();
    for (const [name, handle] of Object.entries(AVATARS)) {
      if (plain.includes(name) && avatarFiles.has(handle)) {
        return `<p class="has-avatar"><img class="avatar" src="avatars/${avatarFiles.get(handle)}" alt="" loading="lazy">` + strong;
      }
    }
    return m;
  });
}

// ---------- generative cover art & section icons ----------

// Deterministic editorial SVG "engraving" seeded by the date — halftone dots,
// concentric arcs and a signal wave; every day gets a different plate.
function coverArt(seed) {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  const rnd = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
  const sand = '#c9d6e5', ink = '#2b3440', accent = '#0b5cad';
  let s = '';
  // halftone dot field on the right
  for (let gx = 0; gx < 12; gx++) {
    for (let gy = 0; gy < 8; gy++) {
      const x = 470 + gx * 20 + (gy % 2) * 10;
      const y = 14 + gy * 19;
      const r = 0.7 + 1.9 * Math.abs(Math.sin(gx * 0.7 + gy * 0.5 + rnd() * 2));
      s += `<circle cx="${x}" cy="${y}" r="${r.toFixed(2)}" fill="${sand}"/>`;
    }
  }
  // concentric arcs, bottom-left
  const cx = 60 + rnd() * 30, cy = 150;
  for (let r = 26; r <= 110; r += 14) {
    s += `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r}" fill="none" stroke="${ink}" stroke-width="1" opacity="${(0.5 - r / 400).toFixed(2)}"/>`;
  }
  // signal wave across the middle
  const pts = [];
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const x = 30 + i * ((560 - 40) / n);
    const y = 55 + Math.sin(i * (1.2 + rnd()) + rnd() * 6) * (18 + rnd() * 14);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  s += `<polyline points="${pts.join(' ')}" fill="none" stroke="${accent}" stroke-width="2"/>`;
  // sparks
  for (let i = 0; i < 3; i++) {
    s += `<circle cx="${(90 + rnd() * 480).toFixed(1)}" cy="${(20 + rnd() * 120).toFixed(1)}" r="${(2.2 + rnd() * 2.4).toFixed(1)}" fill="${accent}"/>`;
  }
  // one thin outline ring for air
  s += `<circle cx="${(430 + rnd() * 60).toFixed(1)}" cy="${(40 + rnd() * 60).toFixed(1)}" r="${(16 + rnd() * 14).toFixed(1)}" fill="none" stroke="${ink}" stroke-width="1" opacity="0.35"/>`;
  return `<svg viewBox="0 0 720 170" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${s}</svg>`;
}

const H3_ICONS = {
  insight: '<svg class="h3-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/></svg>',
  x: '<svg class="h3-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 2.5l11 11M13.5 2.5l-11 11"/></svg>',
  blog: '<svg class="h3-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="1.8" width="10" height="12.4" rx="1"/><path d="M5.5 5h5M5.5 8h5M5.5 11h3"/></svg>',
  pod: '<svg class="h3-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5.8" y="1.8" width="4.4" height="7" rx="2.2"/><path d="M3.2 7.5a4.8 4.8 0 0 0 9.6 0M8 12.2v2M5.8 14.2h4.4"/></svg>',
};

// Swap the emoji-lead section h3s for icon + tracked-spacing labels.
function decorateH3(html) {
  return html.replace(/<h3>([^<]*)<\/h3>/g, (m, t) => {
    const txt = t.trim();
    if (txt.startsWith('🧭')) return `<h3 class="ins-h">${H3_ICONS.insight}<span>${txt.replace(/^🧭\s*/, '')}</span></h3>`;
    if (txt.startsWith('𝕏')) return `<h3>${H3_ICONS.x}<span>${txt.replace(/^𝕏\s*\/?\s*/, '')}</span></h3>`;
    if (txt.startsWith('🎙')) return `<h3>${H3_ICONS.pod}<span>${txt.replace(/^🎙\s*/, '')}</span></h3>`;
    if (txt.startsWith('📰')) return `<h3>${H3_ICONS.blog}<span>${txt.replace(/^📰\s*/, '')}</span></h3>`;
    return m;
  });
}

async function main() {
  // digests are stored monthly: YYYY-MM.zh.md / YYYY-MM.en.md, one
  // '## YYYY-MM-DD' section per day — fewer files than per-day storage.
  const byDate = new Map();
  for (const f of await readdir(DIGEST_DIR)) {
    const m = f.match(/^(\d{4}-\d{2})\.(zh|en)\.md$/);
    if (!m) continue;
    const md = await readFile(join(DIGEST_DIR, f), 'utf-8');
    for (const [day, body] of splitMonthly(md)) {
      const rec = byDate.get(day) || {};
      rec[m[2]] = { md: body, bytes: Buffer.byteLength(body, 'utf-8') };
      byDate.set(day, rec);
    }
  }
  const entries = [...byDate.entries()]
    .map(([key, langs]) => ({ key, ...langs }))
    .sort((a, b) => b.key.localeCompare(a.key)); // newest first

  const dates = new Map(entries.map((e) => [e.key, e.zh?.bytes || e.en?.bytes || 0]));
  // NOTE: "today" must be computed in local time — UTC would mislabel the cell
  // for anything east of Greenwich before 08:00 local.
  const now = new Date();
  const todayKey = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const datesJson = JSON.stringify(Object.fromEntries(dates));
  const latestKey = entries[0]?.key || '';

  const kwChips = (md) => parseKeywords(md).kw.map((k) => `<span class="kw">#${escapeHtml(k)}</span>`).join('');
  const avatarFiles = await loadAvatarFiles();
  const langDiv = (l, rec) => {
    if (!rec) return '';
    const { kw, headline, deck, quote, quoteBy, body } = parseKeywords(rec.md);
    const langZh = l === 'zh';
    const title = headline || (langZh ? `${rec.key} 简报` : `Briefing · ${rec.key}`);
    const kicker = langZh ? '封面报道 · COVER STORY' : 'COVER STORY';
    const plain = body.replace(/https?:\/\/\S+/g, '').replace(/\s/g, '');
    const minutes = Math.max(1, Math.round(plain.length / 600));
    const readTime = langZh ? `阅读约 ${minutes} 分钟` : `A ${minutes}-min read`;
    const storyHead = `
      <div class="story-head">
        <div class="story-kicker">${kicker}</div>
        <h1 class="story-title">${escapeHtml(title)}</h1>
        ${deck ? `<div class="story-deck">${escapeHtml(deck)}</div>` : ''}
        <div class="story-meta">${readTime} · Follow Builders</div>
      </div>
      <div class="story-art">${coverArt(rec.key + l)}</div>`;
    const kwRow = `<div class="kw-row">${kw.map((k) => `<span class="kw">#${escapeHtml(k)}</span>`).join('')}</div>`;
    let html = `${storyHead}${kwRow}${injectAvatars(mdToHtml(body), avatarFiles)}`;
    html = decorateH3(html);
    if (quote) {
      const pq = `<aside class="pullquote"><span class="pq-mark">「</span><div class="pq-text">${escapeHtml(quote)}</div>${quoteBy ? `<div class="pq-by">${escapeHtml(quoteBy)}</div>` : ''}</aside>`;
      const start = html.indexOf('<p class="callout">');
      if (start > -1) {
        const end = html.indexOf('</p>', start) + 4;
        html = html.slice(0, end) + pq + html.slice(end);
      } else {
        html = pq + html;
      }
    }
    return `<div class="lang lang-${l}">${html}</div>`;
  };

  // "today's hot topics" chips were removed from the page head by user request;
  // parseKeywords still feeds the per-article chip rows.
  const articles = entries.map((e) => `
    <article id="d-${e.key}" class="day ${e.en ? '' : 'no-en'}${e.zh ? '' : ' no-zh'}">
      ${langDiv('zh', e.zh)}
      ${langDiv('en', e.en)}
      <div class="lang-note">This day has no English version yet — showing the Chinese digest.</div>
      <div class="lang-note note-zh">此日暂无中文版 — 显示英文原版。</div>
    </article>`).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Builders Digest</title>
<style>
  :root {
    --bg: #f7f8fa;      /* near-white page */
    --card: #ffffff;
    --text: #1c1f24;
    --muted: #6f7680;
    --border: #e4e8ee;
    --accent: #0b5cad;  /* newsprint blue */
    --red: #c2312c;     /* brand red, used sparingly */
    --soft: #eef4fa;    /* light blue tint */
    --sans: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--sans);
    font-size: 15.5px; line-height: 1.9;
  }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 26px 20px 90px; }

  /* ---------- masthead ---------- */
  .page-head {
    text-align: center; padding: 10px 0 16px;
    border-bottom: 3px solid var(--accent);
    position: relative;
  }
  .page-head::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -6px;
    height: 1px; background: var(--accent);
  }
  .mast-kicker {
    font-size: 12px; font-weight: 700;
    letter-spacing: 0.34em; text-indent: 0.34em; color: var(--red);
  }
  .page-head h1 {
    margin: 10px 0 8px; font-size: 36px; font-weight: 800;
    letter-spacing: 0.02em; line-height: 1.25; color: #10141a;
  }
  .mast-meta { font-size: 12px; color: var(--muted); letter-spacing: 0.05em; }

  /* ---------- two-column layout ---------- */
  .layout {
    display: grid; grid-template-columns: minmax(0, 1fr) 252px;
    gap: 28px; align-items: start; margin-top: 20px;
  }
  .main { min-width: 0; }
  .side { position: sticky; top: 16px; }
  @media (max-width: 780px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 4px; padding: 18px 16px;
  }

  /* ---------- date line ---------- */
  .day-bar {
    display: flex; align-items: center; gap: 12px;
    font-size: 12.5px; font-weight: 700;
    letter-spacing: 0.14em; color: var(--muted);
  }
  .day-bar::after { content: ""; flex: 1; height: 1px; background: var(--border); }

  /* ---------- calendar (sidebar) ---------- */
  .side .card { margin-top: 0; padding: 14px 12px; }
  .cal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .cal-title { font-size: 13px; font-weight: 700; }
  .cal-nav { display: flex; gap: 4px; }
  .cal-btn {
    font-size: 11.5px; line-height: 1.2; color: var(--muted);
    background: #fff; border: 1px solid var(--border); border-radius: 3px;
    padding: 4px 8px; cursor: pointer;
  }
  .cal-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .cal-btn:disabled { opacity: 0.3; cursor: default; }
  .cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 4px; }
  .cal-week span { text-align: center; font-size: 10.5px; color: var(--muted); }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .cal-cell {
    display: block; text-align: center; text-decoration: none;
    border: 1px solid transparent; border-radius: 3px; padding: 6px 0;
    background: transparent;
  }
  .cal-cell .dn { display: block; font-size: 12px; font-weight: 600; color: #9aa2ad; }
  .cal-cell.out { opacity: 0.4; }
  a.cal-cell:hover { border-color: var(--accent); }
  .cal-cell.c1 { background: #eef3f9; } .cal-cell.c2 { background: #dce8f4; }
  .cal-cell.c3 { background: #c5d9ec; } .cal-cell.c4 { background: #aac9e3; }
  .cal-cell.c1 .dn, .cal-cell.c2 .dn, .cal-cell.c3 .dn, .cal-cell.c4 .dn { color: var(--accent); }
  .cal-cell.today { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cal-cell.sel { border-color: var(--accent); }
  .cal-cell.sel .dn { color: var(--accent); font-weight: 700; }

  /* ---------- article ---------- */
  article.day { display: none; }
  article.day.active { display: block; margin-top: 0; }
  .day-empty {
    margin-top: 0; background: var(--card); border: 1px dashed var(--border);
    border-radius: 4px; padding: 42px 20px; text-align: center; color: var(--muted);
  }
  article {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 4px; padding: 30px 34px 32px; margin-top: 0;
    scroll-margin-top: 16px; font-size: 15.5px; line-height: 1.92;
  }
  article h3 {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; font-weight: 700;
    letter-spacing: 0.22em; color: var(--accent);
    margin: 2em 0 0.9em; padding-bottom: 8px;
    border-bottom: 2px solid var(--accent);
  }
  article h3.ins-h { color: var(--accent); }
  article h4 { font-size: 16.5px; font-weight: 700; margin: 1.5em 0 0.4em; line-height: 1.6; color: #111; }
  article p { margin: 0.85em 0; text-align: justify; }
  article p.callout {
    background: var(--soft); border-left: 4px solid var(--accent);
    border-radius: 3px; padding: 12px 16px; margin: 1.1em 0;
    font-size: 15.5px; text-align: left;
  }
  article strong { font-weight: 700; color: #111; }
  strong.num { color: var(--accent); font-weight: 700; font-style: normal; }
  article ol { margin: 0.5em 0 1.1em; padding-left: 22px; }
  article ol li { margin: 0.45em 0; }
  article ol li::marker { color: var(--accent); font-weight: 700; }
  .src { margin: -4px 0 1.2em; }
  .src-link {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 11.5px; line-height: 1.5; color: var(--accent);
    background: transparent; border: none; border-bottom: 1px dotted #b9c6d6;
    border-radius: 0; padding: 1px 0; text-decoration: none;
  }
  .src-link:hover { border-bottom-color: var(--accent); }
  .src-link svg { flex: none; }
  .src-link span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a { color: var(--accent); text-decoration: none; }
  article em { color: var(--muted); }
  blockquote { margin: 0.8em 0; padding: 2px 16px; border-left: 3px solid var(--accent); color: var(--muted); }
  .empty { color: var(--muted); }

  /* ---------- avatars ---------- */
  p.has-avatar { display: flow-root; }
  .avatar {
    float: left; width: 46px; height: 46px; border-radius: 3px;
    margin: 4px 14px 3px 0; border: 1px solid var(--border);
    background: #f0f3f7;
  }

  /* ---------- keyword tags ---------- */
  .kw-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin: 2px 0 6px; }
  .kw {
    display: inline-block; font-size: 11.5px; line-height: 1.7;
    padding: 2px 10px; border-radius: 3px;
    background: var(--soft); border: 1px solid #d5e2f0; color: var(--accent);
    font-weight: 600;
  }
  .kw:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

  /* ---------- story head ---------- */
  .story-head { margin: 2px 0 6px; }
  .story-kicker {
    font-size: 12px; font-weight: 700;
    letter-spacing: 0.22em; color: var(--red);
  }
  .story-title { font-size: 29px; font-weight: 800; line-height: 1.4; margin: 8px 0 8px; color: #10141a; }
  .story-deck { font-size: 15px; color: #495057; line-height: 1.9; }
  .story-meta { font-size: 11.5px; color: var(--muted); margin-top: 10px; letter-spacing: 0.06em; }
  .story-art { margin: 14px 0 4px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 8px 0; background: #fbfcfe; }
  .story-art svg { display: block; width: 100%; height: auto; }

  /* ---------- pull quote ---------- */
  .pullquote {
    margin: 1.6em 0; padding: 16px 20px;
    background: #f8f9fb; border-left: 4px solid var(--accent);
    border-radius: 3px;
  }
  .pq-mark { display: block; font-size: 30px; line-height: 0.7; color: var(--accent); font-weight: 800; }
  .pq-text { font-size: 17px; line-height: 1.85; margin: 8px 0 6px; font-weight: 700; color: #16191d; }
  .pq-by { font-size: 12px; color: var(--muted); letter-spacing: 0.08em; }

  /* ---------- language toggle ---------- */
  body[data-lang="zh"] .lang-en { display: none; }
  body[data-lang="en"] .lang-zh { display: none; }
  body[data-lang="zh"] article.no-zh .lang-en { display: block; }
  body[data-lang="en"] article.no-en .lang-zh { display: block; }
  .lang-note { display: none; margin: 0 0 14px; padding: 8px 12px; font-size: 12px; color: #8a6d1f; background: #fdf6e3; border: 1px solid #e5d9a8; border-radius: 3px; }
  body[data-lang="en"] article.no-en .lang-note:not(.note-zh) { display: block; }
  body[data-lang="zh"] article.no-zh .lang-note.note-zh { display: block; }
  .lang-switch {
    position: fixed; bottom: 24px; right: 18px; z-index: 50;
    display: flex; gap: 2px; padding: 3px;
    background: #fff; border: 1px solid var(--border);
    border-radius: 4px; box-shadow: 0 1px 8px rgba(20, 40, 70, 0.1);
  }
  .sw-btn {
    border: none; background: transparent; cursor: pointer;
    font-size: 12px; line-height: 1.3;
    padding: 4px 13px; border-radius: 2px; color: var(--muted);
  }
  .sw-btn:hover { color: var(--accent); }
  .sw-btn.on { background: var(--accent); color: #fff; }

  footer.site { margin-top: 40px; text-align: center; font-size: 11.5px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 16px; }

</style>
</head>
<body id="top" data-lang="zh">
<div class="lang-switch" role="group" aria-label="语言 / Language">
  <button class="sw-btn" type="button" data-lang="zh">中文</button>
  <button class="sw-btn" type="button" data-lang="en">EN</button>
</div>
<div class="wrap">
  <div class="page-head">
    <div class="mast-kicker"><span class="lang-zh">每 日 AI 行 业 观 察</span><span class="lang-en">A DAILY AI INDUSTRY BRIEF</span></div>
    <h1>AI Builders Digest</h1>
    <div class="mast-meta"><span class="lang-zh">第 ${entries.length} 期 · 每天早上 8:00 更新 · ${todayKey} 刊</span><span class="lang-en">Issue ${entries.length} · Updated daily at 8:00 AM · ${todayKey}</span></div>
  </div>

  <div class="day-bar" id="dayBar"></div>
  <div class="layout">
    <main class="main">
      ${articles}
      <div class="day-empty" id="dayEmpty" hidden>
        <span class="lang-zh">这一天没有摘要</span><span class="lang-en">No digest for this day</span>
      </div>
    </main>
    <aside class="side">
      <div class="card">
    <div class="cal-head">
      <div class="cal-nav">
        <button class="cal-btn" id="calPrevYear" type="button" aria-label="上一年">«</button>
        <button class="cal-btn" id="calPrev" type="button" aria-label="上一月">‹</button>
      </div>
      <div class="cal-title" id="calTitle"></div>
      <div class="cal-nav">
        <button class="cal-btn" id="calTodayBtn" type="button"><span class="lang-zh">今天</span><span class="lang-en">Today</span></button>
        <button class="cal-btn" id="calNext" type="button" aria-label="下一月">›</button>
        <button class="cal-btn" id="calNextYear" type="button" aria-label="下一年">»</button>
      </div>
    </div>
    <div class="cal-week">
      <span class="lang-zh">一</span><span class="lang-en">Mo</span>
      <span class="lang-zh">二</span><span class="lang-en">Tu</span>
      <span class="lang-zh">三</span><span class="lang-en">We</span>
      <span class="lang-zh">四</span><span class="lang-en">Th</span>
      <span class="lang-zh">五</span><span class="lang-en">Fr</span>
      <span class="lang-zh">六</span><span class="lang-en">Sa</span>
      <span class="lang-zh">日</span><span class="lang-en">Su</span>
    </div>
    <div class="cal-grid" id="calGrid"></div>
      </div>
    </aside>
  </div>

  <footer class="site">Generated through the Follow Builders skill · <a href="https://github.com/zarazhangrui/follow-builders">zarazhangrui/follow-builders</a></footer>
</div>
<script>
const DIGEST_DATES = ${datesJson};
const TODAY_KEY = ${JSON.stringify(todayKey)};
const LATEST_KEY = ${JSON.stringify(latestKey)};

// month calendar grid + one-day-at-a-time view
(function () {
  var grid = document.getElementById('calGrid');
  if (!grid) return;
  var title = document.getElementById('calTitle');
  var prevBtn = document.getElementById('calPrev');
  var prevYearBtn = document.getElementById('calPrevYear');
  var nextBtn = document.getElementById('calNext');
  var nextYearBtn = document.getElementById('calNextYear');
  var todayBtn = document.getElementById('calTodayBtn');
  var dayBar = document.getElementById('dayBar');
  var dayEmpty = document.getElementById('dayEmpty');
  var WD_ZH = ['一', '二', '三', '四', '五', '六', '日'];
  var WD_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
  var MS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseKey(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function key(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function level(bytes) {
    if (!bytes) return 0;
    if (bytes < 4000) return 1;
    if (bytes < 7000) return 2;
    if (bytes < 11000) return 3;
    return 4;
  }

  var today = parseKey(TODAY_KEY);
  var view = { y: today.getFullYear(), m: today.getMonth() };
  var selKey = TODAY_KEY;

  function render() {
    grid.innerHTML = '';
    var first = new Date(view.y, view.m, 1);
    var start = new Date(view.y, view.m, 1 - ((first.getDay() + 6) % 7));
    for (var i = 0; i < 42; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var k = key(d);
      var bytes = DIGEST_DATES[k] || 0;
      var el = document.createElement('a');
      el.href = '#d-' + k;
      el.dataset.day = k;
      if (bytes) el.title = k + ' · ' + (bytes / 1024).toFixed(1) + ' KB';
      el.className = 'cal-cell' +
        (bytes ? ' c' + level(bytes) : '') +
        (k === TODAY_KEY ? ' today' : '') +
        (k === selKey ? ' sel' : '') +
        (d.getMonth() !== view.m ? ' out' : '');
      el.innerHTML = '<span class="dn">' + d.getDate() + '</span>';
      el.addEventListener('click', (function (kk) {
        return function (ev) { ev.preventDefault(); selectDay(kk); };
      })(k));
      grid.appendChild(el);
    }
    title.innerHTML = '<span class="lang-zh">' + view.y + '年' + (view.m + 1) + '月</span>' +
      '<span class="lang-en">' + MS_EN[view.m] + ' ' + view.y + '</span>';
    var atCur = view.y === today.getFullYear() && view.m === today.getMonth();
    nextBtn.disabled = atCur;
    nextYearBtn.disabled = view.y >= today.getFullYear();
  }

  function labelFor(k, empty) {
    var d = parseKey(k);
    var zh = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WD_ZH[(d.getDay() + 6) % 7] + (empty ? ' · 无内容' : '');
    var en = WD_EN[(d.getDay() + 6) % 7] + ', ' + MS_EN[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + (empty ? ' · no digest' : '');
    dayBar.innerHTML = '<span class="lang-zh">' + zh + '</span><span class="lang-en">' + en + '</span>';
  }

  function markSel(k) {
    document.querySelectorAll('#calGrid .cal-cell').forEach(function (c) {
      c.classList.toggle('sel', c.dataset.day === k);
    });
  }

  function showDay(k) {
    document.querySelectorAll('article.day').forEach(function (a) {
      a.classList.toggle('active', a.id === 'd-' + k);
    });
    dayEmpty.hidden = true;
    labelFor(k, false);
    markSel(k);
  }

  function showEmpty(k) {
    document.querySelectorAll('article.day').forEach(function (a) { a.classList.remove('active'); });
    dayEmpty.hidden = false;
    labelFor(k, true);
    markSel(k);
  }

  function shiftMonth(n) {
    var m = view.m + n, y = view.y;
    while (m < 0) { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    if (y > today.getFullYear() || (y === today.getFullYear() && m > today.getMonth())) return;
    view = { y: y, m: m };
    render();
  }

  function selectDay(k) {
    selKey = k;
    var d = parseKey(k);
    view = { y: d.getFullYear(), m: d.getMonth() };
    render();
    if (DIGEST_DATES[k]) showDay(k); else showEmpty(k);
    try { history.replaceState(null, '', '#d-' + k); } catch (e) {}
  }

  // initial=true accepts falling back to the latest digest when the hash is
  // absent or not a date; later hashchange events with non-date hashes keep
  // the current view untouched.
  function route(initial) {
    var m = location.hash.match(/^#d-(\d{4}-\d{2}-\d{2})$/);
    var k;
    if (m) k = m[1];
    else {
      if (!initial) return;
      k = LATEST_KEY;
    }
    if (!k) { showEmpty(TODAY_KEY); return; }
    selectDay(k);
  }

  prevBtn.addEventListener('click', function () { shiftMonth(-1); });
  nextBtn.addEventListener('click', function () { shiftMonth(1); });
  prevYearBtn.addEventListener('click', function () { shiftMonth(-12); });
  nextYearBtn.addEventListener('click', function () { shiftMonth(12); });
  todayBtn.addEventListener('click', function () { selectDay(TODAY_KEY); });
  window.addEventListener('hashchange', function () { route(false); });
  route(true);
})();

(function () {
  var btns = document.querySelectorAll('.sw-btn');
  function setLang(l) {
    document.body.dataset.lang = l;
    try { localStorage.setItem('fb-lang', l); } catch (e) {}
    btns.forEach(function (b) { b.classList.toggle('on', b.dataset.lang === l); });
  }
  btns.forEach(function (b) { b.addEventListener('click', function () { setLang(b.dataset.lang); }); });
  var saved = 'zh';
  try { saved = localStorage.getItem('fb-lang') || 'zh'; } catch (e) {}
  setLang(saved);
})();
</script>
</body>
</html>
`;

  await writeFile(OUT, html, 'utf-8');
  console.log(`OK ${OUT} — ${entries.length} digest(s), latest: ${entries[0]?.key || 'none'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
