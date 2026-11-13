#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ ! -f "$ENV_FILE" ]; then
  ENV_FILE="$SCRIPT_DIR/.env"
fi
STRIPE_API_KEY="$(grep -E '^STRIPE_SECRET_KEY=' "$ENV_FILE" | head -n1 | cut -d '=' -f2- | tr -d '"'\''\r')" \
"$SCRIPT_DIR/stripe" listen --skip-update \
  --events checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_succeeded,invoice.payment_failed \
  --forward-to http://127.0.0.1:8224/api/stripe/webhook
