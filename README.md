![App Store Preview - Design Settings and Live Preview](appstore-preview/docs/screenshots/design-settings-live-preview.png)
![App Store Preview - Canvas List Overview](appstore-preview/docs/screenshots/canvas-list-overview.png)

# image-ai Workspace

`image-ai` is a multi-project workspace for visual content tooling.
It currently includes three independent products:

- `mosaic-ai`: image privacy/editing app (mosaic brush workflow)
- `appstore-preview`: App Store screenshot/video composer for iPhone layouts
- `business-diagram-studio`: Venn/Competitive Quadrant chart canvas editor

## Project Overview

### 1. `appstore-preview/` (React + TypeScript)

Purpose:
- Build App Store-ready marketing assets from uploaded image/video media
- Organize work by project and multi-canvas timeline/list

What it provides:
- iPhone frame preview with draggable/resizable placement
- Drag-and-drop + file-picker upload (image/video)
- Text box system (create, inline edit, duplicate, delete, resize, move)
- Background style controls (solid/gradient, angle)
- Multiple iPhone canvas presets (including 886x1920 and additional preset sizes)
- Snap guides (center magnet behavior)
- Undo/Redo for editing and structural actions
- Canvas-level export and full project ZIP export
- Auto-save for project state and media mapping
- Optional local API for i18n automation:
  - project clone (with API-stored media binary copy)
  - canvas clone (within same project or cross-project)
  - canvas media binary upload/read/delete
  - text box patch (single/bulk)
  - text box line-wrap metadata
  - full shape metadata
  - ZIP export API

Tech stack:
- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- shadcn-style component setup
- Node.js API module (`appstore-preview/api`)

Docs:
- [appstore-preview README](appstore-preview/README.md)

