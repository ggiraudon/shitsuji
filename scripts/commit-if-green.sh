#!/usr/bin/env bash
# Formats, runs `pnpm check`, and commits everything only if the check passes.
# Usage: scripts/commit-if-green.sh "subject" "body"
set -euo pipefail
cd "$(dirname "$0")/.."
npx prettier --write packages scripts > /dev/null
if ! timeout 300 pnpm check < /dev/null > /tmp/shitsuji-check.log 2>&1; then
  grep -E "✗|error|×|FAIL|AssertionError" /tmp/shitsuji-check.log | head -20
  echo "CHECK FAILED: nothing committed" >&2
  exit 1
fi
grep -E "Tests " /tmp/shitsuji-check.log | tail -2
git add -A
git commit -q -m "$1" -m "$2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1
