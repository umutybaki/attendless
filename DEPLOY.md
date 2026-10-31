# Deploying Attendless

First deployment, start to finish, including `attendless.app` on Cloudflare. Steps marked **(once)** are never repeated. After that, every merge to `main` deploys automatically.

You need: AWS CLI v2, an AWS identity that can create IAM roles (an administrator), access to the Cloudflare dashboard for `attendless.app`, and admin access to the GitHub repository.

**Regions.** Attendless runs in **eu-central-1 (Frankfurt)**, the closest AWS region to its users in Turkey. That covers the API, the room database, the site files and the deploy setup.

- **The certificate is the one exception.** CloudFront only accepts TLS certificates issued in **us-east-1**, so the certificate gets its own small stack there. It holds no data and costs nothing.
- **CloudFront itself is global.** It serves visitors from edge locations near them. Its `PriceClass_100` includes the "Europe, Israel, and Türkiye" pricing region, and CloudFront has an edge location in Istanbul.

## 1. Sign in to AWS

```sh
aws login
aws sts get-caller-identity
```

Use the account you want Attendless in. Each command below passes `--region` explicitly.

## 2. Find out whether GitHub's OIDC provider exists (once)

An AWS account can have only one `token.actions.githubusercontent.com` provider. Your portfolio may already use it. The provider is global, so the region doesn't matter here.

```sh
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text
```

If an ARN ending in `oidc-provider/token.actions.githubusercontent.com` appears, keep it for the next step. Otherwise, leave the parameter empty and the bootstrap creates it.

## 3. Deploy the bootstrap stack in Frankfurt (once)

[`infra/bootstrap.yaml`](infra/bootstrap.yaml) creates:

- the private bucket for Lambda packages;
- a permissions boundary;
- the role GitHub Actions assumes to deploy. Its trust is pinned to this repository's `production` environment, and it can only touch resources named `attendless-production-*` in this region.

The trust must match the exact subject GitHub puts in its tokens. This repository uses GitHub's immutable subjects, which carry owner and repository IDs. The template's `GitHubSubjectPrefix` default is `repo:umutybaki@56262778/attendless@1439523130`. For another repository, print its prefix with `gh api repos/OWNER/REPO/actions/oidc/customization/sub` and pass it as `GitHubSubjectPrefix`.

```sh
aws cloudformation deploy --region eu-central-1 \
  --stack-name attendless-bootstrap \
  --template-file infra/bootstrap.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubOidcProviderArn=PASTE_ARN_FROM_STEP_2_OR_LEAVE_EMPTY

aws cloudformation describe-stacks --region eu-central-1 --stack-name attendless-bootstrap \
  --query 'Stacks[0].Outputs[].[Description,OutputValue]' --output table
```

Keep the outputs: they become GitHub variables in step 5.

## 4. Issue the certificate in us-east-1 and validate it in Cloudflare (once)

[`infra/certificate.yaml`](infra/certificate.yaml) requests a certificate for `attendless.app` and `www.attendless.app`:

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name attendless-certificate \
  --template-file infra/certificate.yaml
```

The command will appear to hang. **This is expected.** The certificate waits for DNS validation, so keep it running. In another terminal, print the validation records:

```sh
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='attendless.app'].CertificateArn" --output text
aws acm describe-certificate --region us-east-1 --certificate-arn PASTE_ARN \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' --output table
```

In Cloudflare, open **attendless.app → DNS → Records** and add each record as:

- **Type:** CNAME
- **Name:** the record's `Name`, without the trailing dot
- **Target:** its `Value`
- **Proxy status:** **DNS only** (grey cloud)

The two names can share a record. If Cloudflare reports a duplicate, one record is enough.

Validation usually takes a few minutes, after which the deploy command finishes. Leave these records in place: ACM uses them to renew the certificate. If the zone has CAA records, one of them must allow `amazon.com`.

Print the certificate's ARN for step 8:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name attendless-certificate \
  --query "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue" --output text
```

## 5. Configure GitHub (once)

1. In **umutybaki/attendless → Settings → Environments**, create `production`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.
3. Add these environment variables:

   | Variable | Value |
   |---|---|
   | `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` output (step 3) |
   | `DEPLOYMENT_BUCKET` | `DeploymentBucket` output (step 3) |
   | `ROLE_BOUNDARY_ARN` | `RoleBoundaryArn` output (step 3) |
   | `AWS_REGION` | `eu-central-1` |

   Leave `DOMAIN_NAME` and `CERTIFICATE_ARN` unset for now. The first deploy uses the CloudFront hostname, because the domain can't point anywhere until the distribution exists.

