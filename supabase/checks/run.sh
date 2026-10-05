#!/usr/bin/env bash
# Run every SQL check and race case against a throwaway Postgres.
#
#   bash supabase/checks/run.sh                 all checks, then the race cases
#   bash supabase/checks/run.sh path/to/x.sql   only those files, no races
#
# It starts its own Postgres 15 with pgvector (256 MB, ephemeral port) and a
# PgBouncer in transaction mode, applies bootstrap.sql and every versioned
# migration in order, then runs each check. It never touches the local
# Supabase stack on 54322. Containers are removed on exit.
#
# A check is a .sql file in supabase/checks that opens with `begin;`, raises
# or asserts on failure, and ends with `rollback;`. Exit code is 1 if any
# check or race fails, or if a migration does not apply.
#
# On a shared machine run it as: nice -n 19 ionice -c3 bash supabase/checks/run.sh
set -euo pipefail

PG_IMAGE=pgvector/pgvector:pg15
POOL_IMAGE=edoburu/pgbouncer:v1.24.1-p1

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
id=cello-checks-$$

cleanup() {
  docker rm -f "$id-pg" "$id-pool" >/dev/null 2>&1 || true
  docker network rm "$id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$id" >/dev/null
docker run -d --name "$id-pg" --network "$id" --memory=256m \
  -e POSTGRES_PASSWORD=postgres -p 127.0.0.1::5432 \
  -v "$root/supabase:/supabase:ro" "$PG_IMAGE" >/dev/null

# -h 127.0.0.1: the image's init server listens on the socket only.
for _ in $(seq 60); do
  docker exec "$id-pg" pg_isready -h 127.0.0.1 -U postgres -q && break
  sleep 1
done
docker exec "$id-pg" pg_isready -h 127.0.0.1 -U postgres -q || { echo "postgres did not start"; exit 1; }

share=$(docker exec "$id-pg" pg_config --sharedir)
for f in "$here"/stubs/*; do docker cp "$f" "$id-pg:$share/extension/"; done

psql_f() { docker exec "$id-pg" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }

psql_f -f /supabase/checks/bootstrap.sql || { echo "bootstrap failed"; exit 1; }

# Only versioned files, as the Supabase CLI does. free_tier_migration.sql has no version.
while IFS= read -r m; do
  psql_f --single-transaction -f "/supabase/migrations/$m" || { echo "migration failed: $m"; exit 1; }
done < <(cd "$root/supabase/migrations" && LC_ALL=C ls | grep -E '^[0-9]{14}_.*\.sql$')

port=$(docker port "$id-pg" 5432/tcp | head -1 | sed 's/.*://')
DB="postgresql://postgres:postgres@127.0.0.1:$port/postgres"

# Checkpointer tables come from PostgresSaver.setup() only, never from vendored DDL.
[ -d "$root/apps/web/node_modules" ] || { echo "run pnpm install first"; exit 1; }
DB="$DB" APP="$root/apps/web/package.json" node --input-type=module -e '
import { createRequire } from "node:module";
const require = createRequire(process.env.APP);
const { PostgresSaver } = require("@langchain/langgraph-checkpoint-postgres");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DB });
try {
  await new PostgresSaver(pool, undefined, { schema: "langgraph" }).setup();
} finally {
  await pool.end();
}
' || { echo "checkpointer setup failed"; exit 1; }

if [ $# -gt 0 ]; then
  files=("$@")
else
  files=()
  for f in "$here"/*.sql; do [ "$(basename "$f")" = bootstrap.sql ] || files+=("$f"); done
fi

passed=0
failed=0
for f in "${files[@]}"; do
  abs=$(cd "$(dirname "$f")" && pwd)/$(basename "$f")
  if psql_f -f "/supabase${abs#"$root/supabase"}"; then
    echo "ok   $f"; passed=$((passed + 1))
  else
    echo "FAIL $f"; failed=$((failed + 1))
  fi
done

if [ $# -eq 0 ]; then
  docker run -d --name "$id-pool" --network "$id" --memory=64m \
    -e DB_HOST="$id-pg" -e DB_USER=postgres -e DB_PASSWORD=postgres -e DB_NAME=postgres \
    -e POOL_MODE=transaction -e AUTH_TYPE=scram-sha-256 -e DEFAULT_POOL_SIZE=10 \
    -e MAX_CLIENT_CONN=100 -e LISTEN_PORT=6432 -p 127.0.0.1::6432 "$POOL_IMAGE" >/dev/null
  pport=$(docker port "$id-pool" 6432/tcp | head -1 | sed 's/.*://')
  POOL="postgresql://postgres:postgres@127.0.0.1:$pport/postgres"
  race=$(RACE_DIRECT_URL="$DB" RACE_POOLER_URL="$POOL" node "$here/race.mjs") && race_rc=0 || race_rc=$?
  echo "$race"
  passed=$((passed + $(echo "$race" | grep -c '^ok   race' || true)))
  n=$(echo "$race" | grep -c '^FAIL race' || true)
  [ "$race_rc" -eq 0 ] || [ "$n" -gt 0 ] || n=1
  failed=$((failed + n))
fi

echo "checks: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
