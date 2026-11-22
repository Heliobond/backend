#!/bin/sh
# One-shot deployer for the local stack (#662). Runs inside the `deployer`
# container: waits for the local Stellar node, builds and deploys the contracts
# from the mounted contracts repo, funds accounts and writes /stack/contracts.env.
#
# The contracts repo is mounted at /contracts (see CONTRACTS_DIR in
# docker-compose.yml). Adjust the package/alias names below if your contracts
# repo names them differently.
set -eu

RPC_URL="${RPC_URL:-http://stellar:8000/soroban/rpc}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
FRIENDBOT_URL="${FRIENDBOT_URL:-http://stellar:8000/friendbot}"
OUT="${OUT:-/stack/contracts.env}"

echo "==> waiting for $RPC_URL"
until curl -sf "${RPC_URL%/soroban/rpc}/" >/dev/null 2>&1; do sleep 2; done

stellar network add local --rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE" || true

echo "==> funding deployer and admin accounts"
for name in deployer admin; do
  stellar keys generate "$name" --network local --fund 2>/dev/null || stellar keys fund "$name" --network local
done

cd /contracts
echo "==> building contracts"
stellar contract build

deploy() { # $1 = wasm file stem
  stellar contract deploy --wasm "target/wasm32v1-none/release/$1.wasm" --source deployer --network local
}

echo "==> deploying"
REGISTRY_ID="$(deploy "${REGISTRY_WASM:-project_registry}")"
VAULT_ID="$(deploy "${VAULT_WASM:-vault}")"

ADMIN_ADDR="$(stellar keys address admin)"
ADMIN_SECRET="$(stellar keys show admin)"

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
Stellar_NETWORK=local
RPC_URL=${RPC_URL_PUBLIC:-http://localhost:8000/soroban/rpc}
NETWORK_PASSPHRASE=$NETWORK_PASSPHRASE
PROJECT_REGISTRY_CONTRACT_ID=$REGISTRY_ID
VAULT_CONTRACT_ID=$VAULT_ID
ADMIN_ADDRESS=$ADMIN_ADDR
ADMIN_SECRET_KEY=$ADMIN_SECRET
EOF
echo "==> wrote $OUT"
