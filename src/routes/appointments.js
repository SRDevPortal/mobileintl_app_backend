const express = require("express");
const crypto = require("crypto");
const { DOCTYPE } = require("../config");
const { erpCreate, erpDelete, erpGetDoc, erpGetList, erpUpdate } = require("../frappeClient");
const { findMobileAppUser, tryUsersLookupV1, unwrapMobileAppV1Message } = require("../services/userService");
const { mapAppointmentChildRowForFullSync, pickExternalId, pickPhone } = require("../normalize");

const router = express.Router();

function stripRootUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

async function saveAppointmentsViaResourceApi(userName, next) {
  if (!userName) {
    const err = new Error("Mobile App User not found for appointment sync fallback");
    err.status = 404;
    throw err;
  }
  const saved = await erpUpdate(DOCTYPE.MOBILE_APP_USER, userName, {
    appointments: next,
  });
  return saved || { name: userName, appointments: next };
}

async function replaceStandaloneAppointment(name, doc) {
  try {
    await erpDelete(DOCTYPE.MOBILE_APP_APPOINTMENT, name);
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return erpCreate(DOCTYPE.MOBILE_APP_APPOINTMENT, doc);
}

async function updateStandaloneAppointment(name, doc) {
  try {
    return await erpUpdate(DOCTYPE.MOBILE_APP_APPOINTMENT, name, doc);
  } catch (e) {
    if (e.status === 404) return replaceStandaloneAppointment(name, doc);
    throw e;
  }
}

async function upsertStandaloneAppointment(body, userName, newRow) {
  const appointmentExternalId = newRow.appointment_external_id || crypto.randomUUID();
  const doc = stripRootUndefined({
    ...newRow,
    external_id: appointmentExternalId,
    appointment_external_id: appointmentExternalId,
    user_id: userName || newRow.user_id,
    booking_id: newRow.booking_id || body.booking_id,
    patient_name: newRow.patient_name || body.patient_name,
    mobile_number: newRow.mobile_number || pickPhone(body) || body.patient_phone,
    patient_phone: newRow.mobile_number || pickPhone(body) || body.patient_phone,
    email: newRow.email || body.email || body.patient_email,
    patient_email: newRow.email || body.email || body.patient_email,
    consultation_type: newRow.consultation_type || body.consultation_type || body.appointment_type,
    appointment_type: newRow.consultation_type || body.consultation_type || body.appointment_type,
    appointment_for: newRow.appointment_for || body.appointment_for,
    page_url_disease: newRow.page_url_disease || body.page_url,
    page_url: newRow.page_url_disease || body.page_url,
    status: newRow.status || body.status || "pending",
  });

  const bookingId = body.booking_id != null ? String(body.booking_id).trim() : "";
  if (bookingId) {
    const byBookingId = await erpGetList(DOCTYPE.MOBILE_APP_APPOINTMENT, {
      filters: [["booking_id", "=", bookingId]],
      fields: ["name"],
      limit: 1,
    });
    if (byBookingId[0]?.name) {
      return updateStandaloneAppointment(byBookingId[0].name, doc);
    }
  }

  try {
    return await updateStandaloneAppointment(appointmentExternalId, doc);
  } catch (e) {
    if (e.status !== 404) throw e;
  }

  try {
    const byExternalId = await erpGetList(DOCTYPE.MOBILE_APP_APPOINTMENT, {
      filters: [["external_id", "=", appointmentExternalId]],
      fields: ["name"],
      limit: 1,
    });
    if (byExternalId[0]?.name) {
      return updateStandaloneAppointment(byExternalId[0].name, doc);
    }
  } catch (e) {
    if (!String(e.message || "").includes("Field not permitted in query: external_id")) {
      throw e;
    }
  }

  try {
    return await erpCreate(DOCTYPE.MOBILE_APP_APPOINTMENT, doc);
  } catch (e) {
    const duplicate = e.status === 409 || String(e.message || "").includes("DuplicateEntryError");
    if (!duplicate) throw e;
    return replaceStandaloneAppointment(appointmentExternalId, doc);
  }
}

async function readAllMobileAppUsers() {
  const users = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const page = await erpGetList(DOCTYPE.MOBILE_APP_USER, {
      fields: ["name", "external_id"],
      limit,
      offset,
      orderBy: "modified asc",
    });
    users.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return users;
}

async function backfillStandaloneAppointments({ userName } = {}) {
  const users = userName
    ? [{ name: userName }]
    : await readAllMobileAppUsers();
  const result = {
    users_scanned: users.length,
    appointment_rows_found: 0,
    standalone_upserted: 0,
    skipped: 0,
    errors: [],
  };

  for (const user of users) {
    try {
      const doc = await erpGetDoc(DOCTYPE.MOBILE_APP_USER, user.name);
      const rows = Array.isArray(doc?.appointments) ? doc.appointments : [];
      result.appointment_rows_found += rows.length;

      for (const row of rows) {
        try {
          const appointmentExternalId =
            row.appointment_external_id != null && String(row.appointment_external_id).trim() !== ""
              ? String(row.appointment_external_id).trim()
              : row.booking_id != null && String(row.booking_id).trim() !== ""
                ? `appt_${String(row.booking_id).trim()}`
                : "";
          if (!appointmentExternalId) {
            result.skipped += 1;
            continue;
          }

          await upsertStandaloneAppointment(
            {
              ...row,
              external_id: appointmentExternalId,
              patient_email: row.email,
              patient_phone: row.mobile_number,
              appointment_type: row.consultation_type,
              page_url: row.page_url_disease,
            },
            doc.name,
            { ...row, appointment_external_id: appointmentExternalId },
          );
          result.standalone_upserted += 1;
        } catch (rowError) {
          result.errors.push({
            user: doc.name,
            booking_id: row.booking_id,
            appointment_external_id: row.appointment_external_id,
            message: rowError.message,
            frappePath: rowError.frappePath,
          });
        }
      }
    } catch (userError) {
      result.errors.push({
        user: user.name,
        message: userError.message,
        frappePath: userError.frappePath,
      });
    }
  }

  return result;
}

router.post("/backfill", async (req, res) => {
  try {
    const body = req.body || {};
    const userName =
      body.user_name != null && String(body.user_name).trim() !== ""
        ? String(body.user_name).trim()
        : body.mobile_app_user != null && String(body.mobile_app_user).trim() !== ""
          ? String(body.mobile_app_user).trim()
          : undefined;
    const result = await backfillStandaloneAppointments({ userName });
    return res.json({ success: true, data: result });
  } catch (e) {
    return res.status(e.status || 500).json({
      success: false,
      message: e.message,
      frappePath: e.frappePath,
      detail: e.payload,
    });
  }
});

/**
 * Create or update one appointment row on **Mobile App User** → **`appointments`** child table
 * and mirror it to standalone **Mobile App Appointment** for list/report views.
 */
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const userRow = await findMobileAppUser(body, {}, {});
    const parentExternalId = pickExternalId(body) || (userRow?.external_id != null ? String(userRow.external_id).trim() : "");
    if (!parentExternalId) {
      return res.status(400).json({
        success: false,
        message: "external_id (or customer_id / id) or a resolvable Mobile App User is required",
      });
    }

    const rowBody = { ...body };
    const newRow = mapAppointmentChildRowForFullSync(rowBody, parentExternalId);
    if (!newRow?.appointment_external_id) {
      return res.status(400).json({ success: false, message: "appointment_external_id could not be set" });
    }

    let existing = [];
    const v1 = await tryUsersLookupV1(body);
    if (Array.isArray(v1?.appointments) && v1.appointments.length) {
      existing = v1.appointments.map((r) => ({ ...r }));
    } else if (userRow?.name) {
      try {
        const doc = await erpGetDoc(DOCTYPE.MOBILE_APP_USER, userRow.name);
        if (doc && Array.isArray(doc.appointments)) existing = doc.appointments.map((r) => ({ ...r }));
      } catch (_) {
        /* keep existing [] */
      }
    }

    const bid = body.booking_id != null ? String(body.booking_id).trim() : "";
    const extId = newRow.appointment_external_id;
    let next = existing.filter((r) => {
      const rBid = r.booking_id != null ? String(r.booking_id).trim() : "";
      const rExt = r.appointment_external_id != null ? String(r.appointment_external_id).trim() : "";
      if (bid && rBid === bid) return false;
      if (extId && rExt === extId) return false;
      return true;
    });
    next.push(newRow);

    let parsed;
    let savedViaResourceApi = false;
    let standaloneAppointment = null;
    try {
      parsed = await erpCallMethod("mobileintl_app.api.v1.users_full_sync", {
        method: "POST",
        appToken: true,
        body: stripRootUndefined({
          external_id: parentExternalId,
          supabase_user_id:
            body.supabase_user_id != null ? String(body.supabase_user_id).trim() : undefined,
          email: body.email != null ? String(body.email).trim() : undefined,
          phone: pickPhone(body) || undefined,
          appointments: next,
        }),
      });
    } catch (e) {
      try {
        parsed = {
          message: {
            success: true,
            data: await saveAppointmentsViaResourceApi(userRow?.name || parentExternalId, next),
          },
        };
        savedViaResourceApi = true;
      } catch (fallbackError) {
        const status = fallbackError.status >= 400 && fallbackError.status < 600 ? fallbackError.status : 502;
        return res.status(status).json({
          success: false,
          message: fallbackError.message || e.message || "appointment Resource API fallback failed",
          frappePath: fallbackError.frappePath || e.frappePath,
          detail: fallbackError.payload || e.payload,
        });
      }
    }

    try {
      standaloneAppointment = await upsertStandaloneAppointment(body, userRow?.name || parentExternalId, newRow);
    } catch (standaloneError) {
      const status = standaloneError.status >= 400 && standaloneError.status < 600 ? standaloneError.status : 502;
      return res.status(status).json({
        success: false,
        message: standaloneError.message || "standalone appointment sync failed",
        frappePath: standaloneError.frappePath,
        detail: standaloneError.payload,
      });
    }

    const data = unwrapMobileAppV1Message(parsed);
    if (data && typeof data === "object") {
      return res.status(201).json({
        success: true,
        data: {
          ...data,
          saved_via_resource_api: savedViaResourceApi,
          standalone_appointment: standaloneAppointment,
        },
      });
    }

    if (!savedViaResourceApi) {
      try {
        const saved = await saveAppointmentsViaResourceApi(userRow?.name || parentExternalId, next);
        return res.status(201).json({
          success: true,
          data: {
            ...saved,
            saved_via_resource_api: true,
            standalone_appointment: standaloneAppointment,
          },
        });
      } catch (fallbackError) {
        const status = fallbackError.status >= 400 && fallbackError.status < 600 ? fallbackError.status : 502;
        return res.status(status).json({
          success: false,
          message:
            fallbackError.message ||
            "Frappe returned 200 but users_full_sync payload could not be parsed; appointment fallback failed.",
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
