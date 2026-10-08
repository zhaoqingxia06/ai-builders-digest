#!/usr/bin/env node
// ============================================================================
// backfill-urls.mjs — 修复历史期号缺失的原文链接
// ----------------------------------------------------------------------------
// 背景：remix 的 LLM 输出偶尔漏掉条目末尾的 URL 行（管线早期无校验），
// 导致站点上对应期号没有"原文"按钮。中央仓库 zarazhangrui/follow-builders
// 的 feed-*.json 有完整的每日 git 历史，本脚本按期号里的 feed: 时间戳
// 找到当天实际使用的快照，把 builder 名下的推文/播客/博客 URL 回填到
// 缺失的段落末尾（build.mjs 会把段落末尾的裸 URL 行渲染成来源按钮）。
//
// 用法：
//   node scripts/backfill-urls.mjs            # dry-run，只打印报告
//   node scripts/backfill-urls.mjs --apply    # 实际写回 digests/*.md
//
// 规则：
// - 只给"完全没有 URL 行"的段落补链接；已有链接的段落不动。
// - 回填的 URL 会先对整份语言文件去重（同一 URL 不出现在两个日期里）。
// - 快照匹配失败的 builder 会列出，留人工处理。
// ============================================================================

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = dirname(scriptDir);
const DIGEST_DIR = join(root, 'digests');
const APPLY = process.argv.includes('--apply');
const CACHE = '/tmp/fb-feed-snapshots';

// 中央仓库每日快照（commit sha + 提交时间 UTC）。feed 每天 06:45 左右更新一次，
// 期号的 feed: 时间戳落在哪个更新窗口，用的就是哪份快照。
const SNAPSHOTS = [
  { sha: '1cddcd628f42c4ee1ce53e593f2b7ba1a99e19b0', at: '2026-09-21T06:52:55Z' },
  { sha: 'ff1603c1ee', at: '2026-09-22T06:42:09Z' },
  { sha: 'a0f699416f', at: '2026-09-23T06:42:41Z' },
  { sha: 'aa33329260', at: '2026-09-24T06:42:43Z' },
  { sha: 'e2a0a19119', at: '2026-09-25T06:44:00Z' },
  { sha: 'ff444307fd', at: '2026-09-26T06:39:58Z' },
  { sha: '7bdcbc9ac2', at: '2026-09-27T06:41:13Z' },
  { sha: 'd24368c962', at: '2026-09-28T06:57:33Z' },
  { sha: 'ee02f51ff2', at: '2026-09-29T06:45:23Z' },
  { sha: '80babcc65f', at: '2026-09-30T06:45:27Z' },
  { sha: '9aa4eece1f', at: '2026-10-01T06:46:37Z' },
  { sha: 'eaa6b60e0d', at: '2026-10-02T06:45:43Z' },
  { sha: '7a40ea8846', at: '2026-10-03T06:49:27Z' },
  { sha: 'ec5b50e312', at: '2026-10-04T08:22:09Z' },
  { sha: 'b7c20ee8f8', at: '2026-10-05T07:02:44Z' },
  { sha: 'a9e696b8c2', at: '2026-10-06T06:46:00Z' },
  { sha: '01496eb35b', at: '2026-10-07T06:45:45Z' },
  { sha: 'aa5fa3ec42', at: '2026-10-08T06:47:58Z' },
];

const OWNER_REPO = 'zarazhangrui/follow-builders';
const FILES = ['feed-x.json', 'feed-podcasts.json', 'feed-blogs.json'];

const log = (...a) => console.log('[backfill]', ...a);

// ---------- 快照下载（带本地缓存） ----------

