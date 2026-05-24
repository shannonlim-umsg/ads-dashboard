import fs from "node:fs";

const token = process.env.META_ACCESS_TOKEN;
const accountId = process.env.META_AD_ACCOUNT_ID;
const graphVersion = process.env.META_GRAPH_VERSION || "v24.0";
const datePreset = process.env.META_DATE_PRESET || "last_30d";

if (!token || !accountId) {
  throw new Error("Missing META_ACCESS_TOKEN or META_AD_ACCOUNT_ID GitHub secret.");
}

const metricFields = [
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

const levelFields = {
  campaign: ["campaign_id", "campaign_name", ...metricFields],
  adset: ["campaign_id", "campaign_name", "adset_id", "adset_name", ...metricFields],
  ad: ["campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name", ...metricFields]
};

async function fetchAllPages(url) {
  const all = [];
  let next = url;

  while (next) {
    const res = await fetch(next);
    const json = await res.json();

    if (!res.ok || json.error) {
      throw new Error(JSON.stringify(json.error || json, null, 2));
    }

    all.push(...(json.data || []));
    next = json.paging?.next || null;
  }

  return all;
}

async function fetchInsights(level) {
  const fields = levelFields[level].join(",");
  const url =
    `https://graph.facebook.com/${graphVersion}/act_${accountId}/insights` +
    `?fields=${encodeURIComponent(fields)}` +
    `&level=${encodeURIComponent(level)}` +
    `&date_preset=${encodeURIComponent(datePreset)}` +
    `&limit=500` +
    `&access_token=${encodeURIComponent(token)}`;

  return fetchAllPages(url);
}

function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  for (const type of types) {
    const found = actions.find(a => a.action_type === type);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

function conversions(row) {
  return actionValue(row.actions, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase",
    "lead",
    "onsite_conversion.lead_grouped",
    "complete_registration"
  ]);
}

function revenue(row) {
  return actionValue(row.action_values, [
    "purchase",
    "omni_purchase",
    "offsite_conversion.fb_pixel_purchase"
  ]);
}

function views(row) {
  if (Array.isArray(row.video_play_actions) && row.video_play_actions.length) {
    return Number(row.video_play_actions[0]?.value || 0);
  }
  return actionValue(row.actions, ["video_view"]);
}

function baseMetrics(row) {
  return {
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    views: views(row),
    conversions: conversions(row),
    spend: Number(row.spend || 0),
    revenue: revenue(row),
    status: "active"
  };
}

function campaignRow(row) {
  return {
    id: row.campaign_id ? `meta_campaign_${row.campaign_id}` : undefined,
    metaCampaignId: row.campaign_id || "",
    artist: "Imported Artist",
    name: row.campaign_name || "Unnamed campaign",
    platform: "Meta",
    type: "Traffic",
    customFields: {},
    ...baseMetrics(row)
  };
}

function adsetRow(row) {
  return {
    id: row.adset_id ? `meta_adset_${row.adset_id}` : undefined,
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    campaign: row.campaign_name || "Unnamed campaign",
    name: row.adset_name || "Unnamed ad set",
    platform: "Meta",
    customFields: {},
    ...baseMetrics(row)
  };
}

function adRow(row) {
  return {
    id: row.ad_id ? `meta_ad_${row.ad_id}` : undefined,
    metaCampaignId: row.campaign_id || "",
    metaAdsetId: row.adset_id || "",
    metaAdId: row.ad_id || "",
    campaign: row.campaign_name || "Unnamed campaign",
    adset: row.adset_name || "Unnamed ad set",
    name: row.ad_name || "Unnamed ad",
    platform: "Meta",
    customFields: {},
    ...baseMetrics(row)
  };
}

function loadExistingData() {
  if (!fs.existsSync("dashboard-data.json")) {
    return { generatedAt: null, source: "Meta Marketing API", dateRange: datePreset, weeks: [] };
  }
  return JSON.parse(fs.readFileSync("dashboard-data.json", "utf8"));
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

function mergeWeek(existing, nextWeek) {
  const weeks = existing.weeks || [];
  const previous = weeks.find(w => w.id === nextWeek.id);
  const retained = weeks.filter(w => w.id !== nextWeek.id);
  return {
    ...existing,
    generatedAt: new Date().toISOString(),
    source: "Meta Marketing API",
    graphVersion,
    dateRange: datePreset,
    weeks: [...retained, preserveCustomFields(previous, nextWeek)]
  };
}

const [campaignRaw, adsetRaw, adRaw] = await Promise.all([
  fetchInsights("campaign"),
  fetchInsights("adset"),
  fetchInsights("ad")
]);

const syncDate = new Date().toISOString().slice(0, 10);
const dateFrom = campaignRaw[0]?.date_start || adsetRaw[0]?.date_start || adRaw[0]?.date_start || "";
const dateTo = campaignRaw[0]?.date_stop || adsetRaw[0]?.date_stop || adRaw[0]?.date_stop || "";

const nextWeek = {
  id: `meta_last_30d_${syncDate}`,
  label: `Meta Last 30 Days ${syncDate}`,
  period: dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : "Last 30 Days",
  dateFrom,
  dateTo,
  source: "Meta Marketing API",
  syncedAt: new Date().toISOString(),
  campaigns: campaignRaw.map(campaignRow),
  adsets: adsetRaw.map(adsetRow),
  ads: adRaw.map(adRow)
};

const merged = mergeWeek(loadExistingData(), nextWeek);
fs.writeFileSync("dashboard-data.json", JSON.stringify(merged, null, 2));

console.log(`Synced campaign level rows: ${nextWeek.campaigns.length}`);
console.log(`Synced ad set level rows: ${nextWeek.adsets.length}`);
console.log(`Synced ad level rows: ${nextWeek.ads.length}`);
console.log("Updated dashboard-data.json and retained previous snapshots.");
