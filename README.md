# SRIAAS backend-erp (Node → Frappe MobileApp)

Express service that maps the mobile app data model from `filds.md` onto the Frappe DocTypes described in `erpmobileapp.md` (Mobile App User, Mobile App Health Entry, etc.) using the Frappe REST API.

**Full HTTP reference, status codes, example JSON, and curl commands for Postman:** [`API.md`](./API.md).

**Postman import and step-by-step:** [`POSTMAN.md`](./POSTMAN.md) (collection + environments in [`postman/`](./postman/), including **ngrok** preset `SRIAAS-backend-erp.postman_environment.ngrok.json` for `https://diabetic-crux-unnatural.ngrok-free.dev` → `localhost:3101`).

## Setup

```bash
cd backend/backend-erp
cp .env.example .env
# Edit .env: ERP_BASE_URL, ERP_TOKEN, APP_ERP_TOKEN, and DocType overrides if your site uses different names.
npm install
npm run dev
```

**Windows (optional):** after running `npm install` inside `backend-erp`, you can start the service with `.\start.ps1`. The ERP backend is standalone and does not use dependencies from the old support backend.

- Health (no auth): `GET /api/health`
- All other routes: header `X-ERP-Token: <APP_ERP_TOKEN>` or `Authorization: Bearer <APP_ERP_TOKEN>`

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default `3101`) |
| `APP_ERP_TOKEN` | Secret the Flutter / n8n client sends to this API |
| `ERP_BASE_URL` | Frappe site root, e.g. `https://your-site.com` |
| `ERP_TOKEN` | `api_key:api_secret` when `ERP_AUTH_SCHEME=token`, or bearer token |
| `ERP_AUTH_SCHEME` | `token` (default) or `bearer` |
| `REMINDER_LOOKAHEAD_MINUTES` | Reminder due window per poll, default `15` |
| `REMINDER_POLL_INTERVAL_MS` | Backend reminder scheduler interval, default `60000` |
| `DOCTYPE_*` | Override Frappe DocType titles if needed |

## Routes (aligned with filds.md + Frappe fields)

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/api/v1/users/sync` | Upsert **Mobile App User**; accepts `id` / `customer_id` / `external_id`, `supabase_user_id`, name aliases from `filds.md` |
| `GET` | `/api/v1/users/lookup` | Query user by same identifiers |
| `POST` | `/api/v1/users/sessions/sync` | Upsert **Mobile App User Session**; resolve user from body; use `session_external_id` / `user_session_id` / `session_id` for the session row (not the user `id`) |
| `POST` | `/api/v1/profiles/sync` | Upsert **`profiles`** child via `users_full_sync` |
| `POST` | `/api/v1/diseases/sync` | Upsert **Mobile App Disease** master |
| `POST` | `/api/v1/disease-selections` | Create **Mobile App User Disease Selection** |
| `POST` | `/api/v1/health-entries` | Sync **`health_entries`** via `users_full_sync` (**one row per `tool_key`**, all logs in `data_json` array) |
| `POST` | `/api/v1/prescriptions` | Create **Mobile App Prescription** |
| `POST` | `/api/v1/doctors/sync` | Upsert **Mobile App Doctor** |
| `POST` | `/api/v1/notifications` | Create **Mobile App Notification** (`type` → `notification_type`) |
| `POST` | `/api/v1/support-tickets` | Create **Mobile App Support Ticket** (`name` → `requester_name`) |
| `POST` | `/api/v1/webhook-events` | Create **Mobile App Webhook Event**; optional user via `customer_id` / `customer_email` / normal user keys |

## Frappe naming (from erpmobileapp.md)

- Mobile `users.id` → `external_id` (DocType autoname)
- `name` / `full_name` → `full_name`
- Notification `type` → `notification_type`
- Support ticket requester `name` → `requester_name`
- Profile `sex` → `gender` (`Male` / `Female`)

## Deploy on Render

1. Push this repo to GitHub (this folder is the **root** of `mobil_app_erp_backend`).
2. In [Render](https://dashboard.render.com): **New** → **Web Service** → connect the repo.
3. **Runtime:** Node; **Build:** `npm install`; **Start:** `npm start`.
4. **Environment:** copy variables from `.env.example` into Render **Environment** (`APP_ERP_TOKEN`, `ERP_*`, **`SUPABASE_URL`**, **`SUPABASE_ANON_KEY`** for `/api/auth/verify-supabase`, same values as the Flutter app’s Supabase project). Render injects **`PORT`** automatically — do not hardcode it.

After deploy, use your Render HTTPS URL as `BACKEND_ERP_BASE_URL` in the Flutter app (`flutter_erp.env` or `--dart-define`).

## Node version

Requires **Node 18+** for global `fetch`.
# Production authentication

Mobile clients authenticate protected endpoints with their Supabase access JWT
in `Authorization: Bearer <token>`. Keep `APP_ERP_TOKEN` only for trusted
server-to-server/Postman access; never bundle it in a mobile application.

Set `SUPABASE_SERVICE_ROLE_KEY` in the deployed backend environment to enable
the authenticated `DELETE /api/v1/account` flow. This key is server-only and
must never be exposed to Flutter, source control, logs, or public build output.
