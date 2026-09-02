const express = require("express");
const multer = require("multer");
const { APP_ERP_TOKEN, REPORTS_OCR_TOKEN } = require("../config");
const { extractReportWithFallbackWebhook, extractReportWithOpenAI, normalizeReportType } = require("../services/reportOcr");
const { uploadFileToS3 } = require("../services/s3PrescriptionUpload");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

function safeEqualText(a, b) {
  const left = (a || "").toString();
  const right = (b || "").toString();
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

function requireReportsToken(req, res, next) {
  if (req.authUser?.id) return next();
  const supplied = req.get("x-reports-ocr-token") || req.get("x-erp-token") || "";
  const expected = REPORTS_OCR_TOKEN || APP_ERP_TOKEN;
  if (!expected) return res.status(503).json({ success: false, message: "REPORTS_OCR_TOKEN is not configured" });
  if (!safeEqualText(supplied, expected)) return res.status(401).json({ success: false, message: "Unauthorized" });
  return next();
}

router.post("/extract", requireReportsToken, upload.single("file"), async (req, res) => {
  const reportType = normalizeReportType(req.body?.report_type);
  let fileUrl = (req.body?.file_url || "").toString().trim();
  let fileName = (req.body?.file_name || req.file?.originalname || "").toString().trim();

  try {
    if (!fileUrl) {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "file_url or multipart file is required",
          report_type: reportType,
          fields: [],
          issues: ["file_url or multipart file is required"],
          parameters: [],
        });
      }
      const userId =
        (req.authUser?.id || req.body?.customer_id || req.body?.user_id || req.body?.external_id || req.body?.customer_email || "guest")
          .toString()
          .trim();
      const uploaded = await uploadFileToS3({
        file: req.file,
        userId,
        prefix: "reports",
        defaultBaseName: "report",
      });
      fileUrl = uploaded.url;
      fileName = fileName || uploaded.key.split("/").pop();
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await extractReportWithOpenAI({
        reportType,
        fileUrl,
        fileName,
        fileBuffer: req.file?.buffer,
        mimeType: req.file?.mimetype,
      });
    } catch (primaryError) {
      console.error("Primary report OCR failed; trying configured fallback:", primaryError.message);
      result = await extractReportWithFallbackWebhook({
        reportType,
        fileUrl,
        fileName,
        customerId: req.authUser?.id || req.body?.customer_id,
        customerEmail: req.authUser?.email || req.body?.customer_email,
      });
      if (!result) throw primaryError;
    }
    res.set("X-Reports-OCR-Duration-Ms", String(Date.now() - startedAt));
    return res.json({ ...result, file_url: fileUrl, file_name: fileName });
  } catch (error) {
    const statusCode = error.statusCode || 502;
    console.error("Report extraction failed:", error);
    return res.status(statusCode).json({
      success: false,
      report_type: reportType,
      fields: [],
      lft_score: null,
      cbc_score: null,
      status: null,
      issues: [error.message || "Report extraction failed"],
      parameters: [],
      raw_text_summary: null,
      file_url: fileUrl || null,
      file_name: fileName || null,
      retryable: statusCode === 429 || statusCode >= 500,
    });
  }
});

module.exports = router;
