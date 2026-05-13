# Starken OS - Project Context

## Overview
**Starken OS** is a unified SPA built in a single HTML file (`checklist-relatorios.html`) with no framework.
- **Repo**: `ferramentastecnologia/starken-os`
- **Live**: `https://escritorio.starkentecnologia.com.br/starken-os/`
- **Source of truth**: VPS path `/var/www/starken-os`
- **Branch**: local VPS Git history

## Mandatory VPS Workflow
This project is operated from the VPS. When working on the live office app, agents must treat `/var/www/starken-os` on `root@187.77.46.199` as the primary source.

Do not use files opened from `file:///Users/...` or local Mac copies as the source of truth. Local Mac files may be used only as temporary scratch copies for diffing, inspection, or safe patch preparation.

Before any code change on the VPS:
- SSH into `root@187.77.46.199` and work in `/var/www/starken-os`.
- Run `git status --short` and understand any existing user changes.
- Create a safety point with `starken-os-backup` or `starken-os-checkpoint "message"` when the change touches live behavior.
- Keep edits surgical. Do not overwrite whole live files from a Mac copy unless explicitly requested and verified against the VPS state.

After any code change on the VPS:
- Review the diff with `git diff`.
- Validate HTML/JS syntax when editing `checklist-relatorios.html`, `index.html`, or API JavaScript.
- Test through the live URL, not a `file:///Users/...` preview.
- Use `starken-os-checkpoint "message"` for a safe backup plus commit once the change is validated.

Preferred live files:
- Main SPA: `/var/www/starken-os/checklist-relatorios.html`
- Mirror entry: `/var/www/starken-os/index.html`
- Content API: `/var/www/starken-os/api/content.js`
- Meta publishing API: `/var/www/starken-os/api/meta/publish.js`

Never commit or print secrets from `.env`, `.mcp.json`, tokens, backup archives, or local credential files.

## Architecture
- **SPA in pure HTML/CSS/JS** — single file (~5000+ lines)
- **Supabase** connected via `_supabase` variable
- **Supabase URL**: `https://cpwpxckmuecejtkcobre.supabase.co`
- **Supabase Plan**: PRO ($25/month) — pg_cron active
- **Vercel**: Hobby plan (12 serverless functions limit, 12 in use — NO ROOM for more)
- **Login**: PIN-based (no backend) — `GP_USERS` array in JS
- **Navigation**: `switchTab(tabName)` global function

## Users & Tenants
- **3 users**: Juan (1234), Henrique (5678), Emily (2222)
- **2 tenants**: Starken Performance (25 clients), Alpha Assessoria (10 clients)
- **35 total clients** stored in Supabase `meta_config` + localStorage

## Supabase Tables
- `meta_config` — Meta API tokens per client
- `publish_history` — Published/scheduled post history
- `publish_queue` — IG scheduling queue (QUEUED → PROCESSING → PUBLISHED/FAILED)
- `content_groups` — Content management groups
- `content_tasks` — Tasks within groups
- `content_comments` — Task comments
- `content_attachments` — Task file attachments
- `content_activity` — Task activity log
- `clients`, `reports` — Legacy tables

## Vercel Serverless Functions (12/12)
- `api/content.js` — Content management (15 multiplexed actions)
- `api/meta/publish.js` — Publish to FB/IG + pg_cron processor
- `api/meta/media.js` — Media upload
- `api/meta/config.js` — Meta config CRUD
- `api/meta/discover.js` — Discover FB pages/IG accounts
- `api/meta/balance.js` — Ad account balance
- `api/meta/insights.js` — Ad performance metrics
- `api/meta/pages.js` — Page management
- `api/asana/tasks.js` — Legacy Asana integration

## Implemented Features

### Meta Publishing (Complete)
- **Facebook**: Publish now + Schedule (native API `scheduled_publish_time`)
- **Instagram**: Publish now + Schedule (via `publish_queue` + pg_cron)
- **Carousel FB**: Multiple image upload → `attached_media[0..N]`
- **Carousel IG**: Individual containers → carousel container → `media_publish`
- **FB+IG simultaneous**: Multi-select platform
- **Upload**: Local file → Supabase Storage → public URL → Meta API
- **Photo reorder**: Drag & drop + arrows in thumbnails
- **Carousel preview**: Swipeable slides with snap, dots, arrows
- **History**: Supabase `publish_history` (shared across PCs)
- **Cancel/delete**: FB deletes via API, IG removes from history
- **Alerts**: Toast notifications for FAILED and delays >5min
- **waitForContainer()**: Polling IG status before publishing

