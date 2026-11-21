#!/bin/sh
# Manual Shell Insight test: wait for a 100-second timer in the foreground.
printf '%s\n' 'Waiting for the 100-second timer. No further output is expected until it expires.'
timeout 100s sleep 200
status=$?
case $status in
    124) printf '%s\n' 'The 100-second timer expired; the foreground wait is over.' ;;
    0)   printf '%s\n' 'Unexpected: sleep finished before the timer expired.' >&2; exit 1 ;;
    *)   exit "$status" ;;
esac
