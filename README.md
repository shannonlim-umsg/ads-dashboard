# Campaign-name upsert and duplicate prevention patch

## What changes

- The permanent weekly archive remains available for trends and the Week filter.
- When **Week = All weeks**, the main Campaign Results Table shows only one row per normalized campaign name.
- The newest archived result is used for the visible row.
- Selecting a specific Week still shows that week's original data.
- Dashboard-backed custom Campaign Results Tables use the same deduplication.
- Within each weekly archive period, matching campaign names are upserted rather than stored twice.
- An existing weekly period is rewritten only when Campaign, Ad Set, or Ad data actually changed.
- Durable Artist/name/platform/type/status/custom-column edits are migrated by Meta ID and by normalized name fallback.
- User-added/manual tables are not deduplicated.

## Replace these repository files

```text
index.html
scripts/sync-meta-ads.mjs
.github/workflows/sync-meta.yml
```

Keep the current `dashboard-data.json`, `sync-debug.json`, Firebase configuration, and Firebase rules.
Do not upload an empty dashboard data file.

## Why history is still retained

The archive keeps weekly periods so historical charts and explicit Week selections continue to work. Duplicate campaign names are consolidated only in the current/all-weeks table view. This avoids visible duplicate result rows without deleting historical reporting periods.
