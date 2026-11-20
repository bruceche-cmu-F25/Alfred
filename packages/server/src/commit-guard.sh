#!/bin/sh
# Git calls reference-transaction under its ref locks, after pre-commit/commit-msg hooks have run.
# Check the actual commit object before the branch moves. Preserve stdin for the repository's own hook.
set -eu
cat > "$ALFRED_REF_INPUT"
if [ "$1" = prepared ]; then
  while read -r old new ref; do
    case "$ref" in
      HEAD|"$ALFRED_REF")
        if [ "$old" != "$ALFRED_PARENT" ] || [ "$(git rev-parse "$new^{tree}")" != "$ALFRED_TREE" ]; then
          touch "$ALFRED_STALE"
          exit 1
        fi
        printf '%s' "$new" > "$ALFRED_REVISION"
        ;;
    esac
  done < "$ALFRED_REF_INPUT"
fi
if [ -x "$ALFRED_HOOKS/reference-transaction" ]; then
  exec "$ALFRED_HOOKS/reference-transaction" "$@" < "$ALFRED_REF_INPUT"
fi
