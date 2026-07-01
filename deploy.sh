#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Applying D1 migrations..."
npx wrangler d1 execute user_db --remote --file=migrations/0001_create_schema.sql
npx wrangler d1 execute user_db --remote --file=migrations/0010_leads_userdb.sql
echo "Deploying worker..."
npx wrangler deploy
echo "Done! Visit https://helpme-api.$(whoami).workers.dev"
