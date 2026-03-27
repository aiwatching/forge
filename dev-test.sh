#!/bin/bash
# dev-test.sh — Start Forge test instance (port 4000, data ~/.forge-test)

mkdir -p ~/.forge-test
NEXT_TELEMETRY_DISABLED=1 PORT=4000 TERMINAL_PORT=4001 FORGE_DATA_DIR=~/.forge-test FORGE_EXTERNAL_SERVICES=0 npx next dev --turbopack -p 4000
