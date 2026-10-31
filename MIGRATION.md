# Move Attendance QR from the portfolio to Attendless

The code has been extracted into this repository. AWS resources have **not** been deployed or transferred, and GitHub settings have **not** been changed. Commit and push the two repositories separately, deploying Attendless first.

> **Sections 1, 2 and 4 are superseded by [DEPLOY.md](DEPLOY.md)**, which deploys Attendless in **eu-central-1** (not us-east-1 as below), creates the artifact bucket and deploy role with `infra/bootstrap.yaml`, the certificate with `infra/certificate.yaml`, and sets up `attendless.app`. Rooms are no longer the fixed `313131`: test with **New room** on one device and its code on another. Section 3's cutover order (Attendless first, then the portfolio removal) still applies.

## 1. Prepare AWS access

Use the same AWS account and `us-east-1` initially. The new stack is named `attendless-production`; the portfolio keeps its existing SST app/state. Do not rename or reuse the portfolio SST app to deploy Attendless.

Create a private S3 bucket for deployment ZIPs in the deployment region. Choose a globally unique name. Example, using an already authenticated AWS CLI:

```sh
aws s3api create-bucket --bucket YOUR_UNIQUE_ARTIFACT_BUCKET --region us-east-1
aws s3api put-public-access-block --bucket YOUR_UNIQUE_ARTIFACT_BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

For regions other than `us-east-1`, bucket creation also needs `--create-bucket-configuration LocationConstraint=REGION`. The artifact bucket and Lambda must be in the same region. This bucket is separate from the automatically created frontend bucket.

The account already uses GitHub's OIDC provider for the portfolio. Create a separate deployment role for Attendless, or extend the existing role's trust deliberately. Use this trust policy with your account ID:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:umutybaki/attendless:environment:production"
      }
    }
  }]
}
```

The workflow uses the GitHub **production environment**, so its OIDC subject is the environment subject above, not `ref:refs/heads/main`. Restrict that environment to the `main` branch in GitHub. If sharing the existing role, preserve the portfolio's existing trusted subject and add this one as another allowed value.

Grant the role permissions to deploy the resources in `infra/template.yaml`. CloudFormation executes with this role's credentials; `CAPABILITY_IAM` acknowledges role creation but does not grant permissions. The role needs:

- CloudFormation change-set creation/execution, stack creation/update and stack/change-set/event/template reads.
- Read/write the deployment ZIP prefix in the artifact bucket.
- Create/update/read/delete the stack's S3 bucket, bucket policy, ownership and public-access settings; list and sync its objects.
- Create/update/read/delete the stack's CloudFront distribution and origin access control; create/read invalidations and tag resources.
- Create/update/read/delete the Go Lambda, Function URL and resource-policy permissions, and tag resources.
- Create/update/read/delete the DynamoDB table, describe/update TTL and tag resources.
- Create/update/read/delete the stack's Lambda execution role and its inline policy, attach/detach `AWSLambdaBasicExecutionRole`, read role policies and tag the role. Allow `iam:PassRole` for that role only, to `lambda.amazonaws.com`.
- Create/read/delete the Lambda log group, set its retention and tag it.

An AWS administrator should scope these deployment permissions to the stack's resources and artifact prefix; the existing portfolio deployment policy may not include CloudFormation or CloudFront origin access controls. The Lambda's own role is separately provisioned with only logging plus Get/Put/Update/Query on its table.

## 2. Configure GitHub

In **umutybaki/attendless → Settings → Environments**, create `production`, restrict deployment branches to `main`, and configure these environment variables (repository variables also work):

| Variable | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | ARN of the OIDC deployment role |
| `DEPLOYMENT_BUCKET` | Private artifact bucket name |
| `AWS_REGION` | `us-east-1` (default if absent) |

No long-lived AWS keys and no manually copied API URL are required. Ensure Actions is enabled and permitted to request OIDC tokens. `.github/workflows/ci.yml` tests pull requests and main pushes; main pushes and manual runs on main deploy after tests. Production environment approval rules, if you add them, also apply.

The job runs Node tests, Go race tests, ARM64 Lambda packaging, mocked Chromium tests and CloudFormation lint. Deployment builds the backend, uploads a content-addressed ZIP, deploys CloudFormation, reads the outputs, writes the public API endpoint into the static site, uploads it and waits for CloudFront invalidation. The final smoke check verifies the site, decoder, endpoint, CORS, invalid-code rejection, a real DynamoDB session write and authenticated room status. Its temporary session expires in two hours; it does not claim the camera lease.

