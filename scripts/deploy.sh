#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DEPLOYMENT_BUCKET:?Set DEPLOYMENT_BUCKET to a private deployment-artifact bucket in AWS_REGION}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-attendless-production}"
npm run build:backend
ARTIFACT_HASH="$(sha256sum .build/backend.zip | cut -d ' ' -f 1)"
ARTIFACT_KEY="$STACK_NAME/backend/$ARTIFACT_HASH.zip"
aws s3 cp .build/backend.zip "s3://$DEPLOYMENT_BUCKET/$ARTIFACT_KEY" --only-show-errors
aws cloudformation deploy --template-file infra/template.yaml \
  --stack-name "$STACK_NAME" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "CodeBucket=$DEPLOYMENT_BUCKET" "CodeKey=$ARTIFACT_KEY"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output json > .build/outputs.json
output() {
  node --input-type=module -e 'import fs from "node:fs"; const v=JSON.parse(fs.readFileSync(".build/outputs.json")).find(x=>x.OutputKey===process.argv[1])?.OutputValue; if(!v) process.exit(1); console.log(v)' "$1"
}
export ATTENDLESS_API_URL="$(output ApiUrl)"
npm run build
SITE_BUCKET="$(output SiteBucket)"
DISTRIBUTION_ID="$(output DistributionId)"
# Mutable entry files must not be cached at the browser or CloudFront.
aws s3 sync dist/ "s3://$SITE_BUCKET/" --delete --cache-control 'no-cache, max-age=0, must-revalidate'
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths '/*' > .build/invalidation.json
INVALIDATION_ID="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(".build/invalidation.json")).Invalidation.Id)')"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION_ID" --id "$INVALIDATION_ID"
SITE_URL="$(output SiteUrl)"
export SITE_URL
node scripts/smoke.mjs
printf 'Attendless deployed: %s\nAPI: %s\n' "$SITE_URL" "$ATTENDLESS_API_URL"
