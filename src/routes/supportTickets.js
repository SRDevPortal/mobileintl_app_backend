const crypto = require("crypto");
const express = require("express");
const { erpCallMethod, erpCreate, erpGetDoc, erpGetList, erpUpdate } = require("../frappeClient");
const { DOCTYPE } = require("../config");
const { resolveUserMiddleware } = require("../services/userService");
const { mapSupportTicketToFrappe, nowFrappeDatetime, pickExternalId } = require("../normalize");
const { saveNotification } = require("../services/notificationStore");
const {
  listSupportNotificationTargets,
  readSupportNotificationStates,
  upsertSupportNotificationTarget,
  writeSupportNotificationStates,
} = require("../services/supportNotificationStore");
const { buildSupportTicketPush, sendSupportTicketPush } = require("../services/pushService");

const router = express.Router();

router.use((req, _res, next) => {
  const queryUserId = req.query?.user_id || req.query?.patient_id;
  const bodyUserId = req.body?.user_id || req.body?.patient_id;
  if (queryUserId && !req.query.external_id) req.query.external_id = queryUserId;
  if ((bodyUserId || queryUserId) && req.body && !req.body.external_id) req.body.external_id = bodyUserId || queryUserId;
  next();
});

function supportRouteNeedsUser(req) {
  if (req.path === "/" && (req.method === "GET" || req.method === "POST")) return true;
  if (req.method === "POST" && /\/messages$/.test(req.path || "")) {
    return Boolean(req.body?.user_id || req.body?.patient_id || req.body?.external_id || req.body?.customer_id);
  }
  return false;
}

function optionalSupportUserMiddleware(req, res, next) {
  if (supportRouteNeedsUser(req)) return resolveUserMiddleware(req, res, next);
  return next();
}

router.use(optionalSupportUserMiddleware);

const MESSAGE_TICKET_FIELD = (process.env.ERP_MESSAGE_TICKET_FIELD || "ticket").trim();
const MESSAGE_DOCTYPE = (process.env.ERP_MESSAGE_DOCTYPE || "App Support Ticket Message").trim();
const MESSAGE_DOCTYPE_CANDIDATES = [
  MESSAGE_DOCTYPE,
  "App Support Ticket Message",
  "Support Ticket Message",
  "Support Message",
  "App Support Message",
  "Ticket Message",
].filter((v, i, arr) => v && arr.indexOf(v) === i);
const MESSAGE_TICKET_FIELD_CANDIDATES = [
  MESSAGE_TICKET_FIELD,
  "ticket",
  "mobile_app_ticket",
  "support_ticket",
  "app_support_ticket",
  "ticket_id",
  "parent_ticket",
].filter((v, i, arr) => v && arr.indexOf(v) === i);
const SUPPORT_RESOURCE_DOCTYPES = [
  "App Support Ticket",
  process.env.ERP_TICKET_DOCTYPE,
  DOCTYPE.MOBILE_APP_SUPPORT_TICKET,
  "Support Ticket",
].filter((v, i, arr) => v && v !== "Mobile App Support Ticket" && arr.indexOf(v) === i);
const RESOURCE_FIELD_CACHE = new Map();
const RESOURCE_META_CACHE = new Map();
const MESSAGE_RESOURCE_CACHE = { values: new Map(), schemaChecked: false };
const SUPPORT_BASE_FIELDS = [
  "name",
  "ticket_number",
  "mobile_app_user",
  "customer_name",
  "requester_name",
  "user_name",
  "patient_name",
  "name_text",
  "email",
  "user_email",
  "email_id",
  "raised_by",
  "phone",
  "user_phone",
  "mobile_number",
  "subject",
  "title",
  "description",
  "message",
  "status",
  "priority",
  "category",
  "assigned_to",
  "assigned_to_name",
  "external_id",
  "user_id",
  "patient_id",
  "mobile_user_id",
  "customer_id",
  "supabase_user_id",
  "creation",
  "modified",
  "resolved_at",
  "closed_at",
  "metadata",
];
const MESSAGE_BASE_FIELDS = [
  "name",
  MESSAGE_TICKET_FIELD,
  ...MESSAGE_TICKET_FIELD_CANDIDATES,
  "ticket_number",
  "ticket",
  "ticket_id",
  "sender_type",
  "sender_id",
  "sender_name",
  "message",
  "attachment",
  "attachments",
  "timestamp",
  "is_read",
  "read_at",
  "creation",
  "modified",
];
const EMBEDDED_MESSAGE_FIELDS = [
  "messages",
  "conversation",
  "conversation_messages",
  "chat",
  "chat_messages",
  "replies",
  "comments",
  "support_messages",
  "ticket_messages",
  "communication",
  "communications",
];
const SUPPORT_LOOKUP_METHODS = [
  "mobileintl_app.api.v1.support_tickets_lookup",
  "mobileintl_app.api.v1.support_tickets_list",
  "mobileintl_app.api.v1.support_tickets_get",
  "mobileintl_app.api.v1.support_tickets_full_sync",
  "mobileintl_app.api.v1.support_ticket_lookup",
  "mobileintl_app.api.v1.support_ticket_list",
  "mobileintl_app.api.v1.support_ticket_get",
  "mobileintl_app.api.v1.support_tickets",
  "mobileintl_app.api.v1.support_ticket",
  "mobileintl_app.api.v1.tickets_lookup",
  "mobileintl_app.api.v1.tickets_list",
  "mobileintl_app.api.v1.user_tickets",
  "mobileintl_app.api.v1.get_user_tickets",
  "mobileintl_app.api.v1.get_support_tickets",
  "mobileintl_app.api.v1.support.lookup",
  "mobileintl_app.api.v1.support.list_tickets",
  "mobileintl_app.api.v1.support.get_tickets",
];
const SUPPORT_SYNC_METHODS = [
  "mobileintl_app.api.v1.support_tickets_sync",
  "mobileintl_app.api.v1.support_tickets_create",
  "mobileintl_app.api.v1.support_ticket_sync",
  "mobileintl_app.api.v1.support_ticket_create",
  "mobileintl_app.api.v1.create_support_ticket",
  "mobileintl_app.api.v1.support.create_ticket",
];

function toApiStatus(value) {
  const normalized = (value || "").toString().trim().toLowerCase().replace(/\s+/g, "_");
  return normalized || "open";
}

