#!/usr/bin/env node
// ============================================================================
// Ai News — Remix（自有管线，无 skill 依赖）
// ----------------------------------------------------------------------------
// 职责：
// 1. 读取 feed.json（prepare-digest.js 抓取的内容快照）
// 2. 找出存档中缺失的日期，逐日生成期号（DeepSeek 优先，无 Key 时降级简报）
//    - 每天早上 8:00（北京）的运行补齐前一天缺失的期号
//    - 每天 20:00（北京）的运行用当天累积的内容刷新当日期号
// 3. 用 feed 时间戳去重：同一快照不重复生成
// 4. 中英双语写入月度文件（digests/YYYY-MM.zh.md / .en.md）
// ============================================================================

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
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

function llmProviders() {
  const providers = [];
  if (process.env.DEEPSEEK_API_KEY) {
    providers.push({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', key: process.env.DEEPSEEK_API_KEY });
  }
  if (process.env.ZHIPU_API_KEY) {
    providers.push({ name: 'Zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.5-flash', key: process.env.ZHIPU_API_KEY });
  }
  return providers;
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

async function llm(system, user) {
  const providers = llmProviders();
  if (!providers.length) return null;
  for (const provider of providers) {
    const text = await callOpenAICompatible(provider.name, provider.baseUrl, provider.model, provider.key, system, user);
    if (text) return text;
  }
  return null;
}

// ---------- 编辑规则 ----------

const ZH_RULES = `你是「Ai News」的编辑，把给定的 AI builder 动态 JSON 改写成当天摘要的小节正文。硬性规则：
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

const EN_RULES = `You are the editor of "Ai News". Rewrite the given AI-builder activity JSON into the day's digest section body. Hard rules:
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
  lines.push(`**核心洞察**：本条为自动简报模式（LLM 生成暂不可用），列出今日追踪对象的全部新动态：${stats.totalTweets} 条推文、${stats.blogPosts} 篇博客、${stats.podcastEpisodes} 期播客。LLM 恢复后将自动生成完整洞察版。`);
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
      out.push(header);
      out.push(section.trimEnd());
      continue;
    }
    if (inSection && dayHeaderRe.test(line)) inSection = false;
    if (!inSection) out.push(line);
  }
  if (replaced) return out.join('\n');
  const base = text.trimEnd();
  return base ? `${base}\n\n${header}\n${section}` : `${header}\n${section}`;
}

// ---------- 主流程 ----------

const feed = JSON.parse(await readFile(join(process.cwd(), 'feed.json'), 'utf-8'));
const stats = feed.stats || {};
const FEED_STAMP = feed.generatedAt || new Date().toISOString();
// 中央快照的内容截止时间：期号戳与刷新守卫都用它（同一中央快照重复运行时不再重生成）
const CONTENT_THROUGH = feed.contentThrough || feed.stats?.feedGeneratedAt || FEED_STAMP;
log('feed stats:', JSON.stringify(stats), '| stamp:', FEED_STAMP);
if (!stats.xBuilders && !stats.podcastEpisodes && !stats.blogPosts) {
  log('EMPTY feed - nothing to do');
  process.exit(0);
}

const compact = {
  date: FEED_STAMP.slice(0, 10),
  generatedAt: FEED_STAMP,
  // 内容真实覆盖到的时间点（中央快照自己的生成时间），供完整日判定使用
  contentThrough: feed.contentThrough || feed.stats?.feedGeneratedAt || FEED_STAMP,
  x: (feed.x || []).map((b) => ({
    name: b.name,
    bio: b.bio || '',
    tweets: (b.tweets || []).map((t) => ({ text: t.text, url: t.url, createdAt: t.createdAt || '' })),
  })),
  podcasts: (feed.podcasts || []).map((p) => ({
    name: p.name, title: p.title, url: p.url, publishedAt: p.publishedAt || '',
    transcript: (p.transcript || '').slice(0, 30000),
  })),
  blogs: (feed.blogs || []).map((b) => ({
    name: b.name, title: b.title, url: b.url, author: b.author || '', publishedAt: b.publishedAt || '',
    description: b.description || '', content: (b.content || '').slice(0, 2500),
  })),
};

