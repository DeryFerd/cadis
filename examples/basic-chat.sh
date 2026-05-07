#!/usr/bin/env bash
# Basic CADIS chat session
# Prerequisites: cadisd running (cadisd &)
set -euo pipefail

echo '=== CADIS Basic Chat Example ==='
echo 'Checking daemon status...'
cadis status
echo ''
echo 'Listing available models...'
cadis models
echo ''
echo 'Sending a chat message...'
cadis chat "What is 2 + 2?"
echo ''
echo 'Done!'
