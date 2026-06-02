# UMG Meta + TikTok Ads Dashboard — Debug Sync Package

This package is designed to diagnose why Meta and/or TikTok data is not pulling.

## Replace these files in your GitHub repo

```text
index.html
scripts/sync-ads-data.mjs
.github/workflows/sync-ads-data.yml
```

Also keep these files in the repo root:

```text
dashboard-data.json
sync-debug.json
```

## Required GitHub secrets

Meta:

```text
META_ACCESS_TOKEN
META_AD_ACCOUNT_ID
```

TikTok:

```text
TIKTOK_ACCESS_TOKEN
TIKTOK_ADVERTISER_ID
```

Optional Meta version override:

```text
META_GRAPH_VERSION
```

Leave this blank unless you need to force a version such as `v24.0`.

## How to test

1. Commit these files.
2. Go to GitHub Actions.
3. Run `Sync Ads Data (Meta + TikTok)`.
4. After it finishes, open `sync-debug.json` in the repo.

The debug file will show:

- whether each secret was present
- whether Meta was skipped, errored, or returned rows
- whether TikTok was skipped, errored, or returned rows
- row counts for campaign, ad set/ad group, and ad levels

## Notes

The workflow no longer fails just because an API returns zero rows. It writes `sync-debug.json` so you can see the exact issue.