// ---------- 北京日期归属 ----------
// 用户要求帖子按其真实时间的北京日期归属期号，且页面始终展示北京时间下
// 最新的内容。中央 feed 每天约 06:45 UTC（北京 14:45）滚动更新一次，单份
// 24h 快照必然把"北京自然日"切在两份快照之间。把上一轮运行存档的快照
// （state/prev-feed.json，随仓库提交）与当前快照合并成 48h 窗口，每轮处理：
//   1. 窗口末端的北京日（"今天"）——每轮滚动刷新（部分日随中央快照累积），
//      让页面当天就能看到当天内容；
//   2. 更早的北京日——窗口完整覆盖时才定稿（昨天在 14:45 更新后即完整）。
// 帖子按 createdAt 的北京日期归组，不按 UTC 快照窗口切天。

const BJ_OFFSET_MS = 8 * 3600e3;
const bjDay = (iso) => (iso ? new Date(new Date(iso).getTime() + BJ_OFFSET_MS).toISOString().slice(0, 10) : '');

const STATE_FILE = join(root, 'state', 'prev-feed.json');
let prevSnap = null;
try {
  prevSnap = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
} catch {}

function mergeSnaps(a, b) {
  const snaps = [a, b].filter(Boolean);
  if (!snaps.length) return null;
  const xByName = new Map();
  for (const s of snaps) for (const bd of s.x || []) {
    if (!xByName.has(bd.name)) xByName.set(bd.name, { name: bd.name, bio: bd.bio || '', tweets: new Map() });
    const ent = xByName.get(bd.name);
    if (bd.bio && !ent.bio) ent.bio = bd.bio;
    for (const t of bd.tweets || []) if (t.url && !ent.tweets.has(t.url)) ent.tweets.set(t.url, t);
  }
  const dedupe = (key) => {
    const m = new Map();
    for (const s of snaps) for (const it of s[key] || []) if (it.url && !m.has(it.url)) m.set(it.url, it);
    return [...m.values()];
  };
  const stamps = snaps.map((s) => Date.parse(s.contentThrough || s.generatedAt || s.date || 0)).filter((n) => !Number.isNaN(n));
  return {
    generatedAt: new Date(Math.max(...stamps)).toISOString(),
    // 内容覆盖窗口：每份快照内容 = [中央生成时间 - lookback(24h), 中央生成时间]
    windowStart: new Date(Math.min(...stamps) - 24 * 3600e3).toISOString(),
    windowEnd: new Date(Math.max(...stamps)).toISOString(),
    x: [...xByName.values()].map((e) => ({ ...e, tweets: [...e.tweets.values()] })),
    podcasts: dedupe('podcasts'),
    blogs: dedupe('blogs'),
  };
}

const merged = mergeSnaps(prevSnap, compact);
if (!merged) {
  log('no snapshot data - nothing to do');
  process.exit(0);
}

// 每轮要生成/刷新的北京日（升序）：
// 1. 窗口末端所在的北京日（"今天"）——始终纳入，随中央快照累积滚动刷新，
//    保证页面展示的永远是北京时间下最新的内容；
// 2. 更早的北京日——仅当窗口已完整覆盖（24h 全在窗口内）时才定稿刷新，
//    防止用半截数据覆盖已完整的历史期号。
// 只检查窗口末端附近三天，陈旧 state 不会触发远古期号的重生成。
function actionableBeijingDays(win) {
  const startMs = Date.parse(win.windowStart);
  const endMs = Date.parse(win.windowEnd || win.generatedAt);
  const days = [];
  // 窗口末端（UTC 瞬间）+8h 后的日历日 = 它所在的北京日
  const latest = new Date(endMs + BJ_OFFSET_MS).toISOString().slice(0, 10);
  // 注意：候选 key 的日历偏移必须用纯日期运算（固定 Z 时区），
  // 一旦把北京午夜时间戳再 toISOString 就会整体错位一天
  const baseMs = Date.parse(latest + 'T00:00:00Z');
  for (let off = 0; off >= -2; off--) {
    const key = new Date(baseMs + off * 86400e3).toISOString().slice(0, 10);
    const dayStart = Date.parse(key + 'T00:00:00+08:00');
    const complete = dayStart >= startMs && dayStart + 24 * 3600e3 <= endMs;
    if (off === 0 || complete) days.push(key);
  }
  return [...new Set(days)].sort(); // 升序：先定稿更早的，最后刷新今天
}

