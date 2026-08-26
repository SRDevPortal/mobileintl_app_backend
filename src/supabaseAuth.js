const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = require("./config");

/**
 * Validates a Supabase session JWT via GET /auth/v1/user (same as your n8n HTTP Request).
 * @returns {Promise<object|null>} Supabase user JSON or null if invalid
 */
async function fetchSupabaseUser(accessToken) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const token = (accessToken || "").toString().trim();
  if (!token) return null;

  const base = SUPABASE_URL.replace(/\/auth\/v1\/user\/?$/, "").replace(/\/+$/, "");
  const url = `${base}/auth/v1/user`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) return null;
  return res.json();
}

async function deleteSupabaseUser(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw Object.assign(new Error("Supabase account deletion is not configured"), { status: 503 });
  }
  const base = SUPABASE_URL.replace(/\/auth\/v1\/user\/?$/, "").replace(/\/+$/, "");
  const headers = { apikey: SUPABASE_SERVICE_ROLE_KEY };
  // New sb_secret_* keys are opaque API keys, not JWTs. Legacy service_role
  // keys remain JWTs and still require the Authorization header.
  if (!SUPABASE_SERVICE_ROLE_KEY.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`;
  }
  const res = await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
    headers,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw Object.assign(new Error(`Supabase account deletion failed: ${text || res.status}`), {
      status: 502,
    });
  }
}

module.exports = { fetchSupabaseUser, deleteSupabaseUser };
