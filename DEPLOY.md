# Deploying Attendless

Attendless runs entirely on Cloudflare: one Worker serves the site and the room API, and each room is a Durable Object. Steps marked **(once)** are never repeated. After that, every merge to `main` deploys automatically.

You need: the Cloudflare account that holds the `attendless.app` zone, admin access to the GitHub repository, and Node 22+ if you want to deploy from your machine.

## What it costs

| | Price | At a busy university (≈ 1,100 rooms a month) |
|---|---|---|
| Worker, Durable Objects, static files | Workers **Free** plan: 100,000 requests a day each, 13,000 GB-s a day of Durable Object compute. Static files are free and unlimited. | About 1% of the daily limits: **$0** |
| TURN relay (optional) | First 1,000 GB a month free, then $0.05/GB | About 90 GB a month: **$0** |
| Aptabase analytics (optional) | Free up to 20,000 events a month | About 16,500 events: **$0** |
| `attendless.app` | Domain renewal | about $14 a year |

On the Free plan, nothing on the Worker side can bill: once a daily limit is reached, requests fail until 00:00 UTC (03:00 in Turkey). Roughly 5,000 rooms a day fit (see [worker/README.md](worker/README.md#cost)). If usage ever gets close, upgrade to Workers Paid ($5 a month, 10 million Worker and 1 million Durable Object requests included); no code changes.

## 1. Create a deploy token (once)

1. In the Cloudflare dashboard, go to **Manage account → Account API tokens** and select **Create Token**.
2. Choose the **Edit Cloudflare Workers** template.
3. Under **Account resources**, pick your account. Under **Zone resources**, pick **Specific zone → attendless.app** (the template's Workers Routes permission lets the deploy attach the domain).
4. Create the token and copy it. It's shown once.
5. Copy your **Account ID** too: it's on the account's home page, or in the URL after `dash.cloudflare.com/`.

## 2. Turn on the TURN relay (once, recommended)

Without TURN, viewers on networks that block direct connections (some campus and corporate Wi-Fi, some mobile carriers) can't connect. With it, only those connections are relayed.

1. In the Cloudflare dashboard, go to **Realtime → TURN Server** and select **Create**.
2. Name it `attendless` and create it. Copy the **Turn Token ID** and the **API Token**.

The Worker turns them into short-lived credentials for each room; the browser never sees the key. To watch usage, the TURN page shows traffic per key.

## 3. Configure GitHub (once)

In **umutybaki/attendless → Settings → Environments → production** (create it if it doesn't exist; restrict deployment branches to `main`):

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 1 |
| Secret | `TURN_KEY_ID` | Turn Token ID from step 2 |
| Secret | `TURN_KEY_API_TOKEN` | API Token from step 2 |
| Variable | `DOMAIN_NAME` | `attendless.app` (leave unset to deploy on `workers.dev` only) |
| Variable | `APTABASE_APP_KEY` | optional, an EU Aptabase app key (`A-EU-…`) |

The same from a terminal:

```sh
gh secret set CLOUDFLARE_API_TOKEN --env production
gh variable set CLOUDFLARE_ACCOUNT_ID --env production --body 'PASTE_ACCOUNT_ID'
gh secret set TURN_KEY_ID --env production
gh secret set TURN_KEY_API_TOKEN --env production
gh variable set DOMAIN_NAME --env production --body attendless.app
```

If the AWS variables from the old deployment exist (`AWS_DEPLOY_ROLE_ARN`, `DEPLOYMENT_BUCKET`, `ROLE_BOUNDARY_ARN`, `AWS_REGION`, `CERTIFICATE_ARN`), delete them; nothing reads them now.

## 4. Free the domain's DNS records (once)

Cloudflare creates the DNS records and certificate for `attendless.app` and `www.attendless.app` itself, but it can't over an existing record. In Cloudflare, open **attendless.app → DNS → Records** and delete any A, AAAA or CNAME records for `@` and `www`, such as the CNAMEs to `…cloudfront.net` from the AWS deployment or a parking page. Keep everything else (mail records, and the ACM validation CNAMEs until step 7).

The site is down between this step and the deploy, a few minutes. To avoid that, deploy once with `DOMAIN_NAME` unset, test on the `workers.dev` address from the log, then delete the records, set `DOMAIN_NAME` and rerun the workflow.

## 5. Deploy

Merge the pull request. The workflow runs the unit tests, the browser tests (including the real Worker in local workerd) and a Wrangler dry run, then the deploy job:

1. builds the site with the API at `/api`;
2. runs `wrangler deploy`, uploading the TURN secrets and attaching the domain and its `www`;
3. runs [`scripts/smoke.mjs`](scripts/smoke.mjs) against the live site: headers, configuration, a refused foreign origin, and one real room created, joined over WebSockets and ended. It says whether TURN is on.

The log ends with `Attendless deployed: https://attendless.app`. A new custom domain can take a minute or two to get its certificate; the smoke check waits for it. To rerun: **Actions → Test and deploy Attendless → Run workflow → main**.

## 6. Check it on real devices

Mocked tests don't prove camera permissions or real networks, so do this once by hand ([the full list](worker/README.md#manual-acceptance-check)):

1. On a phone, open `https://attendless.app` and tap **New room**. Allow the camera, then share the invite.
2. Join from a second phone and from a laptop, using the code and the invite link.
3. Show a QR code on another screen. Both viewers should get the link within about a second, with a ticking age. Show a second code and check the link updates.
4. Try **Pause**, a reload on each device, switching the camera phone's network off and on for a few seconds, and **End** (two taps).
5. Repeat on Turkish mobile data and on a restrictive Wi-Fi network; with TURN on, both should connect.

## 7. Retire the AWS deployment (once, if it was deployed)

After step 6 passes. The stacks retain some resources on purpose, so delete those explicitly:

```sh
# The app: empty the site bucket first, or the stack can't delete it.
SITE_BUCKET=$(aws cloudformation describe-stacks --region eu-central-1 --stack-name attendless-production \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucket'].OutputValue" --output text)
TABLE=$(aws cloudformation describe-stacks --region eu-central-1 --stack-name attendless-production \
  --query "Stacks[0].Outputs[?OutputKey=='TableName'].OutputValue" --output text)
aws s3 rm "s3://$SITE_BUCKET" --recursive
aws cloudformation delete-stack --region eu-central-1 --stack-name attendless-production
aws cloudformation wait stack-delete-complete --region eu-central-1 --stack-name attendless-production
aws dynamodb delete-table --region eu-central-1 --table-name "$TABLE"   # retained by the stack

# The certificate (us-east-1).
aws cloudformation delete-stack --region us-east-1 --stack-name attendless-certificate

# The deploy setup: its artifact bucket is versioned and retained.
ARTIFACTS=$(aws cloudformation describe-stacks --region eu-central-1 --stack-name attendless-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='DeploymentBucket'].OutputValue" --output text)
aws cloudformation delete-stack --region eu-central-1 --stack-name attendless-bootstrap
aws s3api delete-objects --bucket "$ARTIFACTS" --delete "$(aws s3api list-object-versions --bucket "$ARTIFACTS" \
  --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}}' --output json)"
aws s3api delete-bucket --bucket "$ARTIFACTS"
```

If the bootstrap stack created GitHub's OIDC provider (you left `GitHubOidcProviderArn` empty) and the portfolio's deploys use it too, deleting the stack removes it. Recreate it afterwards with `aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com`. If a command fails because a resource never existed or a bucket is already empty, skip it. Finally, delete the ACM validation CNAMEs (`_…acm-validations.aws`) from Cloudflare DNS.

For the portfolio's old service, follow [MIGRATION.md](MIGRATION.md) §3, steps 5–6.

## Afterwards

- **Every merge to `main`** tests and deploys. Pull requests only test.
- **Deploying from your machine:** `npx wrangler login`, then `DOMAIN_NAME=attendless.app npm run deploy`. Export `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` to upload them too; otherwise the deployed secrets stay as they are.
- **Rollback:** `npx wrangler rollback` returns the Worker and its files to the previous version at once, or pick one with `npx wrangler versions list`. Reverting the commit on `main` also redeploys. Rooms live in Durable Objects, which a rollback doesn't touch.
- **Usage:** **Workers & Pages → attendless → Metrics**, and **Durable Objects** for requests and compute against the free limits. Logs are sampled at 10% (`observability` in `wrangler.jsonc`).
- **Abuse:** room codes are guessable and the API is public. On the Free plan, abuse can only exhaust the daily limits, not run up a bill. TURN credentials go to anyone in a room, so the TURN relay is the one cost exposed to abuse; Cloudflare's TURN page shows its traffic, and the key can be rotated at any time.
