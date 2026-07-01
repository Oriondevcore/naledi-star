#!/bin/bash
cd "$(dirname "$0")"
echo "Starting helpme-api dev server on http://127.0.0.1:8787"
npx wrangler dev --port 8787 --ip 127.0.0.1