function toFrappeStatus(value) {
  const normalized = (value || "").toString().trim().toLowerCase();
  if (normalized === "in_progress") return "In Progress";
  if (normalized === "waiting_for_customer") return "Waiting for Customer";
  if (normalized === "resolved") return "Resolved";
  if (normalized === "closed") return "Closed";
  return "Open";
}

function toFrappePriority(value) {
  const normalized = (value || "").toString().trim().toLowerCase();
  if (normalized === "low") return "Low";
  if (normalized === "high") return "High";
  if (normalized === "urgent") return "Urgent";
  return "Medium";
}

function toIso(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

function safeJsonParse(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function mapTicket(doc = {}) {
  return {
    id: doc.name || doc.id || doc.ticket_number || doc.record_external_id,
    ticket_number: doc.ticket_number || doc.name || doc.id || doc.record_external_id,
    user_id: doc.external_id || doc.user_id || doc.patient_id || doc.mobile_user_id || doc.mobile_app_user || null,
    user_name: doc.requester_name || doc.user_name || doc.customer_name || doc.patient_name || doc.name_text || "",
    user_email: doc.email || doc.user_email || doc.email_id || doc.raised_by || "",
    user_phone: doc.phone || doc.user_phone || doc.mobile_number || "",
    subject: doc.subject || doc.title || doc.record_type || "Support Ticket",
    description: doc.description || doc.message || doc.notes || doc.details || "",
    status: toApiStatus(doc.status),
    priority: (doc.priority || "medium").toString().trim().toLowerCase(),
    category: doc.category || null,
    assigned_to: doc.assigned_to || null,
    assigned_to_name: doc.assigned_to_name || null,
    created_at: toIso(doc.created_at || doc.creation || doc.timestamp, new Date().toISOString()),
    updated_at: toIso(doc.updated_at || doc.modified || doc.timestamp, new Date().toISOString()),
    resolved_at: toIso(doc.resolved_at, null),
    closed_at: toIso(doc.closed_at, null),
    metadata: safeJsonParse(doc.metadata, null),
    unread_message_count: 0,
    agent_message_count: 0,
  };
}

function unwrapMethodData(parsed) {
  const msg = parsed?.message;
  if (msg && typeof msg === "object") {
    if (msg.success === false) return null;
    return msg.data ?? msg.tickets ?? msg.ticket ?? msg;
  }
  return parsed?.data ?? parsed?.tickets ?? parsed?.ticket ?? null;
}

function ticketRowsFromMethodData(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.tickets)) return data.tickets;
  if (Array.isArray(data?.support_tickets)) return data.support_tickets;
  if (Array.isArray(data?.supportTickets)) return data.supportTickets;
  if (Array.isArray(data?.support_ticket)) return data.support_ticket;
  if (Array.isArray(data?.supportTicket)) return data.supportTicket;
  if (Array.isArray(data?.ticket_list)) return data.ticket_list;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.engagement_items)) {
    return data.engagement_items.filter((row) => /support|ticket/i.test(String(row.record_type || row.type || "")));
  }
  if (data && typeof data === "object" && (data.name || data.subject)) return [data];
  return [];
}

async function callFirstSupportMethod(methods, options) {
  let firstError = null;
  for (const method of methods) {
    try {
      const parsed = await erpCallMethod(method, { ...options, appToken: true });
      const data = unwrapMethodData(parsed);
      return { method, data };
    } catch (e) {
      firstError = firstError || e;
      const message = (e.message || "").toString();
      const missingMethod =
        e.status === 404 ||
        message.includes("has no attribute") ||
        message.includes("Failed to get method") ||
        message.includes("Unknown method");
      if (e.status && !missingMethod) break;
    }
  }
  throw firstError || new Error("No support method configured");
}

function normalizeSenderType(value, doc = {}) {
  const raw = (value || doc.sender || doc.from || doc.author_type || doc.user_type || "").toString().trim().toLowerCase();
  if (
    raw.includes("agent") ||
    raw.includes("admin") ||
    raw.includes("support") ||
    raw.includes("staff") ||
    raw.includes("operator") ||
    raw.includes("manager") ||
    raw.includes("doctor") ||
    raw.includes("erp")
  ) {
    return "agent";
  }
  if (raw.includes("user") || raw.includes("patient") || raw.includes("customer") || raw.includes("requester")) {
    return "user";
  }

  const owner = (doc.owner || doc.sender_email || doc.email || "").toString().trim().toLowerCase();
  const senderName = (doc.sender_name || doc.sender || doc.owner_name || "").toString().trim().toLowerCase();
  if (
    owner === "administrator" ||
    owner.includes("admin") ||
    owner.includes("support") ||
    senderName.includes("support") ||
    senderName.includes("admin")
  ) {
    return "agent";
  }

  return "user";
}

function getMessageText(doc = {}) {
  return doc.message || doc.content || doc.text || doc.comment || doc.reply || doc.description || doc.body || "";
}

function getMessageTime(doc = {}) {
  return doc.timestamp || doc.creation || doc.created_at || doc.created_on || doc.date || doc.modified;
}

function mapMessage(doc = {}) {
  const attachments = safeJsonParse(doc.attachments, []);
  const senderType = normalizeSenderType(doc.sender_type, doc);
  return {
    id: doc.name || doc.id || "",
    ticket_id: doc[MESSAGE_TICKET_FIELD] || doc.ticket || doc.ticket_id || doc.reference_name || "",
    sender_type: senderType,
    sender_id: doc.sender_id || null,
    sender_name: doc.sender_name || doc.comment_by || doc.owner || "",
    message: getMessageText(doc),
    attachments: Array.isArray(attachments) && attachments.length > 0 ? attachments : doc.attachment ? [doc.attachment] : [],
    is_read: doc.is_read === 1 || doc.is_read === true || doc.is_read === "1",
    read_at: toIso(doc.read_at, null),
    created_at: toIso(getMessageTime(doc), new Date().toISOString()),
    updated_at: toIso(doc.modified, new Date().toISOString()),
  };
}

async function getMessageFieldSet() {
  const resource = await getMessageResource();
  return resource?.fieldSet || null;
}

function clearResourceCaches(doctype) {
  RESOURCE_FIELD_CACHE.delete(doctype);
  RESOURCE_META_CACHE.delete(doctype);
  if (doctype === MESSAGE_DOCTYPE) {
    MESSAGE_RESOURCE_CACHE.values.clear();
  }
}

