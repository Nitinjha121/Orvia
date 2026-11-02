#!/usr/bin/env bash
# Snapshot the real database and the interview recordings, then prune old ones.
#
# Run this before anything risky. Interview recordings are irreplaceable: you
# cannot re-record a round you already did, and a report is only as good as the
# audio it was written from.
#
#   bash tools/backup-db.sh                # snapshot, then prune
#   bash tools/backup-db.sh --prune-only   # prune only, no dump
#   RETAIN_DAYS=7 bash tools/backup-db.sh  # keep a week instead of two days
#   PG_DUMP=/path/to/pg_dump bash tools/backup-db.sh   # skip version detection
#
# Every snapshot is a full copy of every recording, so old backups are pruned
# to prevent disk usage from growing unboundedly.
set -euo pipefail

DB="${DATABASE_URL:-postgresql://postgres@localhost:5432/orvia}"

# How many DAYS of snapshots to keep, counting today as the first. Two means
# today and yesterday; several runs on the same day all survive, since the unit
# is the day and not the run.
RETAIN_DAYS="${RETAIN_DAYS:-2}"

PRUNE_ONLY=0
[ "${1:-}" = "--prune-only" ] && PRUNE_ONLY=1

# pg_dump refuses to dump a newer server than itself, and the one on PATH is
# often an older DBngin install. Pick the binary that matches the running
# server rather than whichever happens to be first on PATH.
server_version() { psql "$DB" -tAc 'SHOW server_version;' | cut -d. -f1; }
find_pg_dump() {
  local major="$1" candidate
  for candidate in /Users/Shared/DBngin/postgresql/"$major"*/bin/pg_dump \
                   /opt/homebrew/opt/postgresql@"$major"/bin/pg_dump \
                   /usr/local/opt/postgresql@"$major"/bin/pg_dump; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  command -v pg_dump
}
NAME="$(basename "$DB" | cut -d'?' -f1)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/backups/$STAMP"

# Deletes snapshots older than RETAIN_DAYS. Only considers directories named
# YYYYMMDD-HHMMSS, always preserves the newest snapshot regardless of age,
# and compares the date encoded in the folder name rather than filesystem mtime.
prune_old_backups() {
  local dir="$ROOT/backups"
  [ -d "$dir" ] || return 0

  # BSD date on macOS, GNU date everywhere else.
  local back=$(( RETAIN_DAYS - 1 )) cutoff
  cutoff="$(date -v-"${back}"d +%Y%m%d 2>/dev/null || date -d "-${back} days" +%Y%m%d)"

  local stamps newest freed=0 removed=0
  stamps="$(ls -1 "$dir" 2>/dev/null | grep -E '^[0-9]{8}-[0-9]{6}$' | sort || true)"
  [ -n "$stamps" ] || return 0
  newest="$(echo "$stamps" | tail -1)"

  local stamp
  while IFS= read -r stamp; do
    [ -n "$stamp" ] || continue
    [ "$stamp" = "$newest" ] && continue
    [ "${stamp%%-*}" -ge "$cutoff" ] && continue

    local size
    size="$(du -sk "$dir/$stamp" | cut -f1)"
    rm -rf "$dir/$stamp"
    freed=$(( freed + size ))
    removed=$(( removed + 1 ))
    echo "  pruned $stamp"
  done <<< "$stamps"

  if [ "$removed" -gt 0 ]; then
    local human="$(( freed / 1024 ))MB"
    [ "$freed" -lt 1024 ] && human="${freed}KB"
    echo "pruned $removed snapshot(s) older than $RETAIN_DAYS day(s), freed $human"
  else
    echo "nothing to prune (keeping $RETAIN_DAYS day(s))"
  fi
}

# Before anything touches the server: pruning needs no database.
if [ "$PRUNE_ONLY" = 1 ]; then
  prune_old_backups
  du -sh "$ROOT/backups" 2>/dev/null || true
  exit 0
fi

PG_DUMP="${PG_DUMP:-$(find_pg_dump "$(server_version)")}"

# Built under a name the prune filter does not match, and renamed only once
# both halves are written. Otherwise an interrupted run leaves a half snapshot
# that the prune then protects as the NEWEST — while deleting the last good one.
PARTIAL="$OUT.partial"
trap 'rm -rf "$PARTIAL"' EXIT
mkdir -p "$PARTIAL"
"$PG_DUMP" "$DB" -Fc -f "$PARTIAL/$NAME.dump"

# `*.mix.wav` is the playback mix, rebuilt from the two tracks on demand. New
# ones go to DATA_DIR/mix; this skips the ones left in data/audio from before.
if [ -d "$ROOT/apps/api/data/audio" ] && [ -n "$(ls -A "$ROOT/apps/api/data/audio" 2>/dev/null)" ]; then
  tar -czf "$PARTIAL/recordings.tar.gz" --exclude='*.mix.wav' -C "$ROOT/apps/api/data" audio
fi

mv "$PARTIAL" "$OUT"
trap - EXIT

echo "backed up '$NAME' to $OUT  (using $PG_DUMP)"
du -sh "$OUT"

# Only after the new snapshot is safely on disk, so a failed dump above cannot
# take the previous one down with it.
prune_old_backups

echo
echo "restore with:"
echo "  pg_restore -d $DB --clean --if-exists $OUT/$NAME.dump"
echo "  tar -xzf $OUT/recordings.tar.gz -C $ROOT/apps/api/data"
