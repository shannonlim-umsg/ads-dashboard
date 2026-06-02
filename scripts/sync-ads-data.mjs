import fs from "node:fs";

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || "";
const META_AD_ACCOUNT_ID_RAW = process.env.META_AD_ACCOUNT_ID || "";
const META_AD_ACCOUNT_ID = META_AD_ACCOUNT_ID_RAW.replace(/^act_/, "");
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v24.0";

const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN || "";
const TIKTOK_ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID || "";

const DATE_PRESET = process.env.ADS_DATE_PRESET || "last_30d";
const syncDate = new Date().toISOString().slice(0, 10);
const { startDate, endDate } = lastNDaysRange(30);

const debug = {
  generatedAt: new Date().toISOString(),
  datePreset: DATE_PRESET,
  dateRange: { startDate, endDate },
  meta: {
    enabled: Boolean(META_ACCESS_TOKEN && META_AD_ACCOUNT_ID),
    tokenPresent: Boolean(META_ACCESS_TOKEN),
    adAccountIdPresent: Boolean(META_AD_ACCOUNT_ID),
    graphVersion: META_GRAPH_VERSION,
    levels: {}
  },
  tiktok: {
    enabled: Boolean(TIKTOK_ACCESS_TOKEN && TIKTOK_ADVERTISER_ID),
    tokenPresent: Boolean(TIKTOK_ACCESS_TOKEN),
    advertiserIdPresent: Boolean(TIKTOK_ADVERTISER_ID),
    levels: {}
  },
  summary: {}
};

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
  try {
    return JSON.parse(fs.readFileSync("dashboard-data.json", "utf8"));
  } catch {
    return { generatedAt: null, source: "Meta + TikTok APIs", dateRange: DATE_PRESET, weeks: [] };
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2));
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

function writeMergedWeek(nextWeek, syncStatus) {
  const existing = readExistingData();
  const rows = [nextWeek.campaigns, nextWeek.adsets, nextWeek.ads].flat().length;

  let weeks = existing.weeks || [];
  if (rows > 0) {
    const previous = weeks.find(w => w.id === nextWeek.id);
    const retained = weeks.filter(w => w.id !== nextWeek.id);
    weeks = [...retained, preserveCustomFields(previous, nextWeek)];
  }

  const merged = {
    ...existing,
    generatedAt: new Date().toISOString(),
    source: "Meta Marketing API + TikTok Business API",
    dateRange: DATE_PRESET,
    lastSyncStatus: syncStatus,
    weeks
  };

  writeJson("dashboard-data.json", merged);
}

function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const type of types) {
    const found = actions.find(a => a.action_type === type);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

function statValue(stats, types = []) {
  if (!Array.isArray(stats) || !stats.length) return 0;
  if (types.length) {
    for (const type of types) {
      const found = stats.find(a => a.action_type === type);
      if (found) return Number(found.value || 0);
    }
  }
  return Number(stats[0]?.value || 0);
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  return 0;
}

function safeRatio(numerator, denominator) {
  const n = Number(numerator || 0);
  const d = Number(denominator || 0);
  return d ? n / d : 0;
}

function percentToRatio(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : 0;
}

const PURCHASE_ACTION_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_conversion.purchase",
  "onsite_conversion.website_purchase",
  "web_in_store_purchase",
  "mobile_app_purchase",
  "app_custom_event.fb_mobile_purchase"
];

const CONVERSION_ACTION_TYPES = [
  ...PURCHASE_ACTION_TYPES,
  "lead",
  "onsite_conversion.lead_grouped",
  "complete_registration"
];

/* Meta */
const META_CORE_METRICS = [
  "impressions", "reach", "clicks", "ctr", "cpc", "cpm", "spend",
  "actions", "action_values", "video_play_actions", "date_start", "date_stop"
];

const META_FULL_METRICS = [
  ...META_CORE_METRICS,
  "inline_link_clicks",
  "inline_link_click_ctr",
  "cost_per_inline_link_click",
  "unique_inline_link_clicks",
  "unique_link_clicks_ctr",
  "outbound_clicks",
  "outbound_clicks_ctr",
  "cost_per_outbound_click",
  "website_ctr",
  "cost_per_action_type",
  "purchase_roas",
  "website_purchase_roas",
  "mobile_app_purchase_roas"
];

