import fs from "node:fs";

/* ========================================================================== 
   META ADS WEEKLY ARCHIVE SYNC
   Purpose:
   - Fetch Campaign, Ad Set, and Ad insights in weekly reporting periods.
   - Refresh only recent weeks while preserving every older archived week.
   - Retain legacy rolling snapshots for reference without replacing them.
   - Never write zero/empty API results over previously stored data.
   ========================================================================== */

const token = process.env.META_ACCESS_TOKEN;
const accountId = process.env.META_AD_ACCOUNT_ID;
const graphVersion = process.env.META_GRAPH_VERSION || "v24.0";

/* Normal runs refresh the most recent 6 weeks. The first upgraded run can
   backfill one year. Override these values with optional GitHub Secrets. */
const syncWeeks = positiveInteger(process.env.META_SYNC_WEEKS, 6);
const initialBackfillWeeks = positiveInteger(process.env.META_INITIAL_BACKFILL_WEEKS, 52);
const forcedBackfillWeeks = optionalPositiveInteger(process.env.META_FORCE_BACKFILL_WEEKS);
const chunkWeeks = Math.min(positiveInteger(process.env.META_CHUNK_WEEKS, 12), 12);

if (!token || !accountId) {
  throw new Error("Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID GitHub secret.");
}

const metricFields = [
  "impressions",
  "reach",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "inline_link_clicks",
  "inline_link_click_ctr",
  "cost_per_inline_link_click",
  "outbound_clicks",
  "outbound_clicks_ctr",
  "cost_per_outbound_click",
  "website_ctr",
  "spend",
  "actions",
  "action_values",
  "cost_per_action_type",
  "purchase_roas",
  "website_purchase_roas",
  "mobile_app_purchase_roas",
  "video_play_actions",
  "date_start",
  "date_stop"
];

const coreMetricFields = [
  "impressions",
  "reach",
  "clicks",
  "spend",
  "actions",
  "action_values",
  "video_play_actions",
  "date_start",
  "date_stop"
];

const identityFields = {
  campaign: ["campaign_id", "campaign_name"],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name"],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"]
};

const existing = readExistingJson("dashboard-data.json", {
  generatedAt: null,
  source: "Meta Marketing API",
  archiveVersion: 2,
  weeks: []
});

const existingWeeks = Array.isArray(existing.weeks) ? existing.weeks : [];
const hasWeeklyArchive = existingWeeks.some(
  week => week?.snapshotType === "weekly" || String(week?.id || "").startsWith("meta_week_")
);
const lookbackWeeks = forcedBackfillWeeks || (hasWeeklyArchive ? syncWeeks : initialBackfillWeeks);

const today = startOfUtcDay(new Date());
const archiveStart = addDays(startOfIsoWeek(today), -(lookbackWeeks - 1) * 7);
const archiveEnd = today;
const ranges = buildWeekAlignedChunks(archiveStart, archiveEnd, chunkWeeks);

const debug = {
  generatedAt: new Date().toISOString(),
  mode: "weekly_archive",
  graphVersion,
  accountIdPresent: !!accountId,
  tokenPresent: !!token,
  archive: {
    existingWeeklyArchive: hasWeeklyArchive,
    forcedBackfillWeeks: forcedBackfillWeeks || null,
    requestedWeeks: lookbackWeeks,
    normalRefreshWeeks: syncWeeks,
    initialBackfillWeeks,
    chunkWeeks,
    since: formatDate(archiveStart),
    until: formatDate(archiveEnd),
    chunks: ranges.map(range => ({ since: range.since, until: range.until }))
  },
  meta: { levels: {} }
};

let hadFetchError = false;

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function optionalPositiveInteger(value) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function startOfIsoWeek(date) {
  const value = startOfUtcDay(date);
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() - day + 1);
  return value;
}

