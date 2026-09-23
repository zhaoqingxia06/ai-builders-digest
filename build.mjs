#!/usr/bin/env node
// Build the digest site: reads ~/.follow-builders/digests/YYYY-MM-DD.md and
// emits ~/.follow-builders/site/index.html — calendar heatmap on top, all
// digests below, heatmap cells link to each day's article. No dependencies.

import { readdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = join(homedir(), '.follow-builders');
const DIGEST_DIR = join(ROOT, 'digests');
const OUT = join(ROOT, 'site', 'index.html');

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

// `keywords: a | b | c` line under the H1 feeds the hot-topic chips; stripped from the body.
function parseKeywords(md) {
  const m = md.match(/^keywords:\s*(.+)\s*$/m);
  if (!m) return { kw: [], body: md };
  const kw = m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3);
  return { kw, body: md.replace(m[0], '') };
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
  const langDiv = (l, rec) => {
    if (!rec) return '';
    const { kw, body } = parseKeywords(rec.md);
    return `<div class="lang lang-${l}"><div class="kw-row">${kw.map((k) => `<span class="kw">#${escapeHtml(k)}</span>`).join('')}</div>${mdToHtml(body).replaceAll('<h3>🧭', '<h3 class="ins-h">🧭')}</div>`;
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
    --bg: #f6f8fa; --card: #fff; --text: #1f2328; --muted: #656d76;
    --border: #d8dee4; --accent: #0969da;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
    font-size: 15px; line-height: 1.75;
  }
  .wrap { max-width: 1060px; margin: 0 auto; padding: 36px 20px 90px; }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 252px; gap: 26px; align-items: start; }
  .main { min-width: 0; }
  .main .day-bar { margin-top: 2px; }
  .side { position: sticky; top: 16px; }
  .side .card { margin-top: 0; padding: 14px 12px; }
  .side .cal-head { margin-bottom: 8px; }
  .side .cal-title { font-size: 12.5px; }
  .side .cal-btn { font-size: 11.5px; padding: 4px 8px; }
  .side .cal-week { gap: 4px; margin-bottom: 4px; }
  .side .cal-week span { font-size: 10.5px; }
  .side .cal-grid { gap: 4px; }
  .side .cal-cell { padding: 6px 0; border-radius: 6px; }
  .side .cal-cell .dn { font-size: 12px; }
  @media (max-width: 780px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }
  .page-head h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: 0.5px; }
  .page-head p { margin: 0; color: var(--muted); font-size: 13px; }
  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 20px 22px; margin-top: 24px;
  }
  .cal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .cal-title { font-size: 13.5px; font-weight: 600; }
  .cal-nav { display: flex; gap: 6px; }
  .cal-btn {
    font-family: inherit; font-size: 13px; line-height: 1.2; color: var(--muted);
    background: #fff; border: 1px solid var(--border); border-radius: 8px;
    padding: 5px 12px; cursor: pointer;
  }
  .cal-btn:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
  .cal-btn:disabled { opacity: 0.35; cursor: default; }
  .cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 6px; }
  .cal-week span { text-align: center; font-size: 11px; color: var(--muted); }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
  .cal-cell {
    display: block; text-align: center; text-decoration: none;
    border: 1px solid var(--border); border-radius: 8px; padding: 8px 2px;
    background: #fafbfc;
  }
  .cal-cell .dn { display: block; font-size: 14px; font-weight: 600; color: #9aa4ae; }
  .cal-cell.out { opacity: 0.35; }
  a.cal-cell { cursor: pointer; }
  a.cal-cell:hover { border-color: var(--accent); }
  .cal-cell.c1 { background: #f2fbf4; border-color: #d8efdd; }
  .cal-cell.c2 { background: #e3f6e8; border-color: #bfe3c8; }
  .cal-cell.c3 { background: #d0eed9; border-color: #a5d9b2; }
  .cal-cell.c4 { background: #b9e5c6; border-color: #8ccf9e; }
  .cal-cell.c1 .dn, .cal-cell.c2 .dn, .cal-cell.c3 .dn, .cal-cell.c4 .dn { color: #116329; }
  .cal-cell.today { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cal-cell.today .dn { color: var(--accent); }
  .cal-cell.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .cal-cell.sel .dn { color: var(--accent); }
  .day-bar { margin-top: 26px; padding: 0 4px; font-size: 13px; font-weight: 600; color: var(--muted); }
  article.day { display: none; }
  article.day.active { display: block; margin-top: 12px; }
  .day-empty {
    margin-top: 26px; background: var(--card); border: 1px dashed var(--border);
    border-radius: 12px; padding: 36px 20px; text-align: center; color: var(--muted);
  }
  article {
    background: var(--card); border: 1px solid var(--border);
    border-radius: 12px; padding: 22px 30px 26px; margin-top: 26px;
    scroll-margin-top: 16px; font-size: 15px; line-height: 1.85;
  }
  article h3 {
    display: flex; align-items: center; gap: 8px;
    font-size: 13.5px; font-weight: 600; letter-spacing: 2px;
    color: var(--muted); margin: 1.9em 0 0.7em; padding-bottom: 7px;
    border-bottom: 1px solid var(--border);
  }
  article h4 { font-size: 16px; font-weight: 650; margin: 1.3em 0 0.3em; line-height: 1.5; }
  article p { margin: 0.75em 0; text-align: justify; }
  article p.callout {
    background: #f0f7f1; border-left: 3px solid #40c463; border-radius: 6px;
    padding: 9px 14px; margin: 1em 0; text-align: left;
  }
  article strong { font-weight: 700; }
  strong.num { color: #116329; font-weight: 700; font-style: normal; }
  .src { margin: -3px 0 1.15em; }
  .src-link {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; line-height: 1.4; color: var(--muted);
    background: #f6f8fa; border: 1px solid var(--border); border-radius: 999px;
    padding: 2.5px 11px 2.5px 9px; text-decoration: none;
  }
  .src-link:hover { color: var(--accent); border-color: var(--accent); background: #f0f6ff; }
  .src-link svg { flex: none; }
  .src-link span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a { color: var(--accent); text-decoration: none; }
  article em { color: var(--muted); }
  blockquote { margin: 0.8em 0; padding: 2px 14px; border-left: 3px solid var(--border); color: var(--muted); }
  hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }
  article ol { margin: 0.5em 0 1.1em; padding-left: 22px; }
  article ol li { margin: 0.4em 0; }
  article ol li::marker { color: var(--accent); font-weight: 700; }
  article h3.ins-h { color: #116329; border-bottom-color: #40c463; }
  .empty { color: var(--muted); }
  footer.site { margin-top: 34px; text-align: center; font-size: 12px; color: var(--muted); }
  /* language toggle */
  body[data-lang="zh"] .lang-en { display: none; }
  body[data-lang="en"] .lang-zh { display: none; }
  body[data-lang="zh"] article.no-zh .lang-en { display: block; }
  body[data-lang="en"] article.no-en .lang-zh { display: block; }
  .lang-note { display: none; margin: 4px 0 14px; padding: 8px 12px; font-size: 12.5px; color: #9a6700; background: #fff8c5; border: 1px solid rgba(212, 167, 44, 0.4); border-radius: 6px; }
  body[data-lang="en"] article.no-en .lang-note:not(.note-zh) { display: block; }
  body[data-lang="zh"] article.no-zh .lang-note.note-zh { display: block; }
  .lang-switch {
    position: fixed; bottom: 24px; right: 18px; z-index: 50;
    display: flex; gap: 2px; padding: 3px;
    background: rgba(255, 255, 255, 0.92); border: 1px solid var(--border);
    border-radius: 999px; box-shadow: 0 1px 10px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
  }
  .kw {
    display: inline-block; font-size: 12.5px; line-height: 1.6;
    padding: 2px 12px; border-radius: 999px;
    background: #ecf7ee; border: 1px solid #bfe3c8; color: #116329;
    font-weight: 600;
  }
  a.kw:hover { border-color: var(--accent); color: var(--accent); background: #e8f3fd; }
  .kw-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin: 4px 0 2px; }
  .kw-row .kw { font-size: 12px; padding: 1.5px 11px; }
  .sw-btn {
    border: none; background: transparent; cursor: pointer;
    font-family: inherit; font-size: 12.5px; line-height: 1.3;
    padding: 4px 13px; border-radius: 999px; color: var(--muted);
  }
  .sw-btn:hover { color: var(--text); }
  .sw-btn.on { background: var(--accent); color: #fff; }
</style>
</head>
<body id="top" data-lang="zh">
<div class="lang-switch" role="group" aria-label="语言 / Language">
  <button class="sw-btn" type="button" data-lang="zh">中文</button>
  <button class="sw-btn" type="button" data-lang="en">EN</button>
</div>
<div class="wrap">
  <div class="page-head">
    <h1>AI Builders Digest</h1>
    <p>${entries.length} 期 · 最近更新 ${todayKey} · 每天早上 8:00 自动生成</p>
  </div>

  <div class="layout">
    <main class="main">
      <div class="day-bar" id="dayBar"></div>
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
