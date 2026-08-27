const { ERP_BASE_URL, ERP_TOKEN, MOBILE_APP_ERP_TOKEN, erpAuthHeader } = require("./config");

async function erpFetch(path, { method = "GET", body, query } = {}) {
  if (!ERP_BASE_URL) throw Object.assign(new Error("ERP_BASE_URL is not configured"), { status: 503 });
  if (!ERP_TOKEN) throw Object.assign(new Error("ERP_TOKEN is not configured"), { status: 503 });

  const url = new URL(`${ERP_BASE_URL}${path}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
      ...erpAuthHeader(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = { message: text };
  }

  if (!response.ok) {
    let msg = parsed?.message || parsed?.exc || parsed?._error_message;
    if (!msg || String(msg).trim() === "") {
      msg = `ERP HTTP ${response.status} ${method} ${path}`;
      if (response.status === 404) {
        msg +=
          ". Unknown route or DocType/method on Frappe. Check ERP_BASE_URL and that the method or Resource exists.";
      }
    }
    const err = new Error(msg);
    err.status = response.status;
    err.payload = parsed;
    err.frappePath = path;
    throw err;
  }

  return parsed;
}

async function erpGetList(
  doctype,
  { filters = [], fields = ["name"], limit = 20, offset = 0, orderBy = "modified desc" } = {},
) {
  const payload = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}`, {
    query: {
      filters,
      fields,
      order_by: orderBy,
      limit_page_length: limit,
      limit_start: offset,
    },
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function erpCreate(doctype, doc) {
  const payload = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}`, {
    method: "POST",
    body: doc,
  });
  return payload?.data || null;
}

async function erpUpdate(doctype, name, doc) {
  const payload = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: doc,
  });
  return payload?.data || null;
}

async function erpDelete(doctype, name) {
  const payload = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  return payload?.data || payload?.message || true;
}

async function erpGetDoc(doctype, name) {
  const payload = await erpFetch(`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  return payload?.data || null;
}

async function erpCallMethod(methodDottedPath, { method = "GET", query = {}, body, appToken = false } = {}) {
  const clean = String(methodDottedPath || "").trim().replace(/^\/+/, "");
  if (!clean) throw Object.assign(new Error("erpCallMethod: missing method path"), { status: 400 });
  if (!ERP_BASE_URL) throw Object.assign(new Error("ERP_BASE_URL is not configured"), { status: 503 });
  if (appToken && !MOBILE_APP_ERP_TOKEN) {
    throw Object.assign(new Error("MOBILE_APP_ERP_TOKEN is not configured"), { status: 503 });
  }
  if (!appToken && !ERP_TOKEN) {
    throw Object.assign(new Error("ERP_TOKEN is not configured"), { status: 503 });
  }

  const url = new URL(`${ERP_BASE_URL}/api/method/${clean}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
    }
  }

  const headers = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
    ...erpAuthHeader(),
    ...(appToken ? { "X-ERP-Token": MOBILE_APP_ERP_TOKEN } : {}),
  };

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (_) {
    parsed = { message: text };
  }

  if (!response.ok) {
    let msg = parsed?.message || parsed?.exc || parsed?._error_message;
    if (!msg || String(msg).trim() === "") {
      msg = `ERP HTTP ${response.status} ${method} /api/method/${clean}`;
      if (response.status === 404) {
        msg += ". Unknown method on Frappe. Check ERP_BASE_URL and that the method exists.";
      }
    }
    const err = new Error(msg);
    err.status = response.status;
    err.payload = parsed;
    err.frappePath = `/api/method/${clean}`;
    throw err;
  }

  return parsed;
}

module.exports = {
  erpFetch,
  erpGetList,
  erpCreate,
  erpUpdate,
  erpDelete,
  erpGetDoc,
  erpCallMethod,
};
