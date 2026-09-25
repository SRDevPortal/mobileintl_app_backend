const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { aiChatErrorResponse } = require("../src/services/aiChatErrors");

let calls = [];
let uploads = [];
let upstream;
const clientPath = require.resolve("../src/frappeClient");
const uploadPath = require.resolve("../src/services/s3PrescriptionUpload");
require.cache[clientPath] = { exports: {
  erpCallMethod: async (method, options) => {
    calls.push({ method, options });
    return upstream(method, options);
  },
  erpUploadFile: async (options) => {
    uploads.push({ provider: "frappe", options });
    return { url: "https://files.example.test/file.jpg" };
  },
} };
require.cache[uploadPath] = { exports: {
  uploadFileToS3: async (options) => {
    uploads.push({ provider: "s3", options });
    return { url: "https://files.example.test/file.jpg" };
  },
} };
const router = require("../src/routes/aiChat");
let server;
let baseUrl;
const s3Keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "S3_BUCKET"];
const previousEnv = Object.fromEntries(s3Keys.map((key) => [key, process.env[key]]));

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!req.headers["x-test-no-user"]) req.authUser = { id: "authenticated-user" };
    next();
  });
  app.use("/ai-chat", router);
  server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/ai-chat`;
});
after(async () => {
  for (const key of s3Keys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  calls = [];
  uploads = [];
  for (const key of s3Keys) delete process.env[key];
  upstream = async () => ({ message: { success: true, data: { conversation_id: "CHAT-1", messages: [] } } });
});

async function jsonRequest(path, body, headers = {}) {
  const response = await fetch(baseUrl + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
function attachment(size = 3) {
  const form = new FormData();
  form.append("conversation", "CHAT-1");
  form.append("profile_id", "PROFILE-2");
  form.append("client_message_id", "ID-1");
  form.append("content_type", "Image");
  form.append("file", new Blob([Buffer.alloc(size)], { type: "image/jpeg" }), "image.jpg");
  return form;
}
function permissionError() {
  return Object.assign(new Error('["Traceback (most recent call last): /apps/private.py secret-value\\nfrappe.exceptions.PermissionError: Conversation was not found."]'), {
    status: 403, payload: { exc_type: "PermissionError" },
  });
}

test("session uses authenticated identity and selected profile, ignoring spoofed external ID", async () => {
  const result = await jsonRequest("/session", { external_id: "other-user", profile_id: "PROFILE-2" });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.conversation_id, "CHAT-1");
  assert.equal(calls[0].method, "wa_chat_hub.api.mobile_app.open_session");
  assert.deepEqual(calls[0].options.body, { external_id: "authenticated-user", profile_id: "PROFILE-2" });
  assert.equal(calls[0].options.appToken, true);
});
test("no authenticated user means no Frappe request", async () => {
  const result = await jsonRequest("/session", { external_id: "other-user" }, { "x-test-no-user": "1" });
  assert.equal(result.status, 401);
  assert.equal(calls.length, 0);
});
test("screenshot permission traceback becomes readable and contains no internal text", async () => {
  upstream = async () => { throw permissionError(); };
  const result = await jsonRequest("/session", {});
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "CHAT_ACCESS_DENIED");
  assert.doesNotMatch(JSON.stringify(result.body), /Traceback|private.py|secret-value|frappe.exceptions/);
});
test("nested Frappe messages report missing country code without guessing a country", () => {
  const result = aiChatErrorResponse({ status: 417, payload: {
    _server_messages: JSON.stringify([JSON.stringify({ message: "Add a verified mobile number including its country code before using AI chat." })]),
  } });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, "CHAT_PHONE_REQUIRED");
  assert.doesNotMatch(result.body.message, /\+91|\+1/);
});
test("profile selection errors remain actionable", () => {
  for (const message of ["The selected profile does not belong to this user.", "Select a patient profile before starting AI chat."]) {
    assert.equal(aiChatErrorResponse({ message }).body.code, "CHAT_PROFILE_REQUIRED");
  }
});
test("upstream authentication failure does not imply the app user needs to log in", () => {
  const result = aiChatErrorResponse({ status: 401, message: "Invalid backend token." });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "CHAT_UNAVAILABLE");
});
test("unknown server errors never forward arbitrary strings or HTML", () => {
  for (const message of ["token=secret-value", "<html>Internal gateway configuration</html>", "Traceback: /private/path"]) {
    const result = aiChatErrorResponse({ status: 500, message });
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(result.body), /secret-value|<html>|private\/path/);
  }
});
test("rate limits preserve retryable status", () => {
  assert.equal(aiChatErrorResponse({ status: 429 }).status, 429);
});
test("input errors use fixed messages instead of raw ERP errors", () => {
  for (const [message, code] of [
    ["Message is required.", "CHAT_MESSAGE_REQUIRED"],
    ["Message cannot exceed 4000 characters.", "CHAT_MESSAGE_TOO_LONG"],
    ["Client message ID is required.", "CHAT_MESSAGE_ID_REQUIRED"],
  ]) {
    const result = aiChatErrorResponse({ message, status: 417 });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, code);
  }
});
test("invalid success envelope is rejected", async () => {
  upstream = async () => ({ message: { success: true } });
  const result = await jsonRequest("/session", {});
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "CHAT_UNAVAILABLE");
});
test("text sends and care-team escalation preserve conversation and profile", async () => {
  for (const path of ["/messages", "/escalate"]) {
    const result = await jsonRequest(path, { conversation: "CHAT-1", profile_id: "PROFILE-2", message: "Hello", client_message_id: "ID-1" });
    assert.equal(result.status, 200);
    const forwarded = calls.at(-1).options.body;
    assert.equal(forwarded.external_id, "authenticated-user");
    assert.equal(forwarded.conversation, "CHAT-1");
    assert.equal(forwarded.profile_id, "PROFILE-2");
  }
});
test("polling preserves selected conversation, profile and cursor", async () => {
  const response = await fetch(baseUrl + "/messages?conversation=CHAT-1&profile_id=PROFILE-2&after=MSG-1&limit=10");
  assert.equal(response.status, 200);
  assert.equal(calls[0].options.query.external_id, "authenticated-user");
  assert.equal(calls[0].options.query.profile_id, "PROFILE-2");
  assert.equal(calls[0].options.query.after, "MSG-1");
});
test("denied attachments never upload to Frappe or S3", async () => {
  upstream = async () => { throw permissionError(); };
  for (const provider of ["frappe", "s3"]) {
    if (provider === "s3") for (const key of s3Keys) process.env[key] = "test-only";
    const response = await fetch(baseUrl + "/attachments", { method: "POST", body: attachment() });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "CHAT_ACCESS_DENIED");
    assert.equal(uploads.length, 0);
  }
});
test("unexpected authorization response does not upload a file", async () => {
  upstream = async () => ({ message: { success: true, data: { conversation_id: "OTHER" } } });
  const response = await fetch(baseUrl + "/attachments", { method: "POST", body: attachment() });
  assert.equal(response.status, 502);
  assert.equal(uploads.length, 0);
});
test("authorized attachment is checked before upload and sent to the same chat", async () => {
  for (const provider of ["frappe", "s3"]) {
    if (provider === "s3") for (const key of s3Keys) process.env[key] = "test-only";
    calls = [];
    upstream = async (method) => {
      if (method.endsWith("get_messages")) assert.equal(calls.length, 1);
      else assert.equal(uploads.at(-1).provider, provider);
      return { message: { success: true, data: { conversation_id: "CHAT-1" } } };
    };
    const response = await fetch(baseUrl + "/attachments", { method: "POST", body: attachment() });
    assert.equal(response.status, 200);
    assert.equal(calls[0].options.query.profile_id, "PROFILE-2");
    assert.equal(calls[1].options.body.conversation, "CHAT-1");
    assert.equal(calls[1].options.body.profile_id, "PROFILE-2");
    assert.equal(calls[1].options.body.external_id, "authenticated-user");
  }
});
test("oversized attachments produce a readable 413 response", async () => {
  const response = await fetch(baseUrl + "/attachments", { method: "POST", body: attachment(25 * 1024 * 1024 + 1) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "ATTACHMENT_TOO_LARGE");
  assert.equal(calls.length, 0);
  assert.equal(uploads.length, 0);
});
test("profile sync keeps patient links and explicit country prefixes", () => {
  const { buildProfilesPayloadForFullSync } = require("../src/normalize");
  for (const phone of ["+14155550123", "+919876543210", "00447700900123"]) {
    const [profile] = buildProfilesPayloadForFullSync({ profiles: [{ profile_name: "Family", patient_id: "PATIENT-2", phone }] });
    assert.equal(profile.phone, phone);
    assert.equal(profile.patient_id, "PATIENT-2");
  }
});