function ensureMessageDocTypeShape(meta) {
  const fields = Array.isArray(meta?.fields) ? meta.fields.map((field) => ({ ...field })) : [];
  let changed = false;

  let ticketField = fields.find((field) => field?.fieldname === MESSAGE_TICKET_FIELD);
  if (!ticketField) {
    const insertAfter = fields.length > 0 ? fields[fields.length - 1].fieldname : undefined;
    ticketField = {
      doctype: "DocField",
      parent: MESSAGE_DOCTYPE,
      parenttype: "DocType",
      parentfield: "fields",
      fieldname: MESSAGE_TICKET_FIELD,
      label: "Ticket",
      fieldtype: "Link",
      options: "App Support Ticket",
      reqd: 1,
      ...(insertAfter ? { insert_after: insertAfter } : {}),
    };
    fields.push(ticketField);
    changed = true;
  }

  if (ticketField.fieldtype !== "Link" || ticketField.options !== "App Support Ticket") {
    ticketField.fieldtype = "Link";
    ticketField.options = "App Support Ticket";
    changed = true;
  }

  if (!fields.some((field) => field?.fieldname === "ticket_number")) {
    fields.push({
      doctype: "DocField",
      parent: MESSAGE_DOCTYPE,
      parenttype: "DocType",
      parentfield: "fields",
      fieldname: "ticket_number",
      label: "Ticket Number",
      fieldtype: "Data",
      insert_after: MESSAGE_TICKET_FIELD,
    });
    changed = true;
  }

  return { changed, fields };
}

async function ensureSupportMessageSchema() {
  if (MESSAGE_RESOURCE_CACHE.schemaChecked) return;
  MESSAGE_RESOURCE_CACHE.schemaChecked = true;
  if (MESSAGE_DOCTYPE !== "App Support Ticket Message") return;

  try {
    const meta = await erpGetDoc("DocType", MESSAGE_DOCTYPE);
    if (!meta) return;
    const { changed, fields } = ensureMessageDocTypeShape(meta);
    if (!changed) return;

    await erpUpdate("DocType", MESSAGE_DOCTYPE, { fields });
    clearResourceCaches(MESSAGE_DOCTYPE);
    console.log(`[supportTickets] Updated ${MESSAGE_DOCTYPE}.${MESSAGE_TICKET_FIELD} to Link App Support Ticket and ensured ticket_number`);
  } catch (e) {
    console.warn(`[supportTickets] Could not auto-sync ${MESSAGE_DOCTYPE} schema:`, e.message);
  }
}

function messageFieldFromMeta(meta, ticketDoctype) {
  const fields = meta?.fields || [];
  const compatible = (field) => {
    if (!field?.fieldname) return false;
    const fieldtype = (field.fieldtype || "").toString().toLowerCase();
    const options = (field.options || "").toString().trim();
    if (!["link", "dynamic link", "data"].includes(fieldtype)) return true;
    if (!options) return true;
    return options === ticketDoctype || SUPPORT_RESOURCE_DOCTYPES.includes(options);
  };
  for (const candidate of MESSAGE_TICKET_FIELD_CANDIDATES) {
    const exact = fields.find((field) => field?.fieldname === candidate);
    if (exact && compatible(exact)) return exact.fieldname;
    if (exact) {
      console.warn(
        `[supportTickets] Skipping message field ${meta?.name || ""}.${candidate}; it links to ${exact.options || "unknown"}, not ${ticketDoctype}`,
      );
    }
  }
  const byOptions = fields.find((field) => {
    const fieldtype = (field?.fieldtype || "").toString().toLowerCase();
    const options = (field?.options || "").toString().trim();
    return field?.fieldname && ["link", "dynamic link", "data"].includes(fieldtype) && options === ticketDoctype;
  });
  if (byOptions) return byOptions.fieldname;
  const byName = fields.find((field) => {
    const haystack = `${field?.fieldname || ""} ${field?.label || ""} ${field?.options || ""}`.toLowerCase();
    return field?.fieldname && /ticket/.test(haystack) && compatible(field);
  });
  return byName?.fieldname || null;
}

async function getMessageResource(ticketDoctype = "App Support Ticket") {
  await ensureSupportMessageSchema();
  const cached = MESSAGE_RESOURCE_CACHE.values.get(ticketDoctype);
  if (cached) return cached;
  for (const doctype of MESSAGE_DOCTYPE_CANDIDATES) {
    const meta = await getResourceMeta(doctype);
    if (!meta) continue;
    const fieldSet = fieldsFromMeta(meta);
    const ticketField = messageFieldFromMeta(meta, ticketDoctype);
    if (!ticketField) {
      console.warn(`[supportTickets] Skipping message DocType ${doctype}; no compatible ticket link field for ${ticketDoctype}`);
      continue;
    }
    const resource = { doctype, meta, fieldSet, ticketField };
    MESSAGE_RESOURCE_CACHE.values.set(ticketDoctype, resource);
    console.log(`[supportTickets] Using message DocType ${doctype} with ticket field ${ticketField}`);
    return resource;
  }
  return null;
}

function addQueries(queries, fields, value, status) {
  const normalized = (value || "").toString().trim();
  if (!normalized) return;
  for (const field of fields) {
    const filters = [[field, "=", normalized]];
    if (status) filters.push(["status", "=", toFrappeStatus(status)]);
    queries.push(filters);
  }
}

async function getResourceFieldSet(doctype) {
  if (RESOURCE_FIELD_CACHE.has(doctype)) return RESOURCE_FIELD_CACHE.get(doctype);
  const meta = await getResourceMeta(doctype);
  const fields = meta ? fieldsFromMeta(meta) : null;
  RESOURCE_FIELD_CACHE.set(doctype, fields);
  return fields;
}

function fieldsFromMeta(meta) {
  if (!meta) return null;
  const fields = new Set(["name", "owner", "creation", "modified", "modified_by", "docstatus", "idx"]);
  for (const field of meta?.fields || []) {
    if (field?.fieldname) fields.add(String(field.fieldname));
  }
  return fields;
}

