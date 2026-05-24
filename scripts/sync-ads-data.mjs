import fs from "node:fs";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID || "";
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v24.0";

const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || "";
const TIKTOK_ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID || "";

const DATE_PRESET = "last_30d";
const syncDate = new Date().toISOString().slice(0, 10);
const { startDate, endDate } = lastNDaysRange(30);

function lastNDaysRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

function readExistingData() {
  if (!fs.existsSync("dashboard-data.json")) {
    return { generatedAt: null, source: "Meta + TikTok APIs", dateRange: DATE_PRESET, weeks: [] };
  }
  return JSON.parse(fs.readFileSync("dashboard-data.json", "utf8"));
}

function writeMergedWeek(nextWeek) {
  const existing = readExistingData();
  const weeks = existing.weeks || [];
  const previous = weeks.find(w => w.id === nextWeek.id);
  const retained = weeks.filter(w => w.id !== nextWeek.id);

  const merged = {
    ...existing,
    generatedAt: new Date().toISOString(),
    source: "Meta Marketing API + TikTok Business API",
    dateRange: DATE_PRESET,
    weeks: [...retained, preserveCustomFields(previous, nextWeek)]
  };

  fs.writeFileSync("dashboard-data.json", JSON.stringify(merged, null, 2));
}

function preserveCustomFields(oldWeek, newWeek) {
  if (!oldWeek) return newWeek;
  for (const key of ["campaigns", "adsets", "ads"]) {
    newWeek[key] = (newWeek[key] || []).map(next => {
      const old = (oldWeek[key] || []).find(prev => prev.id && prev.id === next.id);
      return old ? { ...next, customFields: old.customFields || {} } : next;
    });
  }
  return newWeek;
}

