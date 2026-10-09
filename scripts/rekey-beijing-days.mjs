#!/usr/bin/env node
// ============================================================================
// rekey-beijing-days.mjs — 把存量期号的段落按帖子北京日期重新归属
// ----------------------------------------------------------------------------
// 背景：旧管线按 UTC 快照窗口切天，期号里会混入"北京时间已是前一天"的
// 帖子（用户点进 X 原文看到的日期和期号对不上）。本脚本对每个 𝕏 段落，
// 用其附带的推文 URL（snowflake id 解码出发帖时间）按多数票算出该段内容
// 的北京日期，把多数票不是当前期号日期的段落整段搬到目标日期的期号里。
//
// 只处理 2026-10 的期号（更早的存档由旧管线生成，缺链接的段落无法定位
// 时间，保持原样）。10-01 的段落若属于北京 09-30，则搬入上月文件的
// 09-30 期号。期号的元数据/洞察小节不做改动。
//
// 用法：node scripts/rekey-beijing-days.mjs [--apply]
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIGEST_DIR = join(root, 'digests');
const APPLY = process.argv.includes('--apply');
const log = (...a) => console.log('[rekey]', ...a);

// Twitter snowflake -> Date
function tweetTime(url) {
  const m = url.match(/\/status(?:es)?\/(\d+)/);
  if (!m) return null;
  return new Date(Number((BigInt(m[1]) >> 22n) + 1288834974657n));
}
const bjDay = (iso) => new Date(iso.getTime() + 8 * 3600e3).toISOString().slice(0, 10);

function loadMonth(file) {
  return readFile(join(DIGEST_DIR, file), 'utf-8');
}

