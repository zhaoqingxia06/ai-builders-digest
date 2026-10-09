#!/usr/bin/env node

// ============================================================================
// AI Builders Digest — Prepare Digest（自有管线，无 skill 依赖）
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

// 内容源端点：可在 site/config/feeds.json 中自主更换
let FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
let FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
let FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';
try {
  const feedsCfg = JSON.parse(readFileSync(join(scriptDir, '..', 'config', 'feeds.json'), 'utf-8'));
  FEED_X_URL = feedsCfg.x || FEED_X_URL;
  FEED_PODCASTS_URL = feedsCfg.podcasts || FEED_PODCASTS_URL;
  FEED_BLOGS_URL = feedsCfg.blogs || FEED_BLOGS_URL;
} catch {}

const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastErr = err;
    }
    if (i < tries - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
  }
  console.error(`Retries exhausted for ${url}: ${lastErr?.message}`);
  return null;
}

async function fetchJSON(url) {
  const res = await fetchWithRetry(url);
  if (!res) return null;
  try { return await res.json(); } catch { return null; }
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  if (!res) return null;
  return res.text();
}

// Remote feed with fallback to the copy shipped with the skill, so a flaky
// network still produces a digest (possibly from a slightly stale feed).
async function fetchFeed(url, localFile) {
  const remote = await fetchJSON(url);
  if (remote) return remote;
  try {
    return JSON.parse(await readFile(join(scriptDir, '..', localFile), 'utf-8'));
  } catch {
    return null;
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all three feeds (remote first, local skill copy as fallback)
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchFeed(FEED_X_URL, 'feed-x.json'),
    fetchFeed(FEED_PODCASTS_URL, 'feed-podcasts.json'),
    fetchFeed(FEED_BLOGS_URL, 'feed-blogs.json')
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.errors?.length) {
    errors.push(
      ...feedX.errors.map((error) => `Tweet feed problem: ${error}`)
    );
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(
      ...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`)
    );
  }
  if (feedBlogs?.errors?.length) {
    errors.push(
      ...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`)
    );
  }

  // 3. Load prompts: user custom > our own local copies (site/prompts/)
  const prompts = {};
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: our own local copy (site/prompts/) — no external dependency
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // 中央快照自己的生成时间（三份 feed 的最大值）。快照内容只覆盖到这个
    // 时间点，remix 用它判断"哪个北京日已被完整覆盖"，不能用抓取时间——
    // 抓取时间比内容晚，会高估覆盖窗口。
    contentThrough: [feedX?.generatedAt, feedPodcasts?.generatedAt, feedBlogs?.generatedAt]
      .filter(Boolean)
      .sort()
      .pop() || null,

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + (a?.tweets?.length || 0), 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