### Content Management (ClickUp-like)
- **Backend**: `api/content.js` — 15 multiplexed actions
- **Hierarchical list**: Groups → Tasks → Subtasks (up to 5 recursive levels)
- **Columns**: Name, Status, Responsible, Date, Indicators, Priority
- **14 custom statuses**: A Fazer → Em Andamento → ... → Agendado → Publicado
- **Fullscreen modal**: Briefing, References, Creative Final, Copy, Description, Subtasks, Publish/Schedule, Comments, Activity
- **Custom date picker**: Shortcuts (Today, Tomorrow, etc) + visual calendar
- **Drag & drop**: Handle for dragging tasks
- **Bulk selection**: Checkboxes + floating bar (Status, Responsible, Priority, Schedule, Delete)
- **Bulk scheduling**: Select multiple tasks → choose platform → schedule with 1h interval
- **Upload attachments**: Visual references + Final creative via Supabase Storage
- **Lightbox**: Click image opens full size
- **Delete cascade**: Subtasks + comments + attachments + activity
- **Optimistic updates**: Status/Priority update visually instantly

### Post Calendar
- **Monthly grid**: 7 columns (MON-SUN) with `pc-*` classes (no conflict with GP)
- **Colored posts**: Green=PUBLISHED, Blue=SCHEDULED, Red=FAILED, Yellow=QUEUED
- **Navigation**: Previous/next month + Today button
- **Filter by client**
- **Click day**: Detail panel

### Sidebar (ClickUp-style)
- **Folder hierarchy**: Starken Performance (25) / Alpha Assessoria (10)
- **35 clients** listed individually
- **Expand/collapse**: Chevron with state saved in localStorage
- **Click client**: Opens filtered Content Management

### UI/UX
- **3 Themes**: Light (default), Dark (navy), Warm/Sepia (beige/cream)
- **Theme switcher**: 3 buttons in sidebar footer
- **Themes use**: `data-theme` attribute on `<html>`, CSS variables override
- **Calendar classes**: `pc-*` prefix (not `cal-*` which conflicts with GP)

### IG Scheduling Queue System
- **Table**: `publish_queue` (QUEUED → PROCESSING → PUBLISHED/FAILED)
- **pg_cron**: Supabase calls endpoint every minute (`process-publish-queue`)
- **Frontend polling**: Backup every 2min while browser open
- **Backend**: `processPublishQueue()` with `waitForContainer()` for IG

## Key JS Variables
```js
gpState = { user, space, view, tasks, calDate }  // GP state
GP_USERS = [{name, pin, initials}]               // Juan/1234, Henrique/5678, Emilly/2222
GP_STATUSES = [16 objects with {label, dotColor, cls}]
GP_STARKEN = [23 Starken clients]
GP_ALPHA = [Alpha clients]
CT_USERS = ['Juan', 'Henrique', 'Emily']         // Content management users
_metaClients = [35 clients from meta_config]
```

## Meta Graph API
- **Version**: v25.0
- **App**: Sistema_Automacao_Portfolio
- **Permissions**: ads_read, instagram_content_publish, instagram_basic, pages_manage_posts, pages_read_engagement, business_management, pages_show_list
- **IG limitation**: No native scheduling — uses custom queue
- **IG limitation**: Published posts cannot be deleted via API

## Known Issues / Pending
1. **F5 returns to login** — session persists but meta_clients takes time to load in sidebar
2. **Supabase console errors** — "invalid anon key" (separate checklist sync)
3. **Vercel Pro** — pending invoice blocking upgrade
4. **Visual feedback for scheduled posts** — needs indicators in task list and modal

## Dev Environment
- **Local server**: Port 7001 via `.Codex/launch.json`
- **User preference**: Fast deploy, test in production on Vercel
- **Push method**: GitHub Desktop (CLI auth doesn't work)
- **Language**: Portuguese (Brazilian) for UI, English for code/API
