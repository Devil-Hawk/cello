#!/bin/sh
set -eu
# Runs the chat eval suite on the free tier and the deep core, against the live models.
# One cold run spends about 180 requests, so the cap (maxRequests in gate.json) is 300.
# Run from apps/web by scripts/evals/run-gate.ts; a vitest exit 1 is a regression.
RUN_CHAT_EVALS=1 CHAT_EVAL_TIER=free CHAT_EVAL_CORE=deep AGENT_EVAL_CACHE=.cache/chat-evals AGENT_EVAL_MAX_REQUESTS="${EVAL_MAX_REQUESTS:-300}" exec pnpm exec vitest run lib/chat/evals/live.eval.test.ts
