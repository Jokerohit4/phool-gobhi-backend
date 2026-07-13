#!/usr/bin/env bash
# Manual one-command deploy fallback for a single Cloud Run service.
#
# Usage: scripts/deploy-cloud-run.sh <service> <dev|prod>
#   service: gateway | auth-service | gym-service | wallet-service | booking-service
#
# Exists because Render's auto-deploy-on-push turned out to be silently
# broken (see the phool-gobhi-backend-deploy memory) — never trust a CI
# webhook alone; always keep a manual path that's known to work. Run this
# from the repo root.
#
# Assumes two separate GCP projects (one per environment), each with plainly
# named services ("gateway", "auth-service", ...) — set GCP_PROJECT_DEV /
# GCP_PROJECT_PROD to those project ids. If you instead used a single shared
# project with "-dev"/"-prod" suffixed service names, change SERVICE below
# to "${SERVICE}-${ENVIRONMENT}" and drop the per-env project lookup.
set -euo pipefail

SERVICE="${1:?Usage: $0 <service> <dev|prod>}"
ENVIRONMENT="${2:?Usage: $0 <service> <dev|prod>}"
REGION="${REGION:-asia-south1}"

case "$ENVIRONMENT" in
  dev)  PROJECT="${GCP_PROJECT_DEV:?Set GCP_PROJECT_DEV to your dev GCP project id}" ;;
  prod) PROJECT="${GCP_PROJECT_PROD:?Set GCP_PROJECT_PROD to your prod GCP project id}" ;;
  *) echo "Environment must be 'dev' or 'prod', got: $ENVIRONMENT" >&2; exit 1 ;;
esac

case "$SERVICE" in
  gateway) SOURCE_DIR="." ;;
  auth-service|gym-service|wallet-service|booking-service) SOURCE_DIR="services/$SERVICE" ;;
  *) echo "Unknown service: $SERVICE (expected gateway|auth-service|gym-service|wallet-service|booking-service)" >&2; exit 1 ;;
esac

echo "Deploying $SERVICE to project $PROJECT ($ENVIRONMENT), region $REGION..."
gcloud run deploy "$SERVICE" \
  --source "$SOURCE_DIR" \
  --project "$PROJECT" \
  --region "$REGION" \
  --allow-unauthenticated \
  --quiet

echo "Done. Service URL:"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format="value(status.url)"