function dayDataFor(dayKey) {
  const inDay = (iso) => bjDay(iso) === dayKey;
  const x = (merged.x || [])
    .map((b) => ({ name: b.name, bio: b.bio, tweets: (b.tweets || []).filter((t) => inDay(t.createdAt)) }))
    .filter((b) => b.tweets.length);
  const podcasts = (merged.podcasts || []).filter((p) => inDay(p.publishedAt));
  const blogs = (merged.blogs || []).filter((b) => inDay(b.publishedAt));
  const totalTweets = x.reduce((n, b) => n + b.tweets.length, 0);
  return {
    x, podcasts, blogs,
    stats: { totalTweets, blogPosts: blogs.length, podcastEpisodes: podcasts.length },
  };
}

// ---------- 产品名下划线 + 点击知识卡（渲染期注入，构建脚本负责） ----------

// （产品包裹由 build.mjs 在构建期完成，remix 只负责写 md）

// ---------- 生成与写入 ----------

async function writeDay(lang, dateKey, body) {
  const month = dateKey.slice(0, 7);
  const file = join(DIGEST_DIR, `${month}.${lang}.md`);
  let text = existsSync(file) ? await readFile(file, 'utf-8') : `# Ai News — ${month}`;
  const section = `${body.trim()}\n\nfeed: ${CONTENT_THROUGH}\n`;
  const lines = text.split('\n');
  const out = [];
  let inSection = false;
  let replaced = false;
  for (const line of lines) {
    if (line.trim() === `## ${dateKey}`) {
      inSection = true;
      replaced = true;
      // 保留天级标题行：build.mjs 与缺失日期检测都依赖 '## YYYY-MM-DD'
      out.push(`## ${dateKey}`);
      out.push(section.trimEnd());
      continue;
    }
    if (inSection && dayHeaderRe.test(line)) inSection = false;
    if (!inSection) out.push(line);
  }
  // 新日期：连同天级标题一起追加
  if (!replaced) out.push(`## ${dateKey}\n${section.trimEnd()}\n`);
  await mkdir(DIGEST_DIR, { recursive: true });
  await writeFile(file, out.join('\n'), 'utf-8');
}

// 读取某日期小节里记录的 feed 时间戳，无该日小节时返回 null
function dayStamp(text, dateKey) {
  const lines = text.split('\n');
  let inSection = false;
  const stamps = [];
  for (const line of lines) {
    if (line.trim() === `## ${dateKey}`) { inSection = true; continue; }
    if (inSection && dayHeaderRe.test(line)) break;
    if (inSection) {
      const m = line.match(/^feed:\s*(.+?)\s*$/);
      if (m) stamps.push(m[1]);
    }
  }
  return stamps.length ? stamps[stamps.length - 1] : null;
}

// ---------- 生成后 URL 修复 ----------
// LLM 偶尔漏掉条目末尾的原文 URL 行（2026-10 上旬连续多天如此，站点期号
// 因此没有"原文"按钮）。这里在写入前做确定性修复：给缺链接的 𝕏 段落补上
// 该 builder 在本快照里的推文 URL，播客/博客块缺链接时补条目 URL。只增不删。

function builderTweets(name, exclude, data) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  if (!n) return [];
  let cands = (data.x || []).filter((b) => norm(b.name) === n);
  if (!cands.length) cands = (data.x || []).filter((b) => norm(b.name).includes(n) || n.includes(norm(b.name)));
  const urls = [];
  for (const b of cands) for (const t of b.tweets) if (t.url && !exclude.has(t.url)) urls.push(t.url);
  return urls;
}

