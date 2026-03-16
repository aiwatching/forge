#!/bin/bash
# publish.sh — Bump version, commit, and publish to npm
#
# Usage:
#   ./publish.sh          # patch bump (0.2.3 → 0.2.4)
#   ./publish.sh minor    # minor bump (0.2.3 → 0.3.0)
#   ./publish.sh major    # major bump (0.2.3 → 1.0.0)
#   ./publish.sh 0.5.0    # explicit version

set -e

VERSION_ARG=${1:-patch}
CURRENT=$(node -p "require('./package.json').version")

# Calculate new version
if [[ "$VERSION_ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION=$VERSION_ARG
elif [ "$VERSION_ARG" = "patch" ]; then
  IFS='.' read -r major minor patch <<< "$CURRENT"
  NEW_VERSION="$major.$minor.$((patch + 1))"
elif [ "$VERSION_ARG" = "minor" ]; then
  IFS='.' read -r major minor patch <<< "$CURRENT"
  NEW_VERSION="$major.$((minor + 1)).0"
elif [ "$VERSION_ARG" = "major" ]; then
  IFS='.' read -r major minor patch <<< "$CURRENT"
  NEW_VERSION="$((major + 1)).0.0"
else
  echo "Usage: ./publish.sh [patch|minor|major|x.y.z]"
  exit 1
fi

echo "Version: $CURRENT → $NEW_VERSION"
echo ""

# Update package.json
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" package.json

# Commit
git add -A
git commit -m "v$NEW_VERSION"
git tag "v$NEW_VERSION"

echo ""
echo "Ready to publish @aion0/forge@$NEW_VERSION"
echo "Run: npm login && npm publish --access public --otp=<code>"
