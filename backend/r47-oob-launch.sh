#!/bin/bash
cd "$(dirname "$0")"
setsid nohup python3 r47-oob-collector.py > r47-oob-collector.stdout 2>&1 < /dev/null &
echo $! > r47-oob-collector.pid
disown 2>/dev/null || true