async function getResourceMeta(doctype) {
  if (RESOURCE_META_CACHE.has(doctype)) return RESOURCE_META_CACHE.get(doctype);
  try {
    const meta = await erpGetDoc("DocType", doctype);
    RESOURCE_META_CACHE.set(doctype, meta || null);
    return meta || null;
  } catch (e) {
    console.warn(`[supportTickets] Could not read DocType metadata for ${doctype}; trying candidate fields:`, e.message);
    RESOURCE_META_CACHE.set(doctype, null);
    RESOURCE_FIELD_CACHE.set(doctype, null);
    return null;
  }
}

function supportedFields(fields, candidates) {
  if (!fields) return candidates;
  return candidates.filter((field) => fields.has(field));
}

function filterDocForFields(doc, fieldSet) {
  if (!fieldSet) return doc;
  const out = {};
  for (const [key, value] of Object.entries(doc)) {
    if (fieldSet.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

async function nextTicketNumber(doctype) {
  const year = new Date().getFullYear();
  const prefix = `TKT-${year}-`;
  try {
    const rows = await erpGetList(doctype, {
      fields: ["ticket_number"],
      filters: [["ticket_number", "like", `${prefix}%`]],
      limit: 100,
      orderBy: "creation desc",
    });
    let max = 0;
    for (const row of rows) {
      const match = String(row.ticket_number || "").match(/(\d+)$/);
      if (!match) continue;
      const value = parseInt(match[1], 10);
      if (!Number.isNaN(value) && value > max) max = value;
    }
    return `${prefix}${String(max + 1).padStart(6, "0")}`;
  } catch (_) {
    return `${prefix}${String(Date.now()).slice(-6)}`;
  }
}

async function findResourceTicketsForQueries(doctype, queries, { limit, offset }) {
  const fieldSet = await getResourceFieldSet(doctype);
  const byName = new Map();
  for (const filters of queries) {
    const supportedFilters = fieldSet ? filters.filter(([field]) => fieldSet.has(field)) : filters;
    if (supportedFilters.length !== filters.length) continue;
    try {
      const nameRows = await erpGetList(doctype, {
        fields: ["name"],
        filters: supportedFilters,
        limit,
        offset,
        orderBy: "modified desc",
      });
      for (const row of nameRows) {
        if (!row?.name) continue;
        const key = `${doctype}:${row.name}`;
        if (byName.has(key)) continue;
        try {
          const doc = await erpGetDoc(doctype, row.name);
          byName.set(key, doc || row);
        } catch (_) {
          byName.set(key, row);
        }
      }
    } catch (e) {
      if (e.status !== 403 && e.status !== 404) {
        console.warn(`[supportTickets] Resource API lookup failed for ${doctype}:`, e.message);
      }
    }
  }

  return [...byName.values()]
    .sort((a, b) => {
      const at = new Date(a.modified || a.updated_at || a.creation || a.created_at || 0).getTime() || 0;
      const bt = new Date(b.modified || b.updated_at || b.creation || b.created_at || 0).getTime() || 0;
      return bt - at;
    })
    .slice(0, limit);
}

async function findTickets({ userId, userLinkName, userEmail, userPhone, userName, status, limit, offset }) {
  try {
    const parsed = await erpCallMethod("mobileintl_app.api.v1.users_lookup", {
      method: "GET",
      appToken: true,
      query: {
        external_id: userId,
        customer_id: userId,
        supabase_user_id: userId,
        user_id: userId,
        mobile_user_id: userLinkName,
        mobile_app_user: userLinkName,
        email: userEmail,
        phone: userPhone,
        mobile: userPhone,
      },
    });
    const data = unwrapMethodData(parsed);
    const rows = ticketRowsFromMethodData(data);
    if (rows.length > 0) {
      return rows
        .sort((a, b) => {
          const at = new Date(a.modified || a.updated_at || a.creation || a.created_at || 0).getTime() || 0;
          const bt = new Date(b.modified || b.updated_at || b.creation || b.created_at || 0).getTime() || 0;
          return bt - at;
        })
        .slice(offset, offset + limit);
    }
  } catch (e) {
    console.warn("[supportTickets] users_lookup engagement fallback failed:", e.message);
  }

  const strongQueries = [];
  addQueries(strongQueries, ["external_id", "user_id", "patient_id", "mobile_user_id", "customer_id", "supabase_user_id"], userId, status);
  addQueries(strongQueries, ["mobile_app_user"], userLinkName, status);

  for (const doctype of SUPPORT_RESOURCE_DOCTYPES) {
    const rows = await findResourceTicketsForQueries(doctype, strongQueries, { limit, offset });
    if (rows.length > 0) return rows;
  }

  return [];
}

async function createTicketViaResource(body, { externalId, userLinkName }) {
  const doctype = SUPPORT_RESOURCE_DOCTYPES[0];
  const fieldSet = await getResourceFieldSet(doctype);
  const requesterName = (body.requester_name || body.name || body.user_name || "").toString().trim();
  const email = (body.email || body.user_email || "").toString().trim();
  const phone = (body.phone || body.user_phone || "").toString().trim();
  const doc = filterDocForFields(
    {
      ticket_number: await nextTicketNumber(doctype),
      external_id: externalId,
      customer_id: externalId,
      supabase_user_id: externalId,
      patient_id: externalId,
      mobile_user_id: userLinkName,
      mobile_app_user: userLinkName,
      user_id: externalId || userLinkName,
      customer_name: requesterName,
      requester_name: requesterName,
      user_name: requesterName,
      patient_name: requesterName,
      email,
      user_email: email,
      phone,
      user_phone: phone,
      subject: body.subject,
      title: body.subject,
      description: body.description,
      message: body.description,
      status: toFrappeStatus(body.status || "open"),
      priority: toFrappePriority(body.priority),
      category: body.category || null,
      metadata: JSON.stringify({ source: "mobile_app", user_link_name: userLinkName || null, mobile_app_user: userLinkName || null }),
    },
    fieldSet,
  );
  return erpCreate(doctype, doc);
}

async function resolveTicket(id) {
  const normalized = (id || "").toString().trim();
  if (!normalized) return null;
  for (const doctype of SUPPORT_RESOURCE_DOCTYPES) {
    const fieldSet = await getResourceFieldSet(doctype);
    try {
      const doc = await erpGetDoc(doctype, normalized);
      if (doc) return { ...doc, __doctype: doctype };
    } catch (_) {
      /* try ticket_number below */
    }
    if (fieldSet && !fieldSet.has("ticket_number")) continue;
    try {
      const rows = await erpGetList(doctype, {
        fields: ["name"],
        filters: [["ticket_number", "=", normalized]],
        limit: 1,
        orderBy: "modified desc",
      });
      if (rows[0]?.name) {
        const doc = await erpGetDoc(doctype, rows[0].name);
        if (doc) return { ...doc, __doctype: doctype };
      }
    } catch (_) {
      /* try next doctype */
    }
  }
  return null;
}

async function getMessages(ticketName, { limit = 100, offset = 0, ticketDoctype = "App Support Ticket" } = {}) {
  const resource = await getMessageResource(ticketDoctype);
  const fieldSet = resource?.fieldSet || null;
  const ticketField = resource?.ticketField || MESSAGE_TICKET_FIELD;
  const doctype = resource?.doctype || MESSAGE_DOCTYPE;
  if (!resource || (fieldSet && !fieldSet.has(ticketField))) return [];
  try {
    return await erpGetList(doctype, {
      fields: supportedFields(fieldSet, MESSAGE_BASE_FIELDS),
      filters: [[ticketField, "=", ticketName]],
      orderBy: "creation asc",
      limit,
      offset,
    });
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) {
      console.warn("[supportTickets] Resource API messages lookup failed:", e.message);
    }
  }
  return [];
}

function embeddedMessagesFromTicket(ticketDoc = {}) {
  const rows = [];
  for (const field of EMBEDDED_MESSAGE_FIELDS) {
    const value = ticketDoc[field];
    const list = Array.isArray(value) ? value : safeJsonParse(value, []);
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const text = getMessageText(item);
      if (!text && !item.sender_type && !item.sender && !item.owner) continue;
      rows.push({
        ...item,
        name: item.name || `${ticketDoc.name || ticketDoc.ticket_number || "ticket"}-${field}-${rows.length}`,
        [MESSAGE_TICKET_FIELD]: item[MESSAGE_TICKET_FIELD] || ticketDoc.name || ticketDoc.ticket_number,
        ticket: item.ticket || ticketDoc.name || ticketDoc.ticket_number,
        creation: item.creation || item.created_at || item.timestamp || ticketDoc.creation,
      });
    }
  }
  return rows;
}

function metadataMessagesFromTicket(ticketDoc = {}) {
  const metadata = safeJsonParse(ticketDoc.metadata, null);
  const rows = Array.isArray(metadata?.support_messages) ? metadata.support_messages : [];
  return rows
    .filter((row) => row && typeof row === "object" && getMessageText(row))
    .map((row, index) => ({
      ...row,
      name: row.name || `${ticketDoc.name || ticketDoc.ticket_number || "ticket"}-metadata-${index}`,
      [MESSAGE_TICKET_FIELD]: row[MESSAGE_TICKET_FIELD] || ticketDoc.name || ticketDoc.ticket_number,
      ticket: row.ticket || ticketDoc.name || ticketDoc.ticket_number,
      creation: row.creation || row.timestamp || ticketDoc.creation,
    }));
}

async function commentMessagesFromTicket(ticketDoc = {}, { limit = 100, offset = 0 } = {}) {
  if (!ticketDoc.name) return [];
  try {
    const rows = await erpGetList("Comment", {
      fields: [
        "name",
        "reference_doctype",
        "reference_name",
        "comment_type",
        "comment_by",
        "content",
        "owner",
        "creation",
        "modified",
      ],
      filters: [
        ["reference_doctype", "=", ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0]],
        ["reference_name", "=", ticketDoc.name],
      ],
      orderBy: "creation asc",
      limit,
      offset,
    });
    return rows
      .filter((row) => {
        const type = (row.comment_type || "").toString().toLowerCase();
        return !type || type === "comment" || type === "info";
      })
      .map((row) => ({
        ...row,
        ticket: ticketDoc.name,
        sender_type: normalizeSenderType(row.sender_type, row),
        sender_name: row.comment_by || row.owner || "",
        message: row.content || "",
        timestamp: row.creation,
      }));
  } catch (e) {
    if (e.status !== 403 && e.status !== 404) {
      console.warn("[supportTickets] Comment messages lookup failed:", e.message);
    }
    return [];
  }
}

