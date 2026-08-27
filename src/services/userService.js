const { DOCTYPE, ERP_BASE_URL } = require("../config");
const { erpGetList, erpGetDoc, erpCallMethod } = require("../frappeClient");
const { pickExternalId, attachCustomerIdentity } = require("../normalize");

/** Child collections returned by `mobile_app.api.v1.users_lookup` — stripped before parent-only enrichment; re-attached for `GET …/users/lookup`. */
const V1_CHILD_KEYS = [
  "profiles",
  "sessions",
  "medical_items",
  "appointments",
  "health_entries",
  "engagement_items",
];

/** Fields safe for Frappe `get_list` on Mobile App User (avoid columns not exposed to list query). */
const MOBILE_APP_USER_LIST_FIELDS = [
  "name",
  "external_id",
  "supabase_user_id",
  "email",
  "phone",
  "full_name",
  "modified",
  "first_name",
  "last_name",
];

/** Turn relative `/files/...` paths into absolute URLs for the Flutter app. */
function absoluteErpAssetUrl(value) {
  const s = value != null ? String(value).trim() : "";
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return normalizePublicFileUrl(s);
  const base = (ERP_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return normalizePublicFileUrl(`${base}${path}`);
}

/** Frappe may emit **:8000** in absolute URLs; HTTPS/ngrok serves without it (same host, port 443). */
function normalizePublicFileUrl(input) {
  const s = input != null ? String(input).trim() : "";
  if (!s) return s;
  try {
    const u = new URL(s);
    if (u.port === "8000") {
      u.port = "";
      return u.href;
    }
  } catch (_) {
    /* relative or malformed */
  }
  return s.replace(/:8000(?=\/|\?|#|$)/, "");
}

/**
 * Adds `avatar_display_url` so clients can load the profile image after ERP-side uploads
 * (Attach Image `image`, or `profile_image_url` / `avatar_url`).
 */
function enrichMobileAppUserForApi(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const profile_image_url = doc.profile_image_url != null ? String(doc.profile_image_url).trim() : "";
  const avatar_url = doc.avatar_url != null ? String(doc.avatar_url).trim() : "";
  const image = doc.image != null ? String(doc.image).trim() : "";

  let avatar_display_url = "";
  if (/^https?:\/\//i.test(profile_image_url)) avatar_display_url = profile_image_url;
  else if (/^https?:\/\//i.test(avatar_url)) avatar_display_url = avatar_url;
  else if (profile_image_url) avatar_display_url = absoluteErpAssetUrl(profile_image_url);
  else if (avatar_url) avatar_display_url = absoluteErpAssetUrl(avatar_url);
  else if (image) {
    const path = image.includes("/") ? image : `/files/${image}`;
    avatar_display_url = absoluteErpAssetUrl(path);
  }

  return {
    ...doc,
    profile_image_url: normalizePublicFileUrl(profile_image_url) || profile_image_url,
    avatar_url: normalizePublicFileUrl(avatar_url) || avatar_url,
    avatar_display_url: normalizePublicFileUrl(avatar_display_url),
  };
}

/**
 * Unwrap Frappe `/api/method/...` JSON: `{ message: { success, data } }` or direct doc in `message`.
 */
function unwrapMobileAppV1Message(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const msg = parsed.message;
  if (msg == null) return null;
  if (typeof msg === "object") {
    if (msg.success === false) return null;
    if (msg.data != null && typeof msg.data === "object") return msg.data;
    if (msg.external_id != null || msg.name != null || msg.full_name != null || msg.supabase_user_id != null) {
      return msg;
    }
  }
  return null;
}

function buildUsersLookupQuery(merged = {}) {
  const q = {};
  const supabase = merged.supabase_user_id != null ? String(merged.supabase_user_id).trim() : "";
  const ext = pickExternalId(merged);
  const email = merged.email != null ? String(merged.email).trim() : "";
  const phone = merged.phone != null ? String(merged.phone).trim() : "";
  if (supabase) q.supabase_user_id = supabase;
  if (ext) q.external_id = ext;
  if (email) q.email = email;
  if (phone) q.phone = phone;
  if (merged.id != null && String(merged.id).trim()) {
    const id = String(merged.id).trim();
    if (id) q.id = id;
  }
  return q;
}

function tryParseJson(s) {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function pickDiseaseFromV1Medical(medicalItems) {
  if (!Array.isArray(medicalItems) || !medicalItems.length) return null;
  const forSel = medicalItems.find((r) => /disease/i.test(String(r.record_type || "")));
  const row = forSel || medicalItems[0];
  let disease_name = row.title || row.disease_name || "";
  if (!disease_name && row.payload_json != null) {
    if (typeof row.payload_json === "string") {
      const p = tryParseJson(row.payload_json);
      if (p && (p.disease_name || p.name)) disease_name = p.disease_name || p.name || "";
    } else if (typeof row.payload_json === "object") {
      disease_name = row.payload_json.disease_name || row.payload_json.name || "";
    }
  }
  return {
    name: row.name,
    disease_name: disease_name || (row.record_external_id != null ? String(row.record_external_id) : ""),
    disease_id: row.record_external_id,
    record_type: row.record_type,
  };
}

function stripV1ChildTables(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const copy = { ...doc };
  V1_CHILD_KEYS.forEach((k) => {
    delete copy[k];
  });
  return copy;
}

/** Re-attach V1 child rows so `GET /api/v1/users/lookup` returns `profiles` (from `users_full_sync`), etc. */
function mergeV1ChildTablesIntoLookupResponse(enrichedBase, v1Data) {
  if (!enrichedBase || !v1Data || typeof v1Data !== "object") return enrichedBase;
  const out = { ...enrichedBase };
  for (const k of V1_CHILD_KEYS) {
    if (v1Data[k] != null) out[k] = v1Data[k];
  }
  return out;
}

function partitionV1UsersLookupData(data) {
  if (!data || typeof data !== "object") {
    return {
      user: null,
      profile: null,
      profiles: [],
      disease_selection: null,
      sessions: [],
      medical_items: [],
      appointments: [],
      health_entries: [],
      engagement_items: [],
    };
  }
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const medical_items = Array.isArray(data.medical_items) ? data.medical_items : [];
  const appointments = Array.isArray(data.appointments) ? data.appointments : [];
  const health_entries = Array.isArray(data.health_entries) ? data.health_entries : [];
  const engagement_items = Array.isArray(data.engagement_items) ? data.engagement_items : [];
  const user = enrichMobileAppUserForApi(stripV1ChildTables(data));
  const profile = profiles.length ? profiles[0] : null;
  const disease_selection = pickDiseaseFromV1Medical(medical_items);
  return {
    user,
    profile,
    profiles,
    disease_selection,
    sessions,
    medical_items,
    appointments,
    health_entries,
    engagement_items,
  };
}

/**
 * Preferred path: Frappe `mobile_app.api.v1.users_lookup` (full doc + child tables).
 * Returns `null` if unavailable or user not found — callers fall back to Resource API.
 */
async function tryUsersLookupV1(merged = {}) {
  const q = buildUsersLookupQuery(merged);
  if (!q || Object.keys(q).length === 0) return null;
  try {
    const parsed = await erpCallMethod("mobileintl_app.api.v1.users_lookup", {
      method: "GET",
      query: q,
      appToken: true,
    });
    const data = unwrapMobileAppV1Message(parsed);
    if (!data || typeof data !== "object") return null;
    return data;
  } catch (e) {
    console.warn("[userService] mobile_app.api.v1.users_lookup failed, legacy fallback:", e.message);
    return null;
  }
}

async function syncMobileAppUserViaV1(body = {}, { throwOnError = false } = {}) {
  try {
    const parsed = await erpCallMethod("mobileintl_app.api.v1.users_sync", {
      method: "POST",
      body,
      appToken: true,
    });
    const data = unwrapMobileAppV1Message(parsed);
    if (!data || typeof data !== "object") {
      if (throwOnError) {
        throw Object.assign(new Error("Frappe users_sync returned no Mobile App User"), { status: 502 });
      }
      return null;
    }
    return enrichMobileAppUserForApi(stripV1ChildTables(data));
  } catch (e) {
    if (throwOnError) throw e;
    console.warn("[userService] mobile_app.api.v1.users_sync failed, legacy fallback:", e.message);
    return null;
  }
}

function userLookupFilters(body = {}, params = {}, query = {}) {
  const merged = { ...query, ...params, ...body };
  const external_id = pickExternalId(merged);
  const supabase_user_id =
    merged.supabase_user_id != null ? String(merged.supabase_user_id).trim() : "";
  const email = merged.email != null ? String(merged.email).trim() : "";
  const phone = merged.phone != null ? String(merged.phone).trim() : "";

  if (external_id) return [["external_id", "=", external_id]];
  if (supabase_user_id) return [["supabase_user_id", "=", supabase_user_id]];
  if (email) return [["email", "=", email]];
  if (phone) return [["phone", "=", phone]];
  return null;
}

async function findMobileAppUser(body = {}, params = {}, query = {}) {
  const filters = userLookupFilters(body, params, query);
  if (!filters) return null;
  const rows = await erpGetList(DOCTYPE.MOBILE_APP_USER, {
    filters,
    fields: MOBILE_APP_USER_LIST_FIELDS,
    limit: 1,
  });
  return rows[0] || null;
}

/**
 * Legacy: Resource API — safe list row + full document merge (image / URL fields often
 * fail get_list with "Field not permitted in query" on custom sites).
 */
async function getMobileAppUserForApiLegacy(body = {}, params = {}, query = {}) {
  const row = await findMobileAppUser(body, params, query);
  if (!row?.name) return null;
  let merged = { ...row };
  try {
    const doc = await erpGetDoc(DOCTYPE.MOBILE_APP_USER, row.name);
    if (doc && typeof doc === "object") {
      merged = { ...merged, ...doc };
    }
  } catch (e) {
    console.warn("[userService] erpGetDoc Mobile App User failed:", e.message);
  }
  return enrichMobileAppUserForApi(merged);
}

/**
 * Resolves user for API: tries `mobile_app.api.v1.users_lookup` first, then Resource API.
 */
async function getMobileAppUserForApi(body = {}, params = {}, query = {}) {
  const merged = { ...query, ...params, ...body };
  const v1Data = await tryUsersLookupV1(merged);
  if (v1Data) {
    const base = enrichMobileAppUserForApi(stripV1ChildTables(v1Data));
    return mergeV1ChildTablesIntoLookupResponse(base, v1Data);
  }
  return getMobileAppUserForApiLegacy(body, params, query);
}

/**
 * Bootstrap payload for Flutter: user + profile + disease — V1 first, else Resource + child lists.
 */
async function getUserContextForApi(query = {}) {
  const merged = { ...query };
  const v1Data = await tryUsersLookupV1(merged);
  if (v1Data) {
    const {
      user,
      profile,
      profiles,
      disease_selection,
      sessions,
      medical_items,
      appointments,
      health_entries,
      engagement_items,
    } = partitionV1UsersLookupData(v1Data);
    if (!user || typeof user !== "object") return null;
    const ext = user.external_id != null ? String(user.external_id).trim() : "";
    return {
      user: attachCustomerIdentity(user, ext),
      profile,
      profiles,
      disease_selection,
      sessions,
      medical_items,
      appointments,
      health_entries,
      engagement_items,
    };
  }

  const enrichedUser = await getMobileAppUserForApiLegacy(merged, {}, {});
  if (!enrichedUser?.name) return null;
  const userLinkName = enrichedUser.name;

  let profiles = Array.isArray(enrichedUser.profiles) ? enrichedUser.profiles : [];
  if (!profiles.length) {
    try {
      profiles = await erpGetList(DOCTYPE.MOBILE_APP_USER_PROFILE, {
        filters: [["user_id", "=", userLinkName]],
        fields: [
          "name",
          "profile_name",
          "phone",
          "gender",
          "age",
          "height",
          "weight",
          "email",
          "profile_data_json",
          "modified",
        ],
        limit: 1,
        orderBy: "modified desc",
      });
    } catch (e) {
      console.warn("[userService] Mobile App User Profile list skipped:", e.message);
      profiles = [];
    }
  }

  const embeddedMedical = Array.isArray(enrichedUser.medical_items) ? enrichedUser.medical_items : [];
  let disease_selection = pickDiseaseFromV1Medical(embeddedMedical);
  if (!disease_selection) {
    let diseases = [];
    try {
      diseases = await erpGetList(DOCTYPE.MOBILE_APP_USER_DISEASE_SELECTION, {
        filters: [
          ["user_id", "=", userLinkName],
          ["is_active", "=", 1],
        ],
        fields: ["name", "disease_name", "disease_id", "modified"],
        limit: 1,
        orderBy: "modified desc",
      });
    } catch (e) {
      console.warn("[userService] active disease selection list skipped:", e.message);
    }
    if (!diseases.length) {
      try {
        diseases = await erpGetList(DOCTYPE.MOBILE_APP_USER_DISEASE_SELECTION, {
          filters: [["user_id", "=", userLinkName]],
          fields: ["name", "disease_name", "disease_id", "modified"],
          limit: 1,
          orderBy: "modified desc",
        });
      } catch (e) {
        console.warn("[userService] disease selection list skipped:", e.message);
      }
    }
    disease_selection = diseases[0] || null;
  }

  const medical_items = embeddedMedical.length
    ? embeddedMedical
    : disease_selection
      ? [
          {
            name: disease_selection.name,
            title: disease_selection.disease_name,
            disease_name: disease_selection.disease_name,
            record_external_id: disease_selection.disease_id,
            record_type: "Disease Selection",
          },
        ]
      : [];

  return {
    user: attachCustomerIdentity(enrichedUser, enrichedUser.external_id),
    profile: profiles[0] || null,
    profiles,
    disease_selection,
    sessions: Array.isArray(enrichedUser.sessions) ? enrichedUser.sessions : [],
    medical_items,
    appointments: Array.isArray(enrichedUser.appointments) ? enrichedUser.appointments : [],
    health_entries: Array.isArray(enrichedUser.health_entries) ? enrichedUser.health_entries : [],
    engagement_items: Array.isArray(enrichedUser.engagement_items) ? enrichedUser.engagement_items : [],
  };
}

/**
 * Resolves Frappe Link target for Mobile App User (`name`, usually equals `external_id`).
 */
async function resolveUserMiddleware(req, res, next) {
  try {
    const user = await findMobileAppUser(req.body || {}, req.params || {}, req.query || {});
    if (!user) {
      return res.status(404).json({
        success: false,
        message:
          "Mobile App User not found. Provide external_id, id, customer_id, supabase_user_id, email, or phone.",
      });
    }
    req.mobileUser = user;
    req.userLinkName = user.name;
    return next();
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
}

module.exports = {
  findMobileAppUser,
  getMobileAppUserForApi,
  getMobileAppUserForApiLegacy,
  getUserContextForApi,
  enrichMobileAppUserForApi,
  resolveUserMiddleware,
  userLookupFilters,
  tryUsersLookupV1,
  syncMobileAppUserViaV1,
  unwrapMobileAppV1Message,
  partitionV1UsersLookupData,
};