function metaFields(level, mode = "full") {
  const metrics = mode === "full" ? META_FULL_METRICS : META_CORE_METRICS;
  if (level === "campaign") return ["campaign_id", "campaign_name", ...metrics];
  if (level === "adset") return ["campaign_id", "campaign_name", "adset_id", "adset_name", ...metrics];
  return ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", ...metrics];
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(JSON.stringify(json, null, 2));
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function fetchAllMetaPages(url) {
  const all = [];
  let next = url;
  while (next) {
    const json = await fetchJson(next);
    if (json.error) throw new Error(JSON.stringify(json.error, null, 2));
    all.push(...(json.data || []));
    next = json.paging?.next || null;
  }
  return all;
}

async function fetchMetaInsights(level) {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    debug.meta.levels[level] = { status: "skipped", reason: "Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID" };
    return [];
  }

  for (const mode of ["full", "core"]) {
    const fields = metaFields(level, mode).join(",");
    const url =
      `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${META_AD_ACCOUNT_ID}/insights` +
      `?fields=${encodeURIComponent(fields)}` +
      `&level=${encodeURIComponent(level)}` +
      `&date_preset=${encodeURIComponent(DATE_PRESET)}` +
      `&limit=500` +
      `&access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`;

    try {
      const rows = await fetchAllMetaPages(url);
      debug.meta.levels[level] = { status: "ok", fieldMode: mode, rows: rows.length };
      return rows;
    } catch (err) {
      debug.meta.levels[level] = {
        status: "error",
        fieldMode: mode,
        message: String(err.message || err).slice(0, 4000)
      };
      if (mode === "core") return [];
      console.warn(`Meta ${level} full-field pull failed; retrying with core fields.`);
    }
  }
  return [];
}

function metaRevenue(row) {
  return actionValue(row.action_values, PURCHASE_ACTION_TYPES);
}
function metaPurchases(row) {
  return actionValue(row.actions, PURCHASE_ACTION_TYPES);
}
function metaConversions(row) {
  return actionValue(row.actions, CONVERSION_ACTION_TYPES);
}
function metaViews(row) {
  return firstFinite(Number(row.video_play_actions?.[0]?.value || 0), actionValue(row.actions, ["video_view"]));
}
function metaLinkClicks(row) {
  return firstFinite(
    row.inline_link_clicks,
    actionValue(row.actions, ["link_click"]),
    statValue(row.outbound_clicks, ["outbound_click"]),
    row.unique_inline_link_clicks
  );
}
function metaPurchaseRoas(row) {
  const revenue = metaRevenue(row);
  return firstFinite(
    statValue(row.purchase_roas, PURCHASE_ACTION_TYPES),
    statValue(row.website_purchase_roas, PURCHASE_ACTION_TYPES),
    statValue(row.mobile_app_purchase_roas, PURCHASE_ACTION_TYPES),
    safeRatio(revenue, row.spend)
  );
}
function metaBase(row) {
  const spend = Number(row.spend || 0);
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const linkClicks = metaLinkClicks(row);
  const purchases = metaPurchases(row);
  const revenue = metaRevenue(row);
  return {
    impressions,
    reach: Number(row.reach || 0),
    clicks,
    clicks_all: clicks,
    link_clicks: linkClicks,
    ctr_all: firstFinite(percentToRatio(row.ctr), safeRatio(clicks, impressions)),
    ctr_link: firstFinite(
      percentToRatio(row.inline_link_click_ctr),
      safeRatio(linkClicks, impressions),
      percentToRatio(statValue(row.outbound_clicks_ctr, ["outbound_click"])),
      percentToRatio(statValue(row.website_ctr, ["link_click", "outbound_click"]))
    ),
    cpc_all: firstFinite(row.cpc, safeRatio(spend, clicks)),
    cpc_link: firstFinite(
      row.cost_per_inline_link_click,
      statValue(row.cost_per_action_type, ["link_click"]),
      statValue(row.cost_per_outbound_click, ["outbound_click"]),
      safeRatio(spend, linkClicks)
    ),
    cpm: firstFinite(row.cpm, safeRatio(spend, impressions) * 1000),
    views: metaViews(row),
    purchases,
    conversions: metaConversions(row),
    spend,
    revenue,
    purchase_roas: metaPurchaseRoas(row),
    status: "active"
  };
}
function mapMetaCampaign(row) {
  return { id: row.campaign_id ? `meta_campaign_${row.campaign_id}` : `meta_campaign_${row.campaign_name}`, metaCampaignId: row.campaign_id || "", artist: "Imported Artist", name: row.campaign_name || row.campaign_id || "Unnamed Meta campaign", platform: "Meta", type: "Traffic", customFields: {}, ...metaBase(row) };
}
function mapMetaAdset(row) {
  return { id: row.adset_id ? `meta_adset_${row.adset_id}` : `meta_adset_${row.adset_name}`, metaCampaignId: row.campaign_id || "", metaAdsetId: row.adset_id || "", campaign: row.campaign_name || row.campaign_id || "Unnamed Meta campaign", name: row.adset_name || row.adset_id || "Unnamed Meta ad set", platform: "Meta", customFields: {}, ...metaBase(row) };
}
function mapMetaAd(row) {
  return { id: row.ad_id ? `meta_ad_${row.ad_id}` : `meta_ad_${row.ad_name}`, metaCampaignId: row.campaign_id || "", metaAdsetId: row.adset_id || "", metaAdId: row.ad_id || "", campaign: row.campaign_name || row.campaign_id || "Unnamed Meta campaign", adset: row.adset_name || row.adset_id || "Unnamed Meta ad set", name: row.ad_name || row.ad_id || "Unnamed Meta ad", platform: "Meta", customFields: {}, ...metaBase(row) };
}
async function syncMeta() {
  const [campaignRaw, adsetRaw, adRaw] = await Promise.all([
    fetchMetaInsights("campaign"),
    fetchMetaInsights("adset"),
    fetchMetaInsights("ad")
  ]);
  return { campaigns: campaignRaw.map(mapMetaCampaign), adsets: adsetRaw.map(mapMetaAdset), ads: adRaw.map(mapMetaAd) };
}

