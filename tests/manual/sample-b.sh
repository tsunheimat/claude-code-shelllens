#!/bin/sh
set -eu
for delay in 0 30 30; do
    sleep "$delay"
    grep -c '^## ' README.md
done