function embeddedMessageField(ticketDoc = {}, fieldSet = null, meta = null) {
  for (const field of EMBEDDED_MESSAGE_FIELDS) {
    const value = ticketDoc[field];
    const list = Array.isArray(value) ? value : safeJsonParse(value, null);
    if (Array.isArray(list)) {
      const metaField = (meta?.fields || []).find((f) => f?.fieldname === field) || null;
      return { fieldname: field, childDoctype: metaField?.options || null };
    }
  }
  const tableFields = (meta?.fields || []).filter((field) => {
    const fieldtype = (field?.fieldtype || "").toString().toLowerCase();
    return field?.fieldname && fieldtype === "table";
  });
  const preferredTable = tableFields.find((field) => {
    const haystack = `${field.fieldname || ""} ${field.label || ""} ${field.options || ""}`.toLowerCase();
    return /message|conversation|chat|reply|comment|communication/.test(haystack);
  }) || (tableFields.length === 1 ? tableFields[0] : null);
  if (preferredTable) {
    return { fieldname: preferredTable.fieldname, childDoctype: preferredTable.options || null };
  }
  if (fieldSet) {
    const fieldname = EMBEDDED_MESSAGE_FIELDS.find((field) => fieldSet.has(field)) || null;
    if (fieldname) return { fieldname, childDoctype: null };
  }
  return null;
}

