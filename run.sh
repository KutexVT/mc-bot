#!/usr/bin/env bash
# Supervisor: si el bot se cae, se cuelga o revienta, vuelve solo.
cd "$(dirname "$0")"
while true; do
  echo "[$(date +%H:%M:%S)] arrancando bot..."
  node --max-old-space-size=2048 ./bot.js
  code=$?
  echo "[$(date +%H:%M:%S)] el bot salio con codigo $code, reintento en 5s"
  sleep 5
done
