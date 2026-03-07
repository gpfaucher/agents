#!/bin/bash
set -e

# Repos are cloned on-demand by the application via REPO_MAP.
# Just ensure directories exist.
mkdir -p /data/repos /data/worktrees

exec node /app/dist/index.js