/* TikTok */
const TIKTOK_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const TIKTOK_REPORT_URL = `${TIKTOK_BASE}/report/integrated/get/`;

const tiktokLevels = {
  campaign: { dataLevel: "AUCTION_CAMPAIGN", dimensions: ["campaign_id"] },
  adgroup: { dataLevel: "AUCTION_ADGROUP", dimensions: ["adgroup_id"] },
  ad: { dataLevel: "AUCTION_AD", dimensions: ["ad_id"] }
};

// Important: keep Reporting API metrics numeric only. Names/hierarchy are enriched from
// campaign/get, adgroup/get, and ad/get, because TikTok may reject name fields as metrics.
const tiktokMetricSets = [
  ["spend", "impressions", "clicks", "reach", "conversion", "real_time_conversion", "result", "video_watched_2s", "ctr", "cpc", "cpm"],
  ["spend", "impressions", "clicks", "conversion", "real_time_conversion", "result"],
  ["spend", "impressions", "clicks"]
];

async function fetchTikTokJson(url) {
  const json = await fetchJson(url, {
    headers: {
      "Access-Token": TIKTOK_ACCESS_TOKEN,
      "Accept": "application/json"
    }
  });
  if (json.code !== undefined && Number(json.code) !== 0) {
    const err = new Error(JSON.stringify(json, null, 2));
    err.body = json;
    throw err;
  }
  return json;
}

function tiktokParams(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, Array.isArray(value) || typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return search.toString();
}

async function fetchTikTokEntityPages(entity, fields) {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) return [];

  const endpoint = `${TIKTOK_BASE}/${entity}/get/`;
  const rows = [];
  let page = 1;
  let totalPage = 1;

  try {
    while (page <= totalPage) {
      const url = `${endpoint}?${tiktokParams({
        advertiser_id: TIKTOK_ADVERTISER_ID,
        fields,
        page,
        page_size: 1000
      })}`;
      const json = await fetchTikTokJson(url);
      const data = json.data || {};
      rows.push(...(data.list || []));
      totalPage = Number(data.page_info?.total_page || data.page_info?.total_pages || 1);
      page += 1;
    }
    debug.tiktok[`${entity}Get`] = { status: "ok", rows: rows.length };
    return rows;
  } catch (err) {
    debug.tiktok[`${entity}Get`] = { status: "error", message: String(err.message || err).slice(0, 4000) };
    return [];
  }
}

