# Deploying Attendless

First deployment, start to finish, including `attendless.app` on Cloudflare. Steps marked **(once)** are never repeated. After that, every merge to `main` deploys automatically.

You need: AWS CLI v2, an AWS identity that can create IAM roles (an administrator), access to the Cloudflare dashboard for `attendless.app`, and admin access to the GitHub repository.

## 1. Sign in to AWS

```sh
aws login
aws sts get-caller-identity
```

Use the account you want Attendless in. Everything below runs in **us-east-1**: CloudFront only accepts certificates issued there.

## 2. Find out whether GitHub's OIDC provider exists (once)

An AWS account can have only one `token.actions.githubusercontent.com` provider. Your portfolio may already use it.

```sh
aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text
```

If an ARN ending in `oidc-provider/token.actions.githubusercontent.com` appears, keep it for the next step. Otherwise, leave the parameter empty and the bootstrap creates it.

## 3. Deploy the bootstrap stack (once)

[`infra/bootstrap.yaml`](infra/bootstrap.yaml) creates:

- the private bucket for Lambda packages;
- the certificate for `attendless.app` and `www.attendless.app`;
- a permissions boundary;
- the role GitHub Actions assumes to deploy. Its trust is pinned to this repository's `production` environment, and it can only touch resources named `attendless-production-*`.

```sh
aws cloudformation deploy --region us-east-1 \
  --stack-name attendless-bootstrap \
  --template-file infra/bootstrap.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GitHubOidcProviderArn=PASTE_ARN_FROM_STEP_2_OR_LEAVE_EMPTY
```

The command will appear to hang. **This is expected.** The certificate waits for DNS validation, so keep it running and do step 4 in another terminal.

## 4. Validate the certificate in Cloudflare (once)

Print the validation records:

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

Validation usually takes a few minutes, after which the step 3 command finishes. Leave these records in place: ACM uses them to renew the certificate. If the zone has CAA records, one of them must allow `amazon.com`.

Then print the outputs. You need them in step 5:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name attendless-bootstrap \
  --query 'Stacks[0].Outputs[].[Description,OutputValue]' --output table
```

## 5. Configure GitHub (once)

1. In **umutybaki/attendless → Settings → Environments**, create `production`.
2. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`.
3. Add these environment variables:

   | Variable | Value |
   |---|---|
   | `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` output |
   | `DEPLOYMENT_BUCKET` | `DeploymentBucket` output |
   | `ROLE_BOUNDARY_ARN` | `RoleBoundaryArn` output |
   | `AWS_REGION` | `us-east-1` |

   Leave `DOMAIN_NAME` and `CERTIFICATE_ARN` unset for now. The first deploy uses the CloudFront hostname, because the domain can't point anywhere until the distribution exists.

The same from a terminal:

```sh
gh api -X PUT repos/umutybaki/attendless/environments/production \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/umutybaki/attendless/environments/production/deployment-branch-policies -f name=main
gh variable set AWS_DEPLOY_ROLE_ARN --env production --body 'arn:aws:iam::…'
gh variable set DEPLOYMENT_BUCKET   --env production --body 'attendless-bootstrap-artifactbucket-…'
gh variable set ROLE_BOUNDARY_ARN   --env production --body 'arn:aws:iam::…:policy/…'
gh variable set AWS_REGION          --env production --body us-east-1
```

## 6. First deploy

Open a pull request from `codex/extract-attendless` to `main`. CI runs the Node, Go, browser and cfn-lint checks. Merge it once they pass; the merge to `main` deploys.

The deploy job:

1. builds and uploads the Lambda;
2. deploys the `attendless-production` stack (the first run takes 10–20 minutes, mostly CloudFront);
3. uploads the site and invalidates the CloudFront cache;
4. runs [`scripts/smoke.mjs`](scripts/smoke.mjs) against the live site. It creates, joins and ends one real room.

The log ends with `Attendless deployed: https://dxxxxxxxx.cloudfront.net`.

## 7. Point attendless.app at CloudFront (once)

Get the distribution hostname:

```sh
aws cloudformation describe-stacks --region us-east-1 --stack-name attendless-production \
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
| `CERTIFICATE_ARN` | `CertificateArn` output from step 4 |

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
5. Repeat on mobile data. There is no TURN relay, so some restrictive networks (strict corporate or campus Wi-Fi) can't connect directly.

## Afterwards

- **Every merge to `main`** tests and deploys. Pull requests only test.
- **Deploying from your machine** uses the same script. Export the same values first:

  ```sh
  DEPLOYMENT_BUCKET=… ROLE_BOUNDARY_ARN=… DOMAIN_NAME=attendless.app CERTIFICATE_ARN=… npm run deploy
  ```
- **Rollback:** redeploy a known-good commit. Old Lambda packages stay in the artifact bucket.
- **Retiring the old portfolio service:** follow [MIGRATION.md](MIGRATION.md) §3, steps 5–6, only after step 9 passes.
- **Costs:** the stack has no fixed monthly charges, only pay-per-use pricing for requests, DynamoDB and transfer. The certificate is free.
- **Abuse:** room codes are guessable and the API is public. It does not enforce a spending cap. If abuse becomes a problem, the next step is AWS WAF rate limiting. That needs the API routed through CloudFront, because WAF can't attach to a Lambda Function URL, and costs about $5–10 a month.