The same from a terminal:

```sh
gh api -X PUT repos/umutybaki/attendless/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/umutybaki/attendless/environments/production/deployment-branch-policies -f name=main
gh variable set AWS_DEPLOY_ROLE_ARN --env production --body 'arn:aws:iam::…'
gh variable set DEPLOYMENT_BUCKET   --env production --body 'attendless-bootstrap-artifactbucket-…'
gh variable set ROLE_BOUNDARY_ARN   --env production --body 'arn:aws:iam::…:policy/…'
gh variable set AWS_REGION          --env production --body eu-central-1
```

## 6. First deploy

Open a pull request from `codex/extract-attendless` to `main`. CI runs the Node, Go, browser and cfn-lint checks. Merge it once they pass; the merge to `main` deploys.

The deploy job:

1. builds and uploads the Lambda;
2. deploys the `attendless-production` stack in eu-central-1 (the first run takes 10–20 minutes, mostly CloudFront);
3. uploads the site and invalidates the CloudFront cache;
4. runs [`scripts/smoke.mjs`](scripts/smoke.mjs) against the live site. It creates, joins and ends one real room.

The log ends with `Attendless deployed: https://dxxxxxxxx.cloudfront.net`.

## 7. Point attendless.app at CloudFront (once)

Get the distribution hostname:

```sh
aws cloudformation describe-stacks --region eu-central-1 --stack-name attendless-production \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
```

In Cloudflare DNS, add two records. Both are **CNAME**, **DNS only (grey cloud)**, with the target `dxxxxxxxx.cloudfront.net`:

- Name `@`. Cloudflare flattens a CNAME on the apex, so this works.
- Name `www`.

Delete any existing A, AAAA or CNAME records for `@` and `www` first, such as a parking page.

**Keep the proxy off.** With the orange cloud, Cloudflare puts a second CDN and TLS hop in front of CloudFront, and that interferes with how CloudFront recognizes the domain. If you want Cloudflare features later, plan that separately.

## 8. Switch the site to the domain

Add two more `production` variables:

| Variable | Value |
|---|---|
| `DOMAIN_NAME` | `attendless.app` |
| `CERTIFICATE_ARN` | the us-east-1 certificate ARN from step 4 |

Then rerun the deploy: **Actions → Test and deploy Attendless → Run workflow → main**. This run:

- adds `attendless.app` and `www.attendless.app` to CloudFront with the certificate;
- allows both origins in the API's CORS;
- runs the smoke test against `https://attendless.app`.

## 9. Check it on real devices

Mocked tests don't prove camera permissions or real network traversal, so do this once by hand:

1. On a phone, open `https://attendless.app` and tap **New room**. Allow the camera, then share the invite.
2. Join from a second phone and from a laptop, using the code and the invite link.
3. Show a QR code on another screen. Both viewers should get the link within about a second, with a ticking age. Show a second QR code and check that the link updates.
4. Try **Pause**, a reload on each device, and **End** (two taps). Viewers should see each state.
5. Repeat on mobile data from Turkish carriers. There is no TURN relay, so some restrictive networks (strict corporate or campus Wi-Fi) can't connect directly.

## Afterwards

- **Every merge to `main`** tests and deploys. Pull requests only test.
- **Deploying from your machine** uses the same script, which defaults to eu-central-1. Export the same values first:

  ```sh
  DEPLOYMENT_BUCKET=… ROLE_BOUNDARY_ARN=… DOMAIN_NAME=attendless.app CERTIFICATE_ARN=… npm run deploy
  ```
- **Rollback:** redeploy a known-good commit. Old Lambda packages stay in the artifact bucket.
- **Retiring the old portfolio service:** follow [MIGRATION.md](MIGRATION.md) §3, steps 5–6, only after step 9 passes. The portfolio's old service stays in its own region; only Attendless moves to Frankfurt.
- **Costs:** the stacks have no fixed monthly charges, only pay-per-use pricing for requests, DynamoDB and transfer. Frankfurt's rates are somewhat higher than us-east-1's. The certificate is free.
- **Abuse:** room codes are guessable and the API is public. It does not enforce a spending cap. If abuse becomes a problem, the next step is AWS WAF rate limiting. That needs the API routed through CloudFront, because WAF can't attach to a Lambda Function URL, and costs about $5–10 a month.
