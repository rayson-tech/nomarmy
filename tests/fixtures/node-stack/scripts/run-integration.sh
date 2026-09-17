#!/usr/bin/env bash
# Fixture only. The scanner records this path; it must never execute it.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
npm run db:migrate
npm run test:e2e
