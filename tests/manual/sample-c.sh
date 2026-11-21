#!/bin/sh
set -eu
for delay in 0 75; do
    sleep "$delay"
    node -p "require('./.claude-plugin/plugin.json').version"
done
