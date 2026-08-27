const express = require("express");
const cors = require("cors");
const {
  PORT,
  ERP_BASE_URL,
  ERP_TOKEN,
  ERP_API_KEY,
  ERP_API_SECRET,
  ERP_BEARER_TOKEN,
  ERP_AUTH_SCHEME,
  DOCTYPE,
  APP_ERP_TOKEN,
  MOBILE_APP_ERP_TOKEN,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS,
  SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED,
} = require("./config");
const { requireAppToken, requireUserOrAppToken } = require("./middleware/requireAppToken");

const bootstrapRouter = require("./routes/bootstrap");
const startupRouter = require("./routes/startup");
const usersRouter = require("./routes/users");
const profilesRouter = require("./routes/profiles");
const diseasesRouter = require("./routes/diseases");
const diseaseSelectionsRouter = require("./routes/diseaseSelections");
const healthEntriesRouter = require("./routes/healthEntries");
const prescriptionsRouter = require("./routes/prescriptions");
const doctorsRouter = require("./routes/doctors");
const notificationsRouter = require("./routes/notifications");
const supportTicketsRouter = require("./routes/supportTickets");
const reportsRouter = require("./routes/reports");
const uploadsRouter = require("./routes/uploads");
const webhookEventsRouter = require("./routes/webhookEvents");
const authRouter = require("./routes/auth");
const accountRouter = require("./routes/account");

let supportTicketNotificationInterval = null;

function startSupportTicketNotificationScheduler() {
  if (SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED) {
    console.log("[supportTicketNotifications] disabled by SUPPORT_TICKET_NOTIFICATION_SCHEDULER_DISABLED=true");
    return;
  }
  if (supportTicketNotificationInterval) return;
  const run = async (source) => {
    try {
      const result = await supportTicketsRouter.runSupportTicketNotifications?.({ source });
      if (result) {
        console.log(
          `[supportTicketNotifications] ${source}: sent=${result.sent}, checkedTargets=${result.checkedTargets}`,
        );
      }
    } catch (e) {
      console.error("[supportTicketNotifications] run failed:", e.message);
    }
  };
  setTimeout(() => run("startup"), 10 * 1000).unref?.();
  supportTicketNotificationInterval = setInterval(
    () => run("scheduler"),
    SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS,
  );
  supportTicketNotificationInterval.unref?.();
  console.log(`[supportTicketNotifications] started intervalMs=${SUPPORT_TICKET_NOTIFICATION_POLL_INTERVAL_MS}`);
}

