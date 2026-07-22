#!/usr/bin/env bash
# bench-compare.sh - head-to-head RPS comparison: Vayu engine vs wrk vs vegeta
#
# All three clients hit the SAME mock server (scripts/test/mock-server.go, :8080)
# with matched concurrency + duration, so the comparison is apples-to-apples.
# Run the engine daemon and mock-server first. Results print as a markdown table.
#
#   go run scripts/test/mock-server.go &            # mock on :8080
#   engine/build/vayu-engine --port 9876 --data-dir engine/data &
#   bash scripts/test/bench-compare.sh
set -euo pipefail

URL="${URL:-http://127.0.0.1:8080/fast}"
DUR="${DUR:-10}"                       # seconds per run
CONCS="${CONCS:-64 128 256}"           # concurrency points to sweep
DAEMON="${DAEMON:-http://127.0.0.1:9876}"
CLI="${CLI:-engine/build-release/vayu-cli}"
[ -x "$CLI" ] || CLI="engine/build/vayu-cli"
WORKERS="${WORKERS:-8}"                # engine event-loop workers (M3 Pro sweet spot)
COOL="${COOL:-3}"                      # cooldown seconds between runs

setcfg(){ curl -s -X POST "$DAEMON/config" -H 'Content-Type: application/json' \
  -d "{\"key\":\"$1\",\"value\":\"$2\"}" >/dev/null; }

wrk_rate(){ wrk -t6 -c"$1" -d"${DUR}s" "$URL" 2>/dev/null | awk '/Requests\/sec/{print $2}'; }

veg_rate(){ echo "GET $URL" | vegeta attack -duration="${DUR}s" -rate=0 -max-workers="$1" 2>/dev/null \
  | vegeta report 2>/dev/null | awk '/^Requests/{print $(NF)}'; }   # $(NF)=throughput (req/s over actual time)

# Vayu closed-loop: omit targetRps, set concurrency. Submit via CLI to daemon, read final stats.
vayu_rate(){
  local cc="$1"
  cat > /tmp/bench_cc.json <<JSON
{ "method":"GET","url":"$URL","headers":{"Accept":"application/json"},"mode":"constant","duration":"${DUR}s","concurrency":$cc }
JSON
  local out rid last
  out="$($CLI run /tmp/bench_cc.json 2>&1)"
  rid="$(echo "$out" | awk '/Run ID:/{print $3}')"
  [ -z "$rid" ] && { echo "ERR"; return; }
  last=""
  for _ in $(seq 1 80); do
    data="$(curl -s -N --max-time 2 "$DAEMON/stats/$rid")"
    ml="$(echo "$data" | grep '^data:' | grep -v '"event"' | tail -1 | sed 's/^data: //')"
    [ -n "$ml" ] && last="$ml"
    echo "$data" | grep -q "event: complete" && break
    sleep 0.4
  done
  echo "$last" | python3 -c "import sys,json;d=json.load(sys.stdin);print(round(d['totalRequests']/d['elapsedSeconds']))"
}

setcfg workers "$WORKERS"
echo "## Vayu vs wrk vs vegeta  -  $URL  (${DUR}s/run, workers=$WORKERS)"
echo
echo "| concurrency | wrk (req/s) | vegeta (req/s) | vayu (req/s) | vayu/wrk |"
echo "|---|---|---|---|---|"
for c in $CONCS; do
  w="$(wrk_rate "$c")"; sleep "$COOL"
  v="$(veg_rate "$c")"; sleep "$COOL"
  y="$(vayu_rate "$c")"; sleep "$COOL"
  ratio="$(python3 -c "print(f'{$y/$w*100:.1f}%')" 2>/dev/null || echo '-')"
  printf "| %s | %s | %s | %s | %s |\n" "$c" "$w" "$v" "$y" "$ratio"
done
