# UMG Meta Ads Dashboard — GitHub Pages

This package is Meta-only. TikTok API code and TikTok secrets have been removed.

## Files

Upload these files to your GitHub repo root:

```text
index.html
dashboard-data.json
sync-debug.json
scripts/sync-meta-ads.mjs
.github/workflows/sync-meta.yml
README.md
```

## GitHub Secrets

Go to:

```text
Settings > Secrets and variables > Actions
```

Add:

```text
META_ACCESS_TOKEN
META_AD_ACCOUNT_ID
```

Optional:

```text
META_GRAPH_VERSION
META_DATE_PRESET
```

Default values:

```text
META_GRAPH_VERSION = v24.0
META_DATE_PRESET = last_30d
```

## Run sync

Go to:

```text
Actions > Sync Meta Ads Data > Run workflow
```

The workflow writes:

```text
dashboard-data.json
sync-debug.json
```

## Open dashboard

Enable GitHub Pages:

```text
Settings > Pages > Deploy from branch > main > /root
```

Open the Pages URL and click:

```text
Sync GitHub Data
```

The dashboard also auto-loads `dashboard-data.json` through:

```js
loadRemoteData(true)
```

## Important localStorage fix

This package uses:

```text
umg_meta_ads_dashboard_v1
```

as the localStorage key. It merges synced `dashboard-data.json` weeks into localStorage, so data is retained and does not disappear on refresh.
