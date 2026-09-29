#!/usr/bin/env node
// ============================================================================
// AI Builders Digest — Remix（自有管线，无 skill 依赖）
// ----------------------------------------------------------------------------
// 职责：
// 1. 读取 feed.json（prepare-digest.js 抓取的内容快照）
// 2. 找出存档中缺失的日期，逐日生成期号（DeepSeek 优先，无 Key 时降级简报）
//    - 每天早上 8:00（北京）的运行补齐前一天缺失的期号
//    - 每天 20:00（北京）的运行用当天累积的内容刷新当日期号
// 3. 用 feed 时间戳去重：同一快照不重复生成
// 4. 中英双语写入月度文件（digests/YYYY-MM.zh.md / .en.md）
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir); // 仓库根（site/）
const DIGEST_DIR = join(root, 'digests');

const log = (...a) => console.log('[remix]', ...a);

// ---------- feed 端点（可在 site/config/feeds.json 自主更换） ----------

let FEEDS = {
  x: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
  podcasts: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
  blogs: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json',
};
try {
  const cfg = JSON.parse(await readFile(join(root, 'config', 'feeds.json'), 'utf-8'));
  FEEDS = { ...FEEDS, ...cfg };
} catch {}

// ---------- LLM providers（DeepSeek 优先，智谱备用） ----------

function llmProvider() {
  if (process.env.DEEPSEEK_API_KEY) {
    return { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key: process.env.DEEPSEEK_API_KEY };
  }
  if (process.env.ZHIPU_API_KEY) {
    return { name: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-flash', key: process.env.ZHIPU_API_KEY };
  }
  return null;
}

async function callOpenAICompatible(name, baseUrl, model, key, system, user) {
  try {
    const res = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      log(name, 'HTTP', res.status, '- falling back');
      return null;
    }
    const data = await res.json();
    let text = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
    text = text.replace(/^```(?:markdown)?\n?/, '').replace(/\n?```\s*$/, '').trim();
    return text || null;
  } catch (e) {
    log(name, 'call failed:', e.message, '- falling back');
    return null;
  }
}

// ---------- 编辑规则 ----------

const ZH_RULES = `你是「AI Builders Digest」的编辑，把给定的 AI builder 动态 JSON 改写成当天摘要的小节正文。硬性规则：
1. 只使用 JSON 里的内容，绝不编造；每条动态末尾独占一行放 JSON 给出的原文 URL，没有 URL 的内容不要收录。
2. 不使用 @ 句柄（写姓名全称）；职位头衔只用 JSON bio 字段给的，否则只写姓名。
3. 不用破折号连接句子；技术名词（AI、agent、LLM、stablecoin 等）、人名、公司名、URL 保留英文。
4. 元数据行，按顺序共 5 行（都独占一行）：
   keywords: 关键词1 | 关键词2 | 关键词3（3 个代表当天热点的短关键词）
   headline: 当天大标题（杂志封面风，中文不超过 18 字，有张力、能概括当天最大主线）
   deck: 副题（40-60 字，一句话点出当天两三条主线，设置悬念）
   quote: 当天最带劲/最有观点的一句原话（中文翻译），没有合适的就留空
   quoteBy: 说这句话的人 · 其职位（来自 bio 字段），quote 为空则此行留空
5. 之后依次为小节："## 🧭 今日洞察"（内含 **核心洞察**：2-3 句总结今天大家在讨论什么、有什么趋势在形成；**TOP 3 热点话题**：有序列表 1. 2. 3.，每项 **加粗话题名** — 一句概括并点出来源）、"## 𝕏 / TWITTER"（每位有实质动态的 builder 一段，2-4 句概括，正文用 **加粗** 标注关键产品/协议/概念，数字如 76%、30¢ 原样保留）、有博客时 "## 📰 OFFICIAL BLOGS"、有播客时 "## 🎙 PODCASTS"（200-400 字，含一句最 memorable 的直接引语，开头给一句话要点）。
6. 闲聊、纯宣传、拉票推文跳过；没提的 builder 不要出现。
7. 不要输出 "## 日期" 格式的标题（如 ## 2026-09-23），直接从 keywords 行开始；不要输出任何解释、前言或代码围栏。`;