async function getAllTicketMessages(ticketDoc, { limit = 100, offset = 0 } = {}) {
  const ticketDoctype = ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0];
  const ids = [
    ticketDoc.name,
    ticketDoc.ticket_number,
    ticketDoc.id,
  ].map((v) => (v || "").toString().trim()).filter(Boolean);
  const byKey = new Map();
  for (const id of [...new Set(ids)]) {
    const rows = await getMessages(id, { limit, offset, ticketDoctype });
    for (const row of rows) {
      const key = row.name || `${getMessageTime(row) || ""}:${getMessageText(row)}`;
      byKey.set(key, row);
    }
  }
  for (const row of embeddedMessagesFromTicket(ticketDoc)) {
    const key = row.name || `${getMessageTime(row) || ""}:${getMessageText(row)}`;
    byKey.set(key, row);
  }
  for (const row of metadataMessagesFromTicket(ticketDoc)) {
    const key = row.name || `${getMessageTime(row) || ""}:${getMessageText(row)}`;
    byKey.set(key, row);
  }
  for (const row of await commentMessagesFromTicket(ticketDoc, { limit, offset })) {
    const key = row.name || `${getMessageTime(row) || ""}:${getMessageText(row)}`;
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => {
    const at = new Date(getMessageTime(a) || 0).getTime() || 0;
    const bt = new Date(getMessageTime(b) || 0).getTime() || 0;
    return at - bt;
  });
}

function countPendingAgentMessages(rows) {
  let latestUserReplyAt = null;
  for (const row of rows) {
    const senderType = normalizeSenderType(row.sender_type, row);
    if (senderType === "agent") continue;
    const at = new Date(getMessageTime(row) || 0).getTime();
    if (!at) continue;
    if (latestUserReplyAt == null || at > latestUserReplyAt) latestUserReplyAt = at;
  }
  return rows.filter((row) => {
    const senderType = normalizeSenderType(row.sender_type, row);
    if (senderType !== "agent") return false;
    const at = new Date(getMessageTime(row) || 0).getTime();
    return latestUserReplyAt == null || (at && at > latestUserReplyAt);
  }).length;
}

async function countUnreadAgentMessages(ticket) {
  return countPendingAgentMessages(await getAllTicketMessages(ticket, { limit: 100, offset: 0 }));
}

function ticketStateKey(userId, ticket) {
  return `${userId}:${ticket.ticket_number || ticket.name || ticket.id || ""}`;
}

function latestAgentMessage(messages = []) {
  const agentMessages = messages
    .map(mapMessage)
    .filter((message) => message.sender_type === "agent")
    .sort((a, b) => {
      const at = new Date(a.created_at || a.updated_at || 0).getTime() || 0;
      const bt = new Date(b.created_at || b.updated_at || 0).getTime() || 0;
      return bt - at;
    });
  return agentMessages[0] || null;
}

function agentMessageStateKey(message) {
  if (!message) return "";
  return [
    message.id || "",
    message.created_at || "",
    (message.message || "").toString().slice(0, 80),
  ].join("|");
}

async function pushAndSaveSupportNotification(target, ticket, event, extra = {}) {
  const built = buildSupportTicketPush({
    event,
    ticketId: ticket.id || ticket.name,
    ticketNumber: ticket.ticket_number,
    subject: ticket.subject,
    status: ticket.status,
    ...extra,
  });
  const push = await sendSupportTicketPush({
    ...target,
    event,
    ticketId: ticket.id || ticket.name,
    ticketNumber: ticket.ticket_number,
    subject: ticket.subject,
    status: ticket.status,
    ...extra,
  });
  const notification = await saveNotification({
    appointment: target,
    event: built.event,
    title: built.title,
    body: built.body,
    data: built.data,
    push,
  });
  return { notification, push };
}

async function runSupportTicketNotifications(options = {}) {
  const targets = await listSupportNotificationTargets();
  const states = await readSupportNotificationStates();
  const results = [];
  let sent = 0;

  for (const target of targets) {
    const userId = (target.userId || "").toString().trim();
    if (!userId) continue;
    let rows = [];
    try {
      rows = await findTickets({
        userId,
        userLinkName: "",
        userEmail: target.userEmail,
        userPhone: target.userPhone,
        userName: target.userName,
        limit: 50,
        offset: 0,
      });
    } catch (e) {
      results.push({ userId, error: e.message });
      continue;
    }

    for (const row of rows) {
      const ticket = mapTicket({ ...row, external_id: row.external_id || userId });
      const key = ticketStateKey(userId, ticket);
      if (!key.endsWith(":")) {
        const messages = await getAllTicketMessages({ ...row, ...ticket });
        const latestAgent = latestAgentMessage(messages);
        const nextState = {
          status: ticket.status || "",
          updatedAt: ticket.updated_at || "",
          latestAgentMessageKey: agentMessageStateKey(latestAgent),
          checkedAt: new Date().toISOString(),
        };
        const previous = states[key];
        if (!previous) {
          states[key] = nextState;
          results.push({ ticket: ticket.ticket_number, seeded: true });
          continue;
        }

        let event = null;
        let extra = {};
        if (
          nextState.latestAgentMessageKey &&
          nextState.latestAgentMessageKey !== previous.latestAgentMessageKey
        ) {
          event = "support_ticket_agent_reply";
          extra = {
            messageId: latestAgent?.id,
            message: latestAgent?.message,
          };
        } else if (nextState.status && nextState.status !== previous.status) {
          event = "support_ticket_status_update";
        } else if (nextState.updatedAt && nextState.updatedAt !== previous.updatedAt) {
          event = "support_ticket_updated";
        }

        if (event) {
          const pushed = await pushAndSaveSupportNotification(target, ticket, event, extra);
          if (pushed.push?.sent) sent += 1;
          results.push({ ticket: ticket.ticket_number, event, sent: Boolean(pushed.push?.sent) });
        }
        states[key] = nextState;
      }
    }
  }

  await writeSupportNotificationStates(states);
  return { checkedTargets: targets.length, results, sent, source: options.source || "manual" };
}

