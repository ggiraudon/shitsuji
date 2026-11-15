#!/usr/bin/env bash
# Formats, runs `pnpm check`, and commits everything only if the check passes.
# Usage: scripts/commit-if-green.sh "subject" "body"
set -euo pipefail
cd "$(dirname "$0")/.."
# Only auto-fixable rules (e.g. type-only imports); the check below still fails on everything else.
npx eslint --fix . > /dev/null 2>&1 || true
npx prettier --write packages scripts > /dev/null
if ! timeout 300 pnpm check < /dev/null > /tmp/shitsuji-check.log 2>&1; then
  grep -E "✗|error|×|FAIL|AssertionError" /tmp/shitsuji-check.log | head -20
  echo "CHECK FAILED: nothing committed" >&2
  exit 1
fi
grep -E "Tests " /tmp/shitsuji-check.log | tail -2
git add -A
git commit -q -m "$1" -m "$2"
git log --oneline -1
