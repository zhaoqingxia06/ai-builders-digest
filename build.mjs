#!/usr/bin/env node
// Build the digest site: reads ~/.follow-builders/digests/YYYY-MM-DD.md and
// emits ~/.follow-builders/site/index.html — calendar heatmap on top, all
// digests below, heatmap cells link to each day's article. No dependencies.

import { readdir, readFile, writeFile, rename } from 'fs/promises';
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

// snowflake id -> 发帖时间的北京时间字符串（MM-DD HH:MM）
function tweetBjTime(id) {
  try {
    const d = new Date(Number((BigInt(id) >> 22n) + 1288834974657n) + 8 * 3600e3);
    return d.toISOString().slice(5, 10).replace('-', '月') + '日 ' + d.toISOString().slice(11, 16);
  } catch { return ''; }
}

function srcChip(url) {
  let label = '原文';
  let tweetAttr = '';
  let timeHtml = '';
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (/^(x|twitter)\.com$/.test(h)) {
      label = 'X 原文';
      // status links open in the in-page source panel; keep href as fallback
      const st = url.match(/\/[^/]+\/status(?:es)?\/(\d+)/);
      if (st) {
        tweetAttr = ` data-tweet="${st[1]}"`;
        // 展示发帖时间对应的北京时间
        const bj = tweetBjTime(st[1]);
        if (bj) timeHtml = `<span class="src-time">${bj}</span>`;
      }
    }
    else if (h.includes('youtu')) label = 'YouTube';
    else if (h === 'github.com') label = 'GitHub';
    else label = h;
  } catch {}
  return `<div class="src"><a class="src-link"${tweetAttr} href="${url}" target="_blank" rel="noopener" title="${url}">${ICON_LINK}<span>${label}</span>${timeHtml}</a></div>`;
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

// ---------- product knowledge base (click a product -> info card) ----------
const PRODUCT_KB = {
  muse:      { name: 'Muse', desc: 'Meta 推出的个人 AI Agent 应用，可跨 App 替用户执行任务，被视为 ChatGPT 之外最有力的入口级 agent 竞争者。' },
  chatgpt:   { name: 'ChatGPT', desc: 'OpenAI 的对话式 AI 助手，全球用户量最大的 AI 产品，正从聊天扩展到代理执行、个人金融助手等场景。' },
  siri:      { name: 'Siri', desc: 'Apple 的语音助手，正被重构为大模型驱动的个人 agent，但迭代速度常被认为太慢。' },
  x402:      { name: 'X402', desc: 'Coinbase 孵化、后捐给 Linux 基金会的 agent 支付协议：让 AI agent 用 stablecoin 按请求在线付费。' },
  toshi:     { name: 'Toshi', desc: 'Coinbase 内部的 agent harness，把团队的事故记录、规范等「大脑」喂给 agent，实现代码改动的递归自我改进。' },
  capy:      { name: 'Capy', desc: 'capydotai 推出的 agentic 编程工具，擅长多步工作流追踪与大型 PR 自动化，被 Garry Tan 称为快过 Codex/Claude Code 的秘密武器。' },
  astra:     { name: 'Astra', desc: '一款可完成可验证端到端任务的 agent，投资人 Nikunj Kothari 评价：给它足够难的任务，它直接起飞。' },
  codex:     { name: 'Codex', desc: 'OpenAI 的 AI 编程 agent 与云服务，可自主完成编码任务，其团队已宣告「代码冻结」时代结束。' },
  grok:      { name: 'Grok', desc: 'xAI 的大模型，Vercel CEO 实测其逆向工程能力后评价：解得非常漂亮，而且快得惊人。' },
  openclaw:  { name: 'OpenClaw', desc: 'Peter Steinberger 参与的开源个人 agent 项目（代号 claw），Meta 的自研 agent 曾被传「使用 OpenClaw」，实为受其启发。' },
  instinct:  { name: 'Instinct', desc: '零配置、面向普通用户的手机 agent 应用，被视作「人人都能用的 agent」的范例。' },
  vercel:    { name: 'Vercel', desc: 'Guillermo Rauch 创办的前端云平台，AI Gateway 让各家模型通过 HTTP 直接调用。' },
  replit:    { name: 'Replit', desc: 'Amjad Masad 领导的在线开发平台，主打人人可造软件，AI agent 深度融入产品。' },
  box:       { name: 'Box', desc: 'Aaron Levie 领导的企业内容管理平台，agent 可对其数千万份企业文件随问随答。' },
  blacksmith:{ name: 'Blacksmith', desc: '高性能 CI 服务商，OpenClaw 项目的赞助商。' },
  typesafe:  { name: 'TypeSafe AI', desc: 'ChatGPT 联合创造者 Diogo Almeida 创办的 AI 初创公司，主打「机器原生 AI」与 System One 模型 Jev，已获 4000 万美元种子轮。' },
  jev:       { name: 'Jev', desc: 'TypeSafe AI 发布的首个 System One 模型。' },
  'diogo almeida': { name: 'Diogo Almeida', desc: 'TypeSafe AI 联合创始人兼 CEO，OpenAI 时期参与创造 ChatGPT、RLHF 与 InstructGPT。' },
  'claude in chrome': { name: 'Claude in Chrome', desc: 'Anthropic 的浏览器扩展，让 Claude 直接在 Chrome 内替用户操作网页，已正式发布。' },
  openai:    { name: 'OpenAI', desc: 'ChatGPT 与 Codex 的缔造者，AGI 研发的头部公司。' },
  meta:      { name: 'Meta', desc: 'Facebook 与 Instagram 的母公司，自研个人 agent Muse。' },
  apple:     { name: 'Apple', desc: 'Siri 的缔造者，个人 agent 入口之争的重要玩家。' },
};
const PRODUCT_RULES = Object.entries(PRODUCT_KB)
  .sort((a, b) => b[1].name.length - a[1].name.length)
  .map(([key, p]) => [key, new RegExp('(<[^>]*>)|\\b(' + p.name.replace(/[.*+?^${}()|[\]\\]/g, '\$&') + ')\\b', 'g')]);

