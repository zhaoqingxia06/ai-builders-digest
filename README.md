# AI Builders Digest

每日追踪 AI builders（X 动态 + 播客 + 官方博客）的摘要站点，4 次/天自动生成。

**站点**：https://zhaoqingxia06.github.io/ai-builders-digest/

![daily-digest](https://github.com/zhaoqingxia06/ai-builders-digest/actions/workflows/daily-digest.yml/badge.svg)

## 状态徽章变红 = 站点没有最新一期

构建流程最后一步是保鲜检查（`scripts/verify-fresh.mjs`）：页面里必须存在今天或昨天的期号，否则 workflow 失败并向仓库所有者发失败邮件。变红时按顺序排查：

1. 打开本次失败运行里 **remix + merge** 的日志：
   - 出现 `DeepSeek HTTP 402` → DeepSeek 账户欠费，充值即可；或配置 `ZHIPU_API_KEY` secret 作为备用通道（代码已支持自动切换）。
   - 出现 `EMPTY feed` → 上游内容源（follow-builders 中央 feed）没数据，稍后手动触发一次（Actions → daily-digest → Run workflow）。
2. 手动重跑：Actions → daily-digest → Run workflow。
3. 徽章绿色但站点仍旧？强刷浏览器缓存（⌘⇧R）。

## 结构

- `.github/workflows/daily-digest.yml` — 每天 06:00 / 08:00 / 15:30 / 20:00（北京时间）各跑一次：抓取 feed → LLM 改写 → 构建站点 → 保鲜检查 → 提交推送（GitHub Pages 自动部署）。
- `digests/YYYY-MM.zh.md` / `.en.md` — 月度存档，每天一个小节（`## YYYY-MM-DD`），小节末尾 `feed:` 行记录生成时所用 feed 快照。
- `scripts/prepare-digest.js` — 拉取中央 feed；`scripts/remix.mjs` — 按天补齐/刷新期号；`build.mjs` — 生成单页 `index.html`。