async function buildTikTokEntityMaps() {
  const [campaigns, adgroups, ads] = await Promise.all([
    fetchTikTokEntityPages("campaign", ["campaign_id", "campaign_name", "objective_type", "operation_status", "secondary_status"]),
    fetchTikTokEntityPages("adgroup", ["adgroup_id", "adgroup_name", "campaign_id", "operation_status", "secondary_status"]),
    fetchTikTokEntityPages("ad", ["ad_id", "ad_name", "adgroup_id", "campaign_id", "operation_status", "secondary_status"])
  ]);

  const campaignMap = new Map(campaigns.map(c => [String(c.campaign_id || ""), c]));
  const adgroupMap = new Map(adgroups.map(g => [String(g.adgroup_id || ""), g]));
  const adMap = new Map(ads.map(a => [String(a.ad_id || ""), a]));

  return { campaignMap, adgroupMap, adMap };
}

async function fetchTikTokOnce(levelKey, metrics, page) {
  const cfg = tiktokLevels[levelKey];
  const url = `${TIKTOK_REPORT_URL}?${tiktokParams({
    advertiser_id: TIKTOK_ADVERTISER_ID,
    service_type: "AUCTION",
    report_type: "BASIC",
    data_level: cfg.dataLevel,
    dimensions: cfg.dimensions,
    metrics,
    start_date: startDate,
    end_date: endDate,
    query_mode: "REGULAR",
    page,
    page_size: 1000
  })}`;

  return fetchTikTokJson(url);
}

async function fetchTikTokReport(levelKey) {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
    debug.tiktok.levels[levelKey] = { status: "skipped", reason: "Missing TIKTOK_ACCESS_TOKEN or TIKTOK_ADVERTISER_ID" };
    return [];
  }

  for (let i = 0; i < tiktokMetricSets.length; i++) {
    const metrics = tiktokMetricSets[i];
    const rows = [];
    let page = 1;
    let totalPage = 1;

    try {
      while (page <= totalPage) {
        const json = await fetchTikTokOnce(levelKey, metrics, page);
        const data = json.data || {};
        rows.push(...(data.list || []));
        totalPage = Number(data.page_info?.total_page || data.page_info?.total_pages || 1);
        page += 1;
      }

      debug.tiktok.levels[levelKey] = {
        status: "ok",
        metricSet: i + 1,
        rows: rows.length,
        metrics
      };
      return rows;
    } catch (err) {
      debug.tiktok.levels[levelKey] = {
        status: "error",
        metricSet: i + 1,
        metrics,
        message: String(err.message || err).slice(0, 4000)
      };
      console.warn(`TikTok ${levelKey} metric set ${i + 1} failed; trying fallback.`);
    }
  }

  return [];
}

function ttVal(row, key) {
  return row?.metrics?.[key] ?? row?.dimensions?.[key] ?? row?.[key] ?? "";
}

function ttNum(row, keys) {
  for (const key of keys) {
    const value = ttVal(row, key);
    if (value !== undefined && value !== null && value !== "") return Number(value || 0);
  }
  return 0;
}

function ttRatioPercent(row, keys, fallback) {
  for (const key of keys) {
    const value = ttVal(row, key);
    if (value !== undefined && value !== null && value !== "") return Number(value || 0) / 100;
  }
  return fallback;
}

function tiktokBase(row) {
  const impressions = ttNum(row, ["impressions", "show_cnt"]);
  const clicks = ttNum(row, ["clicks", "click_cnt"]);
  const spend = ttNum(row, ["spend", "cost"]);
  const purchases = ttNum(row, ["purchase", "purchases", "conversion", "real_time_conversion", "result"]);

  return {
    impressions,
    reach: ttNum(row, ["reach"]),
    clicks,
    clicks_all: clicks,
    link_clicks: clicks,
    ctr_all: ttRatioPercent(row, ["ctr"], safeRatio(clicks, impressions)),
    ctr_link: ttRatioPercent(row, ["ctr"], safeRatio(clicks, impressions)),
    cpc_all: firstFinite(ttNum(row, ["cpc"]), safeRatio(spend, clicks)),
    cpc_link: firstFinite(ttNum(row, ["cpc"]), safeRatio(spend, clicks)),
    cpm: firstFinite(ttNum(row, ["cpm"]), safeRatio(spend, impressions) * 1000),
    views: ttNum(row, ["video_watched_2s", "video_views"]),
    purchases,
    conversions: purchases,
    spend,
    revenue: 0,
    purchase_roas: 0,
    status: "active"
  };
}