// 每个产品在同一期内只标注首次出现，避免满屏下划线
function wrapProducts(html, used) {
  const masks = [];
  let h = html.replace(/<div class="kw-row">[\s\S]*?<\/div>/g, (m) => { masks.push(m); return '\u0001' + (masks.length - 1) + '\u0001'; });
  for (const [key, rx] of PRODUCT_RULES) {
    if (used.has(key)) continue;
    h = h.replace(rx, (m, tag, word) => {
      if (tag) return m;
      used.add(key);
      return '<span class="prod" data-prod="' + key + '">' + word + '</span>';
    });
  }
  h = h.replace(/\u0001(\d+)\u0001/g, (m, i) => masks[Number(i)]);
  return h;
}

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
    const { kw, headline, deck, body } = parseKeywords(rec.md);
    const langZh = l === 'zh';
    const title = headline || (langZh ? `${rec.key} 简报` : `Briefing · ${rec.key}`);
    const plain = body.replace(/https?:\/\/\S+/g, '').replace(/\s/g, '');
    const minutes = Math.max(1, Math.round(plain.length / 600));
    const readTime = langZh ? `阅读约 ${minutes} 分钟` : `A ${minutes}-min read`;
    const storyHead = `
      <div class="story-head">
        <h1 class="story-title">${escapeHtml(title)}</h1>
        ${deck ? `<div class="story-deck">${escapeHtml(deck)}</div>` : ''}
        <div class="story-meta">${readTime} · Follow Builders</div>
      </div>
    `;
    const kwRow = `<div class="kw-row">${kw.map((k) => `<span class="kw">#${escapeHtml(k)}</span>`).join('')}</div>`;
    let html = `${storyHead}${kwRow}${injectAvatars(mdToHtml(body), avatarFiles)}`;
    const used = new Set();
    html = decorateH3(wrapProducts(html, used));
    // 只保留 标题 + 核心洞察：TOP 3 与正文重复，不再渲染
    html = html.replace(/<p class="callout"><strong>(?:TOP ?3|Top ?3)[^<]*<\/strong>[^<]*<\/p>\s*<ol>[\s\S]*?<\/ol>\s*/g, '');
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
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1d1d1f;
    --muted: #6e6e73;
    --border: rgba(0, 0, 0, 0.08);
    --accent: #0071e3;
    --soft: rgba(0, 113, 227, 0.06);
    --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: var(--sans);
    font-size: 16px; line-height: 1.85;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 32px 90px; }

  /* ---------- masthead ---------- */
  .page-head {
    text-align: center; padding: 20px 0 26px;
    border-bottom: 1px solid var(--border);
  }
  .page-head h1 {
    margin: 0 0 10px; font-size: 44px; font-weight: 800;
    letter-spacing: -0.025em; line-height: 1.15; color: var(--text);
  }
  .mast-meta { font-size: 13px; color: var(--muted); letter-spacing: 0.02em; }

  /* ---------- layout ---------- */
  .layout {
    display: grid; grid-template-columns: minmax(0, 1fr) 264px;
    gap: 32px; align-items: start; margin-top: 30px;
  }
  .main { min-width: 0; }
  .side { position: sticky; top: 100px; }
  @media (max-width: 800px) {
    .layout { grid-template-columns: 1fr; }
    .side { position: static; }
  }

  /* ---------- calendar: frosted card ---------- */
  .side .card {
    background: rgba(255, 255, 255, 0.72);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(0, 0, 0, 0.05); border-radius: 18px;
    padding: 18px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05);
  }
  .cal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .cal-title { font-size: 14px; font-weight: 700; white-space: nowrap; }
  .cal-nav { display: flex; gap: 5px; }
  .cal-btn {
    font-size: 12px; line-height: 1.2; color: var(--muted);
    background: transparent; border: none; border-radius: 8px;
    padding: 5px 9px; cursor: pointer; transition: background 0.15s ease;
  }
  .cal-btn:hover:not(:disabled) { color: var(--accent); background: var(--soft); }
  .cal-btn:disabled { opacity: 0.3; cursor: default; }
  .cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 6px; }
  .cal-week span { text-align: center; font-size: 11px; color: var(--muted); }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .cal-cell {
    display: block; text-align: center; text-decoration: none;
    border: none; border-radius: 9px; padding: 7px 0;
    background: transparent; transition: background 0.15s ease;
  }
  .cal-cell .dn { display: block; font-size: 12.5px; font-weight: 500; color: #86868b; }
  .cal-cell.out { opacity: 0.35; }
  a.cal-cell:hover { background: var(--soft); }
  .cal-cell.c1 { background: #f0f6ff; } .cal-cell.c2 { background: #e1ecfc; }
  .cal-cell.c3 { background: #c7defb; } .cal-cell.c4 { background: #a8d0f6; }
  .cal-cell.c1 .dn, .cal-cell.c2 .dn, .cal-cell.c3 .dn, .cal-cell.c4 .dn { color: #0b5cad; font-weight: 600; }
  .cal-cell.today { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cal-cell.today .dn { color: var(--accent); font-weight: 700; }
  .cal-cell.sel { background: var(--accent); }
  .cal-cell.sel .dn { color: #fff; }

  /* ---------- story head ---------- */
  .story-head { margin: 2px 0 6px; }
  .story-title {
    font-size: 32px; font-weight: 800; line-height: 1.35;
    letter-spacing: -0.02em; margin: 0 0 10px; color: var(--text);
  }
  .story-deck { font-size: 16px; color: var(--muted); line-height: 1.85; }
  .story-meta { font-size: 12px; color: var(--muted); margin-top: 12px; letter-spacing: 0.03em; }

  /* ---------- topic chips: gradient pills ---------- */
  .kw-row { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; margin: 10px 0 4px; }
  .kw {
    display: inline-block; font-size: 13px; line-height: 1.7;
    padding: 6px 18px; border-radius: 980px;
    background: linear-gradient(135deg, #0a84ff, #5e5ce6);
    color: #fff; font-weight: 600; letter-spacing: 0.01em;
    box-shadow: 0 2px 12px rgba(10, 132, 255, 0.3);
    transition: transform 0.2s ease, box-shadow 0.2s ease;
  }
  .kw:hover { transform: translateY(-1px); box-shadow: 0 4px 18px rgba(10, 132, 255, 0.4); }
  .kw-row .kw:nth-of-type(2) {
    background: linear-gradient(135deg, #bf5af2, #ff375f);
    box-shadow: 0 2px 12px rgba(191, 90, 242, 0.3);
  }
  .kw-row .kw:nth-of-type(3) {
    background: linear-gradient(135deg, #30d158, #6ac4dc);
    box-shadow: 0 2px 12px rgba(48, 209, 88, 0.3);
  }

  /* ---------- article card ---------- */
  article.day { display: none; }
  article.day.active { display: block; margin-top: 0; scroll-margin-top: 16px; }
  .day-empty {
    margin-top: 0; background: #fff; border: none; border-radius: 20px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05); padding: 52px 24px;
    text-align: center; color: var(--muted);
  }
  article {
    background: #fff; border: none; border-radius: 20px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05);
    padding: 36px 40px 40px; margin-top: 0;
    scroll-margin-top: 16px; font-size: 16px; line-height: 1.9;
  }
  article h3 {
    display: flex; align-items: center; gap: 10px;
    font-size: 16px; font-weight: 700; letter-spacing: 0.01em; color: var(--text);
    margin: 1.5em 0 0.8em; padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
  }
  article h3.ins-h { color: var(--text); }
  article h3 .h3-ico { color: var(--accent); }
  .h3-ico { width: 14px; height: 14px; flex: none; }
  article h4 { font-size: 17px; font-weight: 700; margin: 1.5em 0 0.4em; line-height: 1.6; color: var(--text); }
  article p { margin: 0.8em 0; text-align: justify; }
  article p.callout {
    background: var(--soft); border-left: 4px solid var(--accent);
    border-radius: 14px; padding: 16px 20px; margin: 1.2em 0;
    text-align: left;
  }
  article strong { font-weight: 650; color: var(--text); }
  strong.num { color: var(--accent); font-weight: 700; font-style: normal; }
  article ol { margin: 0.4em 0 0.9em; padding-left: 22px; }
  article ol li { margin: 0.5em 0; }
  article ol li::marker { color: var(--accent); font-weight: 700; }
  .src { display: inline-block; margin: 0 12px 0.3em 0; }
  .src-link {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; line-height: 1.5; color: var(--accent);
    background: transparent; border: none; border-radius: 0; padding: 1px 0;
    text-decoration: none;
  }
  .src-link:hover { text-decoration: underline; }
  .src-link svg { flex: none; }
  .src-link span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .src-time { color: var(--muted); font-weight: 400; max-width: none !important; }

  /* ---------- live updates: relay's newest posts, fetched on open ---------- */
  .live {
    background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 14px; padding: 16px 20px; margin: 0 0 26px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05);
  }
  .live[hidden] { display: none; }
  .live-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
  .live-dot {
    width: 8px; height: 8px; border-radius: 50%; background: #e5484d;
    box-shadow: 0 0 0 3px rgba(229, 72, 77, 0.18); align-self: center; flex: none;
    animation: livePulse 2s ease-in-out infinite;
  }
  @keyframes livePulse { 50% { opacity: 0.35; } }
  .live-title { font-size: 15px; font-weight: 700; }
  .live-clock { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .live-note { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
  .live-list { list-style: none; margin: 0; padding: 0; max-height: 420px; overflow-y: auto; }
  .live-list li {
    display: grid; grid-template-columns: 44px auto 1fr auto; gap: 10px;
    align-items: baseline; padding: 7px 0; border-bottom: 1px dashed var(--border);
    font-size: 13.5px; line-height: 1.6;
  }
  .live-list li:last-child { border-bottom: none; }
  .lv-time { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .lv-name { font-weight: 700; white-space: nowrap; }
  .lv-text { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .lv-link { white-space: nowrap; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  article em { color: var(--muted); }
  blockquote { margin: 0.8em 0; padding: 2px 16px; border-left: 3px solid var(--accent); color: var(--muted); }

  /* ---------- avatars ---------- */
  p.has-avatar { display: flow-root; }
  .avatar {
    float: left; width: 48px; height: 48px; border-radius: 50%;
    margin: 4px 14px 3px 0; border: none;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.14);
  }

  /* ---------- product knowledge panel ---------- */
  .prod {
    border-bottom: 1.5px dotted rgba(0, 113, 227, 0.55);
    cursor: pointer; transition: background 0.15s ease;
  }
  .prod:hover, .prod.active { background: rgba(0, 113, 227, 0.08); }
  .prod-panel {
    position: fixed; z-index: 70; width: 330px;
    background: rgba(255, 255, 255, 0.92);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid var(--border); border-radius: 14px;
    padding: 14px 16px;
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.16);
  }
  .prod-panel[hidden] { display: none; }
  .pp-close {
    position: absolute; top: 8px; right: 12px; border: none; background: transparent;
    font-size: 18px; line-height: 1; color: var(--muted); cursor: pointer;
  }
  .pp-close:hover { color: var(--text); }
  .pp-name { font-weight: 700; font-size: 15px; margin-bottom: 6px; padding-right: 14px; }
  .pp-desc { font-size: 13px; line-height: 1.8; color: #48484a; }
  @media (max-width: 800px) {
    .prod-panel { left: 12px; right: 12px; top: auto; bottom: 90px; width: auto; }
  }

  /* ---------- source card: original post under the calendar ---------- */
  .src-link[data-tweet] { cursor: pointer; }
  .src-link.active { font-weight: 700; }
  .src-card {
    margin-top: 14px;
    background: rgba(255, 255, 255, 0.72);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(0, 0, 0, 0.05); border-radius: 18px;
    padding: 12px 12px 4px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.05);
    scroll-margin-top: 100px;
  }
  .sc-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 4px 8px;
  }
  .sc-title {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; font-weight: 700; color: var(--muted);
  }
  .sc-title svg { width: 12px; height: 12px; color: var(--text); flex: none; }
  .sc-close {
    border: none; background: transparent; cursor: pointer;
    font-size: 18px; line-height: 1; color: var(--muted);
    padding: 2px 6px; border-radius: 6px; transition: background 0.15s ease;
  }
  .sc-close:hover { color: var(--text); background: var(--soft); }
  .sc-body { overflow: hidden; border-radius: 12px; }
  .sc-body .twitter-tweet { margin: 0 !important; }
  .sc-body iframe { max-width: 100%; }
  @media (min-width: 801px) {
    /* the sticky sidebar must stay within the viewport once the source card
       grows it past one screen — scroll inside the column instead */
    .side:has(.src-card:not([hidden])) {
      max-height: calc(100vh - 116px);
      overflow-y: auto; scrollbar-width: thin;
    }
  }
  .sk {
    border: 1px solid var(--border); border-radius: 12px; padding: 14px;
  }
  .sk-row, .sk-ava {
    background: linear-gradient(90deg, #ececf0 25%, #f6f6f8 45%, #ececf0 65%);
    background-size: 200% 100%;
    animation: skshine 1.3s infinite linear;
  }
  .sk-row { height: 11px; border-radius: 6px; margin-bottom: 10px; }
  .sk-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .sk-ava { width: 40px; height: 40px; border-radius: 50%; flex: none; }
  @keyframes skshine { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  .sp-error {
    border: 1px solid var(--border); border-radius: 12px; padding: 18px 14px;
    text-align: center; color: var(--muted); font-size: 12.5px; line-height: 1.75;
  }
  .sp-error .btns { display: flex; gap: 8px; justify-content: center; margin-top: 12px; flex-wrap: wrap; }
  .sp-btn {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12.5px; font-weight: 600; line-height: 1.4;
    padding: 6px 15px; border-radius: 980px; cursor: pointer;
    color: #fff; background: var(--accent); border: none;
    text-decoration: none;
  }
  .sp-btn:hover { opacity: 0.85; }
  .sp-btn.ghost { color: var(--accent); background: transparent; border: 1px solid rgba(0, 113, 227, 0.4); }
  .sp-btn.ghost:hover { background: var(--soft); opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .sk-row, .sk-ava { animation: none; }
  }

  /* ---------- language toggle: frosted pill ---------- */
  body[data-lang="zh"] .lang-en { display: none; }
  body[data-lang="en"] .lang-zh { display: none; }
  body[data-lang="zh"] article.no-zh .lang-en { display: block; }
  body[data-lang="en"] article.no-en .lang-zh { display: block; }
  .lang-note {
    display: none; margin: 0 0 14px; padding: 10px 14px; font-size: 12.5px;
    color: var(--muted); background: var(--soft); border-radius: 10px;
  }
  body[data-lang="en"] article.no-en .lang-note:not(.note-zh) { display: block; }
  body[data-lang="zh"] article.no-zh .lang-note.note-zh { display: block; }
  .lang-switch {
    position: fixed; top: 16px; right: 16px; z-index: 50;
    display: flex; gap: 2px; padding: 3px;
    background: rgba(255, 255, 255, 0.72);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border: 1px solid rgba(0, 0, 0, 0.06); border-radius: 980px;
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  }
  .sw-btn {
    border: none; background: transparent; cursor: pointer;
    font-size: 12.5px; line-height: 1.3;
    padding: 4px 14px; border-radius: 980px; color: var(--muted);
  }
  .sw-btn:hover { color: var(--text); }
  .sw-btn.on { background: var(--accent); color: #fff; }

  footer.site { margin-top: 44px; text-align: center; font-size: 12px; color: var(--muted); }

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
    <div class="mast-meta"><span class="lang-zh">第 ${entries.length} 期 · 每天北京时间 6/10/12/16/20/24 点更新 · ${todayKey} 刊</span><span class="lang-en">Issue ${entries.length} · Refreshed 6×daily at 06/10/12/16/20/24 (GMT+8) · ${todayKey}</span></div>
  </div>

  <div class="layout">
    <main class="main">
      <section id="liveFeed" class="live" hidden>
        <div class="live-head">
          <span class="live-dot"></span>
          <span class="live-title"><span class="lang-zh">最新动态 · 实时</span><span class="lang-en">Live updates</span></span>
          <span class="live-clock" id="liveClock"></span>
        </div>
        <div class="live-note"><span class="lang-zh">中转站今天（北京时间）最新获取的原帖，尚未进入编辑摘要——定时运行后由摘要收录。</span><span class="lang-en">Newest raw posts from the relay (Beijing time), not yet covered by the editorial digests.</span></div>
        <ol class="live-list" id="liveList"></ol>
      </section>
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
      <div class="src-card" id="srcCard" hidden>
        <div class="sc-head">
          <span class="sc-title"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg><span class="lang-zh">原帖</span><span class="lang-en">Original post</span></span>
          <button class="sc-close" id="spClose" type="button" aria-label="关闭 / Close">×</button>
        </div>
        <div class="sc-body" id="spBody"></div>
      </div>
    </aside>
  </div>

  <aside class="prod-panel" id="prodPanel" hidden>
    <button class="pp-close" id="ppClose" type="button" aria-label="关闭">×</button>
    <div class="pp-name" id="ppName"></div>
    <div class="pp-desc" id="ppDesc"></div>
  </aside>
  <footer class="site">Generated through the Follow Builders skill · <a href="https://github.com/zarazhangrui/follow-builders">zarazhangrui/follow-builders</a></footer>
</div>
<script>
const DIGEST_DATES = ${datesJson};
const TODAY_KEY = ${JSON.stringify(todayKey)};
const PRODUCT_KB = ${JSON.stringify(PRODUCT_KB)};
const LATEST_KEY = ${JSON.stringify(latestKey)};

// ---------- 中转站实时内容：每次打开页面拉取最新原帖 ----------
// 只展示北京时间"今天"的、且尚未被任何期号收录（页面上无对应链接）的帖子；
// 按发帖时间（北京时间）倒序。拉取失败时静默隐藏，不影响正文阅读。
(async () => {
  try {
    const BJ = 8 * 3600e3;
    const bjDay = (ms) => new Date(ms + BJ).toISOString().slice(0, 10);
    const bjHM = (ms) => new Date(ms + BJ).toISOString().slice(11, 16);
    const nowDay = bjDay(Date.now());
    const base = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/';
    const [xr, pr] = await Promise.all([fetch(base + 'feed-x.json'), fetch(base + 'feed-podcasts.json')]);
    if (!xr.ok) return;
    const data = await xr.json();
    const pods = pr.ok ? (await pr.json()).podcasts || [] : [];
    const known = new Set([...document.querySelectorAll('a.src-link')].map((a) => a.href));
    const items = [];
    for (const b of data.x || []) {
      for (const t of b.tweets || []) {
        if (!t.url || !t.createdAt) continue;
        const ms = Date.parse(t.createdAt);
        if (!ms || bjDay(ms) !== nowDay) continue;
        if (known.has(t.url)) continue;
        items.push({ ms, name: b.name, text: (t.text || '').replace(/https:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 220), url: t.url });
      }
    }
    for (const p of pods) {
      if (!p.url || !p.publishedAt) continue;
      const ms = Date.parse(p.publishedAt);
      if (!ms || bjDay(ms) !== nowDay) continue;
      if (known.has(p.url)) continue;
      items.push({ ms, name: p.name, text: (p.title || '').replace(/\s+/g, ' ').trim().slice(0, 220), url: p.url });
    }
    if (!items.length) return;
    items.sort((a, b) => b.ms - a.ms);
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    document.getElementById('liveList').innerHTML = items.slice(0, 40).map((it) =>
      '<li><span class="lv-time">' + bjHM(it.ms) + '</span><span class="lv-name">' + esc(it.name || '') + '</span>' +
      '<span class="lv-text">' + esc(it.text) + '</span>' +
      '<a class="lv-link" href="' + it.url + '" target="_blank" rel="noopener"><span class="lang-zh">原文</span><span class="lang-en">open</span></a></li>'
    ).join('');
    document.getElementById('liveClock').textContent = bjHM(Date.now());
    document.getElementById('liveFeed').hidden = false;
  } catch (e) { console.warn('live feed unavailable:', e); }
})();

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
  var dayEmpty = document.getElementById('dayEmpty');
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
    markSel(k);
  }

  function showEmpty(k) {
    document.querySelectorAll('article.day').forEach(function (a) { a.classList.remove('active'); });
    dayEmpty.hidden = false;
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
    // [0-9] not \d — backslashes don't survive this template literal
    var m = location.hash.match(/^#d-([0-9]{4}-[0-9]{2}-[0-9]{2})$/);
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

// product knowledge panel (click underlined product -> right info card)
(function () {
  var panel = document.getElementById('prodPanel');
  if (!panel) return;
  var nameEl = document.getElementById('ppName');
  var descEl = document.getElementById('ppDesc');
  function mark(key) {
    var all = document.querySelectorAll('.prod');
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle('active', all[i].getAttribute('data-prod') === key);
    }
  }
  function place(anchor) {
    var r = anchor.getBoundingClientRect();
    var w = panel.offsetWidth || 330;
    panel.style.maxWidth = Math.min(330, window.innerWidth - 24) + 'px';
    var left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - w - 12));
    var top = r.bottom + 10;
    var h = panel.offsetHeight;
    if (top + h > window.innerHeight - 12) top = Math.max(12, r.top - h - 10);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  function open(key, anchor) {
    var p = PRODUCT_KB[key];
    if (!p) return;
    nameEl.textContent = p.name;
    descEl.textContent = p.desc;
    panel.hidden = false;
    if (anchor) place(anchor); else { panel.style.left = '16px'; panel.style.top = '104px'; }
    mark(key);
  }
  function close() {
    panel.hidden = true;
    mark('');
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    while (t && t.classList && !t.classList.contains('prod') && t !== document.body) t = t.parentNode;
    if (t && t.classList && t.classList.contains('prod')) { open(t.getAttribute('data-prod'), t); return; }
    if (!panel.hidden && !(t && t.closest && t.closest('#prodPanel'))) close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  document.getElementById('ppClose').addEventListener('click', close);
})();

// source card: open the original X post under the calendar in the sidebar
// instead of leaving the page. Renders the official embed via widgets.js (the
// syndication JSON API is CORS-locked to platform.twitter.com, so embeds are
// the only client-side option). Falls back to an "open on X" card when
// unreachable.
(function () {
  var card = document.getElementById('srcCard');
  if (!card) return;
  var body = document.getElementById('spBody');
  var loadSeq = 0;   // guards stale async results after switching tweets
  var lastId = '';
  var lastUrl = '';

  var ZH = {
    netfail: '暂时无法连接到 X，请检查网络（或代理）后重试。',
    fail: '原帖加载失败，可能已被删除或设置了访问限制。',
    retry: '重试',
    open: '在 X 打开'
  };
  var EN = {
    netfail: 'Could not reach X right now — check your network (or proxy) and retry.',
    fail: 'Could not load this post — it may have been deleted or made private.',
    retry: 'Retry',
    open: 'Open on X'
  };
  function t(key) { return (document.body.dataset.lang === 'en' ? EN : ZH)[key]; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function mark(id) {
    var all = document.querySelectorAll('.src-link[data-tweet]');
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle('active', all[i].getAttribute('data-tweet') === id);
    }
  }

  function show() {
    if (!card.hidden) return;
    card.hidden = false;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function close() {
    if (card.hidden) return;
    card.hidden = true;
    mark('');
    body.innerHTML = '';
  }

  // ---- widgets.js loader: injected once, on first use ----
  var wjsState = 0; // 0 idle, 1 loading, 2 ready, 3 failed
  var wjsWaiters = [];
  function ensureWidgets() {
    if (wjsState === 2) return Promise.resolve();
    if (wjsState === 3) return Promise.reject(new Error('widgets.js unavailable'));
    return new Promise(function (resolve, reject) {
      wjsWaiters.push([resolve, reject]);
      if (wjsState === 1) return;
      wjsState = 1;
      var s = document.createElement('script');
      s.id = 'sp-wjs';
      s.src = 'https://platform.twitter.com/widgets.js';
      s.async = true;
      s.charset = 'utf-8';
      s.onload = function () {
        if (!window.twttr || !window.twttr.widgets) { settle(3); return; }
        settle(2);
      };
      s.onerror = function () { settle(3); };
      document.head.appendChild(s);
      setTimeout(function () { if (wjsState === 1) settle(3); }, 12000);
      function settle(state) {
        if (wjsState === 2 || wjsState === 3) return;
        wjsState = state;
        wjsWaiters.forEach(function (w) { state === 2 ? w[0]() : w[1](new Error('widgets.js unavailable')); });
        wjsWaiters = [];
      }
    });
  }

  function skeleton() {
    var row = '<div class="sk-row"></div>';
    return '<div class="sk">'
      + '<div class="sk-head"><span class="sk-ava"></span><span class="sk-row" style="flex:1;margin:0"></span></div>'
      + row + row + '<div class="sk-row" style="width:72%"></div>'
      + '<div class="sk-row" style="height:120px;border-radius:10px;margin-top:14px"></div>'
      + '</div>';
  }

  function errorHtml(msgKey) {
    return '<div class="sp-error"><div>' + esc(t(msgKey)) + '</div><div class="btns">'
      + '<button type="button" class="sp-btn" id="spRetry">' + esc(t('retry')) + '</button>'
      + '<a class="sp-btn ghost" href="' + esc(lastUrl || ('https://x.com/i/web/status/' + lastId)) + '" target="_blank" rel="noopener">' + esc(t('open')) + ' ↗</a>'
      + '</div></div>';
  }

  function load(id, url) {
    if (!/^[0-9]+$/.test(id)) return;
    lastId = id;
    if (url) lastUrl = url;
    var seq = ++loadSeq;
    mark(id);
    show();
    body.scrollTop = 0;
    body.innerHTML = skeleton();
    if (wjsState === 3) wjsState = 0; // retry may follow a network recovery
    ensureWidgets().then(function () {
      if (seq !== loadSeq) return;
      var holder = document.createElement('div');
      body.innerHTML = '';
      body.appendChild(holder);
      var settled = false;
      var opts = {
        conversation: 'none',
        dnt: true,
        align: 'center',
        theme: 'light',
        lang: document.body.dataset.lang === 'en' ? 'en' : 'zh-cn',
        width: Math.min(550, Math.max(200, (body.clientWidth || 236) - 2))
      };
      try {
        var p = window.twttr.widgets.createTweet(id, holder, opts);
        if (p && typeof p.then === 'function') {
          p.then(function () { settled = true; }).catch(function () {
            if (seq === loadSeq) body.innerHTML = errorHtml('fail');
          });
        }
      } catch (e) {
        body.innerHTML = errorHtml('fail');
        return;
      }
      setTimeout(function () {
        if (seq !== loadSeq || settled) return;
        // an iframe exists as soon as createTweet runs; only a real render
        // gives it height. Still 0-height after 12s = stuck or unreachable:
        // append a recovery card but keep watching — a late render removes it.
        var f = holder.querySelector('iframe');
        if (!f || f.getBoundingClientRect().height < 40) {
          var err = document.createElement('div');
          err.innerHTML = errorHtml('netfail');
          body.appendChild(err);
          var watch = setInterval(function () {
            if (seq !== loadSeq || !err.parentNode) { clearInterval(watch); return; }
            var ff = holder.querySelector('iframe');
            if (ff && ff.getBoundingClientRect().height >= 40) { err.remove(); clearInterval(watch); }
          }, 800);
        }
      }, 12000);
    }).catch(function () {
      if (seq === loadSeq) body.innerHTML = errorHtml('netfail');
    });
  }

  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!(el && el.closest)) return;
    var chip = el.closest('a.src-link[data-tweet]');
    if (chip) {
      e.preventDefault();
      load(chip.getAttribute('data-tweet'), chip.getAttribute('href'));
      return;
    }
    if (el.closest('#spClose')) { close(); return; }
    if (el.closest('#spRetry')) { load(lastId, lastUrl); return; }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
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

  // 原子写入：先写临时文件再改名，避免构建期间被请求读到半截文件
  await writeFile(OUT + '.tmp', html, 'utf-8');
  await rename(OUT + '.tmp', OUT);
  console.log(`OK ${OUT} — ${entries.length} digest(s), latest: ${entries[0]?.key || 'none'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
