#!/usr/bin/env node
// remix.mjs — turn feed.json into a daily digest section and merge it into
// the monthly digest files. Runs locally or inside GitHub Actions.
//
// - If ZHIPU_API_KEY is set, calls GLM (glm-4.5-flash) to write the polished
//   zh + en digests in the house format.
// - Otherwise writes a simple deterministic zh briefing, so the archive never
//   misses a day; the local machine upgrades it to the full version later.
// - Skips entirely when today's section already exists (idempotent).

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> repo root
const DIGEST_DIR = join(root, 'digests');
const date = new Date().toISOString().slice(0, 10);
const month = date.slice(0, 7);

const log = (...a) => console.log('[remix]', ...a);

// ---------- monthly file helpers ----------

const dayHeaderRe = /^## \d{4}-\d{2}-\d{2}\s*$/;

function mergeInto(text, body) {
  const header = `## ${date}`;
  const section = `${header}\n\n${body.trim()}\n`;
  const lines = text.split('\n');
  const out = [];
  let inSection = false;
  let replaced = false;
  for (const line of lines) {
    if (line.trim() === header) {
      inSection = true;
      replaced = true;
      out.push(section.trimEnd());
      continue;
    }
    if (inSection && dayHeaderRe.test(line)) inSection = false;
    if (!inSection) out.push(line);
  }
  if (replaced) return out.join('\n');
  const base = text.trimEnd();
  return base ? `${base}\n\n${section}` : `# AI Builders Digest — ${month}\n\n${section}`;
}

async function writeDay(lang, body) {
  const file = join(DIGEST_DIR, `${month}.${lang}.md`);
  let text = existsSync(file) ? await readFile(file, 'utf-8') : `# AI Builders Digest — ${month}`;
  await writeFile(file, mergeInto(text, body), 'utf-8');
}

async function hasToday() {
  const file = join(DIGEST_DIR, `${month}.zh.md`);
  if (!existsSync(file)) return false;
  const text = await readFile(file, 'utf-8');
  return new RegExp(`^## ${date}\\s*$`, 'm').test(text);
}

// ---------- GLM API ----------

const ZH_RULES = `你是「AI Builders Digest」的编辑，把给定的 AI builder 动态 JSON 改写成当天摘要的小节正文。硬性规则：
1. 只使用 JSON 里的内容，绝不编造；每条动态末尾独占一行放 JSON 给出的原文 URL，没有 URL 的内容不要收录。
2. 不使用 @ 句柄（写姓名全称）；职位头衔只用 JSON bio 字段给的，否则只写姓名。
3. 不用破折号连接句子；技术名词（AI、agent、LLM、stablecoin 等）、人名、公司名、URL 保留英文。
4. 输出第一行是 keywords: 关键词1 | 关键词2 | 关键词3（3 个代表当天热点的短关键词）。
5. 之后依次为小节："## 🧭 今日洞察"（内含 **核心洞察**：2-3 句总结今天大家在讨论什么、有什么趋势在形成；**TOP 3 热点话题**：有序列表 1. 2. 3.，每项 **加粗话题名** — 一句概括并点出来源）、"## 𝕏 / TWITTER"（每位有实质动态的 builder 一段，2-4 句概括，正文用 **加粗** 标注关键产品/协议/概念，数字如 76%、30¢ 原样保留）、有博客时 "## 📰 OFFICIAL BLOGS"、有播客时 "## 🎙 PODCASTS"（200-400 字，含一句最 memorable 的直接引语，开头给一句话要点）。
6. 闲聊、纯宣传、拉票推文跳过；没提的 builder 不要出现。
7. 不要输出 "## 日期" 格式的标题（如 ## 2026-09-23），直接从 keywords 行开始；不要输出任何解释、前言或代码围栏。`;

const EN_RULES = `You are the editor of "AI Builders Digest". Rewrite the given AI-builder activity JSON into the day's digest section body. Hard rules:
1. Use ONLY content from the JSON; never invent. End every item with its original URL from the JSON on its own line; drop items without a URL.
2. Never use @handles (write full names); only use job titles given in the JSON bio field, otherwise just the name.
3. No em-dashes; keep technical terms (AI, agent, LLM, stablecoin...), names, and URLs in English as-is.
4. First line: keywords: kw1 | kw2 | kw3 (three short keywords representing today's hot topics).
5. Then sections in order: "## 🧭 Daily Insights" (with **Core insight**: 2-3 sentences on what everyone is discussing and what trend is forming; **Top 3 topics**: ordered list 1. 2. 3., each **bold topic name** — one-line summary with sources), "## 𝕏 / TWITTER" (one 2-4 sentence paragraph per builder with substantive posts, **bold** key products/protocols/concepts in the text, keep numbers like 76%, 30¢ as-is), "## 📰 OFFICIAL BLOGS" if blogs exist, "## 🎙 PODCASTS" if podcasts exist (200-400 words, one memorable direct quote, lead with a one-sentence takeaway).
6. Skip small talk, pure promotion, engagement bait; builders without substance do not appear.
7. Do NOT output a "## date" style heading (like ## 2026-09-23); start directly from the keywords line. No explanations, preamble, or code fences.`;