## 3. Deploy Attendless before removing the old service

1. Commit/push Attendless to `main` after setting the variables above, or run its workflow manually on `main`.
2. Read `SiteUrl` and `ApiUrl` from the deployment log or CloudFormation outputs:

   ```sh
   aws cloudformation describe-stacks --stack-name attendless-production \
     --region us-east-1 --query 'Stacks[0].Outputs'
   ```

3. Open `SiteUrl` on a phone and desktop. Join with `313131`, share on the phone, scan two different QR links, check both viewers, stop and reclaim from a second phone. Check English and `?lang=tr`. Repeat on Wi-Fi and mobile data. Mocked CI tests do not prove camera permissions or real WebRTC traversal.
4. Users must rejoin on the new site. The new table is empty by design. Existing data consists of two-hour sessions/signaling and a 12-second lease; there are no accounts, QR histories or media records to migrate. Old and new rooms are independent during cutover.
5. Only after the new service works, commit/push the portfolio extraction to `main`. Its SST config now provisions only `Web`; Go setup, attendance routes, tool listing, translations, QR decoder and attendance tests are removed. The portfolio's pipeline now runs its remaining tests and type check before its existing SST deploy.
6. Inspect the portfolio's SST resource diff/output for the removal of `AttendanceQRBackend`, its URL/permissions and `AttendanceQR`. Production uses `removal: retain`; inspect which stateful resources SST retains. Do not manually delete a table while SST still manages it. After cutover, inspect retained resources and delete unused ones deliberately to avoid leftovers. Do not delete the portfolio stack or its deployment role.

Local migration validation passed Attendless's unit/browser tests, Go race tests, static build, ARM64 Lambda packaging and CloudFormation lint, plus the portfolio's remaining tests and type check. The portfolio production build needs access to `fonts.googleapis.com` and `fonts.gstatic.com`; this cloud task's network policy rejects Google Fonts. The GitHub-hosted runner ordinarily has that access. No deployed AWS checks have run yet; the workflow runs them after deployment.

The old `/attendance-qr`, `/en/tools/attendance-qr` and Turkish routes are removed. Announce/share the new `SiteUrl`; no destination domain was assumed and no hardcoded redirect is installed. If you want to preserve old bookmarks, add redirects in a separate portfolio change once the final Attendless hostname is known.

## 4. Custom domain (optional)

The default CloudFront hostname already provides HTTPS. For a custom hostname:

1. Issue and DNS-validate an ACM certificate in **us-east-1**, even if the stack is in another region.
2. Add the hostname to the distribution's `Aliases` and use its ACM certificate in `ViewerCertificate` instead of `CloudFrontDefaultCertificate`.
3. Add the exact `https://HOSTNAME` to `BackendUrl.Cors.AllowOrigins`, keeping the CloudFront and local origins if still needed. Update and redeploy the template through GitHub.
4. Point your DNS CNAME (or provider ALIAS) to the `SiteUrl` hostname. Test the custom origin, preflight, joining and real device sharing before sharing it.

Use CloudFront's certificate and HTTPS configuration; DNS alone does not configure a custom CloudFront hostname. The frontend endpoint config remains automatic because the backend URL does not depend on the site's hostname.

## Local deployment and rollback

With AWS CLI v2, Node, Go and zip installed and authenticated to the intended account:

```sh
npm ci
AWS_REGION=us-east-1 DEPLOYMENT_BUCKET=YOUR_UNIQUE_ARTIFACT_BUCKET npm run deploy
```

To roll back a faulty Attendless revision, redeploy a known-good commit using this script with the same stack name and artifact bucket (or revert it on main). Old artifact ZIPs remain in the artifact bucket. A failed CloudFormation deployment does not upload a new frontend. A frontend upload failure can require rerunning the known-good deployment; S3 sync is not an atomic release. The table has Retain policies; deleting a stack will not delete it, and a nonempty frontend bucket must be emptied before stack deletion.

If cutover fails before the portfolio deploy, keep using the old site. After the portfolio removes the service, reverting that commit and deploying can recreate removed resources rather than restore old sessions. Prefer fixing or rolling back Attendless; coordinate any return to the old site and have users rejoin.
