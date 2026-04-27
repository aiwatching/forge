#!/bin/bash
# Publish the Forge IntelliJ plugin to the JetBrains Marketplace.
#
# Usage:
#   ./publish.sh                # publish current version in build.gradle.kts
#   ./publish.sh patch          # bump patch (0.1.19 → 0.1.20) + publish
#   ./publish.sh minor          # bump minor (0.1.x → 0.2.0) + publish
#   ./publish.sh major          # bump major (0.x.x → 1.0.0) + publish
#   ./publish.sh 0.5.0          # publish exact version
#
# Auth: get a permanent token at https://plugins.jetbrains.com/author/me/tokens
# and export it as JETBRAINS_MARKETPLACE_TOKEN. The first publish must go
# through the JetBrains Marketplace upload form for moderation; subsequent
# updates can use this script.
#
# Requires JDK 17 — Gradle's Kotlin compiler crashes on the host JDK 25.

set -euo pipefail
cd "$(dirname "$0")"

if [[ -z "${JETBRAINS_MARKETPLACE_TOKEN:-}" ]]; then
    echo "ERROR: set JETBRAINS_MARKETPLACE_TOKEN env var first." >&2
    echo "  Get one at https://plugins.jetbrains.com/author/me/tokens" >&2
    exit 1
fi

ARG="${1:-}"

bump_version() {
    local kind="$1"
    local current
    current=$(grep -E '^version = "' build.gradle.kts | head -1 | sed -E 's/^version = "([^"]+)".*/\1/')
    local new
    case "$kind" in
        patch|minor|major)
            local major minor patch
            IFS='.' read -r major minor patch <<<"$current"
            case "$kind" in
                patch) patch=$((patch + 1)) ;;
                minor) minor=$((minor + 1)); patch=0 ;;
                major) major=$((major + 1)); minor=0; patch=0 ;;
            esac
            new="${major}.${minor}.${patch}"
            ;;
        *)
            new="$kind"
            ;;
    esac
    echo "→ Bumping $current → $new"
    # Replace both `version = "..."` (top-level) and `version = "..."` (in pluginConfiguration).
    sed -i.bak -E "s/version = \"$current\"/version = \"$new\"/g" build.gradle.kts
    rm -f build.gradle.kts.bak
}

case "$ARG" in
    "")
        ;;
    patch|minor|major)
        bump_version "$ARG"
        ;;
    *)
        if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            bump_version "$ARG"
        else
            echo "Unknown argument: $ARG" >&2
            echo "Usage: $0 [patch|minor|major|x.y.z]" >&2
            exit 1
        fi
        ;;
esac

VERSION=$(grep -E '^version = "' build.gradle.kts | head -1 | sed -E 's/^version = "([^"]+)".*/\1/')
echo "→ Publishing version $VERSION to JetBrains Marketplace…"

JAVA_HOME="$(/usr/libexec/java_home -v 17)" gradle publishPlugin

echo "✓ Published Forge Vibe Coding v$VERSION"
echo "→ https://plugins.jetbrains.com/author/me/plugins"