function mapTikTokCampaign(row, maps) {
  const id = String(ttVal(row, "campaign_id") || "");
  const campaign = maps.campaignMap.get(id) || {};
  const name = String(campaign.campaign_name || ttVal(row, "campaign_name") || id || "Unnamed TikTok campaign");

  return {
    id: id ? `tiktok_campaign_${id}` : `tiktok_campaign_${name}`,
    tiktokCampaignId: id,
    artist: "Imported Artist",
    name,
    platform: "TikTok",
    type: campaign.objective_type || "Traffic",
    customFields: {},
    ...tiktokBase(row)
  };
}

function mapTikTokAdgroup(row, maps) {
  const id = String(ttVal(row, "adgroup_id") || "");
  const adgroup = maps.adgroupMap.get(id) || {};
  const cid = String(adgroup.campaign_id || ttVal(row, "campaign_id") || "");
  const campaign = maps.campaignMap.get(cid) || {};
  const cname = String(campaign.campaign_name || cid || "Unknown TikTok campaign");
  const name = String(adgroup.adgroup_name || ttVal(row, "adgroup_name") || id || "Unnamed TikTok ad group");

  return {
    id: id ? `tiktok_adgroup_${id}` : `tiktok_adgroup_${name}`,
    tiktokCampaignId: cid,
    tiktokAdgroupId: id,
    campaign: cname,
    name,
    platform: "TikTok",
    customFields: {},
    ...tiktokBase(row)
  };
}

function mapTikTokAd(row, maps) {
  const id = String(ttVal(row, "ad_id") || "");
  const ad = maps.adMap.get(id) || {};
  const gid = String(ad.adgroup_id || ttVal(row, "adgroup_id") || "");
  const adgroup = maps.adgroupMap.get(gid) || {};
  const cid = String(ad.campaign_id || adgroup.campaign_id || ttVal(row, "campaign_id") || "");
  const campaign = maps.campaignMap.get(cid) || {};
  const cname = String(campaign.campaign_name || cid || "Unknown TikTok campaign");
  const gname = String(adgroup.adgroup_name || gid || "Unknown TikTok ad group");
  const name = String(ad.ad_name || ttVal(row, "ad_name") || id || "Unnamed TikTok ad");

  return {
    id: id ? `tiktok_ad_${id}` : `tiktok_ad_${name}`,
    tiktokCampaignId: cid,
    tiktokAdgroupId: gid,
    tiktokAdId: id,
    campaign: cname,
    adset: gname,
    name,
    platform: "TikTok",
    customFields: {},
    ...tiktokBase(row)
  };
}

async function syncTikTok() {
  if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
    debug.tiktok.status = "skipped";
    debug.tiktok.reason = "Missing TIKTOK_ACCESS_TOKEN or TIKTOK_ADVERTISER_ID";
    return { campaigns: [], adsets: [], ads: [] };
  }

  const maps = await buildTikTokEntityMaps();

  const [campaignRaw, adgroupRaw, adRaw] = await Promise.all([
    fetchTikTokReport("campaign"),
    fetchTikTokReport("adgroup"),
    fetchTikTokReport("ad")
  ]);

  const campaigns = campaignRaw.map(row => mapTikTokCampaign(row, maps));
  const adsets = adgroupRaw.map(row => mapTikTokAdgroup(row, maps));
  const ads = adRaw.map(row => mapTikTokAd(row, maps));

  debug.tiktok.mappedRows = { campaigns: campaigns.length, adsets: adsets.length, ads: ads.length };
  return { campaigns, adsets, ads };
}


const meta = await syncMeta();
const tiktok = await syncTikTok();

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

debug.summary = {
  campaigns: nextWeek.campaigns.length,
  adsets: nextWeek.adsets.length,
  ads: nextWeek.ads.length,
  totalRows: nextWeek.campaigns.length + nextWeek.adsets.length + nextWeek.ads.length
};

writeMergedWeek(nextWeek, debug.summary);
writeJson("sync-debug.json", debug);

console.log("Sync summary:", JSON.stringify(debug.summary, null, 2));
console.log("Meta levels:", JSON.stringify(debug.meta.levels, null, 2));
console.log("TikTok levels:", JSON.stringify(debug.tiktok.levels, null, 2));
console.log("Wrote dashboard-data.json and sync-debug.json.");

if (debug.summary.totalRows === 0) {
  console.warn("No rows were returned. Check sync-debug.json for exact Meta/TikTok API errors or missing secrets.");
}
