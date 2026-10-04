#!/usr/bin/env bash
# Reports which search engines answer from this machine's network address.
set -u
BASE="${SEARXNG_URL:-http://localhost:8888}"
for i in $(seq 1 40); do curl -sf "$BASE/healthz" >/dev/null 2>&1 && break; sleep 2; done
for q in "Stripe company revenue employees 2026" "Nvidia Data Engineer salary Bengaluru" "Zoho Corporation revenue growth forecast"; do
  echo "== $q"
  curl -s -G "$BASE/search" --data-urlencode "q=$q" -d format=json -m 60 \
    | jq -r '"results: \(.results|length)   unresponsive: \(.unresponsive_engines | map("\(.[0]) (\(.[1]))") | join(", "))", (.results[:7][] | "  [\(.engines|join(","))] \(.title) | \(.url)\n      \((.content // "")[:160])")' \
    || echo "request failed"
  sleep 3
done