// 把月度文件切成 [{header:'## 2026-10-02', lines:[...]}]，保留所有原始行
function splitDays(text) {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^## (\d{4}-\d{2}-\d{2})\s*$/);
    if (m) {
      if (cur) out.push(cur);
      cur = { header: m[1], lines: [ln] };
    } else if (cur) {
      cur.lines.push(ln);
    } else {
      if (!out.length) out.push({ header: null, lines: [ln] });
      else out[0].lines.push(ln);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// 𝕏 小节的段落块：[{start,end}]（行号区间，含段落文本与其 URL 行）
function xParagraphRanges(dayLines) {
  let xStart = -1, xEnd = -1;
  dayLines.forEach((ln, i) => {
    if (/^## .*TWITTER/i.test(ln)) xStart = i + 1;
    else if (xStart >= 0 && xEnd < 0 && /^## |^feed:/.test(ln)) xEnd = i;
  });
  if (xStart < 0) return { xStart, ranges: [] };
  if (xEnd < 0) xEnd = dayLines.length;
  const blocks = [];
  let i = xStart;
  while (i < xEnd) {
    if (dayLines[i].trim() === '') { i++; continue; }
    const start = i;
    while (i < xEnd && dayLines[i].trim() !== '') i++;
    blocks.push({ start, end: i });
  }
  // URL-only 块归并到前一个块：en 版的链接行与正文隔空行，
  // 它们是同一条目的来源按钮，必须作为一个单元搬移
  const ranges = [];
  for (const b of blocks) {
    const isUrlOnly = dayLines.slice(b.start, b.end).every((ln) => /^https?:\/\//.test(ln.trim()));
    const prev = ranges[ranges.length - 1];
    if (isUrlOnly && prev) prev.end = b.end;
    else ranges.push({ ...b });
  }
  return { xStart, ranges };
}

// 对每个语言文件计算并执行搬移
async function rekey(file) {
  const text = await loadMonth(file);
  const days = splitDays(text);
  const byDay = new Map(days.map((d) => [d.header, d]));
  const moves = [];

  for (const day of days) {
    if (!day.header || !/^\d{4}-10/.test(day.header)) continue;
    const { ranges } = xParagraphRanges(day.lines);
    for (const r of ranges) {
      const block = day.lines.slice(r.start, r.end);
      const times = block
        .flatMap((ln) => [...ln.matchAll(/https:\/\/x\.com\/[^/]+\/status(?:es)?\/(\d+)/g)])
        .map((m) => tweetTime(m[0]))
        .filter(Boolean);
      if (!times.length) { moves.push({ day, range: r, target: null, reason: 'no-time' }); continue; }
      const votes = new Map();
      for (const t of times) {
        const d = bjDay(t);
        votes.set(d, (votes.get(d) || 0) + 1);
      }
      const maj = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (maj === day.header) continue;
      moves.push({ day, range: r, target: maj, block });
    }
  }

  const real = moves.filter((m) => m.target);
  log(`${file}: 段落ranges总数 ${moves.length}, 其中无时间 ${moves.filter((m) => m.reason === 'no-time').length}, 需搬移 ${real.length}`);
  for (const m of real) {
    const name = (m.block[0].match(/^\*\*([^*]+)\*\*/) || m.block[0].match(/^([A-Za-z][A-Za-z0-9 .&']{2,40}?)[,，:：]/) || ['', '?'])[1];
    log(`  ${m.day.header} → ${m.target}: ${name}`);
  }

  if (!APPLY || !real.length) return;

  // 从源段摘除（倒序删行），目标插入到其 𝕏 小节末尾
  const cuts = new Map(); // header -> [ranges]
  for (const m of real) {
    if (!cuts.has(m.day.header)) cuts.set(m.day.header, []);
    cuts.get(m.day.header).push(m.range);
  }
  for (const [header, ranges] of [...cuts]) {
    const day = byDay.get(header);
    ranges.sort((a, b) => b.start - a.start);
    for (const r of ranges) day.lines.splice(r.start, r.end - r.start);
    // 清掉可能出现的连续空行
    day.lines = day.lines.filter((ln, i, arr) => !(ln.trim() === '' && arr[i - 1] && arr[i - 1].trim() === '' && i > 1));
  }
  // 插入（同目标聚合，只插入一次）
  const insertions = new Map();
  for (const m of real) {
    if (!insertions.has(m.target)) insertions.set(m.target, []);
    insertions.get(m.target).push(m.block);
  }
  for (const [target, blocks] of insertions) {
    let day = byDay.get(target);
    if (!day) {
      // 目标日期在另一份月度文件里（如 10-01 → 09-30）
      const otherFile = target.slice(0, 7) + file.slice(7);
      const otherText = await loadMonth(otherFile);
      const otherDays = splitDays(otherText);
      day = otherDays.find((d) => d.header === target);
      byDay.set('__other__' + target, { file: otherFile, days: otherDays });
      if (!day) { log(`  ⚠ 目标期号 ${target} 不存在，放弃 ${blocks.length} 段`); continue; }
      // 记录待写回
      globalThis.__pending = globalThis.__pending || new Map();
      globalThis.__pending.set(otherFile, otherDays);
    }
    const { xStart } = xParagraphRanges(day.lines);
    if (xStart < 0) { log(`  ⚠ 目标期号 ${target} 无 𝕏 小节，放弃`); continue; }
    // 找 𝕏 小节结束行（下一个 ## 或 feed: 行）
    let xEnd = day.lines.length;
    for (let i = xStart; i < day.lines.length; i++) {
      if (/^## |^feed:/.test(day.lines[i])) { xEnd = i; break; }
    }
    const insertLines = [];
    for (const b of blocks) insertLines.push(...b, '');
    day.lines.splice(xEnd, 0, ...insertLines);
  }

  // 写回当前文件
  const outText = days.map((d) => d.lines.join('\n')).join('\n');
  await writeFile(join(DIGEST_DIR, file), outText, 'utf-8');
  // 写回跨月目标文件
  if (globalThis.__pending) {
    for (const [otherFile, otherDays] of globalThis.__pending) {
      const out = otherDays.map((d) => d.lines.join('\n')).join('\n');
      await writeFile(join(DIGEST_DIR, otherFile), out, 'utf-8');
    }
    globalThis.__pending = null;
  }
}

for (const f of ['2026-10.zh.md', '2026-10.en.md']) {
  await rekey(f);
}
if (!APPLY) log('dry-run 完成，加 --apply 写回');
