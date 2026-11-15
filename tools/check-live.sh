#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .tmp
cp tools/probes/catalog.test.template .tmp/catalog.test.tsx
.tools/nsh/bin/nsh test .tmp/catalog.test.tsx
# Cookie probe: first run `python3 tools/probes/http-server.py` in another terminal.
if [ "${1:-}" = "--cookies" ]; then
 cp tools/probes/network.test.template .tmp/network.test.tsx
 .tools/nsh/bin/nsh test .tmp/network.test.tsx
fi
