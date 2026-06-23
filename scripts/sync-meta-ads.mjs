import fs from "node:fs";

const token = process.env.META_ACCESS_TOKEN;
const accountId = process.env.META_AD_ACCOUNT_ID;
const graphVersion = process.env.META_GRAPH_VERSION || "v24.0";
const datePreset = process.env.META_DATE_PRESET || "last_30d";

if (!token || !accountId) {
  throw new Error("Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID GitHub secret.");
}

const fullFields = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
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

const coreFields = [
  "campaign_id",
  "campaign_name",
  "adset_id",
  "adset_name",
  "ad_id",
  "ad_name",
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

const debug = {
  generatedAt: new Date().toISOString(),
  datePreset,
  meta: {
    enabled: true,
    tokenPresent: !!token,
    adAccountIdPresent: !!accountId,
    graphVersion,
    levels: {}
  }
};

let hadFetchError = false;

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

async function fetchInsights(level, fieldMode = "full") {
  const fields = fieldMode === "full" ? fullFields : coreFields;
  const url =
    `https://graph.facebook.com/${graphVersion}/act_${accountId}/insights` +
    `?fields=${encodeURIComponent(fields.join(","))}` +
    `&level=${encodeURIComponent(level)}` +
    `&date_preset=${encodeURIComponent(datePreset)}` +
    `&limit=500` +
    `&access_token=${encodeURIComponent(token)}`;

  try {
    const rows = await fetchAllPages(url);
    debug.meta.levels[level] = { status: "ok", fieldMode, rows: rows.length };
    return rows;
  } catch (error) {
    if (fieldMode === "full") {
      debug.meta.levels[level] = { status: "retrying_core_fields", fieldMode, message: error.message };
      return fetchInsights(level, "core");
    }
    hadFetchError = true;
    debug.meta.levels[level] = { status: "error", fieldMode, message: error.message };
    return [];
  }
}

function arrValue(arr, actionTypes) {
  if (!Array.isArray(arr)) return 0;
  for (const type of actionTypes) {
    const found = arr.find(x => x.action_type === type);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

function firstValue(arr) {
  if (!Array.isArray(arr) || !arr.length) return 0;
  return Number(arr[0]?.value || 0);
}

function metricNumber(row, key) {
  return Number(row[key] || 0);
}

function getLinkClicks(row) {
  return metricNumber(row, "inline_link_clicks") ||
    arrValue(row.actions, ["link_click", "onsite_conversion.messaging_first_reply"]) ||
    firstValue(row.outbound_clicks);
}

function getCtrAll(row) {
  const v = metricNumber(row, "ctr");
  if (v) return v / 100;
  const impressions = metricNumber(row, "impressions");
  return impressions ? metricNumber(row, "clicks") / impressions : 0;
}

function getCtrLink(row) {
  const v = metricNumber(row, "inline_link_click_ctr");
  if (v) return v / 100;

  const out = firstValue(row.outbound_clicks_ctr);
  if (out) return out / 100;

  const web = firstValue(row.website_ctr);
  if (web) return web / 100;

  const impressions = metricNumber(row, "impressions");
  return impressions ? getLinkClicks(row) / impressions : 0;
}

function getCpcAll(row) {
  return metricNumber(row, "cpc") || (metricNumber(row, "clicks") ? metricNumber(row, "spend") / metricNumber(row, "clicks") : 0);
}

function getCpcLink(row) {
  return metricNumber(row, "cost_per_inline_link_click") ||
    arrValue(row.cost_per_action_type, ["link_click"]) ||
    firstValue(row.cost_per_outbound_click) ||
    (getLinkClicks(row) ? metricNumber(row, "spend") / getLinkClicks(row) : 0);
}

function getCpm(row) {
  return metricNumber(row, "cpm") ||
    (metricNumber(row, "impressions") ? metricNumber(row, "spend") / metricNumber(row, "impressions") * 1000 : 0);
}

function getPurchases(row) {
  return arrValue(row.actions, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_conversion.purchase",
    "web_in_store_purchase"
  ]);
}

function getRevenue(row) {
  return arrValue(row.action_values, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "onsite_conversion.purchase",
    "web_in_store_purchase"
  ]);
}

function getPurchaseRoas(row) {
  return firstValue(row.purchase_roas) ||
    firstValue(row.website_purchase_roas) ||
    firstValue(row.mobile_app_purchase_roas) ||
    (metricNumber(row, "spend") ? getRevenue(row) / metricNumber(row, "spend") : 0);
}

function getViews(row) {
  return firstValue(row.video_play_actions) || arrValue(row.actions, ["video_view"]);
}

function baseMetrics(row) {
  const spend = metricNumber(row, "spend");
  const impressions = metricNumber(row, "impressions");
  const clicks = metricNumber(row, "clicks");
  const purchases = getPurchases(row);
  const revenue = getRevenue(row);

  return {
    impressions,
    reach: metricNumber(row, "reach"),
    clicks_all: clicks,
    ctr_all: getCtrAll(row),
    cpc_all: getCpcAll(row),
    cpm: getCpm(row),
    link_clicks: getLinkClicks(row),
    ctr_link: getCtrLink(row),
    cpc_link: getCpcLink(row),
    purchases,
    purchase_roas: getPurchaseRoas(row),
    views: getViews(row),
    conversions: purchases || arrValue(row.actions, ["lead", "complete_registration"]),
    spend,
    revenue,
    roas: spend ? revenue / spend : 0
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

const [campaignRaw, adsetRaw, adRaw] = await Promise.all([
  fetchInsights("campaign"),
  fetchInsights("adset"),
  fetchInsights("ad")
]);

const campaigns = campaignRaw.map(mapCampaign);
const adsets = adsetRaw.map(mapAdset);
const ads = adRaw.map(mapAd);
const totalRows = campaigns.length + adsets.length + ads.length;

const today = new Date().toISOString().slice(0, 10);
const week = {
  id: `meta_${datePreset}_${today}`,
  label: `Meta ${datePreset.replace("_", " ")} ${today}`,
  period: campaignRaw[0]?.date_start && campaignRaw[0]?.date_stop
    ? `${campaignRaw[0].date_start} to ${campaignRaw[0].date_stop}`
    : datePreset,
  dateFrom: campaignRaw[0]?.date_start || "",
  dateTo: campaignRaw[0]?.date_stop || "",
  campaigns,
  adsets,
  ads,
  source: "Meta Marketing API",
  syncedAt: new Date().toISOString()
};

const existing = readExistingJson("dashboard-data.json", {
  generatedAt: null,
  source: "Meta Marketing API",
  datePreset,
  weeks: []
});

const withoutSame = (existing.weeks || []).filter(w => (w.id || w.label) !== (week.id || week.label));

const output = {
  ...existing,
  generatedAt: new Date().toISOString(),
  source: "Meta Marketing API",
  datePreset,
  weeks: [...withoutSame, week]
};

debug.summary = {
  campaigns: campaigns.length,
  adsets: adsets.length,
  ads: ads.length,
  totalRows
};

if (hadFetchError || totalRows === 0) {
  debug.summary.skippedDashboardDataUpdate = true;
  debug.summary.reason = hadFetchError
    ? "Meta API returned an error. Existing dashboard-data.json was left unchanged."
    : "Meta API returned zero rows. Existing dashboard-data.json was left unchanged.";
  fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));
  console.log("Skipped dashboard-data.json update because Meta did not return usable rows.");
  console.log(`Meta campaigns: ${campaigns.length}`);
  console.log(`Meta ad sets: ${adsets.length}`);
  console.log(`Meta ads: ${ads.length}`);
  process.exit(0);
}

fs.writeFileSync("dashboard-data.json", JSON.stringify(output, null, 2));
fs.writeFileSync("sync-debug.json", JSON.stringify(debug, null, 2));

console.log(`Meta campaigns: ${campaigns.length}`);
console.log(`Meta ad sets: ${adsets.length}`);
console.log(`Meta ads: ${ads.length}`);
