# plasma-qa-tools

Lighthouse CI running against Vercel preview deployments on every PR.

## GitHub Secrets

The workflow requires four repository secrets. Add them in **Settings > Secrets and variables > Actions > New repository secret**.

### `VERCEL_TOKEN`

A Vercel personal access token used to poll the deployments API.

1. Go to https://vercel.com/account/tokens
2. Click **Create**
3. Give it a name (e.g. `lhci-github-action`) and pick a scope/expiration
4. Copy the token and save it as the `VERCEL_TOKEN` secret

### `VERCEL_PROJECT_ID`

The ID of the Vercel project whose preview deployments are audited.

1. Open your project on Vercel
2. Go to **Settings > General**
3. Copy the **Project ID** from the overview section
4. Save it as the `VERCEL_PROJECT_ID` secret

### `VERCEL_TEAM_ID`

The Vercel team (org) ID. Required if the project belongs to a team.

1. Go to https://vercel.com/teams and open your team
2. Go to **Settings > General**
3. Copy the **Team ID**
4. Save it as the `VERCEL_TEAM_ID` secret

### `VERCEL_AUTOMATION_BYPASS_SECRET`

Allows Lighthouse to bypass Vercel's Deployment Protection (the auth wall on preview URLs).

1. Open your project on Vercel
2. Go to **Settings > Deployment Protection**
3. Scroll to **Protection Bypass for Automation**
4. Click **Generate** (or copy the existing secret)
5. Save it as the `VERCEL_AUTOMATION_BYPASS_SECRET` secret
