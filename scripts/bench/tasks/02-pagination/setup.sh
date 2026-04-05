#!/usr/bin/env bash
# Create a basic user list module without pagination.
set -e
PROJECT="${1:-/Users/zliu/IdeaProjects/harness_test}"
mkdir -p "$PROJECT/src/api"

cat > "$PROJECT/src/api/users.js" <<'EOF'
const USERS = Array.from({ length: 127 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
}));

export function listUsers() {
  return USERS;
}
EOF

echo "Setup complete: created src/api/users.js with 127 users and a listUsers() function."
