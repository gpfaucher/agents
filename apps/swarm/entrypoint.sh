#!/bin/bash
set -e

# Repos are cloned on-demand by the application via REPO_MAP.
# Just ensure directories exist.
mkdir -p /data/repos /data/worktrees

# Link superpowers skills into each repo's .claude/skills/ directory.
# The SDK loads skills from cwd (the repo dir) via settingSources: ["project"].
# Also remove any project .mcp.json to prevent loading unwanted MCP servers
# (e.g. playwright, next-devtools) from target repos.
link_skills() {
  for repo_dir in /data/repos/*/; do
    [ -d "$repo_dir" ] || continue
    mkdir -p "$repo_dir/.claude/skills"
    for skill_dir in /app/.claude/skills/*/; do
      [ -d "$skill_dir" ] || continue
      skill_name=$(basename "$skill_dir")
      if [ ! -e "$repo_dir/.claude/skills/$skill_name" ]; then
        ln -s "$skill_dir" "$repo_dir/.claude/skills/$skill_name"
      fi
    done
    # Remove project MCP configs to prevent agents from loading unwanted MCP servers
    rm -f "$repo_dir/.mcp.json" "$repo_dir/.claude/mcp.json"
  done
}

# Link skills for any repos that already exist
link_skills

# Also set up an inotify-style hook: re-link when new repos appear
# (runs in background, lightweight)
(
  while true; do
    sleep 30
    link_skills
  done
) &

exec node /app/dist/index.js