async function ensureSnapshot(sha) {
  await mkdir(CACHE, { recursive: true });
  const out = {};
  for (const f of FILES) {
    const p = join(CACHE, `${sha}-${f}`);
    if (!existsSync(p)) {
      const url = `https://raw.githubusercontent.com/${OWNER_REPO}/${sha}/${f}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      await writeFile(p, await res.text());
    }
    out[f] = JSON.parse(await readFile(p, 'utf-8'));
  }
  return out;
}

// 快照 → 统一条目：{ url, kind, name, title }
function snapshotItems(snap) {
  const items = [];
  for (const b of snap['feed-x.json'].x || []) {
    for (const t of b.tweets || []) {
      if (t.url) items.push({ url: t.url, kind: 'x', name: b.name || '', text: t.text || '', createdAt: t.createdAt || '' });
    }
  }
  for (const f of ['feed-podcasts.json', 'feed-blogs.json']) {
    for (const b of snap[f]?.podcasts || snap[f]?.blogs || snap[f]?.x || []) {
      if (b.url) items.push({ url: b.url, kind: f === 'feed-podcasts.json' ? 'podcast' : 'blog', name: b.name || '', title: b.title || '' });
    }
  }
  return items;
}

// ---------- 名称匹配 ----------

function norm(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

// 段落开头的 **Name** → 快照里的 builder
function findBuilder(nameInMd, items) {
  const n = norm(nameInMd);
  if (!n) return [];
  const names = [...new Set(items.map((i) => i.name).filter(Boolean))];
  let best = names.filter((x) => norm(x) === n);
  if (!best.length) best = names.filter((x) => norm(x).includes(n) || n.includes(norm(x)));
  if (!best.length) return [];
  const set = new Set(best.map(norm));
  return items.filter((i) => set.has(norm(i.name)));
}

// ---------- 主流程 ----------

// 解析月度文件为 { dayKey: section }，保留原文以便精确替换
function splitByDay(text) {
  const out = {};
  const re = /^## (\d{4}-\d{2}-\d{2})\s*$/gm;
  let marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ day: m[1], start: m.index, headerEnd: re.lastIndex });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    out[marks[i].day] = { header: `## ${marks[i].day}`, body: text.slice(marks[i].headerEnd, end), start: marks[i].start, headerEnd: marks[i].headerEnd };
  }
  return out;
}

// 把一段 body 按（段落块 | 小节标题）序列展开
function blocksOf(body) {
  return body.split(/\n(?=## )/); // 小节之间按 "## " 切
}

// 对 𝕏 小节逐段补推文链接；播客/博客小节整节做标题词匹配
function repairSection(sectionBody, items, usedUrls, dayKey) {
  const report = [];
  const sections = blocksOf(sectionBody);
  const outSections = sections.map((sec) => {
    const headerMatch = sec.match(/^## ([^\n]*)/);
    const header = headerMatch ? headerMatch[1].trim() : '';
    const isX = /TWITTER/i.test(header);
    const isPodcast = /PODCASTS/i.test(header);
    const isBlog = /BLOGS/i.test(header);
    if (!isX && !isPodcast && !isBlog) return sec;

    if (isPodcast) {
      if (/https?:\/\//.test(sec)) return sec; // 已有链接，不动
      const lines = sec.split('\n');
      const feedIdx = lines.findIndex((l) => /^feed:\s/.test(l));
      const proseLines = feedIdx >= 0 ? lines.slice(0, feedIdx) : lines;
      const proseText = proseLines.join('\n').toLowerCase();
      // 播客不做跨日去重：中央 feed 对同频道节目常给同一个播放列表 URL，
      // 不同日期引用同一列表是正常现象，评分匹配保证选对当天那期
      const cands = items.filter((i) => i.kind === 'podcast');
      let best = null, bestScore = 0;
      for (const c of cands) {
        let score = 0;
        for (const t of new Set(`${c.name}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))) {
          if (proseText.includes(t)) score += 2;
        }
        for (const t of new Set(`${c.title}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4))) {
          if (proseText.includes(t)) score += 1;
        }
        if (score > bestScore) { bestScore = score; best = c; }
      }
      if (!best || bestScore < 3) {
        report.push(`  ⚠ ${dayKey}: ${header} 无高置信匹配（最高分 ${bestScore}），留人工处理`);
        return sec;
      }
      // 链接插在最后一行正文之后、feed: 行之前
      const out = [...proseLines];
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      out.push(String(best.url));
      usedUrls.add(best.url);
      report.push(`  ✔ ${dayKey}: ${header} +1 条链接 (${best.url})`);
      const tail = feedIdx >= 0 ? [''].concat(lines.slice(feedIdx)) : [];
      return out.concat(tail).join('\n');
    }

    if (isBlog) {
      // 博客小节按段落逐段匹配（一天可能有多篇官方博客）
      const lines = sec.split('\n');
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (lines[i].trim() === '') { out.push(lines[i]); i++; continue; }
        const para = [];
        while (i < lines.length && lines[i].trim() !== '') { para.push(lines[i]); i++; }
        const text = para.join('\n');
        // 段落自带链接，或紧跟着（隔一空行）独立 URL 行 → 视为已有链接
        let j = i;
        while (j < lines.length && lines[j].trim() === '') j++;
        let followedByUrls = false;
        while (j < lines.length && /^https?:\/\/\S+$/.test(lines[j].trim())) { followedByUrls = true; j++; }
        if (/https?:\/\//.test(text) || followedByUrls) { out.push(...para); continue; }
        const low = text.toLowerCase();
        let best = null, bestScore = 0;
        for (const c of items.filter((i2) => i2.kind === 'blog' && !usedUrls.has(i2.url))) {
          let score = 0;
          for (const t of new Set(`${c.name}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))) {
            if (low.includes(t)) score += 2;
          }
          for (const t of new Set(`${c.title}`.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4))) {
            if (low.includes(t)) score += 1;
          }
          if (score > bestScore) { bestScore = score; best = c; }
        }
        if (!best || bestScore < 3) {
          if (!/^## /.test(text)) report.push(`  ⚠ ${dayKey}: 📰 段落无高置信匹配（最高分 ${bestScore}）: ${text.slice(0, 40)}…`);
          out.push(...para);
        } else {
          out.push(...para);
          out.push(String(best.url));
          usedUrls.add(best.url);
          report.push(`  ✔ ${dayKey}: 📰 +1 条链接 (${best.url})`);
        }
      }
      return out.join('\n');
    }

    // 𝕏 小节：段落 = 连续非空行
    const lines = sec.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      if (lines[i].trim() === '') { out.push(lines[i]); i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() !== '') { para.push(lines[i]); i++; }
      const text = para.join('\n');
      // 段落自带链接，或紧跟着（隔一空行）独立 URL 行 → 视为已有链接
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      let followedByUrls = false;
      while (j < lines.length && /^https?:\/\/\S+$/.test(lines[j].trim())) { followedByUrls = true; j++; }
      if (/https?:\/\//.test(text) || followedByUrls) { out.push(...para); continue; }

      const nameM = text.match(/^\*\*([^*]+)\*\*/);
      let lead = '';
      let cands = [];
      if (nameM) {
        cands = findBuilder(nameM[1], items).filter((i2) => i2.kind === 'x' && !usedUrls.has(i2.url));
      } else {
        // 无加粗格式（如 "Thibault Sottiaux, who works on ..."）：取段首人名匹配
        if (/^(##|feed:)/.test(text)) { out.push(...para); continue; }
        lead = text.split(/[,，:：—-]/)[0].trim().split(/\s+/).slice(0, 4).join(' ');
        cands = findBuilder(lead, items).filter((i2) => i2.kind === 'x' && !usedUrls.has(i2.url));
        if (!cands.length) {
          report.push(`  ⚠ ${dayKey}: 𝕏 段落无法识别 builder（"${lead}"），跳过: ${text.slice(0, 40)}…`);
          out.push(...para);
          continue;
        }
      }
      if (!cands.length) {
        report.push(`  ⚠ ${dayKey}: "${nameM ? nameM[1] : lead}" 在快照中无可用推文`);
        out.push(...para);
      } else {
        out.push(...para);
        cands.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
        for (const c of cands) {
          out.push(String(c.url));
          usedUrls.add(c.url);
        }
        report.push(`  ✔ ${dayKey}: ${nameM ? nameM[1] : lead} +${cands.length} 条推文链接`);
      }
    }
    return out.join('\n');
  });
  // split(/\n(?=## )/ 把分隔的换行吃掉了，join 时要补回去
  return { body: outSections.join('\n'), report };
}

const files = ['2026-10.zh.md', '2026-10.en.md'];
const snapshotCache = new Map();
async function snapFor(stamp) {
  // 期号生成时点可用的最新快照
  const t = Date.parse(stamp);
  let best = null;
  for (const s of SNAPSHOTS) {
    if (Date.parse(s.at) <= t) best = s;
  }
  if (!best) return null;
  if (!snapshotCache.has(best.sha)) snapshotCache.set(best.sha, snapshotItems(await ensureSnapshot(best.sha)));
  return { at: best.at, sha: best.sha, items: snapshotCache.get(best.sha) };
}

for (const file of files) {
  const path = join(DIGEST_DIR, file);
  const text = await readFile(path, 'utf-8');
  const days = splitByDay(text);
  // 整份文件已用的 URL（跨日去重）
  const used = new Set();
  for (const d of Object.values(days)) for (const u of d.body.match(/https?:\/\/\S+/g) || []) used.add(u);

  const allReports = [];
  const newBodies = {};
  for (const [dayKey, sec] of Object.entries(days)) {
    const stampM = sec.body.match(/^feed:\s*(.+?)\s*$/m);
    if (!stampM) {
      allReports.push(`${file} ${dayKey}: 无 feed 时间戳，跳过`);
      continue;
    }
    const snap = await snapFor(stampM[1]);
    if (!snap) {
      allReports.push(`${file} ${dayKey}: 找不到 ${stampM[1]} 之前的快照，跳过`);
      continue;
    }
    // 当日已用（本日内）URL 不阻止段落匹配——repairSection 只处理完全没链接的段落
    const { body, report } = repairSection(sec.body, snap.items, used, dayKey);
    newBodies[dayKey] = body;
    allReports.push(`${file} ${dayKey} (快照 ${snap.sha} @ ${snap.at}):\n${report.join('\n') || '  无需修复'}`);
  }

  console.log(`\n===== ${file} =====`);
  console.log(allReports.join('\n'));

  if (APPLY) {
    // 按位置切片重建（不能用 String.replace：sec.header+sec.body 与原文
    // 在标题后的空行上有细微差异，会静默失配）
    const keys = Object.keys(days);
    let out = text.slice(0, days[keys[0]].start);
    for (const dayKey of keys) {
      const sec = days[dayKey];
      out += text.slice(sec.start, sec.headerEnd) + newBodies[dayKey];
    }
    await writeFile(path, out, 'utf-8');
    log('written:', path);
  }
}

if (!APPLY) log('dry-run 完成，加 --apply 写回');
