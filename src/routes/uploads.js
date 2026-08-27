const express = require("express");
const multer = require("multer");
const path = require("path");
const { erpCallMethod, erpGetDoc, erpUpdate } = require("../frappeClient");
const { DOCTYPE } = require("../config");
const { findMobileAppUser, tryUsersLookupV1, unwrapMobileAppV1Message } = require("../services/userService");
const {
  collectLogsFromExistingRows,
  mergeHealthEntriesForToolSync,
  mergeLogsPreferIncoming,
} = require("../services/healthEntryRows");
const { uploadPrescriptionToS3 } = require("../services/s3PrescriptionUpload");

const router = express.Router();

function friendlyErpWarning(message) {
  const raw = (message || "").toString().trim();
  if (!raw) return "Prescription uploaded, but ERP save failed.";
  if (raw.includes("Source cannot be") || raw.includes("ValidationError")) {
    return "Prescription uploaded, but ERP rejected the health entry source.";
  }
  if (raw.includes("Traceback") || raw.length > 220) {
    return "Prescription uploaded, but ERP save failed.";
  }
  return raw;
}

const prescriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMime = /^(image\/(jpeg|jpg|pjpeg|png|gif|webp|heic|heif)|application\/pdf)$/i;
    if (allowedMime.test(file.mimetype || "")) return cb(null, true);
    const ext = (path.extname(file.originalname || "") || "").toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".pdf"].includes(ext)) {
      return cb(null, true);
    }
    return cb(new Error("Only images or PDF files are allowed."), false);
  },
});

router.post("/prescription", prescriptionUpload.single("file"), async (req, res) => {
  try {
    const rawUserId =
      req.authUser?.id || req.query?.userId || req.query?.user_id || req.body?.userId || req.body?.user_id;
    const uploaded = await uploadPrescriptionToS3({ file: req.file, userId: rawUserId });
    let erpSaved = null;
    let erpWarning = null;
    try {
      const userId = rawUserId != null ? String(rawUserId).trim() : "";
      const userRow = userId
        ? await findMobileAppUser(
          { external_id: userId, supabase_user_id: userId, customer_id: userId },
          {},
          {},
        )
        : null;
      const parentExternalId = userRow?.external_id || userId;
      if (!parentExternalId) throw new Error("Unable to resolve Mobile App User for prescription sync.");

      let existing = [];
      const lookup = await tryUsersLookupV1({ external_id: parentExternalId, supabase_user_id: parentExternalId });
      if (Array.isArray(lookup?.health_entries)) {
        existing = lookup.health_entries.map((r) => ({ ...r }));
      } else if (userRow?.name) {
        const userDoc = await erpGetDoc(DOCTYPE.MOBILE_APP_USER, userRow.name);
        if (Array.isArray(userDoc?.health_entries)) existing = userDoc.health_entries.map((r) => ({ ...r }));
      }

      const nowIso = new Date().toISOString();
      const fileName = req.file?.originalname || path.basename(uploaded.key);
      const fileType = req.file?.mimetype || path.extname(fileName).replace(/^\./, "");
      const isPdf = fileType === "application/pdf" || /\.pdf$/i.test(fileName);
      const entry = {
        id: req.body?.entry_id || req.body?.id || Date.now(),
        logged_at: req.body?.logged_at || nowIso,
        valDisplay: fileName,
        date: req.body?.date,
        upload_date: req.body?.upload_date || req.body?.date,
        upload_time: req.body?.upload_time,
        type: req.body?.type || (isPdf ? "PDF" : "Image"),
        file_kind: isPdf ? "pdf" : "image",
        time: req.body?.time || req.body?.upload_time,
        doctor_name: req.body?.doctor_name,
        clinic_name: req.body?.clinic_name,
        doctor: req.body?.doctor || req.body?.doctor_name,
        clinic: req.body?.clinic || req.body?.clinic_name,
        file_url: uploaded.url,
        file_name: fileName,
        file_type: fileType,
        file_size: req.file?.size,
      };
      const prescriptionLogs = mergeLogsPreferIncoming(
        collectLogsFromExistingRows(existing, "prescriptions_data"),
        [entry],
      );
      const body = {
        external_id: parentExternalId,
        supabase_user_id: parentExternalId,
        tool_key: "prescriptions_data",
        entry_id: `local_${Date.now()}_prescriptions_data`,
        entry_timestamp: nowIso,
        data_json: prescriptionLogs,
        source: "app",
      };
      const next = mergeHealthEntriesForToolSync(existing, body, parentExternalId);
      try {
        const parsed = await erpCallMethod("mobileintl_app.api.v1.users_full_sync", {
          method: "POST",
          appToken: true,
          body: {
            external_id: parentExternalId,
            supabase_user_id: parentExternalId,
            health_entries: next,
          },
        });
        erpSaved = unwrapMobileAppV1Message(parsed) || parsed;
      } catch (e) {
        if (!userRow?.name) throw e;
        console.warn("[uploads/prescription] users_full_sync failed, trying Resource API health_entries update:", e.message);
        erpSaved = await erpUpdate(DOCTYPE.MOBILE_APP_USER, userRow.name, {
          health_entries: next,
        });
      }
    } catch (e) {
      erpWarning = friendlyErpWarning(e.message || "Prescription uploaded to S3, but ERP save failed.");
      console.warn("[uploads/prescription] ERP prescription health-entry sync failed:", erpWarning);
    }
    return res.status(201).json({
      success: true,
      url: uploaded.url,
      key: uploaded.key,
      erp_persisted: Boolean(erpSaved),
      ...(erpSaved ? { erp_data: erpSaved } : {}),
      ...(erpWarning ? { erp_warning: erpWarning } : {}),
    });
  } catch (err) {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, error: "File too large. Max 5 MB." });
    }
    if (err.message && err.message.includes("Only images or PDF")) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return res.status(500).json({ success: false, error: err.message || "Upload failed" });
  }
});

module.exports = router;