function repairUrls(body, source, data) {
  let added = 0;
  const sections = body.split(/\n(?=## )/);
  const out = sections.map((sec) => {
    if (/^## .*(TWITTER|PODCASTS|BLOGS)/i.test(sec) === false) return sec;
    if (/PODCASTS|BLOGS/i.test(sec)) {
      if (/https?:\/\//.test(sec)) return sec;
      const m = sec.match(/^\*\*([^*]+)\*\*/m) || sec.match(/([A-Za-z][A-Za-z0-9 .&']{2,40})/);
      if (!m) return sec;
      const norm = (s) => (s || '').toLowerCase();
      const pool = /PODCASTS/i.test(sec) ? (data.podcasts || []) : (data.blogs || []);
      let best = null, bestScore = 0;
      for (const it of pool) {
        let score = 0;
        for (const t of new Set(`${it.name}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))) if (norm(sec).includes(t)) score += 2;
        for (const t of new Set(`${it.title}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4))) if (norm(sec).includes(t)) score += 1;
        if (score > bestScore) { bestScore = score; best = it; }
      }
      if (best && bestScore >= 3) {
        added += 1;
        return sec.trimEnd() + '\n' + best.url + '\n';
      }
      log(`[repair] ${source}: ${sec.match(/^## [^\n]*/)[0]} 有块缺链接且无法匹配，保留原样`);
      return sec;
    }
    // 𝕏 小节：段落 = 连续非空行
    const lines = sec.split('\n');
    const res = [];
    let para = [];
    const seen = new Set();
    for (const line of lines) {
      if (line.trim() === '') {
        if (para.length) {
          const text = para.join('\n');
          if (!/https?:\/\//.test(text)) {
            const nameM = text.match(/^\*\*([^*]+)\*\*/) || text.match(/^([A-Za-z][A-Za-z0-9 .&']{2,40}?)[,，:：]/);
            if (nameM) {
              const urls = builderTweets(nameM[1], seen, data);
              if (urls.length) {
                para.push(...urls);
                urls.forEach((u) => seen.add(u));
                added += urls.length;
                log(`[repair] ${source}: "${nameM[1]}" +${urls.length} 条链接`);
              } else {
                log(`[repair] ${source}: "${nameM[1]}" 段落缺链接但快照中无其推文`);
              }
            } else {
              log(`[repair] ${source}: 段落缺链接且无 builder 名`);
            }
          }
          res.push(...para);
          para = [];
        }
        res.push(line);
      } else {
        para.push(line);
      }
    }
    if (para.length) res.push(...para);
    return res.join('\n');
  });
  return { body: out.join('\n'), added };
}

// 为目标日生成小节：DeepSeek 优先、Zhipu 备用；都失败时——
// 新日期写入降级简报，刷新已有日期则跳过（保留旧版，不用简报覆盖好内容）
async function generateEdition(dateKey, dayData, { refresh = false } = {}) {
  const feedText = JSON.stringify(dayData);
  const user = `Today is ${dateKey}. Feed JSON:\n${feedText}`;
  let zh = await llm(ZH_RULES, user);
  const llmOk = !!zh;
  if (!zh) {
    if (refresh) {
      log('refresh skipped, LLM unavailable for', dateKey);
      return;
    }
    zh = fallbackBody(dayData.stats, dayData);
  } else {
    zh = repairUrls(zh, `zh ${dateKey}`, dayData).body;
  }
  let en = llmOk ? await llm(EN_RULES, user) : null;
  if (en) en = repairUrls(en, `en ${dateKey}`, dayData).body;
  await writeDay('zh', dateKey, zh);
  if (en) await writeDay('en', dateKey, en);
  log('edition written:', dateKey, llmOk ? '(LLM)' : '(fallback)');
}

// 生成/刷新本轮所有可处理的北京日（升序：先定稿历史日，最后滚动刷新今天）；
// 已有期号且内容戳相同则跳过，避免同一天内重复空转
const days = actionableBeijingDays(merged);
log('actionable Beijing day(s):', days.join(', ') || '(none)');
let generated = 0;
for (const dayKey of days) {
  const dayData = dayDataFor(dayKey);
  if (!dayData.stats.totalTweets && !dayData.stats.blogPosts && !dayData.stats.podcastEpisodes) {
    log('skip', dayKey, '- no content in merged window');
    continue;
  }
  const monthFile = join(DIGEST_DIR, dayKey.slice(0, 7) + '.zh.md');
  let existing = null;
  try { existing = await readFile(monthFile, 'utf-8'); } catch {}
  const stamp = existing ? dayStamp(existing, dayKey) : null;
  if (stamp === CONTENT_THROUGH) {
    log('skip', dayKey, '- already generated from this snapshot');
    continue;
  }
  await generateEdition(dayKey, dayData, { refresh: !!stamp });
  generated += 1;
}

// 存档本轮快照，供下一轮合并出 48h 窗口
await mkdir(join(root, 'state'), { recursive: true });
await writeFile(STATE_FILE, JSON.stringify(compact), 'utf-8');

log('DONE:', generated, 'Beijing-day edition(s) generated/refreshed');
