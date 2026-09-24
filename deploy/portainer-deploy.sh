#!/usr/bin/env bash
# Builds digsite's images on this host and deploys deploy/portainer-stack.yml
# as the Portainer stack `digsite` (created the first time, updated after).
#
#   deploy/portainer-deploy.sh
#
# Reads:
#   deploy/.env        the stack's settings and secrets (from
#                      .env.production.example); never committed
#   PORTAINER_ENV      a file with PORTAINER_URL / PORTAINER_USER /
#                      PORTAINER_PASSWORD (default: the ollama project's .env)
# Prints no secret. Images are tagged with the commit, so a redeploy of the
# same commit reuses them and a rollback is a redeploy of an older tag.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
STACK_FILE="$APP/deploy/portainer-stack.yml"
ENV_FILE="$APP/deploy/.env"
PORTAINER_ENV="${PORTAINER_ENV:-/mnt/Ghar/2TA/DevStuff/ollama/.env}"
STACK_NAME=digsite

[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE (copy .env.production.example)" >&2; exit 1; }
[ -r "$PORTAINER_ENV" ] || { echo "missing $PORTAINER_ENV" >&2; exit 1; }

# `KEY=value` lines to JSON, literally: no shell expansion of the values.
env_json() {
  python3 - "$1" <<'PY'
import json, sys
out = {}
for raw in open(sys.argv[1], encoding="utf-8"):
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
        v = v[1:-1]
    out[k.strip()] = v
print(json.dumps(out))
PY
}
settings=$(env_json "$ENV_FILE")
portainer=$(env_json "$PORTAINER_ENV")
get() { jq -r --arg k "$1" '.[$k] // empty' <<<"$2"; }

api_domain=$(get API_DOMAIN "$settings")
[ -n "$api_domain" ] || { echo "API_DOMAIN is not set in $ENV_FILE" >&2; exit 1; }
if [ "$(get AUTH_SECRET "$settings")" = "replace-with-a-long-random-secret" ]; then
  echo "AUTH_SECRET is still the placeholder" >&2; exit 1
fi

# -- images -------------------------------------------------------------------
cd "$APP"
if [ -n "$(git status --porcelain -- server shared web deploy db)" ]; then
  echo "note: building with uncommitted changes under server/ shared/ web/ deploy/ db/" >&2
fi
tag=$(git rev-parse --short HEAD)
server_image="digsite-server:$tag"
web_image="digsite-web:$tag-$(printf %s "$api_domain" | sha1sum | cut -c1-8)"

docker image inspect digsite-postgres:16-pgvector >/dev/null 2>&1 \
  || docker build -t digsite-postgres:16-pgvector db
docker image inspect "$server_image" >/dev/null 2>&1 \
  || docker build -f deploy/Dockerfile.server -t "$server_image" .
docker image inspect "$web_image" >/dev/null 2>&1 \
  || docker build -f deploy/Dockerfile.web \
       --build-arg "VITE_SERVER_ORIGIN=https://$api_domain" -t "$web_image" .
echo "[deploy] images $server_image $web_image"

# -- Portainer ----------------------------------------------------------------
url=$(get PORTAINER_URL "$portainer"); url="${url%/}"
auth=$(jq -nc --arg u "$(get PORTAINER_USER "$portainer")" \
  --arg p "$(get PORTAINER_PASSWORD "$portainer")" '{username:$u,password:$p}')
jwt=$(curl -fsS -k -H 'content-type: application/json' -d "$auth" "$url/api/auth" | jq -r .jwt)
[ -n "$jwt" ] && [ "$jwt" != null ] || { echo "Portainer sign-in failed" >&2; exit 1; }
h=(-H "authorization: Bearer $jwt" -H 'content-type: application/json')
endpoint=${PORTAINER_ENDPOINT_ID:-$(curl -fsS -k "${h[@]}" "$url/api/endpoints" | jq -r '.[0].Id')}

stack_env=$(jq -c --arg s "$server_image" --arg w "$web_image" \
  '. + {SERVER_IMAGE:$s, WEB_IMAGE:$w} | to_entries | map({name:.key, value:.value})' \
  <<<"$settings")
body=$(jq -Rs . <"$STACK_FILE")

existing=$(curl -fsS -k "${h[@]}" "$url/api/stacks" \
  | jq -r --arg n "$STACK_NAME" --argjson e "$endpoint" \
      '.[] | select(.Name == $n and .EndpointId == $e) | .Id' | head -1)
if [ -n "$existing" ]; then
  payload=$(jq -nc --argjson b "$body" --argjson env "$stack_env" \
    '{stackFileContent:$b, env:$env, prune:true, pullImage:false}')
  code=$(curl -k -sS -o /tmp/digsite-portainer.out -w '%{http_code}' -X PUT "${h[@]}" \
    -d "$payload" "$url/api/stacks/$existing?endpointId=$endpoint")
  what="updated stack $existing"
else
  payload=$(jq -nc --arg n "$STACK_NAME" --argjson b "$body" --argjson env "$stack_env" \
    '{Name:$n, StackFileContent:$b, Env:$env, FromAppTemplate:false}')
  code=$(curl -k -sS -o /tmp/digsite-portainer.out -w '%{http_code}' -X POST "${h[@]}" \
    -d "$payload" "$url/api/stacks/create/standalone/string?endpointId=$endpoint")
  what="created stack $STACK_NAME"
fi
if [ "$code" -ge 200 ] && [ "$code" -lt 300 ]; then
  echo "[deploy] $what (http $code)"
else
  echo "[deploy] FAILED (http $code):" >&2; cat /tmp/digsite-portainer.out >&2; exit 1
fi
