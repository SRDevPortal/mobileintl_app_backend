const express = require("express");
const { DOCTYPE } = require("../config");
const { erpCallMethod, erpUpdate } = require("../frappeClient");
const { findMobileAppUser, unwrapMobileAppV1Message } = require("../services/userService");
const {
  pickExternalId,
  pickPhone,
  buildProfilesPayloadForFullSync,
} = require("../normalize");

const router = express.Router();

function stripRootUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function saveProfilesViaResourceApi(body, profiles) {
  const userRow = await findMobileAppUser(body, {}, {});
  const userName = userRow?.name || pickExternalId(body);
  if (!userName) {
    const err = new Error("Mobile App User not found for profile sync fallback");
    err.status = 404;
    throw err;
  }

  const rootUpdate = stripRootUndefined({
    email: body.email != null ? String(body.email).trim() : undefined,
    phone: pickPhone(body) || undefined,
    full_name:
      body.full_name != null
        ? String(body.full_name).trim()
        : body.name != null
          ? String(body.name).trim()
          : undefined,
    profiles,
  });

  const saved = await erpUpdate(DOCTYPE.MOBILE_APP_USER, userName, rootUpdate);
  return saved || { name: userName, profiles };
}

/**
 * Upserts profile row(s) via Frappe **`mobile_app.api.v1.users_full_sync`** (`profiles` child table).
 *
 * There is **no** fallback to `/api/resource/Mobile App User Profile`: on many benches profile rows
 * exist only as child items under **Mobile App User**, so that Resource route returns **404**.
 *
 * Body: `{ "external_id": "...", "profiles": [ { profile_name, phone, ... } ] }`
 * or legacy flat fields on the root object (wrapped into one profile row).
 */
router.post("/sync", async (req, res) => {
  try {
    const body = req.body || {};
    const external_id = pickExternalId(body);
    if (!external_id) {
      return res.status(400).json({
        success: false,
        message: "external_id (or customer_id / id) is required",
      });
    }

    const profiles = buildProfilesPayloadForFullSync(body);

    let parsed;
    let savedViaResourceApi = false;
    try {
      parsed = await erpCallMethod("mobileintl_app.api.v1.users_full_sync", {
        method: "POST",
        appToken: true,
        body: stripRootUndefined({
          external_id,
          supabase_user_id:
            body.supabase_user_id != null ? String(body.supabase_user_id).trim() : undefined,
          email: body.email != null ? String(body.email).trim() : undefined,
          phone: pickPhone(body) || undefined,
          profiles,
        }),
      });
    } catch (e) {
      try {
        parsed = {
          message: {
            success: true,
            data: await saveProfilesViaResourceApi(body, profiles),
          },
        };
        savedViaResourceApi = true;
      } catch (fallbackError) {
        const status = fallbackError.status >= 400 && fallbackError.status < 600 ? fallbackError.status : 502;
        return res.status(status).json({
          success: false,
          message: fallbackError.message || e.message || "profile Resource API fallback failed",
          frappePath: fallbackError.frappePath || e.frappePath,
          detail: fallbackError.payload || e.payload,
        });
      }
    }

    const data = unwrapMobileAppV1Message(parsed);
    if (data && typeof data === "object") {
      return res.json({ success: true, data: { ...data, saved_via_resource_api: savedViaResourceApi } });
    }

    if (!savedViaResourceApi) {
      try {
        const saved = await saveProfilesViaResourceApi(body, profiles);
        return res.json({ success: true, data: { ...saved, saved_via_resource_api: true } });
      } catch (fallbackError) {
        const status = fallbackError.status >= 400 && fallbackError.status < 600 ? fallbackError.status : 502;
        return res.status(status).json({
          success: false,
          message:
            fallbackError.message ||
            "Frappe returned 200 but users_full_sync payload could not be parsed; profile fallback failed.",
          frappePath: fallbackError.frappePath,
          detail: fallbackError.payload,
          raw: parsed,
        });
      }
    }

    return res.status(502).json({
      success: false,
      message:
        "Frappe returned 200 but users_full_sync payload could not be parsed (expected message.success + message.data).",
      raw: parsed,
    });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

module.exports = router;
