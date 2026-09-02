require("dotenv").config();

const trim = (v) => (v || "").toString().trim();

/** Strip BOM / whitespace (Windows .env UTF-8 BOM breaks strict token match). */
function normalizeSecret(v) {
  return trim(v).replace(/^\uFEFF/, "");
}

const ERP_BASE_URL = trim(process.env.ERP_BASE_URL || "").replace(/\/+$/, "");
/** Frappe API key: `api_key:api_secret` — sent as `Authorization: token …` unless ERP_AUTH_SCHEME=bearer */
const ERP_API_KEY = normalizeSecret(process.env.ERP_API_KEY || "");
const ERP_API_SECRET = normalizeSecret(process.env.ERP_API_SECRET || "");
const ERP_BEARER_TOKEN = normalizeSecret(process.env.ERP_BEARER_TOKEN || "");

function normalizeErpToken(v) {
  return normalizeSecret(v)
    .replace(/^token\s+/i, "")
    .replace(/^bearer\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/\s*:\s*/g, ":")
    .trim();
}

const ERP_TOKEN = normalizeErpToken(
  ERP_API_KEY && ERP_API_SECRET ? `${ERP_API_KEY}:${ERP_API_SECRET}` : process.env.ERP_TOKEN || ERP_BEARER_TOKEN,
);
const ERP_AUTH_SCHEME = trim(process.env.ERP_AUTH_SCHEME || "token").toLowerCase();
/** App / Postman → this Node API (`requireAppToken` on `/api/v1/*`). */
const APP_ERP_TOKEN = normalizeSecret(process.env.APP_ERP_TOKEN || "");
/**
 * Same value as `mobile_app_erp_token` in Frappe `site_config.json`.
 * Sent as **X-ERP-Token** on Node→Frappe so `mobile_app.api.v1.*` passes `require_app_token()`.
 * This is separate from **ERP_TOKEN** (Desk API key in **Authorization**).
 */
const MOBILE_APP_ERP_TOKEN = normalizeSecret(process.env.MOBILE_APP_ERP_TOKEN || "");
const PORT = Number(process.env.PORT || 3101);

/** Supabase project (for POST /api/auth/verify-supabase — validates user JWT like n8n). */
const SUPABASE_URL = trim(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = normalizeSecret(process.env.SUPABASE_ANON_KEY || "");
const SUPABASE_SERVICE_ROLE_KEY = normalizeSecret(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

const APP_NOTIFICATION_TOKEN = normalizeSecret(process.env.APP_NOTIFICATION_TOKEN || APP_ERP_TOKEN);
const ONESIGNAL_APP_ID = normalizeSecret(process.env.ONESIGNAL_APP_ID || "");
const ONESIGNAL_REST_API_KEY = normalizeSecret(process.env.ONESIGNAL_REST_API_KEY || "");
const FCM_SERVER_KEY = normalizeSecret(process.env.FCM_SERVER_KEY || "");
const FIREBASE_PROJECT_ID = normalizeSecret(process.env.FIREBASE_PROJECT_ID || "");
const FIREBASE_CLIENT_EMAIL = normalizeSecret(process.env.FIREBASE_CLIENT_EMAIL || "");
const FIREBASE_PRIVATE_KEY = normalizeSecret(process.env.FIREBASE_PRIVATE_KEY || "");
const FIREBASE_SERVICE_ACCOUNT_JSON = normalizeSecret(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "");
const SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS = Number(
  process.env.SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS || 60 * 1000,
);
const SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED =
  trim(process.env.SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED || "").toLowerCase() === "true";

const OPENAI_API_KEY = normalizeSecret(process.env.OPENAI_API_KEY || "");
const OPENAI_MODEL = trim(process.env.OPENAI_MODEL || "gpt-4o-mini");
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);
const OPENAI_MAX_OUTPUT_TOKENS = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || 900);
const OPENAI_MAX_RETRIES = Math.max(0, Number(process.env.OPENAI_MAX_RETRIES || 2));
const REPORTS_OCR_TOKEN = normalizeSecret(process.env.REPORTS_OCR_TOKEN || APP_ERP_TOKEN);
const REPORTS_OCR_FALLBACK_WEBHOOK_URL = trim(process.env.REPORTS_OCR_FALLBACK_WEBHOOK_URL || "");
const REPORTS_OCR_FALLBACK_TIMEOUT_MS = Number(process.env.REPORTS_OCR_FALLBACK_TIMEOUT_MS || 15000);
const S3_PRESCRIPTION_PREFIX = trim(process.env.S3_PRESCRIPTION_PREFIX || "prescriptions");
const S3_PROFILE_PREFIX = trim(process.env.S3_PROFILE_PREFIX || "profile-pics");
const S3_PUBLIC_BASE_URL = trim(process.env.S3_PUBLIC_BASE_URL || "");