function addDays(date, days) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function buildWeekAlignedChunks(start, end, weeksPerChunk) {
  const chunks = [];
  let cursor = startOfIsoWeek(start);

  while (cursor <= end) {
    const chunkEnd = new Date(Math.min(
      addDays(cursor, weeksPerChunk * 7 - 1).getTime(),
      end.getTime()
    ));

    chunks.push({ since: formatDate(cursor), until: formatDate(chunkEnd) });
    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
}

async function fetchAllPages(url) {
  const all = [];
  let next = url;

  while (next) {
    const response = await fetch(next);
    const json = await response.json();

    if (!response.ok || json.error) {
      throw new Error(JSON.stringify(json.error || json, null, 2));
    }

    all.push(...(json.data || []));
    next = json.paging?.next || null;
  }

  return all;
}

function buildInsightsUrl(level, range, fieldMode) {
  const metrics = fieldMode === "full" ? metricFields : coreMetricFields;
  const fields = [...identityFields[level], ...metrics];
  const timeRange = JSON.stringify({ since: range.since, until: range.until });

  return (
    `https://graph.facebook.com/${graphVersion}/act_${accountId}/insights` +
    `?fields=${encodeURIComponent(fields.join(","))}` +
    `&level=${encodeURIComponent(level)}` +
    `&time_range=${encodeURIComponent(timeRange)}` +
    `&time_increment=7` +
    `&limit=500` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

async function fetchRange(level, range, fieldMode = "full") {
  try {
    const rows = await fetchAllPages(buildInsightsUrl(level, range, fieldMode));
    return { rows, fieldMode };
  } catch (error) {
    if (fieldMode === "full") {
      return fetchRange(level, range, "core");
    }
    throw error;
  }
}

async function fetchLevel(level) {
  const rows = [];
  const chunks = [];

  for (const range of ranges) {
    try {
      const result = await fetchRange(level, range);
      rows.push(...result.rows);
      chunks.push({ ...range, status: "ok", fieldMode: result.fieldMode, rows: result.rows.length });
    } catch (error) {
      hadFetchError = true;
      chunks.push({ ...range, status: "error", message: error.message });
      debug.meta.levels[level] = { status: "error", rows: rows.length, chunks };
      return [];
    }
  }

  debug.meta.levels[level] = { status: "ok", rows: rows.length, chunks };
  return rows;
}

function arrayValue(values, actionTypes) {
  if (!Array.isArray(values)) return 0;
  for (const actionType of actionTypes) {
    const match = values.find(value => value.action_type === actionType);
    if (match) return Number(match.value || 0);
  }
  return 0;
}

function firstValue(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  return Number(values[0]?.value || 0);
}

function metricNumber(row, key) {
  return Number(row[key] || 0);
}

function linkClicks(row) {
  return metricNumber(row, "inline_link_clicks") ||
    arrayValue(row.actions, ["link_click", "onsite_conversion.messaging_first_reply"]) ||
    firstValue(row.outbound_clicks);
}

function ctrAll(row) {
  const supplied = metricNumber(row, "ctr");
  if (supplied) return supplied / 100;
  const impressions = metricNumber(row, "impressions");
  return impressions ? metricNumber(row, "clicks") / impressions : 0;
}

function ctrLink(row) {
  const supplied = metricNumber(row, "inline_link_click_ctr");
  if (supplied) return supplied / 100;

  const outbound = firstValue(row.outbound_clicks_ctr);
  if (outbound) return outbound / 100;

  const website = firstValue(row.website_ctr);
  if (website) return website / 100;

  const impressions = metricNumber(row, "impressions");
  return impressions ? linkClicks(row) / impressions : 0;
}

function cpcAll(row) {
  return metricNumber(row, "cpc") ||
    (metricNumber(row, "clicks") ? metricNumber(row, "spend") / metricNumber(row, "clicks") : 0);
}

function cpcLink(row) {
  return metricNumber(row, "cost_per_inline_link_click") ||
    arrayValue(row.cost_per_action_type, ["link_click"]) ||
    firstValue(row.cost_per_outbound_click) ||
    (linkClicks(row) ? metricNumber(row, "spend") / linkClicks(row) : 0);
}

function cpm(row) {
  return metricNumber(row, "cpm") ||
    (metricNumber(row, "impressions")
      ? (metricNumber(row, "spend") / metricNumber(row, "impressions")) * 1000
      : 0);
}

function purchases(row) {
  return arrayValue(row.actions, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_conversion.purchase",
    "web_in_store_purchase"
  ]);
}

function revenue(row) {
  return arrayValue(row.action_values, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_conversion.purchase",
    "web_in_store_purchase"
  ]);
}

function purchaseRoas(row) {
  return firstValue(row.purchase_roas) ||
    firstValue(row.website_purchase_roas) ||
    firstValue(row.mobile_app_purchase_roas) ||
    (metricNumber(row, "spend") ? revenue(row) / metricNumber(row, "spend") : 0);
}

function views(row) {
  return firstValue(row.video_play_actions) || arrayValue(row.actions, ["video_view"]);
}

function baseMetrics(row) {
  const spend = metricNumber(row, "spend");
  const purchaseCount = purchases(row);
  const purchaseValue = revenue(row);

  return {
    impressions: metricNumber(row, "impressions"),
    reach: metricNumber(row, "reach"),
    clicks_all: metricNumber(row, "clicks"),
    ctr_all: ctrAll(row),
    cpc_all: cpcAll(row),
    cpm: cpm(row),
    link_clicks: linkClicks(row),
    ctr_link: ctrLink(row),
    cpc_link: cpcLink(row),
    purchases: purchaseCount,
    purchase_roas: purchaseRoas(row),
    views: views(row),
    conversions: purchaseCount || arrayValue(row.actions, ["lead", "complete_registration"]),
    spend,
    revenue: purchaseValue,
    roas: spend ? purchaseValue / spend : 0
  };
}

function mapCampaign(row) {
  return {
    id: row.campaign_id || row.campaign_name || "",
    metaCampaignId: row.campaign_id || "",
    artist: "Imported Artist",
    name: row.campaign_name || "Unnamed campaign",
    platform: "Meta",
    type: "Traffic",
    status: "active",
    ...baseMetrics(row)
  };
}

function mapAdset(row) {
  return {
    id: row.adset_id || row.adset_name || "",
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    campaign: row.campaign_name || "Unnamed campaign",
    name: row.adset_name || "Unnamed ad set",
    platform: "Meta",
    status: "active",
    ...baseMetrics(row)
  };
}

function mapAd(row) {
  return {
    id: row.ad_id || row.ad_name || "",
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    metaAdId: row.ad_id || "",
    campaign: row.campaign_name || "Unnamed campaign",
    adset: row.adset_name || "Unnamed ad set",
    name: row.ad_name || "Unnamed ad",
    platform: "Meta",
    status: "active",
    ...baseMetrics(row)
  };
}

function readExistingJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function periodKey(row) {
  if (!row.date_start) return null;
  return `${row.date_start}|${row.date_stop || row.date_start}`;
}

function groupRowsByPeriod(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = periodKey(row);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

const [campaignRaw, adsetRaw, adRaw] = await Promise.all([
  fetchLevel("campaign"),
  fetchLevel("adset"),
  fetchLevel("ad")
]);

const campaignPeriods = groupRowsByPeriod(campaignRaw);
const adsetPeriods = groupRowsByPeriod(adsetRaw);
const adPeriods = groupRowsByPeriod(adRaw);
const periodKeys = new Set([
  ...campaignPeriods.keys(),
  ...adsetPeriods.keys(),
  ...adPeriods.keys()
]);

const incomingWeeks = [...periodKeys]
  .sort()
  .map(key => {
    const [dateFrom, dateTo] = key.split("|");
    const campaigns = (campaignPeriods.get(key) || []).map(mapCampaign);
    const adsets = (adsetPeriods.get(key) || []).map(mapAdset);
    const ads = (adPeriods.get(key) || []).map(mapAd);

    return {
      id: `meta_week_${dateFrom}`,
      label: `Meta week ${dateFrom}`,
      period: `${dateFrom} to ${dateTo}`,
      dateFrom,
      dateTo,
      snapshotType: "weekly",
      campaigns,
      adsets,
      ads,
      source: "Meta Marketing API",
      syncedAt: new Date().toISOString()
    };
  })
  .filter(week => week.campaigns.length + week.adsets.length + week.ads.length > 0);

const normalizedExistingWeeks = existingWeeks.map(week => {
  if (
    !week.snapshotType &&
    (String(week.id || "").startsWith("meta_last_30d_") || String(week.label || "").includes("last 30d"))
  ) {
    return { ...week, snapshotType: "legacy_rolling", archivedLegacy: true };
  }
  return week;
});

const mergedById = new Map(normalizedExistingWeeks.map(week => [week.id || week.label, week]));
for (const week of incomingWeeks) mergedById.set(week.id, week);

const mergedWeeks = [...mergedById.values()].sort((a, b) =>
  String(a.dateFrom || a.id || "").localeCompare(String(b.dateFrom || b.id || ""))
);

const totalRows = incomingWeeks.reduce(
  (total, week) => total + week.campaigns.length + week.adsets.length + week.ads.length,
  0
);

debug.summary = {
  incomingWeeks: incomingWeeks.length,
  campaigns: campaignRaw.length,
  adsets: adsetRaw.length,
  ads: adRaw.length,
  totalRows,
  preservedExistingWeeks: normalizedExistingWeeks.length,
  finalArchiveWeeks: mergedWeeks.length
};

if (hadFetchError || totalRows === 0) {
  debug.summary.skippedDashboardDataUpdate = true;
  debug.summary.reason = hadFetchError
    ? "Meta API returned an error. Existing dashboard-data.json was left unchanged."
    : "Meta API returned zero usable weekly rows. Existing dashboard-data.json was left unchanged.";

  fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));
  console.error(debug.summary.reason);
  process.exitCode = 1;
} else {
  const output = {
    ...existing,
    generatedAt: new Date().toISOString(),
    source: "Meta Marketing API",
    archiveVersion: 2,
    archiveGranularity: "weekly",
    syncWeeks,
    initialBackfillWeeks,
    weeks: mergedWeeks
  };

  fs.writeFileSync("dashboard-data.json", JSON.stringify(output, null, 2));
  fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));

  console.log(`Weekly archive periods updated: ${incomingWeeks.length}`);
  console.log(`Meta campaign rows: ${campaignRaw.length}`);
  console.log(`Meta ad set rows: ${adsetRaw.length}`);
  console.log(`Meta ad rows: ${adRaw.length}`);
  console.log(`Total archive periods retained: ${mergedWeeks.length}`);
}
