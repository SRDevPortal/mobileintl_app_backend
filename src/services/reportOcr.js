const {
  OPENAI_API_KEY,
  OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL,
  OPENAI_TIMEOUT_MS,
  OPENAI_MAX_RETRIES,
  REPORTS_OCR_FALLBACK_WEBHOOK_URL,
  REPORTS_OCR_FALLBACK_TIMEOUT_MS,
} = require("../config");

const REPORT_FIELDS = {
  lft: [
    ["total_protein", "Total Protein"],
    ["albumin", "Albumin"],
    ["globulin", "Globulin"],
    ["bilirubin", "Bilirubin"],
    ["sgot_ast", "SGOT / AST"],
    ["sgpt_alt", "SGPT / ALT"],
    ["alp", "ALP"],
  ],
  kft: [
    ["creatinine", "Creatinine"],
    ["urea", "Urea"],
    ["uric_acid", "Uric Acid"],
  ],
  cbc: [
    ["hemoglobin", "Hemoglobin"],
    ["wbc", "WBC"],
    ["platelets", "Platelets"],
  ],
  semen: [
    ["sperm_count", "Sperm Count"],
    ["motility", "Motility"],
    ["morphology", "Morphology"],
    ["volume", "Volume"],
  ],
  hormone: [
    ["testosterone", "Testosterone"],
    ["fsh", "FSH"],
    ["lh", "LH"],
  ],
  varicocele_usg: [
    ["varicocele_grade", "Varicocele Grade"],
    ["testis_size", "Testis Size"],
    ["testis_structure", "Testis Structure"],
    ["hydrocele", "Hydrocele"],
    ["cyst", "Cyst"],
  ],
  varicocele_doppler: [
    ["varicocele_grade", "Varicocele Grade"],
    ["vein_dilation", "Vein Dilation"],
    ["reflux", "Reflux"],
    ["blood_flow", "Blood Flow"],
  ],
};

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "label", "value", "unit", "status", "score", "confidence"],
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          value: { type: ["string", "number", "null"] },
          unit: { type: "string" },
          status: { type: "string", enum: ["NORMAL", "LOW", "HIGH", "BORDERLINE", "ABNORMAL", "CRITICAL", "UNKNOWN"] },
          score: { type: "integer", minimum: 0, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

function normalizeReportType(raw) {
  const value = (raw || "").toString().trim().toLowerCase();
  if (["lft", "thyroid", "lft_thyroid", "lab_lft_thyroid"].includes(value)) return "lft";
  if (["kft", "kidney", "kft_report"].includes(value)) return "kft";
  if (["cbc", "cbc_report"].includes(value)) return "cbc";
  if (["semen", "semen_report"].includes(value)) return "semen";
  if (["hormone", "hormone_report"].includes(value)) return "hormone";
  if (["varicocele_usg", "usg"].includes(value)) return "varicocele_usg";
  if (["varicocele_doppler", "doppler"].includes(value)) return "varicocele_doppler";
  return value || "unknown";
}

function dataUrlFromBuffer(fileBuffer, mimeType) {
  if (!fileBuffer) return "";
  return `data:${mimeType || "application/octet-stream"};base64,${Buffer.from(fileBuffer).toString("base64")}`;
}

function fileContentPart({ fileUrl, fileName, fileBuffer, mimeType }) {
  const lower = `${fileName || fileUrl}`.toLowerCase();
  const mime = (mimeType || "").toLowerCase();
  if (fileBuffer) {
    if (lower.includes(".pdf") || mime === "application/pdf") {
      return {
        type: "input_file",
        filename: fileName || "report.pdf",
        file_data: dataUrlFromBuffer(fileBuffer, "application/pdf"),
        detail: "high",
      };
    }
    const imageMime = mime.startsWith("image/") ? mime : "image/jpeg";
    return {
      type: "input_image",
      image_url: dataUrlFromBuffer(fileBuffer, imageMime),
      detail: "high",
    };
  }
  if (lower.includes(".pdf") || lower.includes("application/pdf")) {
    return { type: "input_file", file_url: fileUrl };
  }
  return { type: "input_image", image_url: fileUrl };
}

function buildPrompt(reportType, expectedFields) {
  const fieldList = expectedFields.map(([key, label]) => `${key}: ${label}`).join("\n");
  return [
    "Extract only the requested lab values visible in the attached report.",
    "Do not invent missing values. Return no row for a missing value.",
    "Never return UNKNOWN, N/A, null, blank, or placeholder text as a value.",
    "For KFT reports, common aliases include Serum Creatinine/Creatinine, Blood Urea/Urea, and Uric Acid/Serum Uric Acid.",
    "Use exact requested keys. Keep value numeric/text only; put unit separately.",
    "Status must be NORMAL, LOW, HIGH, BORDERLINE, ABNORMAL, CRITICAL, or UNKNOWN.",
    "Score is 0-100 where 100 is best/normal.",
    `Report type: ${reportType}`,
    `Fields:\n${fieldList || "Infer relevant report fields."}`,
  ].join("\n\n");
}

function normalizeStatus(raw) {
  const value = (raw || "").toString().trim().toUpperCase();
  if (!value) return "UNKNOWN";
  if (["NORMAL", "OK", "GOOD"].includes(value)) return "NORMAL";
  if (["BORDERLINE", "LOW", "HIGH", "ABNORMAL", "CRITICAL"].includes(value)) return value;
  return value;
}

function isMissingExtractedValue(value) {
  const text = (value == null ? "" : String(value)).trim().toLowerCase();
  if (!text) return true;
  return ["unknown", "n/a", "na", "null", "none", "-", "--", "not found", "not visible", "missing"].includes(text);
}

function normalizeExtractionResult(raw, reportType, expectedFields) {
  const expectedByKey = new Map(expectedFields.map(([key, label]) => [key, label]));
  const fields = [];
  for (const row of Array.isArray(raw?.fields) ? raw.fields : []) {
    const key = (row.key || "").toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    if (!key || isMissingExtractedValue(row.value)) continue;
    fields.push({
      key,
      label: (expectedByKey.get(key) || row.label || key).toString(),
      value: row.value,
      unit: row.unit == null ? "" : String(row.unit),
      status: normalizeStatus(row.status),
      score: Number.isFinite(Number(row.score)) ? Math.max(0, Math.min(100, Math.round(Number(row.score)))) : 70,
      confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0.6,
    });
  }
  return {
    success: true,
    report_type: reportType,
    fields,
    lft_score: raw?.lft_score ?? null,
    cbc_score: raw?.cbc_score ?? null,
    status: raw?.status ?? null,
    issues: Array.isArray(raw?.issues) ? raw.issues.map(String) : [],
    parameters: Array.isArray(raw?.parameters) ? raw.parameters : [],
    raw_text_summary: raw?.raw_text_summary ?? null,
  };
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const parts = [];
  for (const output of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(output?.content) ? output.content : []) {
      const text =
        typeof content?.text === "string"
          ? content.text
          : typeof content?.json === "string"
            ? content.json
            : "";
      if (text.trim()) parts.push(text);
    }
  }
  return parts.join("\n").trim();
}

