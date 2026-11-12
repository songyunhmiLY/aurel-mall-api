#!/bin/sh
set -eu

attempts=0
until npx prisma migrate deploy; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 30 ]; then
    echo "prisma migrate deploy failed" >&2
    exit 1
  fi
  echo "database not ready, retry ${attempts}/30" >&2
  sleep 2
done

exec node dist/main.js