async function createMessageViaResource(ticketDoc, body) {
  const resource = await getMessageResource(ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0]);
  const fieldSet = resource?.fieldSet || null;
  if (!resource || !fieldSet) {
    throw Object.assign(new Error(`${MESSAGE_DOCTYPE_CANDIDATES.join(" / ")} is not available on ERP`), { status: 404 });
  }
  const ticketField = resource.ticketField || MESSAGE_TICKET_FIELD;
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const ticketRefs = [
    ticketDoc.name,
  ].map((v) => (v || "").toString().trim()).filter(Boolean);
  let lastError = null;
  for (const ticketRef of [...new Set(ticketRefs)]) {
    const doc = filterDocForFields(
      {
        [ticketField]: ticketRef,
        [MESSAGE_TICKET_FIELD]: ticketRef,
        ticket: ticketRef,
        ticket_id: ticketRef,
        support_ticket: ticketRef,
        app_support_ticket: ticketRef,
        ticket_number: ticketDoc.ticket_number || "",
        sender_type: "User",
        sender_id: body.user_id,
        sender_name: body.user_name || "User",
        message: body.message,
        attachment: attachments.length > 0 ? attachments[0] : "",
        attachments: JSON.stringify(attachments),
        timestamp: nowFrappeDatetime(),
        is_read: 0,
      },
      fieldSet,
    );
    try {
      console.log(`[supportTickets] Creating message in ${resource.doctype}.${ticketField} for ${ticketRef}`);
      return await erpCreate(resource.doctype, doc);
    } catch (e) {
      lastError = e;
      const raw = (e.message || "").toString();
      const canRetry =
        raw.includes("Could not find") ||
        raw.includes("LinkValidationError") ||
        raw.includes("Invalid Link");
      console.warn(`[supportTickets] Message create failed for ticket ref ${ticketRef}:`, raw);
      if (!canRetry) break;
    }
  }
  throw lastError || new Error("Support ticket message could not be saved.");
}

async function createMessageViaEmbeddedTicket(ticketDoc, body) {
  const doctype = ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0];
  if (!doctype || !ticketDoc.name) return null;
  const meta = await getResourceMeta(doctype);
  const fieldSet = await getResourceFieldSet(doctype);
  const embeddedField = embeddedMessageField(ticketDoc, fieldSet, meta);
  if (!embeddedField?.fieldname) return null;

  const field = embeddedField.fieldname;
  const existingValue = ticketDoc[field];
  const existingRows = Array.isArray(existingValue) ? existingValue : safeJsonParse(existingValue, []);
  const rows = Array.isArray(existingRows) ? [...existingRows] : [];
  const now = nowFrappeDatetime();
  const row = {
    ...(embeddedField.childDoctype ? { doctype: embeddedField.childDoctype } : {}),
    parent: ticketDoc.name,
    parenttype: doctype,
    parentfield: field,
    sender_type: "User",
    sender_id: body.user_id || "",
    sender_name: body.user_name || "User",
    message: body.message,
    timestamp: now,
    is_read: 0,
  };
  rows.push(row);
  const updated = await erpUpdate(doctype, ticketDoc.name, { [field]: rows });
  if (updated) {
    ticketDoc[field] = updated[field] || rows;
  }
  return {
    ...row,
    name: `${ticketDoc.name}-${field}-${rows.length - 1}`,
    [MESSAGE_TICKET_FIELD]: ticketDoc.name,
    ticket: ticketDoc.name,
    creation: now,
  };
}

async function createMessageViaTicketMetadata(ticketDoc, body) {
  const doctype = ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0];
  const fieldSet = await getResourceFieldSet(doctype);
  if (!fieldSet?.has("metadata") || !ticketDoc.name) return null;

  const metadata = safeJsonParse(ticketDoc.metadata, {}) || {};
  const rows = Array.isArray(metadata.support_messages) ? [...metadata.support_messages] : [];
  const now = nowFrappeDatetime();
  const row = {
    name: `${ticketDoc.name}-metadata-${rows.length}`,
    ticket: ticketDoc.name,
    ticket_number: ticketDoc.ticket_number || "",
    sender_type: "User",
    sender_id: body.user_id || "",
    sender_name: body.user_name || "User",
    message: body.message,
    timestamp: now,
    creation: now,
    is_read: 0,
    source: "mobile_app",
  };
  rows.push(row);
  const updatedMetadata = {
    ...metadata,
    support_messages: rows,
  };
  const updated = await erpUpdate(doctype, ticketDoc.name, { metadata: JSON.stringify(updatedMetadata) });
  ticketDoc.metadata = updated?.metadata || JSON.stringify(updatedMetadata);
  return row;
}

async function createMessageViaComment(ticketDoc, body) {
  const doctype = ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0];
  if (!doctype || !ticketDoc.name) return null;
  const now = nowFrappeDatetime();
  const content = body.message;
  const created = await erpCreate("Comment", {
    reference_doctype: doctype,
    reference_name: ticketDoc.name,
    comment_type: "Comment",
    comment_by: body.user_name || "User",
    content,
  });
  return {
    name: created?.name || `${ticketDoc.name}-comment-${Date.now()}`,
    ticket: ticketDoc.name,
    reference_doctype: doctype,
    reference_name: ticketDoc.name,
    sender_type: "User",
    sender_id: body.user_id || "",
    sender_name: body.user_name || created?.comment_by || "User",
    message: created?.content || content,
    timestamp: created?.creation || now,
    creation: created?.creation || now,
    is_read: 0,
  };
}

async function createTicketMessage(ticketDoc, body) {
  try {
    const embedded = await createMessageViaEmbeddedTicket(ticketDoc, body);
    if (embedded) return embedded;
  } catch (e) {
    console.warn("[supportTickets] Embedded ticket message append failed, trying message Resource API:", e.message, e.payload ? JSON.stringify(e.payload).slice(0, 600) : "");
  }
  try {
    return await createMessageViaResource(ticketDoc, body);
  } catch (e) {
    console.warn("[supportTickets] Message Resource API create failed, trying Comment:", e.message, e.payload ? JSON.stringify(e.payload).slice(0, 600) : "");
  }
  try {
    const comment = await createMessageViaComment(ticketDoc, body);
    if (comment) return comment;
  } catch (e) {
    console.warn("[supportTickets] Comment create failed, trying ticket metadata:", e.message, e.payload ? JSON.stringify(e.payload).slice(0, 600) : "");
  }
  const metadata = await createMessageViaTicketMetadata(ticketDoc, body);
  if (metadata) return metadata;
  throw new Error("Support ticket message could not be saved in ERP.");
}

function supportErrorResponse(e, fallback = "Support ticket chat is unavailable. Please try again.") {
  const raw = (e?.message || e || "").toString();
  console.warn("[supportTickets] Chat route failed:", raw, e?.payload ? JSON.stringify(e.payload).slice(0, 800) : "");
  const message =
    raw.includes("Traceback") || raw.includes("frappe.exceptions") || raw.length > 240
      ? fallback
      : raw || fallback;
  return { status: e?.status || 500, body: { success: false, message } };
}

function isPluginPath(req) {
  return (req.baseUrl || "").includes("/api/v1/support/tickets");
}

