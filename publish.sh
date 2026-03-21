#!/bin/bash
# publish.sh — Bump version, generate release notes, commit, tag, push, create GitHub release
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

# Generate release notes from git log since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
RELEASE_NOTES_FILE="RELEASE_NOTES.md"

echo "# Forge v$NEW_VERSION" > "$RELEASE_NOTES_FILE"
echo "" >> "$RELEASE_NOTES_FILE"
echo "Released: $(date +%Y-%m-%d)" >> "$RELEASE_NOTES_FILE"
echo "" >> "$RELEASE_NOTES_FILE"

if [ -n "$LAST_TAG" ]; then
  echo "## Changes since $LAST_TAG" >> "$RELEASE_NOTES_FILE"
  echo "" >> "$RELEASE_NOTES_FILE"

  # Features
  FEATURES=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --grep="feat:" --format="- %s" 2>/dev/null)
  if [ -n "$FEATURES" ]; then
    echo "### Features" >> "$RELEASE_NOTES_FILE"
    echo "$FEATURES" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi

  # Fixes
  FIXES=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --grep="fix:" --format="- %s" 2>/dev/null)
  if [ -n "$FIXES" ]; then
    echo "### Bug Fixes" >> "$RELEASE_NOTES_FILE"
    echo "$FIXES" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi

  # Performance
  PERF=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --grep="perf:" --format="- %s" 2>/dev/null)
  if [ -n "$PERF" ]; then
    echo "### Performance" >> "$RELEASE_NOTES_FILE"
    echo "$PERF" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi

  # Refactors
  REFACTOR=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --grep="refactor:" --format="- %s" 2>/dev/null)
  if [ -n "$REFACTOR" ]; then
    echo "### Refactoring" >> "$RELEASE_NOTES_FILE"
    echo "$REFACTOR" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi

  # Docs
  DOCS=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --grep="docs:" --format="- %s" 2>/dev/null)
  if [ -n "$DOCS" ]; then
    echo "### Documentation" >> "$RELEASE_NOTES_FILE"
    echo "$DOCS" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi

  # Other (commits without conventional prefix)
  OTHER=$(git log --oneline "$LAST_TAG"..HEAD --no-merges --format="%s" 2>/dev/null | grep -v -E "^(feat|fix|perf|refactor|docs|chore|test|ci):" | sed 's/^/- /')
  if [ -n "$OTHER" ]; then
    echo "### Other" >> "$RELEASE_NOTES_FILE"
    echo "$OTHER" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
  fi
else
  echo "Initial release" >> "$RELEASE_NOTES_FILE"
fi

echo "" >> "$RELEASE_NOTES_FILE"
echo "**Full Changelog**: https://github.com/aiwatching/forge/compare/${LAST_TAG}...v${NEW_VERSION}" >> "$RELEASE_NOTES_FILE"

echo "Release notes written to $RELEASE_NOTES_FILE"
cat "$RELEASE_NOTES_FILE"
echo ""

# Commit + tag
git add -A
git commit -m "v$NEW_VERSION"
git tag "v$NEW_VERSION"

# Push
echo "Pushing to origin..."
git push origin main
git push origin "v$NEW_VERSION"

# Create GitHub Release (if gh CLI available)
if command -v gh &> /dev/null; then
  echo ""
  echo "Creating GitHub Release..."
  gh release create "v$NEW_VERSION" --title "v$NEW_VERSION" --notes-file "$RELEASE_NOTES_FILE"
  echo "✓ GitHub Release created: https://github.com/aiwatching/forge/releases/tag/v$NEW_VERSION"
else
  echo ""
  echo "gh CLI not found. Create release manually:"
  echo "  https://github.com/aiwatching/forge/releases/new?tag=v$NEW_VERSION"
fi

echo ""
echo "Ready to publish @aion0/forge@$NEW_VERSION"
echo "Run: npm login && npm publish --access public --otp=<code>"
