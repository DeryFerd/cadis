#!/usr/bin/env bash
# CADIS workspace registration and tool usage
set -euo pipefail
PROJECT_DIR=$(mktemp -d)
echo '=== CADIS Workspace + Tools Example ==='
echo "Using temp project: $PROJECT_DIR"
cd "$PROJECT_DIR" && git init && echo '# Test' > README.md && git add . && git commit -m 'init'
cadis workspace register example-project "$PROJECT_DIR" --kind project
cadis workspace list --grants
cadis workspace doctor example-project
echo 'Cleaning up...'
rm -rf "$PROJECT_DIR"
echo 'Done!'
