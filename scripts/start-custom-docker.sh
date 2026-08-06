#!/usr/bin/env bash
# Start Colima + custom OpenConstructionERP (your code + migrated data + converters).
set -euo pipefail
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
export DOCKER_DEFAULT_PLATFORM=linux/amd64
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! colima status >/dev/null 2>&1; then
  echo "Starting Colima (vz + rosetta)..."
  colima start --vm-type=vz --vz-rosetta --cpu 4 --memory 8 --disk 60 --arch aarch64
fi
docker context use colima >/dev/null 2>&1 || true

docker compose -f docker-compose.custom.yml up -d
echo "Waiting for http://127.0.0.1:8080 ..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8080/api/health >/dev/null; then
    echo ""
    echo "Ready:  http://localhost:8080"
    echo "Login:  demo@openconstructionerp.com / DemoPass1234!"
    echo "Note:   Use this URL for BIM/DWG converters (not :5173/:8000)."
    exit 0
  fi
  sleep 2
done
echo "Timed out" >&2
exit 1
