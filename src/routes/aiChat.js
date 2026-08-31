const express = require("express");
const multer = require("multer");
const { erpCallMethod, erpUploadFile } = require("../frappeClient");
const { uploadFileToS3 } = require("../services/s3PrescriptionUpload");

const router = express.Router();
const METHOD_ROOT = "wa_chat_hub.api.mobile_app";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});
const ALLOWED_CONTENT_TYPES = new Set(["Image", "Video", "Audio", "Document"]);

function authenticatedExternalId(req) {
  return String(req.authUser?.id || "").trim();
}

function unwrapMethodResponse(payload) {
  const message = payload?.message;
  if (message && typeof message === "object") return message;
  return payload;
}

function sendMethodResult(res, payload) {
  const result = unwrapMethodResponse(payload);
  if (result?.success === true) return res.json(result);
  const error = new Error(result?.message || "ERP AI chat returned an invalid response");
  error.status = 502;
  throw error;
}

function errorResponse(res, error) {
  const status = error.status >= 400 && error.status < 600 ? error.status : 502;
  return res.status(status).json({
    success: false,
    message: error.message || "AI chat is unavailable",
  });
}

router.post("/session", async (req, res) => {
  try {
    const externalId = authenticatedExternalId(req);
    if (!externalId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated user is required",
      });
    }
    const payload = await erpCallMethod(`${METHOD_ROOT}.open_session`, {
      method: "POST",
      appToken: true,
      body: {
        external_id: externalId,
        profile_id: req.body?.profile_id,
      },
    });
    return sendMethodResult(res, payload);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get("/messages", async (req, res) => {
  try {
    const externalId = authenticatedExternalId(req);
    if (!externalId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated user is required",
      });
    }
    const payload = await erpCallMethod(`${METHOD_ROOT}.get_messages`, {
      method: "GET",
      appToken: true,
      query: {
        external_id: externalId,
        conversation: req.query?.conversation,
        profile_id: req.query?.profile_id,
        after: req.query?.after,
        limit: req.query?.limit,
      },
    });
    return sendMethodResult(res, payload);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/messages", async (req, res) => {
  try {
    const externalId = authenticatedExternalId(req);
    if (!externalId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated user is required",
      });
    }
    const payload = await erpCallMethod(`${METHOD_ROOT}.send_message`, {
      method: "POST",
      appToken: true,
      body: {
        external_id: externalId,
        conversation: req.body?.conversation,
        profile_id: req.body?.profile_id,
        message: req.body?.message,
        client_message_id: req.body?.client_message_id,
      },
    });
    return sendMethodResult(res, payload);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/attachments", upload.single("file"), async (req, res) => {
  try {
    const externalId = authenticatedExternalId(req);
    if (!externalId) {
      return res.status(401).json({ success: false, message: "Authenticated user is required" });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: "Choose a file to send" });
    }
    const contentType = String(req.body?.content_type || "Document").trim();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
      return res.status(400).json({ success: false, message: "Unsupported attachment type" });
    }
    const hasS3 = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"]
      .every((key) => Boolean(process.env[key]));
    const uploaded = hasS3
      ? await uploadFileToS3({
          file: req.file,
          userId: externalId,
          prefix: "ai-chat",
          defaultBaseName: "chat-attachment",
        })
      : await erpUploadFile({
          file: req.file,
          doctype: "Chat Conversation",
          docname: req.body?.conversation,
        });
    const payload = await erpCallMethod(`${METHOD_ROOT}.send_attachment`, {
      method: "POST",
      appToken: true,
      body: {
        external_id: externalId,
        conversation: req.body?.conversation,
        profile_id: req.body?.profile_id,
        content_type: contentType,
        media_url: uploaded.url,
        file_name: req.file.originalname,
        caption: req.body?.caption,
        client_message_id: req.body?.client_message_id,
      },
    });
    return sendMethodResult(res, payload);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post("/escalate", async (req, res) => {
  try {
    const externalId = authenticatedExternalId(req);
    if (!externalId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated user is required",
      });
    }
    const payload = await erpCallMethod(`${METHOD_ROOT}.escalate`, {
      method: "POST",
      appToken: true,
      body: {
        external_id: externalId,
        conversation: req.body?.conversation,
        profile_id: req.body?.profile_id,
      },
    });
    return sendMethodResult(res, payload);
  } catch (error) {
    return errorResponse(res, error);
  }
});

module.exports = router;
