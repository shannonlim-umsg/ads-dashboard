# Meta + TikTok Ads Dashboard for GitHub Pages

This package publishes the dashboard on GitHub Pages and syncs paid ads data from Meta and TikTok using GitHub Actions.

## Included files

```text
index.html
dashboard-data.json
scripts/sync-ads-data.mjs
.github/workflows/sync-ads-data.yml
README.md
```

## What it syncs

The workflow pulls the past 30 days of data and stores it in `dashboard-data.json`.

### Meta

- Campaign level
- Ad Set level
- Ad level

### TikTok

- Campaign level
- Ad Group level, mapped into the dashboard as `Ad Set / Ad Group`
- Ad level

The dashboard table nests data like this:

```text
Campaign
  > Ad Set / Ad Group
      > Ad
```

## GitHub setup

Upload all files to the root of your GitHub repository.

Make sure the workflow file is located exactly here:

```text
.github/workflows/sync-ads-data.yml
```

If GitHub does not show hidden folders on upload, create the file manually in GitHub by clicking:

```text
Add file > Create new file
```

Then type the filename as:

```text
.github/workflows/sync-ads-data.yml
```

## Repository secrets

Go to:

```text
Settings > Secrets and variables > Actions > New repository secret
```

Add whichever platforms you want to sync.

### Meta secrets

```text
META_ACCESS_TOKEN
META_AD_ACCOUNT_ID
```

`META_AD_ACCOUNT_ID` should be numeric only, without `act_`.

### TikTok secrets

```text
TIKTOK_ACCESS_TOKEN
TIKTOK_ADVERTISER_ID
```

`TIKTOK_ADVERTISER_ID` should be the numeric TikTok advertiser ID.

## Enable GitHub Pages

Go to:

```text
Settings > Pages
```

Choose:

```text
Source: Deploy from a branch
Branch: main
Folder: /root
```

## Run the sync

Go to:

```text
Actions > Sync Ads Data (Meta + TikTok) > Run workflow
```

When the workflow finishes, open the GitHub Pages dashboard and click:

```text
Sync GitHub Data
```

The dashboard will load `dashboard-data.json` and retain the data in browser localStorage.

## Notes

- If only Meta secrets are present, the workflow syncs Meta and skips TikTok.
- If only TikTok secrets are present, the workflow syncs TikTok and skips Meta.
- If neither platform has secrets, the workflow fails to prevent committing empty data.
- TikTok calls the middle level `Ad Group`; the dashboard displays it as `Ad Set / Ad Group` for consistency with Meta.
- Revenue may be `0` unless purchase value is available from the platform reporting data.
