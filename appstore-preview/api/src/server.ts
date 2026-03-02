import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import {
  centerCanvasElementsHorizontally,
  clamp,
  cloneCanvasState,
  cloneProjectDesignState,
  cloneProjectForApi,
  computeCanvasMeta,
  createCanvasId,
  createProjectDesignState,
  DEFAULT_CANVAS_PRESET,
  findCanvas,
  findTextBox,
  getTextBoxMaxWidthForPresetId,
  normalizeProjectRecord,
  patchTextBox,
  sanitizeProjectState,
  shrinkCanvasTextBoxesToSingleLineByCanvas,
  type ProjectDesignState,
  type StoredProjectRecord,
  type TextBoxModel,
} from './domain.js';
import {
  APPSTORE_PREVIEW_ROOT,
  deleteProjectById,
  ProjectNotFoundError,
  ProjectRevisionConflictError,
  createProject,
  getProjectOrNull,
  getProjectOrThrow,
  listProjects,
  saveProject,
} from './store.js';
import { buildProjectZip } from './zip.js';
import {
  cloneCanvasMedia,
  deleteCanvasMedia,
  readCanvasMedia,
  readCanvasMediaMeta,
  saveCanvasMedia,
} from './media-store.js';
import { normalizeVideoForAppStore } from './video-normalize.js';

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

interface JsonObject {
  [key: string]: unknown;
}

function setCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, X-AppStore-Preview-Media-Name, X-AppStore-Preview-Media-Kind',
  );
  response.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, X-AppStore-Preview-Media-Kind, X-AppStore-Preview-Media-Name',
  );
}

function sendJson(response: ServerResponse, status: number, payload: JsonObject) {
  setCorsHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendBinary(
  response: ServerResponse,
  status: number,
  contentType: string,
  fileName: string,
  data: Buffer,
  extraHeaders?: Record<string, string>,
) {
  setCorsHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  response.setHeader('Content-Length', String(data.length));
  if (extraHeaders) {
    for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
      response.setHeader(headerName, headerValue);
    }
  }
  response.end(data);
}

function toProjectSummary(project: StoredProjectRecord) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    revision: project.revision,
    canvasCount: project.state.canvases.length,
    currentCanvasId: project.state.currentCanvasId,
    source: project.source,
  };
}

function computeProjectStateStats(state: ProjectDesignState) {
  return state.canvases.reduce(
    (acc, canvas) => {
      acc.canvasCount += 1;
      acc.textBoxCount += canvas.state.textBoxes.length;
      if (canvas.state.media.kind) {
        acc.mediaCount += 1;
      }
      return acc;
    },
    { canvasCount: 0, textBoxCount: 0, mediaCount: 0 },
  );
}

function isLikelyHydrationPlaceholderState(state: ProjectDesignState) {
  if (state.canvases.length !== 1) {
    return false;
  }

  const canvas = state.canvases[0];
  if (!canvas || state.currentCanvasId !== canvas.id) {
    return false;
  }

  const defaultCanvasName = canvas.name === 'Canvas 1' || canvas.name === '캔버스 1';
  if (!defaultCanvasName) {
    return false;
  }

  return (
    canvas.state.canvasPresetId === DEFAULT_CANVAS_PRESET.id &&
    canvas.state.backgroundMode === 'solid' &&
    canvas.state.backgroundPrimary === '#f2f4f7' &&
    canvas.state.backgroundSecondary === '#dbeafe' &&
    canvas.state.gradientAngle === 26 &&
    canvas.state.phoneOffset.x === 0 &&
    canvas.state.phoneOffset.y === 0 &&
    canvas.state.phoneScale === 1 &&
    canvas.state.textBoxes.length === 0 &&
    canvas.state.media.kind === null &&
    canvas.state.media.name === ''
  );
}

function parseBooleanQuery(url: URL, key: string, defaultValue: boolean) {
  const raw = url.searchParams.get(key);
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  return defaultValue;
}