async function extractReportWithOpenAI({ reportType, fileUrl, fileName, fileBuffer, mimeType }) {
  if (!OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_API_KEY is not configured"), { statusCode: 503 });
  const expectedFields = REPORT_FIELDS[reportType] || [];
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    max_output_tokens: OPENAI_MAX_OUTPUT_TOKENS,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: buildPrompt(reportType, expectedFields) },
        fileContentPart({ fileUrl, fileName, fileBuffer, mimeType }),
      ],
    }],
    text: { format: { type: "json_schema", name: "report_ocr_fields", strict: true, schema: extractionSchema } },
  });

  let lastError;
  for (let attempt = 0; attempt <= OPENAI_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw Object.assign(new Error(payload?.error?.message || `OpenAI request failed: ${response.status}`), {
          statusCode: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      const outputText = extractResponseText(payload);
      if (!outputText.trim()) throw new Error("OpenAI returned an empty extraction response");
      return normalizeExtractionResult(JSON.parse(outputText), reportType, expectedFields);
    } catch (error) {
      lastError = error.name === "AbortError"
        ? Object.assign(new Error("OpenAI extraction timed out"), { statusCode: 504, retryable: true })
        : error;
      if (!(lastError.retryable || !lastError.statusCode) || attempt >= OPENAI_MAX_RETRIES) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function unwrapFallbackPayload(payload) {
  let value = payload;
  for (let i = 0; i < 5; i += 1) {
    if (Array.isArray(value)) value = value[0];
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (_) { break; }
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value.fields)) {
      const next = value.data ?? value.body ?? value.json ?? value.result;
      if (next == null || next === value) break;
      value = next;
      continue;
    }
    break;
  }
  return value;
}

async function extractReportWithFallbackWebhook({ reportType, fileUrl, fileName, customerId, customerEmail }) {
  if (!REPORTS_OCR_FALLBACK_WEBHOOK_URL) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPORTS_OCR_FALLBACK_TIMEOUT_MS);
  try {
    const response = await fetch(REPORTS_OCR_FALLBACK_WEBHOOK_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        event: `${reportType}_report_extract`, report_type: reportType,
        file_url: fileUrl, file_name: fileName,
        customer_id: customerId, customer_email: customerEmail,
        timestamp: new Date().toISOString(),
      }),
    });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`OCR fallback failed: ${response.status}`), { statusCode: 502 });
    let payload;
    try { payload = unwrapFallbackPayload(JSON.parse(text)); } catch (_) {
      throw Object.assign(new Error("OCR fallback returned invalid JSON"), { statusCode: 502 });
    }
    return normalizeExtractionResult(payload, reportType, REPORT_FIELDS[reportType] || []);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { extractReportWithFallbackWebhook, extractReportWithOpenAI, normalizeReportType };