const EN_RULES = `You are the editor of "AI Builders Digest". Rewrite the given AI-builder activity JSON into the day's digest section body. Hard rules:
1. Use ONLY content from the JSON; never invent. End every item with its original URL from the JSON on its own line; drop items without a URL.
2. Never use @handles (write full names); only use job titles given in the JSON bio field, otherwise just the name.
3. No em-dashes; keep technical terms (AI, agent, LLM, stablecoin...), names, and URLs in English as-is.
4. Metadata lines, 5 lines in this order (each on its own line):
   keywords: kw1 | kw2 | kw3 (three short keywords representing today's hot topics)
   headline: the day's big magazine-cover headline (max ~10 words, punchy, captures the main storyline)
   deck: a 25-40 word sub-headline touching the day's two or three main threads, leaving some suspense
   quote: the most striking original quote of the day, translated to English; leave empty if none fits
   quoteBy: speaker · title (from the bio field); leave empty if quote is empty
5. Then sections in order: "## 🧭 Daily Insights" (with **Core insight**: 2-3 sentences on what everyone is discussing and what trend is forming), "## 𝕏 / TWITTER" (one 2-4 sentence paragraph per builder with substantive posts, **bold** key products/protocols/concepts in the text, keep numbers like 76%, 30¢ as-is), "## 📰 OFFICIAL BLOGS" if blogs exist, "## 🎙 PODCASTS" if podcasts exist (200-400 words, one memorable direct quote, lead with a one-sentence takeaway).
6. Skip small talk, pure promotion, engagement bait; builders without substance do not appear.
7. Do NOT output a "## date" style heading (like ## 2026-09-23); start directly from the keywords line. No explanations, preamble, or code fences.`;

// ---------- 降级简报（无 API Key） ----------

function shortBio(bio) {
  return (bio || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 42);
}

function fallbackBody(stats, compact) {
  const lines = [];
  lines.push('keywords: 自动简报');
  lines.push('');
  lines.push('## 🧭 今日洞察');
  lines.push('');
  lines.push(`**核心洞察**：本条为自动简报模式（未配置 LLM API Key），列出今日追踪对象的全部新动态：${stats.totalTweets} 条推文、${stats.blogPosts} 篇博客、${stats.podcastEpisodes} 期播客。配置 API Key 后将自动生成完整洞察版。`);
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

// ---------- 月度文件工具 ----------

const dayHeaderRe = /^## \d{4}-\d{2}-\d{2}\s*$/;

function parseKeywords(md) {
  const m = md.match(/^keywords:\s*(.+)\s*$/m);
  if (!m) return [];
  return m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3);
}

// 把 target 日期的小节（header + section）合并进月度文本：存在则替换，否则追加
function mergeIntoDate(text, dateKey, section) {
  const header = `## ${dateKey}`;
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
  return base ? `${base}\n\n${section}` : section;
}

// ---------- 主流程 ----------

const feed = JSON.parse(await readFile(join(process.cwd(), 'feed.json'), 'utf-8'));
const stats = feed.stats || {};
const FEED_STAMP = feed.generatedAt || new Date().toISOString();
log('feed stats:', JSON.stringify(stats), '| stamp:', FEED_STAMP);
if (!stats.xBuilders && !stats.podcastEpisodes && !stats.blogPosts) {
  log('EMPTY feed - nothing to do');
  process.exit(0);
}

const compact = {
  date: FEED_STAMP.slice(0, 10),
  x: (feed.x || []).map((b) => ({
    name: b.name,
    bio: b.bio || "",
    tweets: (b.tweets || []).map((t) => ({ text: t.text, url: t.url })),
  })),
  podcasts: (feed.podcasts || []).map((p) => ({
    name: p.name, title: p.title, url: p.url,
    transcript: (p.transcript || "").slice(0, 30000),
  })),
  blogs: (feed.blogs || []).map((b) => ({
    name: b.name, title: b.title, url: b.url, author: b.author || "",
    description: b.description || "", content: (b.content || "").slice(0, 2500),
  })),
};
const feedText = JSON.stringify(compact);

const now = new Date();
const TODAY = now.toISOString().slice(0, 10);
const month = TODAY.slice(0, 7);
const YD = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
const YESTERDAY = YD.toISOString().slice(0, 10);

function parseKeywordsLocal(md) {
  const m = md.match(/^keywords:\s*(.+)\s*$/m);
  if (!m) return [];
  return m[1].split("|").map((s) => s.trim()).filter(Boolean).slice(0, 3);
}

function mergeIntoDateLocal(text, dateKey, section) {
  const header = "## " + dateKey;
  const lines = text.split("\n");
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
  if (replaced) return out.join("\n");
  const base = text.trimEnd();
  return base ? base + "\n\n" + section : section;
}

async function writeDay(lang, dateKey, body) {
  const file = join(DIGEST_DIR, month + "." + lang + ".md");
  let text = existsSync(file) ? await readFile(file, "utf-8") : "# AI Builders Digest - " + month;
  const section = mergeIntoDateLocal(text, dateKey, body);
  await mkdir(DIGEST_DIR, { recursive: true });
  const reRead = await readFile(file, "utf-8");
  await writeFile(file, mergeIntoDateLocal(reRead, dateKey, body), "utf-8");
}

log("multi-day edition pass complete for", TODAY);