const DOCTYPE = {
  MOBILE_APP_USER: trim(process.env.DOCTYPE_MOBILE_APP_USER || "Mobile App User"),
  MOBILE_APP_USER_SESSION: trim(process.env.DOCTYPE_MOBILE_APP_USER_SESSION || "Mobile App User Session"),
  MOBILE_APP_USER_PROFILE: trim(process.env.DOCTYPE_MOBILE_APP_USER_PROFILE || "Mobile App User Profile"),
  MOBILE_APP_DISEASE: trim(process.env.DOCTYPE_MOBILE_APP_DISEASE || "Mobile App Disease"),
  MOBILE_APP_USER_DISEASE_SELECTION:
    trim(process.env.DOCTYPE_MOBILE_APP_USER_DISEASE_SELECTION || "Mobile App User Disease Selection"),
  MOBILE_APP_HEALTH_ENTRY: trim(process.env.DOCTYPE_MOBILE_APP_HEALTH_ENTRY || "Mobile App Health Entry"),
  MOBILE_APP_PRESCRIPTION: trim(process.env.DOCTYPE_MOBILE_APP_PRESCRIPTION || "Mobile App Prescription"),
  MOBILE_APP_DOCTOR: trim(process.env.DOCTYPE_MOBILE_APP_DOCTOR || "Mobile App Doctor"),
  MOBILE_APP_NOTIFICATION: trim(process.env.DOCTYPE_MOBILE_APP_NOTIFICATION || "Mobile App Notification"),
  MOBILE_APP_SUPPORT_TICKET: trim(process.env.DOCTYPE_MOBILE_APP_SUPPORT_TICKET || "App Support Ticket"),
  MOBILE_APP_WEBHOOK_EVENT: trim(process.env.DOCTYPE_MOBILE_APP_WEBHOOK_EVENT || "Mobile App Webhook Event"),
};

/**
 * Outbound Frappe headers:
 * - **Authorization** — Desk API user (**ERP_TOKEN**)
 * - **X-ERP-Token** — optional; required by **mobile_app** `require_app_token()` when calling **`/api/method/mobile_app.api.v1.*`**
 */
function erpAuthHeader() {
  const headers = {};
  if (ERP_TOKEN) {
    if (ERP_AUTH_SCHEME === "bearer") {
      headers.Authorization = `Bearer ${ERP_TOKEN}`;
    } else {
      headers.Authorization = `token ${ERP_TOKEN}`;
    }
  }
  if (MOBILE_APP_ERP_TOKEN) {
    headers["X-ERP-Token"] = MOBILE_APP_ERP_TOKEN;
  }
  return headers;
}

module.exports = {
  ERP_BASE_URL,
  ERP_TOKEN,
  ERP_API_KEY,
  ERP_API_SECRET,
  ERP_BEARER_TOKEN,
  ERP_AUTH_SCHEME,
  APP_ERP_TOKEN,
  MOBILE_APP_ERP_TOKEN,
  PORT,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  APP_NOTIFICATION_TOKEN,
  FCM_SERVER_KEY,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_SERVICE_ACCOUNT_JSON,
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  OPENAI_API_KEY,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS,
  OPENAI_MAX_RETRIES,
  SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS,
  SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED,
  REPORTS_OCR_TOKEN,
  REPORTS_OCR_FALLBACK_WEBHOOK_URL,
  REPORTS_OCR_FALLBACK_TIMEOUT_MS,
  S3_PRESCRIPTION_PREFIX,
  S3_PROFILE_PREFIX,
  S3_PUBLIC_BASE_URL,
  DOCTYPE,
  erpAuthHeader,
};
