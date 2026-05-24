# Meta Ads Dashboard for GitHub Pages

This package is a complete GitHub Pages dashboard with a GitHub Actions data sync.

## What this includes

- `index.html` - the editable dashboard
- `dashboard-data.json` - the data file served by GitHub Pages
- `scripts/sync-meta-ads.mjs` - pulls Meta Ads insights from campaign, ad set, and ad level
- `.github/workflows/sync-meta.yml` - GitHub Actions workflow that runs the sync
- `sync-meta.yml` - visible backup copy of the workflow file, included in case hidden folders are hard to upload
- `.nojekyll` - ensures GitHub Pages serves files normally

## What the dashboard does

- Pulls Meta Ads data for the past 30 days
- Pulls all 3 reporting levels:
  - Campaign level
  - Ad Set level
  - Ad level
- Shows Campaign > Ad Set > Ad rows in an accordion table
- Retains synced data in both `dashboard-data.json` and browser localStorage
- Lets you edit all dashboard text, sections, KPI cards, metrics, and columns
- Lets you add new KPI cards and new dashboard sections
- Lets you show/hide table columns and create new custom editable columns
- Uses calendar date inputs for manual week entries
- Provides separate manual entry sections for Campaigns, Ad Sets, and Ads

## GitHub setup

### 1. Upload all files

Upload this package into the root of your GitHub repository.

The workflow file must exist at this exact path:

```text
.github/workflows/sync-meta.yml
```

If GitHub does not show hidden folders, create the workflow manually:

1. Go to your repository
2. Click **Add file > Create new file**
3. In the filename box, type:

```text
.github/workflows/sync-meta.yml
```

4. Paste the contents of the included root-level `sync-meta.yml`
5. Commit the file

### 2. Add repo secrets

Go to:

```text
Settings > Secrets and variables > Actions > New repository secret
```

Add:

```text
META_ACCESS_TOKEN
META_AD_ACCOUNT_ID
```

`META_AD_ACCOUNT_ID` should be numeric only, without `act_`.

Optional repository variable:

```text
META_GRAPH_VERSION
```

If omitted, the script uses `v24.0`.

### 3. Enable GitHub Pages

Go to:

```text
Settings > Pages
```

Set:

```text
Source: Deploy from branch
Branch: main
Folder: /root
```

### 4. Run the sync

Go to:

```text
Actions > Sync Meta Ads Data > Run workflow
```

The workflow also runs daily at 01:00 UTC.

### 5. Open dashboard

Open the GitHub Pages URL shown in Settings > Pages.

Click:

```text
Sync GitHub Data
```

The dashboard also attempts to load `dashboard-data.json` automatically on page load.

## Notes

- The dashboard is static and safe for GitHub Pages because the Meta access token is only used by GitHub Actions.
- `dashboard-data.json` is public once published via GitHub Pages. Do not include secrets in it.
- Synced data is retained. Each daily sync creates or updates a snapshot named like `Meta Last 30 Days YYYY-MM-DD`.
- Custom table cell values are retained when a sync updates the same Meta campaign/ad set/ad IDs.
