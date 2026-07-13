import fs from "node:fs";

/* ========================================================================== 
   META ADS RESILIENT WEEKLY ARCHIVE SYNC
   Purpose:
   - Fetch Campaign, Ad Set, and Ad insights one week at a time.
   - Retry transient Meta API failures with exponential backoff.
   - Fall back from full fields to core, then minimal delivery fields.
   - Preserve successful weeks when another week fails.
   - Resume incomplete initial backfills on later workflow runs.
   - Never replace existing archive data with empty or partial responses.
   ========================================================================== */

const token = process.env.META_ACCESS_TOKEN;
const accountId = process.env.META_AD_ACCOUNT_ID;
const graphVersion = process.env.META_GRAPH_VERSION || "v24.0";

const syncWeeks = positiveInteger(process.env.META_SYNC_WEEKS, 6);
const initialBackfillWeeks = positiveInteger(process.env.META_INITIAL_BACKFILL_WEEKS, 52);
const forcedBackfillWeeks = optionalPositiveInteger(process.env.META_FORCE_BACKFILL_WEEKS);
const maxRetries = positiveInteger(process.env.META_MAX_RETRIES, 5);
const retryBaseMs = positiveInteger(process.env.META_RETRY_BASE_MS, 1200);
const requestDelayMs = nonNegativeInteger(process.env.META_REQUEST_DELAY_MS, 200);
const requestTimeoutMs = positiveInteger(process.env.META_REQUEST_TIMEOUT_MS, 120000);

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

const minimalMetricFields = [
  "impressions",
  "reach",
  "clicks",
  "spend",
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
  archiveVersion: 4,
  weeks: [],
  syncState: {}
});

const existingWeeks = Array.isArray(existing.weeks) ? existing.weeks : [];
const previousSyncState = existing.syncState && typeof existing.syncState === "object"
  ? existing.syncState
  : {};
const initialBackfillComplete = previousSyncState.initialBackfillComplete === true;
const lookbackWeeks = forcedBackfillWeeks || (initialBackfillComplete ? syncWeeks : initialBackfillWeeks);

const today = startOfUtcDay(new Date());
const archiveStart = addDays(startOfIsoWeek(today), -(lookbackWeeks - 1) * 7);
const archiveEnd = today;
const targetRanges = buildWeeklyRanges(archiveStart, archiveEnd);

const recentStart = addDays(startOfIsoWeek(today), -(syncWeeks - 1) * 7);
const previouslyCompleted = new Set([
  ...(Array.isArray(previousSyncState.completedWeeks) ? previousSyncState.completedWeeks : []),
  ...(Array.isArray(previousSyncState.emptyWeeks) ? previousSyncState.emptyWeeks : [])
]);

const rangesToFetch = targetRanges.filter(range => {
  if (forcedBackfillWeeks) return true;
  if (Date.parse(range.since) >= recentStart.getTime()) return true;
  return !previouslyCompleted.has(range.since);
});

/* Fetch newest periods first, so recent dashboard data is completed before old
   backfill periods if Meta becomes temporarily unavailable later in the run. */
rangesToFetch.sort((a, b) => b.since.localeCompare(a.since));

const debug = {
  generatedAt: new Date().toISOString(),
  mode: "resilient_weekly_archive",
  graphVersion,
  accountIdPresent: !!accountId,
  tokenPresent: !!token,
  archive: {
    initialBackfillCompleteBeforeRun: initialBackfillComplete,
    forcedBackfillWeeks: forcedBackfillWeeks || null,
    requestedWeeks: lookbackWeeks,
    normalRefreshWeeks: syncWeeks,
    initialBackfillWeeks,
    since: formatDate(archiveStart),
    until: formatDate(archiveEnd),
    targetWeeks: targetRanges.length,
    weeksSelectedForThisRun: rangesToFetch.length,
    weeksSkippedAsPreviouslyCompleted: targetRanges.length - rangesToFetch.length,
    ranges: rangesToFetch
  },
  retryPolicy: {
    maxRetries,
    retryBaseMs,
    requestDelayMs,
    requestTimeoutMs,
    fieldModes: ["full", "core", "minimal"]
  },
  retries: [],
  weeks: [],
  meta: {
    levels: {
      campaign: { status: "not_started", rows: 0, weeks: [] },
      adset: { status: "not_started", rows: 0, weeks: [] },
      ad: { status: "not_started", rows: 0, weeks: [] }
    }
  }
};

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
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

