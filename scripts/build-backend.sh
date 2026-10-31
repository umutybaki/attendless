#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build
(cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -tags lambda.norpc -o ../.build/bootstrap .)
rm -f .build/backend.zip
(cd .build && zip -q backend.zip bootstrap)