function safeHost(value) {
  try {
    return value ? new URL(value).host : "";
  } catch (_e) {
    return "";
  }
}

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/privacy", (_req, res) => {
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SRIAAS Privacy Policy</title></head><body style="font:16px/1.55 sans-serif;max-width:800px;margin:40px auto;padding:0 20px"><h1>SRIAAS Privacy Policy</h1><p>Last updated: 27 August 2026</p><p>SRIAAS processes account details, contact details, health profile information, health tracker entries, prescriptions, support messages and device notification identifiers to provide the app's health-management features.</p><h2>How data is used</h2><p>Data is used to authenticate users, synchronize their records, provide requested health tracking, deliver notifications, provide support, secure the service and comply with law. SRIAAS does not sell personal or health data.</p><h2>Service providers</h2><p>Data may be processed by Supabase (authentication), Frappe/ERPNext and SRIAAS hosting (records), cloud file storage (uploads), Firebase and OneSignal (notifications), and OpenAI-powered server processing when a user requests report extraction. These providers process only the information needed for their function.</p><h2>Retention and security</h2><p>Records are retained while an account is active and as required for legal, medical, accounting or fraud-prevention obligations. Access controls, encrypted transport and restricted server credentials are used to protect data. No Internet service can guarantee absolute security.</p><h2>Your choices</h2><p>Users can review or update profile information in the app and can delete their account from Profile. Deletion removes the account and associated app data except information that must legally be retained. You may also request deletion at <a href="mailto:support@sriaas.com?subject=SRIAAS%20account%20deletion">support@sriaas.com</a>.</p><h2>Medical disclaimer</h2><p>SRIAAS is not a medical device and does not diagnose, treat, cure, or prevent any medical condition. Consult a qualified healthcare professional for medical advice, diagnosis, or treatment.</p><h2>Contact</h2><p><a href="mailto:support@sriaas.com">support@sriaas.com</a></p></body></html>`);
  });

  app.get("/account-deletion", (_req, res) => {
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Delete SRIAAS Account</title></head><body style="font:16px/1.55 sans-serif;max-width:800px;margin:40px auto;padding:0 20px"><h1>Delete your SRIAAS account</h1><p>Open SRIAAS, go to <strong>Profile</strong>, choose <strong>Delete account</strong>, and follow the confirmation steps. This deletes your sign-in account and associated app profile, health tracker, prescription, support and notification records, except records SRIAAS must retain to meet legal obligations.</p><p>If you cannot access the app, email <a href="mailto:support@sriaas.com?subject=SRIAAS%20account%20deletion">support@sriaas.com</a> from the address registered to your account. We will verify the request before deletion.</p></body></html>`);
  });

  /** Supabase JWT verification + Mobile App User upsert (no APP_ERP_TOKEN). */
  app.use("/api/auth", authRouter);

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      service: "sriaas-backend-erp",
      release: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
      frappe: {
        baseUrlConfigured: Boolean(ERP_BASE_URL),
        erpBaseHost: safeHost(ERP_BASE_URL),
        /** Node → Frappe (`Authorization: token client_id:client_secret`) */
        erpTokenConfigured: Boolean(ERP_TOKEN),
        erpAuthScheme: ERP_AUTH_SCHEME,
        erpTokenHasColon: ERP_TOKEN.includes(":"),
        erpTokenLength: ERP_TOKEN.length,
        erpApiKeyPairConfigured: Boolean(ERP_API_KEY && ERP_API_SECRET),
        erpBearerTokenConfigured: Boolean(ERP_BEARER_TOKEN),
        /** Node → Frappe for `mobile_app.api.v1.*` (`X-ERP-Token` = site `mobile_app_erp_token`) */
        mobileAppErpTokenConfigured: Boolean(MOBILE_APP_ERP_TOKEN),
        /** App / Postman → Node (`X-ERP-Token` = APP_ERP_TOKEN) */
        appTokenConfigured: Boolean(APP_ERP_TOKEN),
        consolidatedBackend: true,
        doctypes: DOCTYPE,
      },
      supabase: {
        configured: Boolean(SUPABASE_URL && SUPABASE_ANON_KEY),
        serviceRoleConfigured: Boolean(SUPABASE_SERVICE_ROLE_KEY),
      },
    });
  });

  app.use("/api/v1", requireUserOrAppToken);

  app.use("/api/v1/bootstrap", bootstrapRouter);
  app.use("/api/v1/startup", startupRouter);
  app.use("/api/v1/users", usersRouter);
  app.use("/api/v1/profiles", profilesRouter);
  app.use("/api/v1/diseases", diseasesRouter);
  app.use("/api/v1/disease-selections", diseaseSelectionsRouter);
  app.use("/api/v1/health-entries", healthEntriesRouter);
  app.use("/api/v1/prescriptions", prescriptionsRouter);
  app.use("/api/v1/doctors", doctorsRouter);
  app.use("/api/v1/notifications", notificationsRouter);
  app.use("/api/v1/reports", reportsRouter);
  app.use("/api/v1/support-tickets", supportTicketsRouter);
  app.use("/api/v1/support/tickets", supportTicketsRouter);
  app.use("/api/v1/account", accountRouter);
  app.use("/api/upload", requireUserOrAppToken, uploadsRouter);
  app.use("/api/v1/webhook-events", webhookEventsRouter);

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ success: false, message: "Internal server error" });
  });

  return app;
}

function listen() {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`backend-erp listening on http://localhost:${PORT}`);
    console.log(`health: http://localhost:${PORT}/api/health`);
    startSupportTicketNotificationScheduler();
  });
}

module.exports = { createApp, listen };
