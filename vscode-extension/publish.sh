#!/bin/bash
# Publish the Forge VSCode extension to the Marketplace.
#
# Usage:
#   ./publish.sh                # bump patch (0.2.6 → 0.2.7) + publish (default)
#   ./publish.sh minor          # bump minor (0.2.x → 0.3.0) + publish
#   ./publish.sh major          # bump major (0.x.x → 1.0.0) + publish
#   ./publish.sh 0.5.0          # publish exact version
#   ./publish.sh --no-bump      # publish current package.json version unchanged
#
# Auth (one-time): `npx vsce login aion0` (credentials cached in ~/.vsce/),
# OR set $VSCE_PAT in the environment before invoking.
#
# vsce will create a `git commit` + `git tag v<x.y.z>` for version bumps —
# push them with `git push --follow-tags` afterwards.

set -euo pipefail
cd "$(dirname "$0")"

ARG="${1:-patch}"

PUBLISH_ARGS=()
case "$ARG" in
    --no-bump)
        ;;
    patch|minor|major)
        PUBLISH_ARGS+=("$ARG")
        ;;
    *)
        if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            PUBLISH_ARGS+=("$ARG")
        else
            echo "Unknown argument: $ARG" >&2
            echo "Usage: $0 [patch|minor|major|x.y.z|--no-bump]" >&2
            exit 1
        fi
        ;;
esac

if [[ -n "${VSCE_PAT:-}" ]]; then
    PUBLISH_ARGS+=(-p "$VSCE_PAT")
fi

echo "→ npx vsce publish ${PUBLISH_ARGS[*]:-}"
npx vsce publish "${PUBLISH_ARGS[@]}"

VERSION=$(node -p "require('./package.json').version")
echo "✓ Published aion0.forge-vibecoding v$VERSION"
echo "→ https://marketplace.visualstudio.com/items?itemName=aion0.forge-vibecoding"
