import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface JsonObject {
  [key: string]: unknown;
}

interface StoredProjectPayload {
  version: 1;
  project: {
    id: string;
    name: string;
    type?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  state: JsonObject;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUSINESS_DIAGRAM_ROOT = path.resolve(__dirname, '../..');
const PROJECT_SAVES_DIR = path.join(BUSINESS_DIAGRAM_ROOT, '.project-saves');
const PROJECT_FILE_EXTENSION = '.business-diagram-project.json';
const API_PORT = Number(process.env.BUSINESS_DIAGRAM_API_PORT ?? 4320);

function setCorsHeaders(response: ServerResponse) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(response: ServerResponse, status: number, payload: JsonObject) {
  setCorsHeaders(response);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function ensureObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as JsonObject;
}

function sanitizeFileNameSegment(name: string) {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\u3131-\u318E\uAC00-\uD7A3._-]/g, '-');
}

function parseTimestamp(value: unknown) {
  if (typeof value !== 'string') {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeProjectState(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.name !== 'string') {
    return null;
  }

  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString();
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : updatedAt;

  return {
    ...record,
    id: record.id,
    name: record.name,
    type: typeof record.type === 'string' ? record.type : 'venn',
    createdAt,
    updatedAt,
  } as JsonObject;
}

async function ensureProjectSavesDirectory() {
  await mkdir(PROJECT_SAVES_DIR, { recursive: true });
}

function buildProjectFilePath(projectId: string, projectName: string) {
  const safeName = sanitizeFileNameSegment(projectName || 'project');
  return path.join(PROJECT_SAVES_DIR, `${safeName}-${projectId}${PROJECT_FILE_EXTENSION}`);
}

async function listProjectFiles() {
  await ensureProjectSavesDirectory();

  const entries = await readdir(PROJECT_SAVES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_FILE_EXTENSION))
    .map((entry) => path.join(PROJECT_SAVES_DIR, entry.name));
}

async function readStoredPayload(filePath: string) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const payload = ensureObject(parsed) as Partial<StoredProjectPayload>;

    const state = normalizeProjectState(payload.state);
    if (!state) {
      return null;
    }

    const projectMeta = ensureObject(payload.project);
    const projectId = typeof projectMeta.id === 'string' ? projectMeta.id : (state.id as string);
    const updatedAt = typeof projectMeta.updatedAt === 'string' ? projectMeta.updatedAt : (state.updatedAt as string);

    return {
      filePath,
      projectId,
      updatedAt,
      state,
    };
  } catch {
    return null;
  }
}

async function loadProjectSnapshot() {
  const files = await listProjectFiles();
  const byId = new Map<string, { updatedAt: string; state: JsonObject }>();

  for (const filePath of files) {
    const loaded = await readStoredPayload(filePath);
    if (!loaded) {
      continue;
    }

    const existing = byId.get(loaded.projectId);
    if (!existing || parseTimestamp(loaded.updatedAt) >= parseTimestamp(existing.updatedAt)) {
      byId.set(loaded.projectId, {
        updatedAt: loaded.updatedAt,
        state: loaded.state,
      });
    }
  }

  return Array.from(byId.values())
    .map((entry) => entry.state)
    .sort((left, right) => parseTimestamp((right as Record<string, unknown>).updatedAt) - parseTimestamp((left as Record<string, unknown>).updatedAt));
}

async function listStoredProjectMetas() {
  const files = await listProjectFiles();
  const metas: Array<{ filePath: string; projectId: string }> = [];

  for (const filePath of files) {
    const loaded = await readStoredPayload(filePath);
    if (!loaded) {
      continue;
    }

    metas.push({
      filePath,
      projectId: loaded.projectId,
    });
  }

  return metas;
}

async function writeProjectSnapshot(rawProjects: unknown[]) {
  await ensureProjectSavesDirectory();

  const normalizedProjects = rawProjects
    .map((project) => normalizeProjectState(project))
    .filter((project): project is JsonObject => Boolean(project));

  const storedMetas = await listStoredProjectMetas();
  const storedById = new Map<string, string[]>();
  for (const meta of storedMetas) {
    const list = storedById.get(meta.projectId) ?? [];
    list.push(meta.filePath);
    storedById.set(meta.projectId, list);
  }

  const nextIds = new Set<string>();

  for (const project of normalizedProjects) {
    const projectId = String(project.id);
    const projectName = String(project.name);
    nextIds.add(projectId);

    const targetFilePath = buildProjectFilePath(projectId, projectName);
    const payload: StoredProjectPayload = {
      version: 1,
      project: {
        id: projectId,
        name: projectName,
        type: typeof project.type === 'string' ? project.type : undefined,
        createdAt: typeof project.createdAt === 'string' ? project.createdAt : undefined,
        updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : new Date().toISOString(),
      },
      state: project,
    };

    await writeFile(targetFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const oldPaths = storedById.get(projectId) ?? [];
    for (const oldPath of oldPaths) {
      if (path.resolve(oldPath) === path.resolve(targetFilePath)) {
        continue;
      }
      await rm(oldPath, { force: true });
    }
  }

  for (const [projectId, paths] of storedById.entries()) {
    if (nextIds.has(projectId)) {
      continue;
    }

    for (const filePath of paths) {
      await rm(filePath, { force: true });
    }
  }

  return normalizedProjects.length;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let totalLength = 0;

  for await (const chunk of request) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += bufferChunk.length;
    if (totalLength > 20 * 1024 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(bufferChunk);
  }

  if (!chunks.length) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return ensureObject(parsed);
  } catch {
    throw new Error('Invalid JSON body.');
  }
}

const server = createServer(async (request, response) => {
  setCorsHeaders(response);

  if (!request.url || !request.method) {
    sendJson(response, 400, { error: 'Invalid request.' });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.statusCode = 204;
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && requestUrl.pathname === '/api/projects/snapshot') {
    try {
      const projects = await loadProjectSnapshot();
      sendJson(response, 200, { projects });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : '프로젝트 목록 로드에 실패했습니다.',
      });
    }
    return;
  }

  if (request.method === 'PUT' && requestUrl.pathname === '/api/projects/snapshot') {
    try {
      const body = await readJsonBody(request);
      const projectsRaw = body.projects;
      if (!Array.isArray(projectsRaw)) {
        sendJson(response, 400, { error: '`projects` must be an array.' });
        return;
      }

      const savedCount = await writeProjectSnapshot(projectsRaw);
      sendJson(response, 200, {
        ok: true,
        savedCount,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : '프로젝트 저장에 실패했습니다.',
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
});

server.listen(API_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[business-diagram-api] listening on http://localhost:${API_PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[business-diagram-api] project saves dir: ${PROJECT_SAVES_DIR}`);
});
