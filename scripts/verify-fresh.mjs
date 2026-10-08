#!/usr/bin/env node
// Freshness gate for the daily digest pipeline: after build.mjs runs, fail
// the workflow (red X + failure email to the repo owner) when the built site
// has no edition for today or yesterday (UTC — editions are labeled by the
// run's UTC date). This is what turns a silent "site stuck on an old issue"
// into a loud, same-day failure.
import { readFile } from 'fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf-8');
const anchors = new Set([...html.matchAll(/id="d-(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]));
const sorted = [...anchors].sort();
const latest = sorted[sorted.length - 1] || '(none)';

const now = Date.now();
const day = (offset) => new Date(now + offset * 86400000).toISOString().slice(0, 10);
const today = day(0);
const yesterday = day(-1);

console.log(`anchors: ${anchors.size} | latest: ${latest} | today(UTC): ${today}`);

// Healthy pipeline publishes at least one edition per UTC day (crons at
// 00:00 / 07:30 / 12:00 UTC each label today; the 22:00 UTC run labels today
// too). Accept yesterday only during the first hours before today's 00:00
// UTC run has fired.
if (!anchors.has(today) && !anchors.has(yesterday)) {
  console.error(`STALE: no edition for ${today} or ${yesterday}. Site is stuck on ${latest}.`);
  console.error('Likely causes: DeepSeek API 402 (out of credit) with no ZHIPU_API_KEY fallback,');
  console.error('or the central feed (follow-builders) returned nothing. Check the "remix + merge" log above.');
  process.exit(1);
}

// Extra tripwire: latest edition must never be more than 2 days old.
if (latest !== today && latest !== yesterday && latest < yesterday) {
  console.error(`STALE: latest edition ${latest} is older than ${yesterday}.`);
  process.exit(1);
}

console.log('FRESH OK');
