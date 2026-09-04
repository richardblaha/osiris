#!/usr/bin/env bash
# Idempotent local/CI bootstrap for the osiris-kind-operator: creates the
# `osiris-kind` cluster if it doesn't already exist, builds the operator
# image, loads it into the cluster, and applies CRDs + RBAC + the manager
# Deployment. Re-run any time to pick up code changes.
#
# This is deliberately a standalone script, not something the `osiris` CLI
# invokes automatically (that auto-bootstrap behavior is spec section 3.1 and
# out of scope here) — it exists so a developer or CI job can stand the
# operator up with one command.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLUSTER=osiris-kind
IMG=${IMG:-osiris-kind-operator:dev}

if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  echo "==> creating kind cluster ${CLUSTER}"
  kind create cluster --name "${CLUSTER}" --config hack/kind-config.yaml
else
  echo "==> kind cluster ${CLUSTER} already exists"
fi

echo "==> building operator image ${IMG}"
docker build -t "${IMG}" .

echo "==> loading image into ${CLUSTER}"
kind load docker-image "${IMG}" --name "${CLUSTER}"

echo "==> generating manifests"
make manifests generate

echo "==> applying CRDs"
kubectl apply -k config/crd

echo "==> applying RBAC"
kubectl apply -k config/rbac

echo "==> deploying operator"
make deploy IMG="${IMG}"

echo "==> waiting for rollout"
kubectl -n osiris-system rollout status deployment/osiris-controller-manager --timeout=120s

echo "==> done. Try: kubectl apply -f config/samples/osiris_v1alpha1_osirisproject.yaml"
