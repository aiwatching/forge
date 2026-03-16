#!/bin/bash
# dev-test.sh — Start Forge test instance (port 4000, data ~/.forge-test)

mkdir -p ~/.forge-test
PORT=4000 TERMINAL_PORT=4001 FORGE_DATA_DIR=~/.forge-test pnpm dev -- -p 4000