async function glm(system, user) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'glm-4.5-flash',
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      log('GLM HTTP', res.status, '— falling back');
      return null;
    }
    const data = await res.json();
    let text = data.choices?.[0]?.message?.content || '';
    text = text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```\s*$/, '').trim();
    return text || null;
  } catch (e) {
    log('GLM call failed:', e.message, '— falling back');
    return null;
  }
}

// ---------- deterministic fallback (no API key) ----------

function shortBio(bio) {
  return (bio || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 42);
}

function fallbackBody(stats, compact) {
  const lines = [];
  lines.push('keywords: 自动简报');
  lines.push('');
  lines.push('## 🧭 今日洞察');
  lines.push('');
  lines.push(`**核心洞察**：本条为自动简报模式（未配置 LLM API Key），列出今日追踪对象的全部新动态：${stats.totalTweets} 条推文、${stats.blogPosts} 篇博客、${stats.podcastEpisodes} 期播客。配置 ZHIPU_API_KEY 后将自动生成完整洞察版；电脑开机时的本地任务也会把当天简报升级为完整版。`);
  lines.push('');
  lines.push('## 𝕏 / TWITTER');
  lines.push('');
  for (const b of compact.x) {
    if (!b.tweets.length) continue;
    lines.push(`**${b.name}**${shortBio(b.bio) ? `（${shortBio(b.bio)}）` : ''}：`);
    for (const t of b.tweets) {
      lines.push(`- ${t.text.replace(/\s+/g, ' ').slice(0, 220)} ${t.url}`);
    }
    lines.push('');
  }
  if (compact.blogs.length) {
    lines.push('## 📰 OFFICIAL BLOGS');
    lines.push('');
    for (const b of compact.blogs) {
      lines.push(`**${b.name}**：${b.title || ''}`);
      lines.push(b.url || '');
      lines.push('');
    }
  }
  if (compact.podcasts.length) {
    lines.push('## 🎙 PODCASTS');
    lines.push('');
    for (const p of compact.podcasts) {
      lines.push(`**${p.name}**：${p.title || ''}`);
      lines.push(p.url || '');
      lines.push('');
    }
  }
  lines.push('*Generated through the Follow Builders skill: https://github.com/zarazhangrui/follow-builders*');
  return lines.join('\n');
}

// ---------- main ----------

const feed = JSON.parse(await readFile(join(process.cwd(), 'feed.json'), 'utf-8'));
const stats = feed.stats || {};
log('feed stats:', JSON.stringify(stats));
if (!stats.xBuilders && !stats.podcastEpisodes && !stats.blogPosts) {
  log('EMPTY feed — nothing to do');
  process.exit(0);
}
if (await hasToday()) {
  log('today already exists — skip');
  process.exit(0);
}

const compact = {
  date,
  x: (feed.x || []).map((b) => ({
    name: b.name,
    bio: b.bio || '',
    tweets: (b.tweets || []).map((t) => ({ text: t.text, url: t.url })),
  })),
  podcasts: (feed.podcasts || []).map((p) => ({
    name: p.name, title: p.title, url: p.url,
    transcript: (p.transcript || '').slice(0, 30000),
  })),
  blogs: (feed.blogs || []).map((b) => ({
    name: b.name, title: b.title, url: b.url, author: b.author || '',
    description: b.description || '', content: (b.content || '').slice(0, 2500),
  })),
};
const feedText = JSON.stringify(compact);

let zhBody = null;
let enBody = null;
if (process.env.ZHIPU_API_KEY) {
  zhBody = await glm(ZH_RULES, `Today is ${date}. Feed JSON:\n${feedText}`);
  if (zhBody) enBody = await glm(EN_RULES, `Today is ${date}. Feed JSON:\n${feedText}`);
} else {
  log('ZHIPU_API_KEY not set — using fallback briefing');
}

if (zhBody) {
  await writeDay('zh', zhBody);
  log('zh: LLM digest written');
} else {
  await writeDay('zh', fallbackBody(stats, compact));
  log('zh: fallback briefing written');
}
if (enBody) {
  await writeDay('en', enBody);
  log('en: LLM digest written');
} else {
  log('en: skipped (LLM unavailable)');
}
log('DONE');