router.get("/", async (req, res) => {
  try {
    const { user_id, patient_id, user_email, email, user_phone, phone, status, page = 1, limit = 20 } = req.query;
    const userId = (user_id || patient_id || "").toString().trim();
    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required. Provide user_id or patient_id." });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;
    const rows = await findTickets({
      userId,
      userLinkName: req.userLinkName,
      userEmail: user_email || email,
      userPhone: user_phone || phone,
      status,
      limit: limitNum,
      offset,
      userName:
        req.mobileUser?.full_name ||
        [req.mobileUser?.first_name, req.mobileUser?.last_name].filter(Boolean).join(" ") ||
        "",
    });

    const tickets = await Promise.all(rows.map(async (row) => {
      const ticket = mapTicket({ ...row, external_id: row.external_id || userId });
      ticket.unread_message_count = await countUnreadAgentMessages({ ...row, ...ticket });
      ticket.has_pending_agent_reply = ticket.unread_message_count > 0;
      return ticket;
    }));
    return res.json({
      success: true,
      data: {
        tickets,
        pagination: { page: pageNum, limit: limitNum, total: tickets.length },
      },
    });
  } catch (e) {
    const out = supportErrorResponse(e, "Support ticket conversation could not be loaded.");
    return res.status(out.status).json(out.body);
  }
});

router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    let external_id = pickExternalId(body);
    if (!external_id) external_id = crypto.randomUUID();

    const requesterName = body.requester_name || body.name || body.user_name;
    const doc = mapSupportTicketToFrappe(
      {
        ...body,
        external_id,
        requester_name: requesterName,
        name: requesterName,
        email: body.email || body.user_email,
        phone: body.phone || body.user_phone,
        status: body.status || "open",
      },
      req.userLinkName,
    );
    let saved = null;
    try {
      saved = await createTicketViaResource(
        {
          ...body,
          external_id,
          requester_name: requesterName,
          email: body.email || body.user_email,
          phone: body.phone || body.user_phone,
          status: body.status || "open",
        },
        { externalId: external_id, userLinkName: req.userLinkName },
      );
    } catch (resourceError) {
      console.warn("[supportTickets] Resource API ticket create failed, trying mobile_app method fallback:", resourceError.message);
      try {
        const { data } = await callFirstSupportMethod(SUPPORT_SYNC_METHODS, {
          method: "POST",
          body: doc,
        });
        saved = Array.isArray(data) ? data[0] : data;
      } catch (_) {
        return res.status(resourceError.status || 502).json({
          success: false,
          message: "Support ticket Resource API create failed",
          error: resourceError.message,
        });
      }
    }
    const ticket = mapTicket(saved || {});
    if (isPluginPath(req)) return res.status(201).json({ success: true, data: { ticket } });
    return res.status(201).json({ success: true, data: saved });
  } catch (e) {
    const out = supportErrorResponse(e, "Support ticket conversation could not be loaded.");
    return res.status(out.status).json(out.body);
  }
});

router.post("/notifications/register", async (req, res) => {
  try {
    const target = await upsertSupportNotificationTarget({
      ...(req.body || {}),
      userId:
        req.body?.user_id ||
        req.body?.patient_id ||
        req.body?.external_id ||
        req.body?.customer_id,
    });
    return res.json({ success: true, data: { target } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.post("/notifications/run", async (_req, res) => {
  try {
    const result = await runSupportTicketNotifications({ source: "manual" });
    return res.json({ success: true, data: result });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const ticketDoc = await resolveTicket(req.params.id);
    if (!ticketDoc) return res.status(404).json({ success: false, message: "Ticket not found" });
    const messages = (await getAllTicketMessages(ticketDoc)).map(mapMessage);
    return res.json({ success: true, data: { ticket: mapTicket(ticketDoc), messages } });
  } catch (e) {
    const out = supportErrorResponse(e, "Support ticket conversation could not be loaded.");
    return res.status(out.status).json(out.body);
  }
});

router.get("/:id/messages", async (req, res) => {
  try {
    const ticketDoc = await resolveTicket(req.params.id);
    if (!ticketDoc) return res.status(404).json({ success: false, message: "Ticket not found" });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const rows = await getAllTicketMessages(ticketDoc, { limit, offset: (page - 1) * limit });
    const messages = rows.map(mapMessage);
    return res.json({ success: true, data: { messages, pagination: { page, limit, total: messages.length } } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.post("/:id/messages", async (req, res) => {
  try {
    const message = (req.body?.message || "").toString().trim();
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });

    const ticketDoc = await resolveTicket(req.params.id);
    if (!ticketDoc) return res.status(404).json({ success: false, message: "Ticket not found" });
    const saved = await createTicketMessage(ticketDoc, { ...req.body, message });
    return res.status(201).json({ success: true, data: { message: mapMessage(saved || {}) } });
  } catch (e) {
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.post("/:id/messages/read", async (req, res) => {
  try {
    const ticketDoc = await resolveTicket(req.params.id);
    if (!ticketDoc) return res.status(404).json({ success: false, message: "Ticket not found" });
    const resource = await getMessageResource(ticketDoc.__doctype || SUPPORT_RESOURCE_DOCTYPES[0]);
    const fieldSet = resource?.fieldSet || null;
    const ticketField = resource?.ticketField || MESSAGE_TICKET_FIELD;
    if (!resource || (fieldSet && !fieldSet.has(ticketField))) {
      return res.json({ success: true, message: "Messages marked as read" });
    }

    let targets = [];
    const messageIds = Array.isArray(req.body?.message_ids) ? req.body.message_ids.filter(Boolean) : [];
    if (messageIds.length > 0) {
      targets = messageIds;
    } else {
      const rows = await erpGetList(resource.doctype, {
        fields: ["name"],
        filters: [[ticketField, "=", ticketDoc.name]],
        limit: 100,
        orderBy: "creation desc",
      });
      targets = rows.map((row) => row.name).filter(Boolean);
    }

    await Promise.all(targets.map((name) => erpUpdate(resource.doctype, name, {
      is_read: 1,
      read_at: nowFrappeDatetime(),
    })));
    return res.json({ success: true, message: "Messages marked as read" });
  } catch (e) {
    if (e.status === 404) return res.json({ success: true, message: "Messages marked as read" });
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }
});

router.runSupportTicketNotifications = runSupportTicketNotifications;

module.exports = router;