function buildWeeklyRanges(start, end) {
  const ranges = [];
  let cursor = startOfIsoWeek(start);

  while (cursor <= end) {
    const weekEnd = new Date(Math.min(addDays(cursor, 6).getTime(), end.getTime()));
    ranges.push({ since: formatDate(cursor), until: formatDate(weekEnd) });
    cursor = addDays(cursor, 7);
  }

  return ranges;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class MetaRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MetaRequestError";
    this.status = options.status || 0;
    this.payload = options.payload || null;
    this.retryAfterMs = options.retryAfterMs || 0;
    this.networkError = options.networkError === true;
  }
}

function graphErrorDetails(error) {
  const payload = error?.payload || {};
  const graphError = payload.error || payload;
  return {
    code: Number(graphError?.code || 0),
    subcode: Number(graphError?.error_subcode || 0),
    isTransient: graphError?.is_transient === true,
    message: String(graphError?.message || error?.message || "Unknown Meta API error")
  };
}

function isRetryableError(error) {
  if (error?.networkError) return true;
  if ([408, 425, 429, 500, 502, 503, 504].includes(Number(error?.status || 0))) return true;

  const details = graphErrorDetails(error);
  if (details.isTransient) return true;
  if ([1, 2, 4, 17, 32, 613].includes(details.code)) return true;
  if ([99, 1504044].includes(details.subcode)) return true;
  if (/temporarily unavailable|unknown error|try again|timeout|rate limit/i.test(details.message)) return true;
  return false;
}

function retryDelay(error, attempt) {
  if (Number(error?.retryAfterMs || 0) > 0) return error.retryAfterMs;
  const exponential = retryBaseMs * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(60000, exponential + jitter);
}