function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const type of types) {
    const found = actions.find(a => a.action_type === type);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

/* ═══════════════════════════════════════════════
   Meta Ads Insights
   Pulls campaign, ad set, and ad levels for last 30 days.
   ═══════════════════════════════════════════════ */
const metaMetricFields = [
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

const metaLevelFields = {
  campaign: ["campaign_id", "campaign_name", ...metaMetricFields],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name", ...metaMetricFields],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", ...metaMetricFields]
};

async function fetchAllMetaPages(url) {
  const all = [];
  let next = url;

  while (next) {
    const res = await fetch(next);
    const json = await res.json();

    if (!res.ok || json.error) {
      throw new Error("Meta API error: " + JSON.stringify(json.error || json, null, 2));
    }

    all.push(...(json.data || []));
    next = json.paging?.next || null;
  }

  return all;
}

async function fetchMetaInsights(level) {
  const fields = metaLevelFields[level].join(",");
  const url =
    `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${META_AD_ACCOUNT_ID}/insights` +
    `?fields=${encodeURIComponent(fields)}` +
    `&level=${encodeURIComponent(level)}` +
    `&date_preset=${encodeURIComponent(DATE_PRESET)}` +
    `&limit=500` +
    `&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;

  return fetchAllMetaPages(url);
}

function metaConversions(row) {
  return actionValue(row.actions, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "lead",
    "onsite_conversion.lead_grouped",
    "complete_registration"
  ]);
}

function metaRevenue(row) {
  return actionValue(row.action_values, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase"
  ]);
}

function metaViews(row) {
  if (Array.isArray(row.video_play_actions) && row.video_play_actions.length) {
    return Number(row.video_play_actions[0]?.value || 0);
  }
  return actionValue(row.actions, ["video_view"]);
}

function metaBaseMetrics(row) {
  return {
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    views: metaViews(row),
    conversions: metaConversions(row),
    spend: Number(row.spend || 0),
    revenue: metaRevenue(row),
    status: "active"
  };
}

function mapMetaCampaign(row) {
  return {
    id: row.campaign_id ? `meta_campaign_${row.campaign_id}` : `meta_campaign_${row.campaign_name}`,
    metaCampaignId: row.campaign_id || "",
    artist: "Imported Artist",
    name: row.campaign_name || "Unnamed Meta campaign",
    platform: "Meta",
    type: "Traffic",
    customFields: {},
    ...metaBaseMetrics(row)
  };
}

function mapMetaAdset(row) {
  return {
    id: row.adset_id ? `meta_adset_${row.adset_id}` : `meta_adset_${row.adset_name}`,
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    campaign: row.campaign_name || "Unnamed Meta campaign",
    name: row.adset_name || "Unnamed Meta ad set",
    platform: "Meta",
    customFields: {},
    ...metaBaseMetrics(row)
  };
}

function mapMetaAd(row) {
  return {
    id: row.ad_id ? `meta_ad_${row.ad_id}` : `meta_ad_${row.ad_name}`,
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    metaAdId: row.ad_id || "",
    campaign: row.campaign_name || "Unnamed Meta campaign",
    adset: row.adset_name || "Unnamed Meta ad set",
    name: row.ad_name || "Unnamed Meta ad",
    platform: "Meta",
    customFields: {},
    ...metaBaseMetrics(row)
  };
}

async function syncMeta() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    console.log("Skipping Meta sync because META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is missing.");
    return { campaigns: [], adsets: [], ads: [] };
  }

  const [campaignRaw, adsetRaw, adRaw] = await Promise.all([
    fetchMetaInsights("campaign"),
    fetchMetaInsights("adset"),
    fetchMetaInsights("ad")
  ]);

  console.log(`Meta campaign rows: ${campaignRaw.length}`);
  console.log(`Meta ad set rows: ${adsetRaw.length}`);
  console.log(`Meta ad rows: ${adRaw.length}`);

  return {
    campaigns: campaignRaw.map(mapMetaCampaign),
    adsets: adsetRaw.map(mapMetaAdset),
    ads: adRaw.map(mapMetaAd)
  };
}

/* ═══════════════════════════════════════════════
   TikTok Business API Reporting
   Pulls campaign, ad group, and ad levels for last 30 days.
   TikTok calls the middle level “Ad Group”; the dashboard stores it
   as an ad set/ad group row for consistent nesting.
   ═══════════════════════════════════════════════ */
const TIKTOK_BASE_URL = "https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/";

const tiktokLevels = {
  campaign: { dataLevel: "AUCTION_CAMPAIGN", dimension: "campaign_id" },
  adgroup: { dataLevel: "AUCTION_ADGROUP", dimension: "adgroup_id" },
  ad: { dataLevel: "AUCTION_AD", dimension: "ad_id" }
};

const tiktokBroadMetrics = [
  "campaign_name",
  "campaign_id",
  "adgroup_name",
  "adgroup_id",
  "ad_name",
  "ad_id",
  "spend",
  "impressions",
  "reach",
  "clicks",
  "conversion",
  "real_time_conversion",
  "result",
  "video_watched_2s"
];

const tiktokCoreMetrics = [
  "campaign_name",
  "campaign_id",
  "adgroup_name",
  "adgroup_id",
  "ad_name",
  "ad_id",
  "spend",
  "impressions",
  "clicks",
  "conversion"
];

function tiktokValue(row, key) {
  return row?.metrics?.[key] ?? row?.dimensions?.[key] ?? row?.[key] ?? "";
}

function tiktokNumber(row, keys) {
  for (const key of keys) {
    const value = tiktokValue(row, key);
    if (value !== undefined && value !== null && value !== "") return Number(value || 0);
  }
  return 0;
}

async function fetchTikTokReportOnce(levelConfig, metrics, page = 1) {
  const params = new URLSearchParams();
  params.set("advertiser_id", TIKTOK_ADVERTISER_ID);
  params.set("report_type", "BASIC");
  params.set("data_level", levelConfig.dataLevel);
  params.set("dimensions", JSON.stringify([levelConfig.dimension]));
  params.set("metrics", JSON.stringify(metrics));
  params.set("start_date", startDate);
  params.set("end_date", endDate);
  params.set("page", String(page));
  params.set("page_size", "1000");

  const res = await fetch(`${TIKTOK_BASE_URL}?${params.toString()}`, {
    headers: { "Access-Token": TIKTOK_ACCESS_TOKEN }
  });

  const json = await res.json();
  if (!res.ok || (json.code !== undefined && Number(json.code) !== 0)) {
    throw new Error(JSON.stringify(json, null, 2));
  }
  return json;
}

async function fetchTikTokReport(levelKey, metrics = tiktokBroadMetrics) {
  const levelConfig = tiktokLevels[levelKey];
  const rows = [];
  let page = 1;
  let totalPage = 1;

  while (page <= totalPage) {
    const json = await fetchTikTokReportOnce(levelConfig, metrics, page);
    const data = json.data || {};
    rows.push(...(data.list || []));
    totalPage = Number(data.page_info?.total_page || data.page_info?.total_pages || 1);
    page += 1;
  }

  return rows;
}

async function fetchTikTokReportWithFallback(levelKey) {
  try {
    return await fetchTikTokReport(levelKey, tiktokBroadMetrics);
  } catch (err) {
    console.warn(`TikTok ${levelKey} broad metric pull failed. Retrying with core metrics.`);
    console.warn(String(err.message || err).slice(0, 1000));
    return fetchTikTokReport(levelKey, tiktokCoreMetrics);
  }
}

function tiktokBaseMetrics(row) {
  return {
    impressions: tiktokNumber(row, ["impressions", "show_cnt"]),
    reach: tiktokNumber(row, ["reach"]),
    clicks: tiktokNumber(row, ["clicks", "click_cnt"]),
    views: tiktokNumber(row, ["video_watched_2s", "video_views", "video_play_actions"]),
    conversions: tiktokNumber(row, ["conversion", "real_time_conversion", "result"]),
    spend: tiktokNumber(row, ["spend", "cost"]),
    revenue: 0,
    status: "active"
  };
}

function mapTikTokCampaign(row) {
  const campaignId = String(tiktokValue(row, "campaign_id") || "");
  const campaignName = String(tiktokValue(row, "campaign_name") || campaignId || "Unnamed TikTok campaign");
  return {
    id: campaignId ? `tiktok_campaign_${campaignId}` : `tiktok_campaign_${campaignName}`,
    tiktokCampaignId: campaignId,
    artist: "Imported Artist",
    name: campaignName,
    platform: "TikTok",
    type: "Traffic",
    customFields: {},
    ...tiktokBaseMetrics(row)
  };
}

function mapTikTokAdgroup(row) {
  const campaignId = String(tiktokValue(row, "campaign_id") || "");
  const campaignName = String(tiktokValue(row, "campaign_name") || "");
  const adgroupId = String(tiktokValue(row, "adgroup_id") || "");
  const adgroupName = String(tiktokValue(row, "adgroup_name") || adgroupId || "Unnamed TikTok ad group");
  return {
    id: adgroupId ? `tiktok_adgroup_${adgroupId}` : `tiktok_adgroup_${adgroupName}`,
    tiktokCampaignId: campaignId,
    tiktokAdgroupId: adgroupId,
    campaign: campaignName || campaignId || "Unnamed TikTok campaign",
    name: adgroupName,
    platform: "TikTok",
    customFields: {},
    ...tiktokBaseMetrics(row)
  };
}

function mapTikTokAd(row) {
  const campaignId = String(tiktokValue(row, "campaign_id") || "");
  const campaignName = String(tiktokValue(row, "campaign_name") || "");
  const adgroupId = String(tiktokValue(row, "adgroup_id") || "");
  const adgroupName = String(tiktokValue(row, "adgroup_name") || "");
  const adId = String(tiktokValue(row, "ad_id") || "");
  const adName = String(tiktokValue(row, "ad_name") || adId || "Unnamed TikTok ad");
  return {
    id: adId ? `tiktok_ad_${adId}` : `tiktok_ad_${adName}`,
    tiktokCampaignId: campaignId,
    tiktokAdgroupId: adgroupId,
    tiktokAdId: adId,
    campaign: campaignName || campaignId || "Unnamed TikTok campaign",
    adset: adgroupName || adgroupId || "Unnamed TikTok ad group",
    name: adName,
    platform: "TikTok",
    customFields: {},
    ...tiktokBaseMetrics(row)
  };
}

async function syncTikTok() {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
    console.log("Skipping TikTok sync because TIKTOK_ACCESS_TOKEN or TIKTOK_ADVERTISER_ID is missing.");
    return { campaigns: [], adsets: [], ads: [] };
  }

  const [campaignRaw, adgroupRaw, adRaw] = await Promise.all([
    fetchTikTokReportWithFallback("campaign"),
    fetchTikTokReportWithFallback("adgroup"),
    fetchTikTokReportWithFallback("ad")
  ]);

  console.log(`TikTok campaign rows: ${campaignRaw.length}`);
  console.log(`TikTok ad group rows: ${adgroupRaw.length}`);
  console.log(`TikTok ad rows: ${adRaw.length}`);

  return {
    campaigns: campaignRaw.map(mapTikTokCampaign),
    adsets: adgroupRaw.map(mapTikTokAdgroup),
    ads: adRaw.map(mapTikTokAd)
  };
}

/* ═══════════════════════════════════════════════
   Main combined sync
   ═══════════════════════════════════════════════ */
const [meta, tiktok] = await Promise.all([syncMeta(), syncTikTok()]);

const nextWeek = {
  id: `ads_last_30d_${syncDate}`,
  label: `Meta + TikTok Last 30 Days ${syncDate}`,
  period: `${startDate} to ${endDate}`,
  dateFrom: startDate,
  dateTo: endDate,
  source: "Meta Marketing API + TikTok Business API",
  syncedAt: new Date().toISOString(),
  campaigns: [...meta.campaigns, ...tiktok.campaigns],
  adsets: [...meta.adsets, ...tiktok.adsets],
  ads: [...meta.ads, ...tiktok.ads]
};

if (!nextWeek.campaigns.length && !nextWeek.adsets.length && !nextWeek.ads.length) {
  throw new Error("No Meta or TikTok rows were synced. Add API secrets or check account permissions.");
}

writeMergedWeek(nextWeek);

console.log(`Combined campaigns: ${nextWeek.campaigns.length}`);
console.log(`Combined ad sets/ad groups: ${nextWeek.adsets.length}`);
console.log(`Combined ads: ${nextWeek.ads.length}`);
console.log("Updated dashboard-data.json and retained previous snapshots/custom fields.");
