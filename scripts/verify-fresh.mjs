#!/usr/bin/env node
// Freshness gate for the daily digest pipeline: after build.mjs runs, fail
// the workflow (red X + failure email to the repo owner) when the built site
// has no recent edition. This is what turns a silent "site stuck on an old
// issue" into a loud, same-day failure.
import { readFile } from 'fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf-8');
const anchors = new Set([...html.matchAll(/id="d-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]));
const sorted = [...anchors].sort();
const latest = sorted[sorted.length - 1] || '(none)';

// 期号按北京日期标注（帖子的北京时间归属）。生成节奏：中央 feed 每天
// 06:45 UTC（北京 14:45）滚动更新，一个完整北京日的帖子要等到下一天
// 的同一份快照才齐全，所以最新期号正常是"北京昨天"，由每天北京 15:30
// 的运行补齐。门禁据此要求：最新期号不得早于北京昨天。
const beijingToday = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const bj = (offset) => new Date(Date.parse(beijingToday + 'T00:00:00+08:00') + offset * 86400000).toISOString().slice(0, 10);
const bjYesterday = bj(-1);

console.log(`anchors: ${anchors.size} | latest: ${latest} | beijing today: ${beijingToday} | expected latest >= ${bjYesterday}`);

if (!anchors.size || latest < bjYesterday) {
  console.error(`STALE: latest edition ${latest} is older than Beijing yesterday (${bjYesterday}).`);
  console.error('Likely causes: DeepSeek API 402 (out of credit) with no ZHIPU_API_KEY fallback,');
  console.error('or the central feed (follow-builders) returned nothing. Check the "remix + merge" log above.');
  process.exit(1);
}

console.log('FRESH OK');