async function requestJsonWithRetry(url, context) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      const text = await response.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }

      if (!response.ok || json.error) {
        const retryAfter = Number(response.headers.get("retry-after") || 0) * 1000;
        throw new MetaRequestError(
          JSON.stringify(json.error || json, null, 2),
          { status: response.status, payload: json, retryAfterMs: retryAfter }
        );
      }

      return json;
    } catch (error) {
      const normalized = error?.name === "AbortError"
        ? new MetaRequestError("Meta request timed out", { networkError: true })
        : error instanceof MetaRequestError
          ? error
          : new MetaRequestError(error?.message || "Network request failed", { networkError: true });

      lastError = normalized;
      const retryable = isRetryableError(normalized);

      if (!retryable || attempt >= maxRetries) break;

      const delayMs = retryDelay(normalized, attempt);
      debug.retries.push({
        ...context,
        attempt,
        delayMs,
        error: graphErrorDetails(normalized)
      });
      await sleep(delayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new MetaRequestError("Meta request failed");
}

function metricFieldsForMode(mode) {
  if (mode === "full") return metricFields;
  if (mode === "core") return coreMetricFields;
  return minimalMetricFields;
}

function buildInsightsUrl(level, range, fieldMode) {
  const fields = [...identityFields[level], ...metricFieldsForMode(fieldMode)];
  const timeRange = JSON.stringify({ since: range.since, until: range.until });

  return (
    `https://graph.facebook.com/${graphVersion}/act_${accountId}/insights` +
    `?fields=${encodeURIComponent(fields.join(","))}` +
    `&level=${encodeURIComponent(level)}` +
    `&time_range=${encodeURIComponent(timeRange)}` +
    `&limit=500` +
    `&access_token=${encodeURIComponent(token)}`
  );
}

async function fetchAllPages(url, context) {
  const rows = [];
  let next = url;
  let page = 0;

  while (next) {
    page += 1;
    const json = await requestJsonWithRetry(next, { ...context, page });
    rows.push(...(json.data || []));
    next = json.paging?.next || null;
    if (next && requestDelayMs) await sleep(requestDelayMs);
  }

  return rows;
}

async function fetchLevelForWeek(level, range) {
  const modes = ["full", "core", "minimal"];
  const attempts = [];

  for (const fieldMode of modes) {
    try {
      const rows = await fetchAllPages(
        buildInsightsUrl(level, range, fieldMode),
        { level, since: range.since, until: range.until, fieldMode }
      );
      return { ok: true, rows, fieldMode, attempts };
    } catch (error) {
      attempts.push({ fieldMode, message: error.message, error: graphErrorDetails(error) });
    }
  }

  return { ok: false, rows: [], fieldMode: null, attempts };
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

const DELIVERY_FIELDS = [
  "spend", "impressions", "reach", "clicks_all", "link_clicks",
  "purchases", "conversions", "revenue", "views"
];

function hasMeasurableResults(row) {
  return DELIVERY_FIELDS.some(key => Number(row?.[key] || 0) > 0);
}

function normalizedName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
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

function archiveRowKey(level, row) {
  if (level === "campaign") {
    return normalizedName(row.name) || `id:${row.metaCampaignId || row.id || "unknown"}`;
  }
  if (level === "adset") {
    const campaign = normalizedName(row.campaign);
    const name = normalizedName(row.name);
    return campaign && name ? `${campaign}|${name}` : `id:${row.metaAdsetId || row.id || "unknown"}`;
  }
  const campaign = normalizedName(row.campaign);
  const adset = normalizedName(row.adset);
  const name = normalizedName(row.name);
  return campaign && name ? `${campaign}|${adset}|${name}` : `id:${row.metaAdId || row.id || "unknown"}`;
}

function dedupeMappedRows(rows, level) {
  const byKey = new Map();
  for (const row of rows || []) byKey.set(archiveRowKey(level, row), row);
  return [...byKey.values()];
}

function filterPeriodToDeliveredRows(campaigns, adsets, ads) {
  const filteredCampaigns = campaigns.filter(hasMeasurableResults);
  const deliveredCampaignNames = new Set(filteredCampaigns.map(row => normalizedName(row.name)));

  const filteredAdsets = adsets.filter(row =>
    hasMeasurableResults(row) && deliveredCampaignNames.has(normalizedName(row.campaign))
  );
  const filteredAds = ads.filter(row =>
    hasMeasurableResults(row) && deliveredCampaignNames.has(normalizedName(row.campaign))
  );

  return {
    campaigns: filteredCampaigns,
    adsets: filteredAdsets,
    ads: filteredAds,
    removed: campaigns.length - filteredCampaigns.length +
      adsets.length - filteredAdsets.length +
      ads.length - filteredAds.length
  };
}

function cleanZeroOnlyRowsFromWeek(week) {
  const campaigns = Array.isArray(week?.campaigns) ? week.campaigns : [];
  const adsets = Array.isArray(week?.adsets) ? week.adsets : [];
  const ads = Array.isArray(week?.ads) ? week.ads : [];
  const filtered = filterPeriodToDeliveredRows(campaigns, adsets, ads);

  return {
    week: { ...week, campaigns: filtered.campaigns, adsets: filtered.adsets, ads: filtered.ads },
    removed: filtered.removed
  };
}

function comparableRow(row) {
  const ignored = new Set(["syncedAt", "_updatedAt", "_updatedBy"]);
  return Object.keys(row || {})
    .filter(key => !key.startsWith("_") && !ignored.has(key))
    .sort()
    .reduce((result, key) => {
      result[key] = row[key];
      return result;
    }, {});
}

function comparableRows(rows, level) {
  return (rows || [])
    .map(row => ({ key: archiveRowKey(level, row), value: comparableRow(row) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function comparableWeek(week) {
  return {
    id: week.id,
    dateFrom: week.dateFrom,
    dateTo: week.dateTo,
    campaigns: comparableRows(week.campaigns, "campaign"),
    adsets: comparableRows(week.adsets, "adset"),
    ads: comparableRows(week.ads, "ad")
  };
}

function weekHasDifferences(existingWeek, incomingWeek) {
  return JSON.stringify(comparableWeek(existingWeek)) !== JSON.stringify(comparableWeek(incomingWeek));
}

function mergeRowsPreservingHistory(existingRows, incomingRows, level) {
  const merged = new Map((existingRows || []).map(row => [archiveRowKey(level, row), row]));
  for (const incoming of incomingRows || []) {
    const key = archiveRowKey(level, incoming);
    const current = merged.get(key);
    merged.set(key, current && JSON.stringify(comparableRow(current)) === JSON.stringify(comparableRow(incoming))
      ? current
      : incoming);
  }
  return [...merged.values()];
}

function mergeWeekPreservingHistory(existingWeek, incomingWeek) {
  if (!existingWeek) return incomingWeek;
  return {
    ...existingWeek,
    ...incomingWeek,
    campaigns: mergeRowsPreservingHistory(existingWeek.campaigns, incomingWeek.campaigns, "campaign"),
    adsets: mergeRowsPreservingHistory(existingWeek.adsets, incomingWeek.adsets, "adset"),
    ads: mergeRowsPreservingHistory(existingWeek.ads, incomingWeek.ads, "ad")
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

async function fetchOneWeek(range) {
  const levelResults = {};
  let failed = false;

  for (const level of ["campaign", "adset", "ad"]) {
    if (requestDelayMs) await sleep(requestDelayMs);
    const result = await fetchLevelForWeek(level, range);
    levelResults[level] = result;

    const levelDebug = {
      since: range.since,
      until: range.until,
      status: result.ok ? "ok" : "error",
      fieldMode: result.fieldMode,
      rows: result.rows.length,
      attempts: result.attempts
    };
    debug.meta.levels[level].weeks.push(levelDebug);
    debug.meta.levels[level].rows += result.rows.length;
    if (!result.ok) failed = true;
  }

  if (failed) {
    return { ok: false, range, levelResults, week: null, empty: false, removed: 0 };
  }

  const campaigns = dedupeMappedRows(levelResults.campaign.rows.map(mapCampaign), "campaign");
  const adsets = dedupeMappedRows(levelResults.adset.rows.map(mapAdset), "adset");
  const ads = dedupeMappedRows(levelResults.ad.rows.map(mapAd), "ad");
  const delivered = filterPeriodToDeliveredRows(campaigns, adsets, ads);
  const totalRows = delivered.campaigns.length + delivered.adsets.length + delivered.ads.length;

  if (totalRows === 0) {
    return { ok: true, range, levelResults, week: null, empty: true, removed: delivered.removed };
  }

  return {
    ok: true,
    range,
    levelResults,
    empty: false,
    removed: delivered.removed,
    week: {
      id: `meta_week_${range.since}`,
      label: `Meta week ${range.since}`,
      period: `${range.since} to ${range.until}`,
      dateFrom: range.since,
      dateTo: range.until,
      snapshotType: "weekly",
      campaigns: delivered.campaigns,
      adsets: delivered.adsets,
      ads: delivered.ads,
      source: "Meta Marketing API",
      syncedAt: new Date().toISOString()
    }
  };
}

/* Fetch one complete week at a time. This avoids the 12-week ad/adset requests
   that previously triggered code 1/subcode 99 and service-unavailable errors. */
const results = [];
for (const range of rangesToFetch) {
  const result = await fetchOneWeek(range);
  results.push(result);
  debug.weeks.push({
    since: range.since,
    until: range.until,
    status: result.ok ? (result.empty ? "ok_empty" : "ok") : "error",
    removedZeroOnlyRows: result.removed,
    rows: result.week
      ? result.week.campaigns.length + result.week.adsets.length + result.week.ads.length
      : 0
  });
}

for (const level of ["campaign", "adset", "ad"]) {
  const weekStatuses = debug.meta.levels[level].weeks;
  const errors = weekStatuses.filter(item => item.status === "error").length;
  debug.meta.levels[level].status = errors === 0 ? "ok" : errors === weekStatuses.length ? "error" : "partial";
  debug.meta.levels[level].failedWeeks = errors;
}

let removedZeroRowsFromIncoming = 0;
let removedZeroRowsFromExisting = 0;

const normalizedExistingWeeks = existingWeeks.map(week => {
  const normalized = (
    !week.snapshotType &&
    (String(week.id || "").startsWith("meta_last_30d_") || String(week.label || "").includes("last 30d"))
  )
    ? { ...week, snapshotType: "legacy_rolling", archivedLegacy: true }
    : week;

  const cleaned = cleanZeroOnlyRowsFromWeek(normalized);
  removedZeroRowsFromExisting += cleaned.removed;
  return cleaned.week;
});

const mergedById = new Map(normalizedExistingWeeks.map(week => [week.id || week.label, week]));
let addedWeeks = 0;
let updatedWeeks = 0;
let unchangedWeeks = 0;
let successfulWeeks = 0;
let emptyWeeks = 0;
let failedWeeks = 0;

const completedWeeks = new Set([
  ...(Array.isArray(previousSyncState.completedWeeks) ? previousSyncState.completedWeeks : []),
  ...(Array.isArray(previousSyncState.emptyWeeks) ? previousSyncState.emptyWeeks : [])
]);
const knownEmptyWeeks = new Set(Array.isArray(previousSyncState.emptyWeeks) ? previousSyncState.emptyWeeks : []);
const failedWeekStarts = new Set();

for (const result of results) {
  if (!result.ok) {
    failedWeeks += 1;
    failedWeekStarts.add(result.range.since);
    continue;
  }

  successfulWeeks += 1;
  completedWeeks.add(result.range.since);
  removedZeroRowsFromIncoming += result.removed;

  if (result.empty || !result.week) {
    emptyWeeks += 1;
    knownEmptyWeeks.add(result.range.since);
    continue;
  }

  knownEmptyWeeks.delete(result.range.since);
  const existingWeek = mergedById.get(result.week.id);
  const mergedWeek = mergeWeekPreservingHistory(existingWeek, result.week);

  if (!existingWeek) {
    mergedById.set(result.week.id, mergedWeek);
    addedWeeks += 1;
  } else if (weekHasDifferences(existingWeek, mergedWeek)) {
    mergedById.set(result.week.id, mergedWeek);
    updatedWeeks += 1;
  } else {
    unchangedWeeks += 1;
  }
}

const mergedWeeks = [...mergedById.values()]
  .filter(week =>
    (week.campaigns?.length || 0) +
    (week.adsets?.length || 0) +
    (week.ads?.length || 0) > 0
  )
  .sort((a, b) => String(a.dateFrom || a.id || "").localeCompare(String(b.dateFrom || b.id || "")));

const targetWeekStarts = targetRanges.map(range => range.since);
const backfillCompleteAfterRun = targetWeekStarts.every(start => completedWeeks.has(start));

const syncState = {
  ...previousSyncState,
  archiveVersion: 4,
  initialBackfillComplete: forcedBackfillWeeks ? previousSyncState.initialBackfillComplete === true : backfillCompleteAfterRun,
  initialBackfillWeeks,
  normalRefreshWeeks: syncWeeks,
  completedWeeks: [...completedWeeks].sort(),
  emptyWeeks: [...knownEmptyWeeks].sort(),
  failedWeeks: [...failedWeekStarts].sort(),
  lastAttemptAt: new Date().toISOString(),
  lastSuccessfulWeekCount: successfulWeeks,
  lastFailedWeekCount: failedWeeks
};

const output = {
  ...existing,
  generatedAt: new Date().toISOString(),
  source: "Meta Marketing API",
  archiveVersion: 4,
  archiveGranularity: "weekly",
  dedupePolicy: "campaign_name_latest_nonzero",
  syncWeeks,
  initialBackfillWeeks,
  syncState,
  weeks: mergedWeeks
};

debug.summary = {
  weeksAttempted: results.length,
  successfulWeeks,
  emptyWeeks,
  failedWeeks,
  addedWeeks,
  updatedWeeks,
  unchangedWeeks,
  finalArchiveWeeks: mergedWeeks.length,
  zeroOnlyRowsRemovedFromIncoming: removedZeroRowsFromIncoming,
  zeroOnlyRowsRemovedFromExisting: removedZeroRowsFromExisting,
  initialBackfillCompleteAfterRun: backfillCompleteAfterRun,
  completedWeekStarts: completedWeeks.size,
  partialDashboardDataUpdate: failedWeeks > 0 && successfulWeeks > 0
};

if (successfulWeeks === 0) {
  debug.summary.skippedDashboardDataUpdate = true;
  debug.summary.reason = "No complete weekly period was fetched. Existing dashboard-data.json was left unchanged.";
  fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));
  console.error(debug.summary.reason);
  process.exitCode = 1;
} else {
  fs.writeFileSync("dashboard-data.json", JSON.stringify(output, null, 2));
  fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));

  console.log(`Weekly periods attempted: ${results.length}`);
  console.log(`Weekly periods completed: ${successfulWeeks}`);
  console.log(`Weekly periods failed: ${failedWeeks}`);
  console.log(`Archive periods added: ${addedWeeks}`);
  console.log(`Archive periods updated: ${updatedWeeks}`);
  console.log(`Archive periods unchanged: ${unchangedWeeks}`);
  console.log(`Initial backfill complete: ${backfillCompleteAfterRun}`);

  /* Mark the workflow as failed when some weeks remain incomplete. The workflow
     still commits successful weeks first, so rerunning resumes only the gaps. */
  if (failedWeeks > 0) process.exitCode = 1;
}