async function readProjectRawFile(project: StoredProjectRecord) {
  try {
    const raw = await readFile(project.sourcePath, 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function buildProjectReadPayload(
  project: StoredProjectRecord,
  options?: { includeMeta?: boolean; includeRawFile?: boolean; includeThumbnails?: boolean },
) {
  const includeMeta = options?.includeMeta ?? true;
  const includeRawFile = options?.includeRawFile ?? true;
  const includeThumbnails = options?.includeThumbnails ?? true;
  const baseState = cloneProjectDesignState(project.state);
  const state = includeThumbnails
    ? baseState
    : {
        ...baseState,
        canvases: baseState.canvases.map((canvas) => ({
          ...canvas,
          thumbnailDataUrl: undefined,
        })),
      };

  const summary = toProjectSummary(project);
  const payload: JsonObject = {
    project: {
      ...summary,
      sourcePath: project.sourcePath,
    },
    state,
  };

  if (includeMeta) {
    payload.metas = project.state.canvases.map((canvas) => computeCanvasMeta(canvas));
  }

  if (includeRawFile) {
    payload.rawFile = await readProjectRawFile(project);
  }

  return payload;
}

function ensureJsonObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += bufferChunk.length;
    if (totalLength > 10 * 1024 * 1024) {
      throw new HttpError(413, 'Request body is too large (max 10MB).');
    }
    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return ensureJsonObject(parsed);
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

async function readBinaryBody(request: IncomingMessage, maxBytes = 1024 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += bufferChunk.length;
    if (totalLength > maxBytes) {
      throw new HttpError(413, `Request body is too large (max ${Math.floor(maxBytes / (1024 * 1024))}MB).`);
    }
    chunks.push(bufferChunk);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, 'Binary request body is required.');
  }

  return Buffer.concat(chunks);
}

function resolveMediaKindFromHeaders(url: URL, request: IncomingMessage): 'image' | 'video' | null {
  const queryKind = url.searchParams.get('kind');
  if (queryKind === 'image' || queryKind === 'video') {
    return queryKind;
  }

  const headerKind = request.headers['x-appstore-preview-media-kind'];
  if (typeof headerKind === 'string') {
    const normalized = headerKind.trim().toLowerCase();
    if (normalized === 'image' || normalized === 'video') {
      return normalized;
    }
  }

  const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '';
  if (contentType.startsWith('image/')) {
    return 'image';
  }
  if (contentType.startsWith('video/')) {
    return 'video';
  }

  return null;
}

function resolveMediaName(url: URL, request: IncomingMessage, fallbackCanvasId: string, kind: 'image' | 'video') {
  const queryName = url.searchParams.get('name');
  if (queryName && queryName.trim()) {
    return queryName.trim();
  }

  const headerName = request.headers['x-appstore-preview-media-name'];
  if (typeof headerName === 'string' && headerName.trim()) {
    return headerName.trim();
  }

  return `${fallbackCanvasId}.${kind === 'image' ? 'png' : 'mp4'}`;
}

function createDuplicateCanvasName(existingNames: string[], sourceName: string) {
  const existing = new Set(existingNames);
  const baseName = sourceName.trim() || 'Canvas';
  const firstCandidate = `${baseName} Copy`;
  if (!existing.has(firstCandidate)) {
    return firstCandidate;
  }

  let index = 2;
  while (existing.has(`${baseName} Copy ${index}`)) {
    index += 1;
  }

  return `${baseName} Copy ${index}`;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function notFound() {
  throw new HttpError(404, 'API route not found.');
}

function getParam(segments: string[], index: number, label: string) {
  const value = segments[index];
  if (!value) {
    throw new HttpError(400, `Missing path parameter: ${label}`);
  }
  return decodeURIComponent(value);
}

function cloneAsEditableProject(project: StoredProjectRecord): StoredProjectRecord {
  return {
    ...project,
    source: 'api',
    sourcePath: '',
    createdAt: project.createdAt,
    updatedAt: new Date().toISOString(),
    revision: project.revision,
    state: cloneProjectDesignState(project.state),
  };
}

function resolveCanvasOrThrow(project: StoredProjectRecord, canvasId: string) {
  const canvas = findCanvas(project.state, canvasId);
  if (!canvas) {
    throw new HttpError(404, `Canvas not found: ${canvasId}`);
  }
  return canvas;
}

function resolveTextBoxOrThrow(canvas: ReturnType<typeof resolveCanvasOrThrow>, textBoxId: string) {
  const textBox = findTextBox(canvas, textBoxId);
  if (!textBox) {
    throw new HttpError(404, `Text box not found: ${textBoxId}`);
  }
  return textBox;
}

function patchProjectTextBox(
  project: StoredProjectRecord,
  canvasId: string,
  textBoxId: string,
  patch: Partial<TextBoxModel>,
) {
  const canvas = resolveCanvasOrThrow(project, canvasId);
  resolveTextBoxOrThrow(canvas, textBoxId);
  const maxTextBoxWidth = getTextBoxMaxWidthForPresetId(canvas.state.canvasPresetId);

  canvas.state.textBoxes = canvas.state.textBoxes.map((box) =>
    box.id === textBoxId ? patchTextBox(box, patch, maxTextBoxWidth) : box,
  );
  project.updatedAt = new Date().toISOString();
}

type CanvasLayoutAction = 'center-horizontal' | 'shrink-text-single-line';

function readCanvasLayoutAction(body: JsonObject): CanvasLayoutAction {
  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (action === 'center-horizontal' || action === 'shrink-text-single-line') {
    return action;
  }
  throw new HttpError(400, '"action" must be one of: center-horizontal, shrink-text-single-line');
}

function applyCanvasLayoutActionToState(
  state: ReturnType<typeof cloneCanvasState>,
  action: CanvasLayoutAction,
) {
  if (action === 'center-horizontal') {
    return centerCanvasElementsHorizontally(state);
  }
  return shrinkCanvasTextBoxesToSingleLineByCanvas(state);
}

async function importProjectFromFile(filePathInput: string) {
  const resolvedFilePath = path.isAbsolute(filePathInput)
    ? filePathInput
    : path.resolve(APPSTORE_PREVIEW_ROOT, filePathInput);
  const raw = await readFile(resolvedFilePath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const normalized = normalizeProjectRecord(parsed, 'api', resolvedFilePath);
  if (!normalized) {
    throw new HttpError(400, `Could not parse project file: ${resolvedFilePath}`);
  }

  return normalized;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  if (!request.url || !request.method) {
    throw new HttpError(400, 'Invalid request.');
  }

  if (request.method === 'OPTIONS') {
    setCorsHeaders(response);
    response.statusCode = 204;
    response.end();
    return;
  }

  const url = new URL(request.url, 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean);

  if (segments[0] !== 'api') {
    notFound();
  }

  if (request.method === 'GET' && segments.length === 2 && segments[1] === 'health') {
    sendJson(response, 200, {
      ok: true,
      service: 'appstore-preview-api',
      now: new Date().toISOString(),
    });
    return;
  }

  if (
    request.method === 'POST' &&
    segments.length === 4 &&
    segments[1] === 'video' &&
    segments[2] === 'normalize' &&
    segments[3] === 'appstore'
  ) {
    const sourceName = url.searchParams.get('sourceName') ?? undefined;
    const minDurationRaw = Number.parseFloat(url.searchParams.get('minDurationSeconds') ?? '');
    const minDurationSeconds = Number.isFinite(minDurationRaw) ? Math.max(0.5, Math.min(120, minDurationRaw)) : undefined;
    const payload = await readBinaryBody(request);
    const normalized = await normalizeVideoForAppStore(payload, {
      sourceName,
      minDurationSeconds,
    });

    sendBinary(
      response,
      200,
      normalized.mimeType,
      normalized.fileName,
      normalized.data,
      {
        'X-AppStore-Video-Input-Duration': normalized.inputDurationSeconds.toFixed(3),
        'X-AppStore-Video-Output-Duration': normalized.outputDurationSeconds.toFixed(3),
        'X-AppStore-Video-Padded': normalized.padded ? 'true' : 'false',
        'X-AppStore-Video-Pad-Seconds': normalized.paddedSeconds.toFixed(3),
      },
    );
    return;
  }

  if (segments[1] !== 'projects') {
    notFound();
  }

  if (request.method === 'GET' && segments.length === 3 && segments[2] === 'full') {
    const includeMeta = parseBooleanQuery(url, 'includeMeta', true);
    const includeRawFile = parseBooleanQuery(url, 'includeRawFile', true);
    const includeThumbnails = parseBooleanQuery(url, 'includeThumbnails', true);
    const projects = await listProjects();
    const fullProjects = await Promise.all(
      projects.map((project) => buildProjectReadPayload(project, { includeMeta, includeRawFile, includeThumbnails })),
    );

    sendJson(response, 200, {
      projects: fullProjects,
      total: fullProjects.length,
      options: { includeMeta, includeRawFile, includeThumbnails },
    });
    return;
  }

  if (request.method === 'GET' && segments.length === 2) {
    const projects = await listProjects();
    sendJson(response, 200, {
      projects: projects.map((project) => toProjectSummary(project)),
      total: projects.length,
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 2) {
    const body = await readJsonBody(request);
    const projectName = typeof body.name === 'string' ? body.name : undefined;
    const state = body.state ? sanitizeProjectState(body.state) : createProjectDesignState();
    const project = await createProject(projectName, state);
    sendJson(response, 201, {
      project: toProjectSummary(project),
      state: project.state,
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 3 && segments[2] === 'import') {
    const body = await readJsonBody(request);
    const payload = body.payload as unknown;
    const filePath = typeof body.filePath === 'string' ? body.filePath : null;
    const nameOverride = typeof body.name === 'string' ? body.name.trim() : '';
    const forceImport = body.force === true;
    const expectedRevisionRaw = readNumber(body.expectedRevision);
    const expectedRevision =
      expectedRevisionRaw === null ? null : Math.max(0, Math.floor(expectedRevisionRaw));

    let imported: StoredProjectRecord;
    if (payload) {
      const normalized = normalizeProjectRecord(payload, 'api', '[payload]');
      if (!normalized) {
        throw new HttpError(400, 'Invalid project payload.');
      }
      imported = normalized;
    } else if (filePath) {
      imported = await importProjectFromFile(filePath);
    } else {
      throw new HttpError(400, 'Either "payload" or "filePath" is required.');
    }

    const editable = cloneAsEditableProject(imported);
    if (nameOverride) {
      editable.name = nameOverride;
    }

    const existingProject = await getProjectOrNull(editable.id);
    if (!forceImport) {
      if (existingProject && expectedRevision === null) {
        throw new HttpError(
          409,
          'Import blocked because expectedRevision is required for existing projects. Read the latest revision first.',
        );
      }

      if (existingProject) {
        const existingStats = computeProjectStateStats(existingProject.state);
        const existingHasMeaningfulContent =
          existingStats.canvasCount > 1 || existingStats.textBoxCount > 0 || existingStats.mediaCount > 0;

        if (existingHasMeaningfulContent && isLikelyHydrationPlaceholderState(editable.state)) {
          throw new HttpError(
            409,
            'Import blocked to prevent accidental overwrite with placeholder project state. Pass force=true to override.',
          );
        }
      }
    }

    const persisted = await saveProject(editable, {
      expectedRevision: existingProject ? expectedRevision : null,
    });
    sendJson(response, 201, {
      imported: true,
      project: toProjectSummary(persisted),
      state: persisted.state,
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 3 && segments[2] === 'actions') {
    const body = await readJsonBody(request);
    const action = readCanvasLayoutAction(body);
    const projects = await listProjects();
    let updatedProjects = 0;
    let updatedCanvases = 0;
    let skippedProjects = 0;
    const failedProjects: Array<{ projectId: string; status: number; message: string }> = [];

    for (const sourceProject of projects) {
      try {
        const editable = cloneAsEditableProject(sourceProject);
        let projectChanged = false;
        let projectChangedCanvases = 0;

        editable.state.canvases = editable.state.canvases.map((canvas) => {
          const nextState = applyCanvasLayoutActionToState(canvas.state, action);
          const changed = JSON.stringify(nextState) !== JSON.stringify(canvas.state);
          if (!changed) {
            return canvas;
          }
          projectChanged = true;
          projectChangedCanvases += 1;
          return {
            ...canvas,
            state: nextState,
          };
        });

        if (!projectChanged) {
          skippedProjects += 1;
          continue;
        }

        editable.updatedAt = new Date().toISOString();
        await saveProject(editable, { expectedRevision: sourceProject.revision });
        updatedProjects += 1;
        updatedCanvases += projectChangedCanvases;
      } catch (error) {
        const payload = toErrorPayload(error);
        failedProjects.push({
          projectId: sourceProject.id,
          status: payload.status,
          message: payload.message,
        });
      }
    }

    sendJson(response, 200, {
      action,
      scope: 'all-projects',
      totalProjects: projects.length,
      updatedProjects,
      updatedCanvases,
      skippedProjects,
      failedProjects,
    });
    return;
  }

  const projectId = getParam(segments, 2, 'projectId');

  if (request.method === 'DELETE' && segments.length === 3) {
    const removedCount = await deleteProjectById(projectId);
    sendJson(response, 200, {
      deleted: true,
      projectId,
      removedCount,
    });
    return;
  }

  const project = await getProjectOrThrow(projectId);

  if (request.method === 'GET' && segments.length === 4 && segments[3] === 'full') {
    const includeMeta = parseBooleanQuery(url, 'includeMeta', true);
    const includeRawFile = parseBooleanQuery(url, 'includeRawFile', true);
    const includeThumbnails = parseBooleanQuery(url, 'includeThumbnails', true);
    const fullProject = await buildProjectReadPayload(project, { includeMeta, includeRawFile, includeThumbnails });
    sendJson(response, 200, {
      ...fullProject,
      options: { includeMeta, includeRawFile, includeThumbnails },
    });
    return;
  }

  if (request.method === 'GET' && segments.length === 3) {
    const includeThumbnails = parseBooleanQuery(url, 'includeThumbnails', true);
    const baseState = cloneProjectDesignState(project.state);
    const state = includeThumbnails
      ? baseState
      : {
          ...baseState,
          canvases: baseState.canvases.map((canvas) => ({
            ...canvas,
            thumbnailDataUrl: undefined,
          })),
        };
    sendJson(response, 200, {
      project: toProjectSummary(project),
      state,
      options: { includeThumbnails },
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 4 && segments[3] === 'clone') {
    const body = await readJsonBody(request);
    const nextName = typeof body.name === 'string' ? body.name : undefined;
    const cloned = cloneProjectForApi(project, nextName);
    const persisted = await saveProject(cloned);
    let expectedMediaCopies = 0;
    let copiedMediaCount = 0;

    for (let index = 0; index < project.state.canvases.length; index += 1) {
      const sourceCanvas = project.state.canvases[index];
      const targetCanvas = persisted.state.canvases[index];
      if (!sourceCanvas || !targetCanvas || !sourceCanvas.state.media.kind) {
        continue;
      }

      expectedMediaCopies += 1;
      const result = await cloneCanvasMedia({
        sourceProjectId: project.id,
        sourceCanvasId: sourceCanvas.id,
        targetProjectId: persisted.id,
        targetCanvasId: targetCanvas.id,
      });
      if (result.copied) {
        copiedMediaCount += 1;
      }
    }

    sendJson(response, 201, {
      clonedFrom: project.id,
      project: toProjectSummary(persisted),
      state: persisted.state,
      mediaCopy: {
        expected: expectedMediaCopies,
        copied: copiedMediaCount,
        missing: expectedMediaCopies - copiedMediaCount,
      },
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 4 && segments[3] === 'actions') {
    const body = await readJsonBody(request);
    const action = readCanvasLayoutAction(body);
    const editable = cloneAsEditableProject(project);
    let changedCanvases = 0;

    editable.state.canvases = editable.state.canvases.map((canvas) => {
      const nextState = applyCanvasLayoutActionToState(canvas.state, action);
      const changed = JSON.stringify(nextState) !== JSON.stringify(canvas.state);
      if (!changed) {
        return canvas;
      }
      changedCanvases += 1;
      return {
        ...canvas,
        state: nextState,
      };
    });

    const persisted =
      changedCanvases > 0
        ? await saveProject(editable, { expectedRevision: project.revision })
        : project;

    sendJson(response, 200, {
      action,
      scope: 'project',
      project: toProjectSummary(persisted),
      state: persisted.state,
      updatedCanvases: changedCanvases,
      changed: changedCanvases > 0,
    });
    return;
  }

  if (request.method === 'GET' && segments.length === 4 && segments[3] === 'meta') {
    const canvasMetas = project.state.canvases.map((canvas) => computeCanvasMeta(canvas));
    sendJson(response, 200, {
      project: toProjectSummary(project),
      metas: canvasMetas,
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 5 && segments[3] === 'export' && segments[4] === 'zip') {
    const body = await readJsonBody(request);
    const includePngPreview = body.includePngPreview !== false;
    const includeOriginalMedia = body.includeOriginalMedia === true;
    const exported = await buildProjectZip(project, { includePngPreview, includeOriginalMedia });

    sendBinary(
      response,
      200,
      'application/zip',
      exported.zipFileName,
      exported.zipBuffer,
      {
        'X-AppStore-Preview-Warnings': String(exported.warnings.length),
        'X-AppStore-Preview-Canvas-Count': String(exported.canvasCount),
        'X-AppStore-Preview-Embedded-Media': String(exported.embeddedMediaCount),
        'X-AppStore-Preview-Missing-Media': String(exported.missingMediaCount),
      },
    );
    return;
  }

  if (segments.length < 6 || segments[3] !== 'canvases') {
    notFound();
  }

  const canvasId = getParam(segments, 4, 'canvasId');
  const canvas = resolveCanvasOrThrow(project, canvasId);

  if (request.method === 'GET' && segments.length === 6 && segments[5] === 'meta') {
    sendJson(response, 200, {
      project: toProjectSummary(project),
      canvasMeta: computeCanvasMeta(canvas),
    });
    return;
  }

  if (request.method === 'PATCH' && segments.length === 6 && segments[5] === 'phone') {
    const body = await readJsonBody(request);
    const offsetPatch = ensureJsonObject(body.offset);
    const x = readNumber(body.x) ?? readNumber(offsetPatch.x);
    const y = readNumber(body.y) ?? readNumber(offsetPatch.y);
    const phoneScale = readNumber(body.phoneScale) ?? readNumber(body.scale);

    if (x === null && y === null && phoneScale === null) {
      throw new HttpError(400, 'At least one of x, y, phoneScale (or offset.x/offset.y) is required.');
    }

    const editable = cloneAsEditableProject(project);
    const editableCanvas = resolveCanvasOrThrow(editable, canvasId);

    editableCanvas.state.phoneOffset = {
      x: x ?? editableCanvas.state.phoneOffset.x,
      y: y ?? editableCanvas.state.phoneOffset.y,
    };
    if (phoneScale !== null) {
      editableCanvas.state.phoneScale = clamp(phoneScale, 0.1, 3);
    }

    editable.updatedAt = new Date().toISOString();
    const persisted = await saveProject(editable, { expectedRevision: project.revision });
    const nextCanvas = resolveCanvasOrThrow(persisted, canvasId);

    sendJson(response, 200, {
      project: toProjectSummary(persisted),
      canvasId,
      phone: {
        offset: nextCanvas.state.phoneOffset,
        scale: nextCanvas.state.phoneScale,
      },
      canvasMeta: computeCanvasMeta(nextCanvas),
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 6 && segments[5] === 'clone') {
    const body = await readJsonBody(request);
    const targetProjectId = typeof body.targetProjectId === 'string' && body.targetProjectId.trim()
      ? body.targetProjectId.trim()
      : project.id;
    const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
    const requestedInsertIndex = typeof body.insertIndex === 'number' ? Math.floor(body.insertIndex) : null;
    const makeCurrent = body.makeCurrent !== false;

    const targetProjectSource = targetProjectId === project.id ? project : await getProjectOrThrow(targetProjectId);
    const editableTargetProject = cloneAsEditableProject(targetProjectSource);
    const targetExistingNames = editableTargetProject.state.canvases.map((item) => item.name);
    const nextCanvasName = requestedName || createDuplicateCanvasName(targetExistingNames, canvas.name);
    const duplicatedCanvasId = createCanvasId();
    const clonedCanvas = {
      id: duplicatedCanvasId,
      name: nextCanvasName,
      state: cloneCanvasState(canvas.state),
      thumbnailDataUrl: canvas.thumbnailDataUrl,
    };

    const clampedInsertIndex =
      requestedInsertIndex === null
        ? editableTargetProject.state.canvases.length
        : Math.max(0, Math.min(requestedInsertIndex, editableTargetProject.state.canvases.length));
    editableTargetProject.state.canvases.splice(clampedInsertIndex, 0, clonedCanvas);
    if (makeCurrent) {
      editableTargetProject.state.currentCanvasId = clonedCanvas.id;
    }
    editableTargetProject.updatedAt = new Date().toISOString();

    const persistedTargetProject = await saveProject(editableTargetProject, {
      expectedRevision: targetProjectSource.revision,
    });
    const mediaCloneResult = await cloneCanvasMedia({
      sourceProjectId: project.id,
      sourceCanvasId: canvas.id,
      targetProjectId: persistedTargetProject.id,
      targetCanvasId: clonedCanvas.id,
    });

    sendJson(response, 201, {
      clonedFrom: {
        projectId: project.id,
        canvasId: canvas.id,
      },
      project: toProjectSummary(persistedTargetProject),
      targetCanvasId: clonedCanvas.id,
      targetCanvasName: clonedCanvas.name,
      mediaCopied: mediaCloneResult.copied,
      mediaMeta: mediaCloneResult.meta,
      state: persistedTargetProject.state,
    });
    return;
  }

  if (request.method === 'POST' && segments.length === 6 && segments[5] === 'actions') {
    const body = await readJsonBody(request);
    const action = readCanvasLayoutAction(body);
    const editable = cloneAsEditableProject(project);
    const editableCanvas = resolveCanvasOrThrow(editable, canvasId);
    const nextState = applyCanvasLayoutActionToState(editableCanvas.state, action);
    const changed = JSON.stringify(nextState) !== JSON.stringify(editableCanvas.state);

    if (changed) {
      editableCanvas.state = nextState;
      editable.updatedAt = new Date().toISOString();
    }

    const persisted = changed
      ? await saveProject(editable, { expectedRevision: project.revision })
      : project;
    const nextCanvas = resolveCanvasOrThrow(persisted, canvasId);

    sendJson(response, 200, {
      action,
      scope: 'canvas',
      project: toProjectSummary(persisted),
      canvasId,
      changed,
      canvasMeta: computeCanvasMeta(nextCanvas),
    });
    return;
  }

  if (segments.length >= 6 && segments[5] === 'media') {
    if (request.method === 'GET' && segments.length === 7 && segments[6] === 'meta') {
      const mediaMeta = await readCanvasMediaMeta(project.id, canvasId);
      sendJson(response, 200, {
        project: toProjectSummary(project),
        canvasId,
        media: mediaMeta,
      });
      return;
    }

    if (request.method === 'GET' && segments.length === 6) {
      const media = await readCanvasMedia(project.id, canvasId);
      if (!media) {
        throw new HttpError(404, `Canvas media not found: ${canvasId}`);
      }

      sendBinary(response, 200, media.meta.type || 'application/octet-stream', media.meta.name || `${canvasId}.bin`, media.data, {
        'X-AppStore-Preview-Media-Kind': media.meta.kind,
        'X-AppStore-Preview-Media-Name': media.meta.name,
      });
      return;
    }

    if (request.method === 'PUT' && segments.length === 6) {
      const contentTypeHeader = request.headers['content-type'];
      const contentType = typeof contentTypeHeader === 'string' ? contentTypeHeader : '';
      const mediaKind = resolveMediaKindFromHeaders(url, request);
      if (!mediaKind) {
        throw new HttpError(
          400,
          'Could not infer media kind. Provide kind=image|video query (or header) and a valid media content type.',
        );
      }

      const mediaData = await readBinaryBody(request);
      const mediaName = resolveMediaName(url, request, canvasId, mediaKind);
      const mediaType = contentType || (mediaKind === 'image' ? 'image/png' : 'video/mp4');
      const mediaMeta = await saveCanvasMedia(project.id, canvasId, {
        kind: mediaKind,
        name: mediaName,
        type: mediaType,
        data: mediaData,
      });

      const editable = cloneAsEditableProject(project);
      const editableCanvas = resolveCanvasOrThrow(editable, canvasId);
      editableCanvas.state.media = {
        kind: mediaKind,
        name: mediaName,
      };
      editable.updatedAt = new Date().toISOString();
      const persisted = await saveProject(editable, { expectedRevision: project.revision });

      sendJson(response, 200, {
        project: toProjectSummary(persisted),
        canvasId,
        media: mediaMeta,
      });
      return;
    }

    if (request.method === 'DELETE' && segments.length === 6) {
      const editable = cloneAsEditableProject(project);
      const editableCanvas = resolveCanvasOrThrow(editable, canvasId);
      editableCanvas.state.media = {
        kind: null,
        name: '',
      };
      editable.updatedAt = new Date().toISOString();
      const persisted = await saveProject(editable, { expectedRevision: project.revision });
      await deleteCanvasMedia(project.id, canvasId);

      sendJson(response, 200, {
        project: toProjectSummary(persisted),
        canvasId,
        deleted: true,
      });
      return;
    }
  }

  if (segments.length >= 6 && segments[5] === 'text-boxes') {
    if (request.method === 'PATCH' && segments.length === 6) {
      const body = await readJsonBody(request);
      const updates = Array.isArray(body.updates) ? (body.updates as unknown[]) : null;
      if (!updates || updates.length === 0) {
        throw new HttpError(400, '"updates" array is required.');
      }

      const editable = cloneAsEditableProject(project);
      const skipped: string[] = [];
      const updatedTextBoxIds: string[] = [];

      for (const row of updates) {
        if (!row || typeof row !== 'object') {
          continue;
        }
        const patchPayload = row as JsonObject;
        const textBoxId = typeof patchPayload.id === 'string' ? patchPayload.id : null;
        if (!textBoxId) {
          continue;
        }

        const targetCanvas = resolveCanvasOrThrow(editable, canvasId);
        const targetBox = findTextBox(targetCanvas, textBoxId);
        if (!targetBox) {
          skipped.push(textBoxId);
          continue;
        }

        patchProjectTextBox(editable, canvasId, textBoxId, patchPayload as Partial<TextBoxModel>);
        updatedTextBoxIds.push(textBoxId);
      }

      if (updatedTextBoxIds.length === 0) {
        throw new HttpError(400, 'No text boxes were updated.');
      }

      const persisted = await saveProject(editable, { expectedRevision: project.revision });
      const nextCanvas = resolveCanvasOrThrow(persisted, canvasId);
      const canvasMeta = computeCanvasMeta(nextCanvas);
      sendJson(response, 200, {
        project: toProjectSummary(persisted),
        updatedTextBoxIds,
        skippedTextBoxIds: skipped,
        canvasMeta,
      });
      return;
    }

    if (segments.length >= 7) {
      const textBoxId = getParam(segments, 6, 'textBoxId');

      if (request.method === 'PATCH' && segments.length === 8 && segments[7] === 'position') {
        const body = await readJsonBody(request);
        const x = readNumber(body.x);
        const y = readNumber(body.y);
        if (x === null && y === null) {
          throw new HttpError(400, 'At least one of x or y is required.');
        }

        const editable = cloneAsEditableProject(project);
        patchProjectTextBox(editable, canvasId, textBoxId, {
          ...(x !== null ? { x } : {}),
          ...(y !== null ? { y } : {}),
        });
        const persisted = await saveProject(editable, { expectedRevision: project.revision });
        const nextCanvas = resolveCanvasOrThrow(persisted, canvasId);
        const textBoxMeta = computeCanvasMeta(nextCanvas).textBoxes.find((item) => item.id === textBoxId) ?? null;

        sendJson(response, 200, {
          project: toProjectSummary(persisted),
          canvasId,
          textBoxId,
          textBoxMeta,
        });
        return;
      }

      if (request.method === 'PATCH' && segments.length === 7) {
        const body = await readJsonBody(request);
        const editable = cloneAsEditableProject(project);
        patchProjectTextBox(editable, canvasId, textBoxId, body as Partial<TextBoxModel>);
        const persisted = await saveProject(editable, { expectedRevision: project.revision });
        const nextCanvas = resolveCanvasOrThrow(persisted, canvasId);
        const textBoxMeta = computeCanvasMeta(nextCanvas).textBoxes.find((item) => item.id === textBoxId) ?? null;

        sendJson(response, 200, {
          project: toProjectSummary(persisted),
          canvasId,
          textBoxId,
          textBoxMeta,
        });
        return;
      }

      if (request.method === 'GET' && segments.length === 8 && segments[7] === 'meta') {
        resolveTextBoxOrThrow(canvas, textBoxId);
        const textBoxMeta = computeCanvasMeta(canvas).textBoxes.find((item) => item.id === textBoxId) ?? null;
        sendJson(response, 200, {
          projectId: project.id,
          canvasId,
          textBoxId,
          textBoxMeta,
        });
        return;
      }
    }
  }

  notFound();
}

interface ErrorPayload {
  status: number;
  message: string;
  code?: string;
  projectId?: string;
  expectedRevision?: number;
  actualRevision?: number;
}

function toErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      message: error.message,
    };
  }

  if (error instanceof ProjectRevisionConflictError) {
    return {
      status: 409,
      code: 'revision_conflict',
      projectId: error.projectId,
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision,
      message: 'Project was changed elsewhere. Refresh to sync latest state before retrying.',
    };
  }

  if (error instanceof ProjectNotFoundError) {
    return {
      status: 404,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      message: error.message,
    };
  }

  return {
    status: 500,
    message: 'Unknown server error.',
  };
}

const apiPort = Number(process.env.APPSTORE_PREVIEW_API_PORT ?? 4318);

const server = createServer(async (request, response) => {
  try {
    await handleRequest(request, response);
  } catch (error) {
    const payload = toErrorPayload(error);
    sendJson(response, payload.status, {
      error: payload.message,
      ...(payload.code ? { code: payload.code } : {}),
      ...(payload.projectId ? { projectId: payload.projectId } : {}),
      ...(typeof payload.expectedRevision === 'number' ? { expectedRevision: payload.expectedRevision } : {}),
      ...(typeof payload.actualRevision === 'number' ? { actualRevision: payload.actualRevision } : {}),
    });
  }
});

server.listen(apiPort, () => {
  console.log(`[appstore-preview-api] listening on http://localhost:${apiPort}`);
});
