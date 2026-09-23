#!/bin/bash
# Deploy the rebuilt site to GitHub Pages. Safe to run repeatedly:
# exits 0 silently when nothing changed.
cd "$HOME/.follow-builders/site" || exit 1
git add -A
if git diff --cached --quiet; then
  echo "NOTHING_TO_DEPLOY"
  exit 0
fi
git commit -m "digest update $(date '+%F %H:%M')" >/dev/null
git pull --rebase origin main >/dev/null 2>&1
if git push origin main >/dev/null 2>&1; then
  echo "DEPLOYED"
else
  # one retry in case of transient network issues
  sleep 3
  if git push origin main >/dev/null 2>&1; then
    echo "DEPLOYED"
  else
    echo "PUSH_FAILED"
    exit 1
  fi
fi