API Quick Links:
- [appstore-preview API section](appstore-preview/README.md#i18n-automation-api)

### appstore-preview API Usage (Detailed)

Purpose:
- i18n automation workflow over saved projects/canvases/text boxes

Base URL:
- Browser (recommended): `/api` (Vite proxy)
- `http://localhost:4318/api`

Run both Web + API with one command:

```bash
cd appstore-preview
npm run dev
```

API only (optional):

```bash
cd appstore-preview
npm run api:dev
```

Common flow:
1. List projects: `GET /api/projects`
2. Read one project: `GET /api/projects/:projectId`
3. Read full local dump (all projects): `GET /api/projects/full`
4. Upload canvas media binary: `PUT /api/projects/:projectId/canvases/:canvasId/media`
5. Clone project: `POST /api/projects/:projectId/clone`
6. Clone canvas: `POST /api/projects/:projectId/canvases/:canvasId/clone`
7. Delete project: `DELETE /api/projects/:projectId`
8. Update translated text boxes:
   - single: `PATCH /api/projects/:projectId/canvases/:canvasId/text-boxes/:textBoxId`
   - position only: `PATCH /api/projects/:projectId/canvases/:canvasId/text-boxes/:textBoxId/position`
   - bulk: `PATCH /api/projects/:projectId/canvases/:canvasId/text-boxes`
9. Move/scale iPhone frame:
   - `PATCH /api/projects/:projectId/canvases/:canvasId/phone`
10. Verify wrapping/line metadata:
   - text box meta: `GET /api/projects/:projectId/canvases/:canvasId/text-boxes/:textBoxId/meta`
11. Verify full shape metadata:
   - canvas meta: `GET /api/projects/:projectId/canvases/:canvasId/meta`
   - project meta: `GET /api/projects/:projectId/meta`
12. Export as ZIP: `POST /api/projects/:projectId/export/zip`
   - options: `includePngPreview` (default `true`), `includeOriginalMedia` (default `false`)
13. Normalize video for App Store upload: `POST /api/video/normalize/appstore`
   - options: `sourceName`, `minDurationSeconds` (default `15.2`)

Example requests:

```bash
# 1) project list
curl -s http://localhost:4318/api/projects

# 2) clone project
curl -s -X POST http://localhost:4318/api/projects/<projectId>/clone \
  -H "Content-Type: application/json" \
  -d '{"name":"Korean i18n Copy"}'

# 3) upload media binary to one canvas
curl -s -X PUT "http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/media?kind=image&name=shot-01.png" \
  -H "Content-Type: image/png" \
  --data-binary "@./shot-01.png"

# 4) canvas clone (cross-project)
curl -s -X POST "http://localhost:4318/api/projects/<sourceProjectId>/canvases/<sourceCanvasId>/clone" \
  -H "Content-Type: application/json" \
  -d '{"targetProjectId":"<targetProjectId>","name":"Shot Copy"}'

# 5) read one project
curl -s http://localhost:4318/api/projects/<projectId>

# 6) full read (all local projects)
curl -s "http://localhost:4318/api/projects/full?includeMeta=true&includeRawFile=true"

# 7) full read (one project)
curl -s "http://localhost:4318/api/projects/<projectId>/full?includeMeta=true&includeRawFile=false"

# 8) delete project
curl -s -X DELETE http://localhost:4318/api/projects/<projectId>

# 9) patch one text box
curl -s -X PATCH http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/text-boxes/<textBoxId> \
  -H "Content-Type: application/json" \
  -d '{"text":"새 번역 문구","width":540,"fontSize":64}'

# 10) move one text box
curl -s -X PATCH "http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/text-boxes/<textBoxId>/position" \
  -H "Content-Type: application/json" \
  -d '{"x":312,"y":260}'

# 11) patch multiple text boxes
curl -s -X PATCH http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/text-boxes \
  -H "Content-Type: application/json" \
  -d '{"updates":[{"id":"text-1","text":"문구 A","width":520},{"id":"text-2","text":"문구 B","fontSize":56}]}'

# 12) move/scale iPhone frame
curl -s -X PATCH "http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/phone" \
  -H "Content-Type: application/json" \
  -d '{"x":24,"y":-30,"phoneScale":1.08}'

# 13) line-wrap/meta check
curl -s http://localhost:4318/api/projects/<projectId>/canvases/<canvasId>/text-boxes/<textBoxId>/meta

# 14) full project meta
curl -s http://localhost:4318/api/projects/<projectId>/meta

# 15) zip export
curl -L -X POST http://localhost:4318/api/projects/<projectId>/export/zip \
  -H "Content-Type: application/json" \
  -d '{"includePngPreview":true}' \
  -o appstore-preview-export.zip

# 16) zip export with original media binaries embedded
curl -L -X POST http://localhost:4318/api/projects/<projectId>/export/zip \
  -H "Content-Type: application/json" \
  -d '{"includePngPreview":true,"includeOriginalMedia":true}' \
  -o appstore-preview-export-with-media.zip

# 17) normalize any preview video to App Store-safe MP4 (AAC + min duration)
curl -L -X POST "http://localhost:4318/api/video/normalize/appstore?sourceName=c1.mp4&minDurationSeconds=15.2" \
  -H "Content-Type: video/mp4" \
  --data-binary "@./c1.mp4" \
  -o c1-appstore.mp4
```

Notes:
- Text box metadata includes `lineCount`, wrapped lines, and line classification.
- Text box metadata includes `lineCount`, wrapped lines, and line classification.
- Text box measured fields are split by engine:
  - `measuredLineCountByCanvas`, `measuredTextWidthByCanvas`
  - `measuredLineCountByDom`, `measuredTextWidthByDom`
- Text box limits: `width 120..round(canvasWidth*0.93)`, `fontSize 18..160` (API에서 범위 밖 값은 clamp).
- Shape metadata includes background, phone frame, and all text boxes.
- ZIP export can include original media binaries when `includeOriginalMedia=true`.
- GUI media upload now syncs binary to API media storage (`PUT /api/projects/:projectId/canvases/:canvasId/media`).
- GUI video export also normalizes through API (`POST /api/video/normalize/appstore`) to produce App Store-safe MP4.
- API responses now include project `revision` for optimistic concurrency.
- `POST /api/projects/import` should include `expectedRevision` when updating existing projects.
- In integrated dev mode (`npm run dev`), GUI projects and API projects are auto-merged/synced.
- Unified storage path: `appstore-preview/.project-saves/*.appstore-preview-project.json`.
- GUI/API now share one SoT on API file storage; runtime project state no longer depends on browser `localStorage`.
- Legacy `localStorage` project data is imported once to API storage (migration) for backward compatibility.
- Full read endpoints support:
  - `includeMeta=true|false` (default: `true`)
  - `includeRawFile=true|false` (default: `true`)
  - `includeThumbnails=true|false` (default: `true`)

### 2. `mosaic-ai/` (Next.js)

Purpose:
- Quickly apply privacy mosaic (pixelation) to sensitive areas in images

What it provides:
- Browser-based image upload (`png/jpg/webp`, size validation included)
- Brush-based mosaic painting on canvas
- Adjustable brush size
- Smooth stroke interpolation while dragging
- Undo/Redo support with keyboard shortcuts (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, `Ctrl+Y`)
- PNG download export

Tech stack:
- Next.js 16
- React 19
- TypeScript
- Tailwind CSS 4

Docs:
- [mosaic-ai README](mosaic-ai/README.md)

### 3. `business-diagram-studio/` (React + TypeScript)

Purpose:
- Create business Venn diagrams and competitive quadrant charts from structured inputs
- Place text and image assets directly on a chart canvas

What it provides:
- Home flow: open existing project or create new project
- New project flow: choose `Venn Diagram` or `Competitive Quadrant`
- Chart-specific input forms:
  - Venn: set names/icons, service names/icons
  - Quadrant: x/y axis names, service names/icons
- Canvas editor:
  - add text boxes
  - attach multiple images
  - drag and resize text/image elements
- Local persistence via browser `localStorage`

Tech stack:
- React 19
- TypeScript
- Vite

Docs:
- [business-diagram-studio README](business-diagram-studio/README.md)

## Repository Layout

```text
image-ai/
├─ mosaic-ai/          # Next.js-based mosaic editor
├─ appstore-preview/   # React/Vite App Store preview composer
├─ business-diagram-studio/ # React/Vite business chart canvas editor
├─ package.json        # Root convenience scripts
└─ .gitignore
```

## Root Scripts

The root scripts include `mosaic-ai` convenience commands and direct commands for `business-diagram-studio`:

```bash
npm run install:mosaic-ai
npm run dev
npm run build
npm run start
npm run lint
npm run install:business-diagram-studio
npm run dev:business-diagram-studio
npm run build:business-diagram-studio
```

## Running Each Project

### Run `mosaic-ai` from root

```bash
npm run install:mosaic-ai
npm run dev
```

### Run `appstore-preview` directly

```bash
cd appstore-preview
npm install
npm run dev
```

Or from root:

```bash
npm --prefix ./appstore-preview install
npm --prefix ./appstore-preview run dev
```

## Notes

- Both projects are frontend-first and can run independently.
- Each subproject has isolated dependencies and its own build pipeline.
- Root scripts are intentionally minimal and currently focused on `mosaic-ai`.
