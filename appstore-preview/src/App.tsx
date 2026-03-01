import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChangeEvent,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ClipboardPaste,
  Copy,
  Download,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react';
import JSZip from 'jszip';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  CANVAS_PRESETS as CORE_CANVAS_PRESETS,
  FONT_OPTIONS as CORE_FONT_OPTIONS,
  TEXT_BOX_FONT_SIZE_MAX as CORE_TEXT_BOX_FONT_SIZE_MAX,
  TEXT_BOX_FONT_SIZE_MIN as CORE_TEXT_BOX_FONT_SIZE_MIN,
  TEXT_BOX_MIN_WIDTH as CORE_TEXT_BOX_MIN_WIDTH,
  cloneCanvasState as cloneCanvasStateCore,
  cloneProjectDesignState as cloneProjectDesignStateCore,
  createCanvasRecord as createCanvasRecordCore,
  createEmptyCanvasState as createEmptyCanvasStateCore,
  createProjectDesignState as createProjectDesignStateCore,
  createProjectId as createProjectIdCore,
  duplicateProjectState as duplicateProjectStateCore,
  getCanvasDimensionsFromState as getCanvasDimensionsFromStateCore,
  getCanvasPresetById as getCanvasPresetByIdCore,
  getFontFamily as getFontFamilyCore,
  getTextBoxMaxWidthForCanvasWidth as getTextBoxMaxWidthForCanvasWidthCore,
  getTextBoxMaxWidthForPresetId as getTextBoxMaxWidthForPresetIdCore,
  getPhoneBaseMetrics as getPhoneBaseMetricsCore,
  sanitizeFileNameSegment as sanitizeFileNameSegmentCore,
  sanitizeProjectState as sanitizeProjectStateCore,
} from '../shared/project-core';

type MediaKind = 'image' | 'video' | null;
type BackgroundMode = 'solid' | 'gradient';
type ArtifactKind = 'image' | 'video';
type FontKey = (typeof CORE_FONT_OPTIONS)[number]['key'];
type DragTarget = 'phone' | 'text-box' | 'text-box-resize';

interface Offset {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TextBoxModel {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontKey: FontKey;
  fontSize: number;
  color: string;
  measuredLineCountByCanvas?: number | null;
  measuredLineCountByDom?: number | null;
  measuredTextWidthByCanvas?: number | null;
  measuredTextWidthByDom?: number | null;
}

interface TextBoxLayout {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  lineHeight: number;
  lines: string[];
  fontFamily: string;
  fontSize: number;
  color: string;
  bounds: Rect;
}

interface PhoneLayout {
  body: Rect;
  screen: Rect;
  radius: number;
  screenRadius: number;
  notch: Rect;
}

interface LayoutMetrics {
  phone: PhoneLayout;
  textBoxes: TextBoxLayout[];
}

interface Artifact {
  kind: ArtifactKind;
  mimeType: string;
  fileName: string;
  url: string;
}

interface CanvasExportArtifact {
  blob: Blob;
  mimeType: string;
  extension: string;
}

interface AppHistoryProjectSnapshot {
  id: string;
  name: string;
  state: ProjectDesignState;
}

interface AppHistorySnapshot {
  projects: AppHistoryProjectSnapshot[];
  currentProjectId: string;
  currentCanvasId: string;
  selectedTextBoxId: string | null;
}

interface AppHistoryEntry {
  past: AppHistorySnapshot[];
  present: AppHistorySnapshot | null;
  future: AppHistorySnapshot[];
}

interface CanvasDesignState {
  canvasPresetId: string;
  backgroundMode: BackgroundMode;
  backgroundPrimary: string;
  backgroundSecondary: string;
  gradientAngle: number;
  phoneOffset: Offset;
  phoneScale: number;
  textBoxes: TextBoxModel[];
  media: {
    kind: MediaKind;
    name: string;
  };
}

interface ProjectCanvasRecord {
  id: string;
  name: string;
  state: CanvasDesignState;
  thumbnailDataUrl?: string;
}

interface ProjectDesignState {
  canvases: ProjectCanvasRecord[];
  currentCanvasId: string;
}

interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: string;
  revision: number;
  state: ProjectDesignState;
}

interface ProjectFilePayload {
  version: 2;
  project: {
    id: string;
    name: string;
    updatedAt: string;
    revision?: number;
  };
  canvas: {
    width: number;
    height: number;
  };
  state: ProjectDesignState;
}

interface DrawOptions {
  width: number;
  height: number;
  backgroundMode: BackgroundMode;
  backgroundPrimary: string;
  backgroundSecondary: string;
  gradientAngle: number;
  phoneOffset: Offset;
  phoneScale: number;
  textBoxes: TextBoxModel[];
  selectedTextBoxId: string | null;
  showGuides: boolean;
  snapGuide?: {
    vertical: boolean;
    horizontal: boolean;
  };
  emptyStateFileLabel?: string;
  media: HTMLImageElement | HTMLVideoElement | null;
}

interface DragSession {
  target: DragTarget;
  pointerId: number;
  startPoint: Offset;
  startPhoneOffset: Offset;
  axisLock?: 'x' | 'y' | null;
  textBoxId?: string;
  startTextBoxPosition?: Offset;
  startTextBoxSize?: { width: number; height: number };
  moved: boolean;
}

const CANVAS_PRESETS = CORE_CANVAS_PRESETS.map((preset, index) =>
  index === 0 ? { ...preset, label: '886 x 1920 (기본)' } : preset,
);

const DEFAULT_CANVAS_PRESET = CANVAS_PRESETS[0];
const DEFAULT_CANVAS_PRESET_ID = DEFAULT_CANVAS_PRESET.id;
const CENTER_SNAP_THRESHOLD_PX = 5;

const FONT_OPTIONS = CORE_FONT_OPTIONS;

const DEFAULTS = {
  backgroundMode: 'solid' as BackgroundMode,
  backgroundPrimary: '#f2f4f7',
  backgroundSecondary: '#dbeafe',
  gradientAngle: 26,
  phoneScale: 1,
};

const LEGACY_LOCAL_PROJECTS_STORAGE_KEY = 'appstore-preview.projects.v1';
const LEGACY_LOCAL_CURRENT_PROJECT_STORAGE_KEY = 'appstore-preview.current-project.v1';
const API_SOT_MIGRATION_MARKER_KEY = 'appstore-preview.api-sot-migrated.v1';
const PROJECT_AUTOSAVE_DELAY_MS = 700;
const CANVAS_THUMBNAIL_AUTOSAVE_DELAY_MS = 280;
const CANVAS_THUMBNAIL_WIDTH = 154;
const TEXT_BOX_RESIZE_HANDLE_SIZE = 20;
const TEXT_BOX_MIN_WIDTH = CORE_TEXT_BOX_MIN_WIDTH;
const TEXT_BOX_FONT_SIZE_MIN = CORE_TEXT_BOX_FONT_SIZE_MIN;
const TEXT_BOX_FONT_SIZE_MAX = CORE_TEXT_BOX_FONT_SIZE_MAX;
const PHONE_SCALE_PERCENT_MIN = 50;
const PHONE_SCALE_PERCENT_MAX = 180;
const HISTORY_LIMIT_PER_CANVAS = 120;
const HISTORY_IDLE_COMMIT_DELAY_MS = 100;
const PROJECT_MEDIA_DB_NAME = 'appstore-preview-media-db';
const PROJECT_MEDIA_DB_VERSION = 1;
const PROJECT_MEDIA_STORE_NAME = 'project_media';
const CANVAS_CLIPBOARD_PREFIX = 'appstore-preview-canvas/v1:';

interface FileHandleLike {
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>;
    close: () => Promise<void>;
  }>;
}

interface DirectoryHandleLike {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<DirectoryHandleLike>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileHandleLike>;
}

interface ProjectMediaRecord {
  projectId: string;
  kind: Exclude<MediaKind, null>;
  name: string;
  type: string;
  blob: Blob;
  updatedAt: string;
}

interface CanvasClipboardPayload {
  version: 1;
  sourceProjectId: string;
  sourceCanvasId: string;
  canvasName: string;
  state: CanvasDesignState;
  copiedAt: string;
}

interface InMemoryCanvasClipboardPayload extends CanvasClipboardPayload {
  thumbnailDataUrl?: string;
  mediaRecord: ProjectMediaRecord | null;
}

interface ApiProjectSummaryPayload {
  id: string;
  name: string;
  updatedAt: string;
  revision?: number;
  canvasCount: number;
  currentCanvasId: string;
  source: string;
}

interface ApiProjectListPayload {
  projects?: ApiProjectSummaryPayload[];
  total?: number;
}

interface ApiProjectDetailPayload {
  project?: {
    id: string;
    name: string;
    updatedAt: string;
    revision?: number;
  };
  state?: unknown;
}

interface ApiCanvasMediaPutPayload {
  project?: {
    id?: string;
    updatedAt?: string;
    revision?: number;
  };
  canvasId?: string;
  media?: {
    kind?: 'image' | 'video';
    name?: string;
  };
}

function getCanvasPresetById(id: string) {
  return getCanvasPresetByIdCore(id);
}

function getCanvasDimensionsFromState(state: CanvasDesignState) {
  return getCanvasDimensionsFromStateCore(state);
}

function getTextBoxMaxWidthForCanvasWidth(canvasWidth: number) {
  return getTextBoxMaxWidthForCanvasWidthCore(canvasWidth);
}

function getTextBoxMaxWidthForPresetId(presetId: string) {
  return getTextBoxMaxWidthForPresetIdCore(presetId);
}

function getCanvasThumbnailHeight(width: number, height: number) {
  return Math.max(1, Math.round((CANVAS_THUMBNAIL_WIDTH * height) / width));
}

function getPhoneBaseMetrics(canvasWidth: number, canvasHeight: number, phoneScale: number) {
  return getPhoneBaseMetricsCore(canvasWidth, canvasHeight, phoneScale);
}

function cloneProjectDesignState(state: ProjectDesignState): ProjectDesignState {
  return cloneProjectDesignStateCore(state);
}

function cloneAppHistorySnapshot(snapshot: AppHistorySnapshot): AppHistorySnapshot {
  return {
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      name: project.name,
      state: cloneProjectDesignState(project.state),
    })),
    currentProjectId: snapshot.currentProjectId,
    currentCanvasId: snapshot.currentCanvasId,
    selectedTextBoxId: snapshot.selectedTextBoxId,
  };
}

function areAppHistorySnapshotsEqual(left: AppHistorySnapshot, right: AppHistorySnapshot) {
  if (left.currentProjectId !== right.currentProjectId) {
    return false;
  }

  if (left.currentCanvasId !== right.currentCanvasId) {
    return false;
  }

  if (left.selectedTextBoxId !== right.selectedTextBoxId) {
    return false;
  }

  return JSON.stringify(left.projects) === JSON.stringify(right.projects);
}

function createEmptyCanvasState(): CanvasDesignState {
  return createEmptyCanvasStateCore();
}

function cloneCanvasState(state: CanvasDesignState): CanvasDesignState {
  return cloneCanvasStateCore(state);
}

function createProjectId() {
  return createProjectIdCore();
}

function createCanvasRecord(name: string, state: CanvasDesignState = createEmptyCanvasState()): ProjectCanvasRecord {
  return createCanvasRecordCore(name, state);
}

function createProjectDesignState(initialCanvas?: ProjectCanvasRecord): ProjectDesignState {
  return createProjectDesignStateCore(initialCanvas, {
    defaultCanvasName: '캔버스 1',
    canvasNamePrefix: '캔버스',
  });
}

function createProjectRecord(name: string, state: ProjectDesignState = createProjectDesignState()): ProjectRecord {
  return {
    id: createProjectId(),
    name,
    updatedAt: new Date().toISOString(),
    revision: 0,
    state: {
      currentCanvasId: state.currentCanvasId,
      canvases: state.canvases.map((canvas) => ({
        id: canvas.id,
        name: canvas.name,
        state: cloneCanvasState(canvas.state),
        thumbnailDataUrl: canvas.thumbnailDataUrl,
      })),
    },
  };
}

function getNextTextBoxSerial(textBoxes: TextBoxModel[]) {
  return (
    textBoxes.reduce((maximum, box) => {
      const numeric = Number(box.id.replace(/^text-/, ''));
      if (Number.isNaN(numeric)) {
        return maximum;
      }

      return Math.max(maximum, numeric);
    }, 0) + 1
  );
}

function createNextProjectName(projects: ProjectRecord[]) {
  const existing = new Set(projects.map((project) => project.name));
  let index = projects.length + 1;

  while (existing.has(`프로젝트 ${index}`)) {
    index += 1;
  }

  return `프로젝트 ${index}`;
}

function createNextCanvasName(canvases: ProjectCanvasRecord[]) {
  const existing = new Set(canvases.map((canvas) => canvas.name));
  let index = canvases.length + 1;

  while (existing.has(`캔버스 ${index}`)) {
    index += 1;
  }

  return `캔버스 ${index}`;
}

function createDuplicateName(existingNames: string[], sourceName: string) {
  const existing = new Set(existingNames);
  const baseName = sourceName.trim() || '이름 없음';
  const firstCandidate = `${baseName} 복사본`;
  if (!existing.has(firstCandidate)) {
    return firstCandidate;
  }

  let index = 2;
  while (existing.has(`${baseName} 복사본 ${index}`)) {
    index += 1;
  }

  return `${baseName} 복사본 ${index}`;
}

function sanitizeFileNameSegment(name: string) {
  return sanitizeFileNameSegmentCore(name);
}

function buildProjectCanvasMediaKey(projectId: string, canvasId: string) {
  return `${projectId}::${canvasId}`;
}

function sanitizeProjectState(state: unknown): ProjectDesignState {
  return sanitizeProjectStateCore(state, {
    defaultCanvasName: '캔버스 1',
    canvasNamePrefix: '캔버스',
    legacyFallback: true,
  });
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function focusElementWithoutScroll(element: HTMLElement | null) {
  if (!element) {
    return;
  }

  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

function parseStoredProjects(raw: string | null) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (item): item is { id?: unknown; name?: unknown; updatedAt?: unknown; revision?: unknown; state?: unknown } =>
          Boolean(item && typeof item === 'object'),
      )
      .map((item) => {
        if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.updatedAt !== 'string') {
          return null;
        }

        const revision =
          typeof item.revision === 'number' && Number.isFinite(item.revision)
            ? Math.max(0, Math.floor(item.revision))
            : 0;

        return {
          id: item.id,
          name: item.name,
          updatedAt: item.updatedAt,
          revision,
          state: sanitizeProjectState(item.state),
        } satisfies ProjectRecord;
      })
      .filter((item): item is ProjectRecord => Boolean(item));
  } catch {
    return [];
  }
}

function getLegacyLocalProjectStore() {
  if (typeof window === 'undefined') {
    return {
      projects: [] as ProjectRecord[],
      currentProjectId: '',
    };
  }
  try {
    const storedProjects = parseStoredProjects(window.localStorage.getItem(LEGACY_LOCAL_PROJECTS_STORAGE_KEY));
    if (storedProjects.length === 0) {
      return {
        projects: [] as ProjectRecord[],
        currentProjectId: '',
      };
    }

    const storedCurrentProjectId = window.localStorage.getItem(LEGACY_LOCAL_CURRENT_PROJECT_STORAGE_KEY);
    const currentProjectId = storedProjects.some((project) => project.id === storedCurrentProjectId)
      ? (storedCurrentProjectId as string)
      : storedProjects[0].id;

    return {
      projects: storedProjects,
      currentProjectId,
    };
  } catch {
    return {
      projects: [] as ProjectRecord[],
      currentProjectId: '',
    };
  }
}

async function openProjectMediaDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(PROJECT_MEDIA_DB_NAME, PROJECT_MEDIA_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_MEDIA_STORE_NAME)) {
        db.createObjectStore(PROJECT_MEDIA_STORE_NAME, { keyPath: 'projectId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB를 열지 못했습니다.'));
  });
}

async function saveProjectMediaRecord(record: ProjectMediaRecord) {
  const db = await openProjectMediaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECT_MEDIA_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PROJECT_MEDIA_STORE_NAME);
    store.put(record);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('미디어 저장에 실패했습니다.'));
    tx.onabort = () => reject(tx.error ?? new Error('미디어 저장이 중단되었습니다.'));
  });
  db.close();
}

async function readProjectMediaRecord(projectId: string) {
  const db = await openProjectMediaDb();
  const result = await new Promise<ProjectMediaRecord | null>((resolve, reject) => {
    const tx = db.transaction(PROJECT_MEDIA_STORE_NAME, 'readonly');
    const store = tx.objectStore(PROJECT_MEDIA_STORE_NAME);
    const request = store.get(projectId);

    request.onsuccess = () => {
      const value = request.result as ProjectMediaRecord | undefined;
      resolve(value ?? null);
    };
    request.onerror = () => reject(request.error ?? new Error('미디어 조회에 실패했습니다.'));
  });
  db.close();
  return result;
}

async function removeProjectMediaRecord(projectId: string) {
  const db = await openProjectMediaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(PROJECT_MEDIA_STORE_NAME, 'readwrite');
    const store = tx.objectStore(PROJECT_MEDIA_STORE_NAME);
    store.delete(projectId);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('미디어 삭제에 실패했습니다.'));
    tx.onabort = () => reject(tx.error ?? new Error('미디어 삭제가 중단되었습니다.'));
  });
  db.close();
}

async function findProjectMediaRecordByKindAndName(kind: Exclude<MediaKind, null>, name: string) {
  const db = await openProjectMediaDb();
  const result = await new Promise<ProjectMediaRecord | null>((resolve, reject) => {
    const tx = db.transaction(PROJECT_MEDIA_STORE_NAME, 'readonly');
    const store = tx.objectStore(PROJECT_MEDIA_STORE_NAME);
    const request = store.openCursor();
    let matched: ProjectMediaRecord | null = null;

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(matched);
        return;
      }

      const value = cursor.value as ProjectMediaRecord | undefined;
      if (value && value.kind === kind && value.name === name) {
        if (!matched) {
          matched = value;
        } else {
          const previousTs = Date.parse(matched.updatedAt);
          const nextTs = Date.parse(value.updatedAt);
          if ((Number.isNaN(previousTs) && !Number.isNaN(nextTs)) || nextTs > previousTs) {
            matched = value;
          }
        }
      }

      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('미디어 검색에 실패했습니다.'));
  });
  db.close();
  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function applyCenterSnap(
  position: Offset,
  size: { width: number; height: number },
  canvas: { width: number; height: number },
  threshold: { x: number; y: number },
) {
  let nextX = position.x;
  let nextY = position.y;

  const centerX = position.x + size.width / 2;
  const centerY = position.y + size.height / 2;
  const canvasCenterX = canvas.width / 2;
  const canvasCenterY = canvas.height / 2;

  const snapX = Math.abs(centerX - canvasCenterX) <= threshold.x;
  const snapY = Math.abs(centerY - canvasCenterY) <= threshold.y;

  if (snapX) {
    nextX = canvasCenterX - size.width / 2;
  }

  if (snapY) {
    nextY = canvasCenterY - size.height / 2;
  }

  return {
    position: { x: nextX, y: nextY },
    snapX,
    snapY,
  };
}

function pointInRect(point: Offset, rect: Rect) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function expandRect(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function getTextBoxResizeHandleRect(bounds: Rect) {
  const size = TEXT_BOX_RESIZE_HANDLE_SIZE;
  return {
    x: bounds.x + bounds.width - size / 2,
    y: bounds.y + bounds.height - size / 2,
    width: size,
    height: size,
  };
}

function getFirstMediaFile(files: FileList | null) {
  if (!files) {
    return null;
  }

  for (const file of Array.from(files)) {
    if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
      return file;
    }
  }

  return null;
}

function measureTextBoxBounds(box: TextBoxModel, maxTextBoxWidth: number): Rect {
  const fontFamily = getFontFamily(box.fontKey);
  const fontSize = clamp(box.fontSize, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
  const width = clamp(box.width, TEXT_BOX_MIN_WIDTH, maxTextBoxWidth);
  const lineHeight = fontSize * 1.2;

  if (typeof document === 'undefined') {
    return {
      x: box.x,
      y: box.y,
      width,
      height: lineHeight,
    };
  }

  const measurementCanvas = document.createElement('canvas');
  const ctx = measurementCanvas.getContext('2d');
  if (!ctx) {
    return {
      x: box.x,
      y: box.y,
      width,
      height: lineHeight,
    };
  }

  ctx.font = `800 ${fontSize}px ${fontFamily}`;
  const lines = wrapTextToLines(ctx, box.text, width);
  const height = Math.max(lineHeight, lines.length * lineHeight);
  return {
    x: box.x,
    y: box.y,
    width,
    height,
  };
}

function centerCanvasElements(state: CanvasDesignState): CanvasDesignState {
  const canvasSize = getCanvasDimensionsFromState(state);
  const maxTextBoxWidth = getTextBoxMaxWidthForCanvasWidth(canvasSize.width);
  const basePhone = getPhoneBaseMetrics(canvasSize.width, canvasSize.height, state.phoneScale);
  const targetPhoneX = (canvasSize.width - basePhone.width) / 2;

  return {
    ...state,
    phoneOffset: {
      x: targetPhoneX - basePhone.x,
      y: state.phoneOffset.y,
    },
    textBoxes: state.textBoxes.map((box) => {
      const boxBounds = measureTextBoxBounds(box, maxTextBoxWidth);
      return {
        ...box,
        x: (canvasSize.width - boxBounds.width) / 2,
        y: box.y,
      };
    }),
  };
}

function computeSingleLineMinWidthByCanvas(
  box: Pick<TextBoxModel, 'text' | 'fontSize' | 'fontKey'>,
  maxTextBoxWidth: number,
): number {
  if (typeof document === 'undefined') {
    return TEXT_BOX_MIN_WIDTH;
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return TEXT_BOX_MIN_WIDTH;
  }

  const fontFamily = getFontFamily(box.fontKey);
  const fontSize = clamp(box.fontSize, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
  // Newline is an explicit line break, so we replace it with a space for "single-line fit" width.
  const textForSingleLine = box.text.replace(/\r\n/g, '\n').split('\n').join(' ');
  if (!textForSingleLine.length) {
    return TEXT_BOX_MIN_WIDTH;
  }

  ctx.font = `800 ${fontSize}px ${fontFamily}`;
  const measured = ctx.measureText(textForSingleLine).width;
  return clamp(Math.ceil(measured + 1), TEXT_BOX_MIN_WIDTH, maxTextBoxWidth);
}

type DomTextMeasureContext = {
  host: HTMLDivElement;
  textNode: Text;
  range: Range;
};

let domTextMeasureContext: DomTextMeasureContext | null = null;

function getDomTextMeasureContext(): DomTextMeasureContext | null {
  if (typeof document === 'undefined' || !document.body) {
    return null;
  }

  if (domTextMeasureContext) {
    return domTextMeasureContext;
  }

  const host = document.createElement('div');
  host.setAttribute('data-appstore-preview-text-measure', 'true');
  host.style.position = 'fixed';
  host.style.left = '-100000px';
  host.style.top = '0';
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '-1';
  host.style.margin = '0';
  host.style.padding = '0';
  host.style.border = '0';
  host.style.boxSizing = 'border-box';
  host.style.whiteSpace = 'pre-wrap';
  host.style.overflowWrap = 'anywhere';
  host.style.wordBreak = 'break-word';

  const textNode = document.createTextNode('');
  host.appendChild(textNode);
  document.body.appendChild(host);

  const range = document.createRange();
  range.selectNodeContents(textNode);
  domTextMeasureContext = { host, textNode, range };
  return domTextMeasureContext;
}

function measureTextMetricsByDom(
  box: Pick<TextBoxModel, 'text' | 'width' | 'fontSize' | 'fontKey'>,
  maxTextBoxWidth: number,
): {
  lineCount: number;
  textWidth: number;
} | null {
  const context = getDomTextMeasureContext();
  if (!context) {
    return null;
  }

  const { host, textNode, range } = context;
  const width = clamp(box.width, TEXT_BOX_MIN_WIDTH, maxTextBoxWidth);
  const fontSize = clamp(box.fontSize, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
  const fontFamily = getFontFamily(box.fontKey);

  host.style.width = `${width}px`;
  host.style.fontFamily = fontFamily;
  host.style.fontSize = `${fontSize}px`;
  host.style.fontWeight = '800';
  const lineHeight = fontSize * 1.2;
  host.style.lineHeight = `${lineHeight}px`;
  textNode.nodeValue = box.text;
  range.selectNodeContents(textNode);

  const hostRect = host.getBoundingClientRect();
  const lineCountByHeight = Math.max(1, Math.round(hostRect.height / Math.max(1, lineHeight)));

  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const lineRects: Array<{ top: number; left: number; right: number }> = [];
  const sortedRects = [...rects].sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top));
  for (const rect of sortedRects) {
    const existing = lineRects.find((line) => Math.abs(line.top - rect.top) < 1);
    if (!existing) {
      lineRects.push({ top: rect.top, left: rect.left, right: rect.right });
      continue;
    }

    existing.left = Math.min(existing.left, rect.left);
    existing.right = Math.max(existing.right, rect.right);
  }

  const textWidth = lineRects.reduce((sum, line) => sum + Math.max(0, line.right - line.left), 0);
  const lineCount = Math.max(lineCountByHeight, lineRects.length, 1);
  return {
    lineCount,
    textWidth,
  };
}

function measureTextMetricsByCanvas(
  box: Pick<TextBoxModel, 'text' | 'width' | 'fontSize' | 'fontKey'>,
  maxTextBoxWidth: number,
): {
  lineCount: number;
  textWidth: number;
} {
  if (typeof document === 'undefined') {
    return { lineCount: 1, textWidth: 0 };
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { lineCount: 1, textWidth: 0 };
  }

  const fontFamily = getFontFamily(box.fontKey);
  const fontSize = clamp(box.fontSize, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
  const width = clamp(box.width, TEXT_BOX_MIN_WIDTH, maxTextBoxWidth);
  ctx.font = `800 ${fontSize}px ${fontFamily}`;
  const lines = wrapTextToLines(ctx, box.text, width);
  const textWidth = lines.reduce((sum, line) => sum + ctx.measureText(line).width, 0);
  return { lineCount: lines.length, textWidth };
}

function measureTextMetrics(
  box: Pick<TextBoxModel, 'text' | 'width' | 'fontSize' | 'fontKey'>,
  maxTextBoxWidth: number,
): {
  lineCountByCanvas: number;
  lineCountByDom: number | null;
  textWidthByCanvas: number;
  textWidthByDom: number | null;
} {
  const canvasMeasured = measureTextMetricsByCanvas(box, maxTextBoxWidth);
  const domMeasured = measureTextMetricsByDom(box, maxTextBoxWidth);
  return {
    lineCountByCanvas: canvasMeasured.lineCount,
    textWidthByCanvas: canvasMeasured.textWidth,
    lineCountByDom:
      typeof domMeasured?.lineCount === 'number' && Number.isFinite(domMeasured.lineCount)
        ? Math.max(1, Math.floor(domMeasured.lineCount))
        : null,
    textWidthByDom:
      typeof domMeasured?.textWidth === 'number' && Number.isFinite(domMeasured.textWidth)
        ? Math.max(0, domMeasured.textWidth)
        : null,
  };
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: BackgroundMode,
  primary: string,
  secondary: string,
  angle: number,
) {
  if (mode === 'solid') {
    ctx.fillStyle = primary;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const rad = (angle * Math.PI) / 180;
  const halfDiagonal = Math.sqrt(width ** 2 + height ** 2) / 2;
  const cx = width / 2;
  const cy = height / 2;

  const x0 = cx - Math.cos(rad) * halfDiagonal;
  const y0 = cy - Math.sin(rad) * halfDiagonal;
  const x1 = cx + Math.cos(rad) * halfDiagonal;
  const y1 = cy + Math.sin(rad) * halfDiagonal;

  const gradient = ctx.createLinearGradient(x0, y0, x1, y1);
  gradient.addColorStop(0, primary);
  gradient.addColorStop(1, secondary);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawMediaCover(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
) {
  const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
  const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;

  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return;
  }

  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = dw / dh;

  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(media, sx, sy, sw, sh, dx, dy, dw, dh);
}

function wrapTextToLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.trim().length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let current = '';

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
      }

      if (ctx.measureText(word).width <= maxWidth) {
        current = word;
        continue;
      }

      let fragment = '';
      for (const char of word) {
        const charCandidate = `${fragment}${char}`;
        if (ctx.measureText(charCandidate).width <= maxWidth) {
          fragment = charCandidate;
        } else {
          if (fragment.length > 0) {
            lines.push(fragment);
          }
          fragment = char;
        }
      }
      current = fragment;
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [''];
}

function getFontFamily(fontKey: FontKey) {
  return getFontFamilyCore(fontKey);
}

function computeLayoutMetrics(ctx: CanvasRenderingContext2D, options: DrawOptions): LayoutMetrics {
  const { width, height, phoneOffset, phoneScale, textBoxes } = options;
  const maxTextBoxWidth = getTextBoxMaxWidthForCanvasWidth(width);

  const basePhone = getPhoneBaseMetrics(width, height, phoneScale);
  const scaledPhoneWidth = basePhone.width;
  const scaledPhoneHeight = basePhone.height;
  const phoneX = basePhone.x + phoneOffset.x;
  const phoneY = basePhone.y + phoneOffset.y;

  const screenInset = 22 * phoneScale;
  const screenX = phoneX + screenInset;
  const screenY = phoneY + screenInset;
  const screenWidth = scaledPhoneWidth - screenInset * 2;
  const screenHeight = scaledPhoneHeight - screenInset * 2;

  const textBoxLayouts: TextBoxLayout[] = textBoxes.map((box) => {
    const fontFamily = getFontFamily(box.fontKey);
    const fontSize = clamp(box.fontSize, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
    const widthValue = clamp(box.width, TEXT_BOX_MIN_WIDTH, maxTextBoxWidth);
    const lineHeight = fontSize * 1.2;

    ctx.save();
    ctx.font = `800 ${fontSize}px ${fontFamily}`;
    const lines = wrapTextToLines(ctx, box.text, widthValue);
    ctx.restore();

    const heightValue = Math.max(lineHeight, lines.length * lineHeight);

    return {
      id: box.id,
      x: box.x,
      y: box.y,
      width: widthValue,
      height: heightValue,
      lineHeight,
      lines,
      fontFamily,
      fontSize,
      color: box.color,
      bounds: {
        x: box.x,
        y: box.y,
        width: widthValue,
        height: heightValue,
      },
    };
  });

  return {
    phone: {
      body: { x: phoneX, y: phoneY, width: scaledPhoneWidth, height: scaledPhoneHeight },
      screen: { x: screenX, y: screenY, width: screenWidth, height: screenHeight },
      radius: 104 * phoneScale,
      screenRadius: 76 * phoneScale,
      notch: {
        x: screenX + (screenWidth - 194 * phoneScale) / 2,
        y: screenY + 14 * phoneScale,
        width: 194 * phoneScale,
        height: 46 * phoneScale,
      },
    },
    textBoxes: textBoxLayouts,
  };
}

function drawComposition(ctx: CanvasRenderingContext2D, options: DrawOptions): LayoutMetrics {
  const {
    width,
    height,
    backgroundMode,
    backgroundPrimary,
    backgroundSecondary,
    gradientAngle,
    selectedTextBoxId,
    showGuides,
    snapGuide,
    emptyStateFileLabel,
    media,
  } = options;

  const layout = computeLayoutMetrics(ctx, options);

  fillBackground(ctx, width, height, backgroundMode, backgroundPrimary, backgroundSecondary, gradientAngle);

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  for (const textLayout of layout.textBoxes) {
    const sourceBox = options.textBoxes.find((box) => box.id === textLayout.id);
    const text = sourceBox?.text ?? '';

    ctx.fillStyle = textLayout.color;
    ctx.font = `800 ${textLayout.fontSize}px ${textLayout.fontFamily}`;

    if (text.trim().length > 0) {
      textLayout.lines.forEach((line, lineIndex) => {
        ctx.fillText(line, textLayout.x, textLayout.y + lineIndex * textLayout.lineHeight);
      });
    }

    if (showGuides) {
      ctx.save();
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = textLayout.id === selectedTextBoxId ? 3 : 2;
      ctx.strokeStyle = textLayout.id === selectedTextBoxId ? 'rgba(37, 99, 235, 0.9)' : 'rgba(100, 116, 139, 0.5)';
      ctx.strokeRect(textLayout.bounds.x, textLayout.bounds.y, textLayout.bounds.width, textLayout.bounds.height);

      if (textLayout.id === selectedTextBoxId) {
        const handleRect = getTextBoxResizeHandleRect(textLayout.bounds);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(37, 99, 235, 0.95)';
        ctx.fillRect(handleRect.x, handleRect.y, handleRect.width, handleRect.height);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 2;
        ctx.strokeRect(handleRect.x, handleRect.y, handleRect.width, handleRect.height);
      }

      ctx.restore();
    }
  }

  ctx.restore();

  const { body, screen, radius, screenRadius, notch } = layout.phone;

  ctx.save();
  const bodyGradient = ctx.createLinearGradient(body.x, body.y, body.x + body.width, body.y + body.height);
  bodyGradient.addColorStop(0, '#0f172a');
  bodyGradient.addColorStop(0.5, '#111827');
  bodyGradient.addColorStop(1, '#374151');

  roundedRectPath(ctx, body.x, body.y, body.width, body.height, radius);
  ctx.fillStyle = bodyGradient;
  ctx.fill();

  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 5 * options.phoneScale;
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  roundedRectPath(ctx, body.x - 5 * options.phoneScale, body.y + 292 * options.phoneScale, 6 * options.phoneScale, 110 * options.phoneScale, 4 * options.phoneScale);
  ctx.fill();
  roundedRectPath(ctx, body.x - 5 * options.phoneScale, body.y + 436 * options.phoneScale, 6 * options.phoneScale, 68 * options.phoneScale, 4 * options.phoneScale);
  ctx.fill();
  roundedRectPath(ctx, body.x + body.width - 1 * options.phoneScale, body.y + 350 * options.phoneScale, 6 * options.phoneScale, 140 * options.phoneScale, 4 * options.phoneScale);
  ctx.fill();

  roundedRectPath(ctx, screen.x, screen.y, screen.width, screen.height, screenRadius);
  ctx.clip();
  ctx.fillStyle = '#dfe5ee';
  ctx.fillRect(screen.x, screen.y, screen.width, screen.height);

  const mediaReady =
    media instanceof HTMLVideoElement
      ? media.readyState >= 2 && media.videoWidth > 0 && media.videoHeight > 0
      : media instanceof HTMLImageElement
        ? media.naturalWidth > 0 && media.naturalHeight > 0
        : false;

  if (media && mediaReady) {
    drawMediaCover(ctx, media, screen.x, screen.y, screen.width, screen.height);
  } else {
    ctx.fillStyle = '#e5e7eb';
    ctx.fillRect(screen.x, screen.y, screen.width, screen.height);

    const hintPadding = 48 * options.phoneScale;
    const hintWidth = screen.width - hintPadding * 2;
    const hintHeight = 280 * options.phoneScale;
    const hintX = screen.x + hintPadding;
    const hintY = screen.y + screen.height / 2 - hintHeight / 2;

    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    roundedRectPath(ctx, hintX, hintY, hintWidth, hintHeight, 28 * options.phoneScale);
    ctx.fill();

    ctx.setLineDash([14 * options.phoneScale, 10 * options.phoneScale]);
    ctx.lineWidth = 3 * options.phoneScale;
    ctx.strokeStyle = 'rgba(71, 85, 105, 0.55)';
    ctx.stroke();
    ctx.setLineDash([]);

    const iconCenterX = hintX + hintWidth / 2;
    const iconTopY = hintY + 58 * options.phoneScale;
    const iconSize = 30 * options.phoneScale;

    ctx.beginPath();
    ctx.moveTo(iconCenterX, iconTopY);
    ctx.lineTo(iconCenterX, iconTopY + iconSize);
    ctx.moveTo(iconCenterX - 12 * options.phoneScale, iconTopY + 12 * options.phoneScale);
    ctx.lineTo(iconCenterX, iconTopY);
    ctx.lineTo(iconCenterX + 12 * options.phoneScale, iconTopY + 12 * options.phoneScale);
    ctx.strokeStyle = 'rgba(37, 99, 235, 0.85)';
    ctx.lineWidth = 4 * options.phoneScale;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.font = `800 ${34 * options.phoneScale}px "Noto Sans KR", sans-serif`;
    ctx.fillText('이미지/영상을 업로드해주세요', iconCenterX, hintY + 108 * options.phoneScale);

    ctx.font = `600 ${24 * options.phoneScale}px "Noto Sans KR", sans-serif`;
    ctx.fillStyle = 'rgba(51, 65, 85, 0.88)';
    ctx.fillText(emptyStateFileLabel ?? '선택된 파일 없음', iconCenterX, hintY + 162 * options.phoneScale);

    ctx.font = `600 ${22 * options.phoneScale}px "Noto Sans KR", sans-serif`;
    ctx.fillStyle = 'rgba(30, 64, 175, 0.85)';
    ctx.fillText('드래그 앤 드롭 가능', iconCenterX, hintY + 206 * options.phoneScale);
  }

  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, notch.x, notch.y, notch.width, notch.height, (23 * options.phoneScale));
  ctx.fillStyle = '#020617';
  ctx.fill();
  ctx.restore();

  if (showGuides) {
    ctx.save();
    ctx.setLineDash([12, 10]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.4)';
    ctx.strokeRect(body.x, body.y, body.width, body.height);
    ctx.restore();

    if (snapGuide?.vertical || snapGuide?.horizontal) {
      ctx.save();
      ctx.setLineDash([10, 10]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(37, 99, 235, 0.9)';

      if (snapGuide.vertical) {
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.stroke();
      }

      if (snapGuide.horizontal) {
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  return layout;
}

function createCanvasThumbnailDataUrl(
  state: CanvasDesignState,
  media: HTMLImageElement | HTMLVideoElement | null,
) {
  const canvasSize = getCanvasDimensionsFromState(state);
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = canvasSize.width;
  fullCanvas.height = canvasSize.height;

  const fullCtx = fullCanvas.getContext('2d');
  if (!fullCtx) {
    return '';
  }

  drawComposition(fullCtx, {
    width: canvasSize.width,
    height: canvasSize.height,
    backgroundMode: state.backgroundMode,
    backgroundPrimary: state.backgroundPrimary,
    backgroundSecondary: state.backgroundSecondary,
    gradientAngle: state.gradientAngle,
    phoneOffset: state.phoneOffset,
    phoneScale: state.phoneScale,
    textBoxes: state.textBoxes,
    selectedTextBoxId: null,
    showGuides: false,
    snapGuide: undefined,
    emptyStateFileLabel: state.media.name || '선택된 파일 없음',
    media,
  });

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = CANVAS_THUMBNAIL_WIDTH;
  thumbCanvas.height = getCanvasThumbnailHeight(canvasSize.width, canvasSize.height);

  const thumbCtx = thumbCanvas.getContext('2d');
  if (!thumbCtx) {
    return '';
  }

  thumbCtx.drawImage(fullCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  return thumbCanvas.toDataURL('image/jpeg', 0.82);
}

function pickRecorderMimeType() {
  const candidates = [
    'video/mp4;codecs=avc1.4D401E,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

function buildOutputFileName(sourceName: string, extension: string) {
  const stem = sourceName.replace(/\.[^/.]+$/, '') || 'appstore-preview';
  const timestamp = Date.now();
  return `${stem}-preview-${timestamp}.${extension}`;
}

function buildBatchCanvasOutputFileName(index: number, canvasName: string, extension: string) {
  const indexLabel = String(index + 1).padStart(2, '0');
  const safeCanvasName = sanitizeFileNameSegment(canvasName || `canvas-${index + 1}`);
  return `${indexLabel}-${safeCanvasName}.${extension}`;
}

function encodeCanvasClipboardPayload(payload: CanvasClipboardPayload) {
  return `${CANVAS_CLIPBOARD_PREFIX}${JSON.stringify(payload)}`;
}

function decodeCanvasClipboardPayloadText(rawText: string): CanvasClipboardPayload | null {
  if (!rawText.startsWith(CANVAS_CLIPBOARD_PREFIX)) {
    return null;
  }

  const jsonText = rawText.slice(CANVAS_CLIPBOARD_PREFIX.length);
  if (!jsonText) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonText) as Partial<CanvasClipboardPayload>;
    if (
      parsed.version !== 1 ||
      typeof parsed.sourceProjectId !== 'string' ||
      typeof parsed.sourceCanvasId !== 'string' ||
      typeof parsed.canvasName !== 'string' ||
      typeof parsed.copiedAt !== 'string'
    ) {
      return null;
    }

    const normalized = sanitizeProjectStateCore(
      {
        canvases: [
          {
            id: 'clipboard-canvas',
            name: parsed.canvasName,
            state: parsed.state,
          },
        ],
        currentCanvasId: 'clipboard-canvas',
      },
      {
        defaultCanvasName: '캔버스 1',
        canvasNamePrefix: '캔버스',
        legacyFallback: true,
      },
    );
    const normalizedState = normalized.canvases[0]?.state ?? createEmptyCanvasStateCore();

    return {
      version: 1,
      sourceProjectId: parsed.sourceProjectId,
      sourceCanvasId: parsed.sourceCanvasId,
      canvasName: parsed.canvasName,
      state: cloneCanvasStateCore(normalizedState),
      copiedAt: parsed.copiedAt,
    };
  } catch {
    return null;
  }
}

async function blobFromCanvas(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('이미지 생성에 실패했습니다.'));
      }
    }, 'image/png');
  });
}

function App() {
  const initialProjectRef = useRef<ProjectRecord | null>(null);
  if (!initialProjectRef.current) {
    initialProjectRef.current = createProjectRecord('프로젝트 1');
  }
  const initialProject = initialProjectRef.current;

  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inlineTextEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const assetUrlRef = useRef<string | null>(null);
  const artifactUrlRef = useRef<string | null>(null);
  const layoutRef = useRef<LayoutMetrics | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const suppressCanvasClickRef = useRef(false);
  const uploadDropDepthRef = useRef(0);
  const canvasDropDepthRef = useRef(0);
  const initialCanvas =
    initialProject.state.canvases.find((canvas) => canvas.id === initialProject.state.currentCanvasId) ??
    initialProject.state.canvases[0];
  const nextTextBoxIdRef = useRef(getNextTextBoxSerial(initialCanvas.state.textBoxes));
  const autoSaveErrorNotifiedRef = useRef(false);
  const mediaRestoreTokenRef = useRef(0);
  const loadedProjectIdRef = useRef<string | null>(null);
  const copiedTextBoxRef = useRef<TextBoxModel | null>(null);
  const copiedCanvasRef = useRef<InMemoryCanvasClipboardPayload | null>(null);
  const lastCopyKindRef = useRef<'text-box' | 'canvas' | null>(null);
  const historyEntryRef = useRef<AppHistoryEntry>({ past: [], present: null, future: [] });
  const isApplyingHistoryRef = useRef(false);
  const apiHydrationCompletedRef = useRef(false);
  const syncableProjectIdsRef = useRef<Set<string>>(new Set());
  const pendingProjectDetailHydrationRef = useRef<Set<string>>(new Set());
  const lastCanvasPreloadSignatureRef = useRef('');
  const isMeasuringAllRef = useRef(false);

  const [projects, setProjects] = useState<ProjectRecord[]>([initialProject]);
  const [currentProjectId, setCurrentProjectId] = useState(initialProject.id);
  const [currentCanvasId, setCurrentCanvasId] = useState(initialCanvas.id);
  const [connectedSaveDirectory, setConnectedSaveDirectory] = useState<DirectoryHandleLike | null>(null);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState('');

  const [assetKind, setAssetKind] = useState<MediaKind>(null);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [assetName, setAssetName] = useState('');

  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>(initialCanvas.state.backgroundMode);
  const [backgroundPrimary, setBackgroundPrimary] = useState(initialCanvas.state.backgroundPrimary);
  const [backgroundSecondary, setBackgroundSecondary] = useState(initialCanvas.state.backgroundSecondary);
  const [gradientAngle, setGradientAngle] = useState(initialCanvas.state.gradientAngle);
  const [canvasPresetId, setCanvasPresetId] = useState(initialCanvas.state.canvasPresetId);

  const [phoneOffset, setPhoneOffset] = useState<Offset>({ ...initialCanvas.state.phoneOffset });
  const [phoneScale, setPhoneScale] = useState(initialCanvas.state.phoneScale);

  const [textBoxes, setTextBoxes] = useState<TextBoxModel[]>(initialCanvas.state.textBoxes.map((box) => ({ ...box })));
  const [selectedTextBoxId, setSelectedTextBoxId] = useState<string | null>(null);
  const [isPlacingTextBox, setIsPlacingTextBox] = useState(false);
  const [hasCopiedTextBox, setHasCopiedTextBox] = useState(false);
  const [isInlineTextEditing, setIsInlineTextEditing] = useState(false);
  const [canvasClientSize, setCanvasClientSize] = useState({ width: 0, height: 0 });

  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingProjectZip, setIsExportingProjectZip] = useState(false);
  const [isMeasuringAll, setIsMeasuringAll] = useState(false);
  const [isUploadDropActive, setIsUploadDropActive] = useState(false);
  const [isCanvasDropActive, setIsCanvasDropActive] = useState(false);
  const [snapGuide, setSnapGuide] = useState({ vertical: false, horizontal: false });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [canvasNameDrafts, setCanvasNameDrafts] = useState<Record<string, string>>({});
  const [draggingCanvasId, setDraggingCanvasId] = useState<string | null>(null);
  const [canvasDropTargetId, setCanvasDropTargetId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState(
    'iPhone 프레임/텍스트박스를 드래그해 배치하고, 이미지/영상을 DnD 또는 클릭 업로드해 주세요.',
  );

  useEffect(() => {
    isMeasuringAllRef.current = isMeasuringAll;
  }, [isMeasuringAll]);

  const selectedTextBox = useMemo(
    () => textBoxes.find((box) => box.id === selectedTextBoxId) ?? null,
    [textBoxes, selectedTextBoxId],
  );

  const selectedTextBoxBounds = useMemo(
    () =>
      selectedTextBox
        ? measureTextBoxBounds(selectedTextBox, getTextBoxMaxWidthForPresetId(canvasPresetId))
        : null,
    [canvasPresetId, selectedTextBox],
  );

  const inlineTextEditorLayout = useMemo(() => {
    if (!isInlineTextEditing || !selectedTextBox || !selectedTextBoxBounds) {
      return null;
    }

    if (canvasClientSize.width <= 0 || canvasClientSize.height <= 0) {
      return null;
    }

    const activePreset = getCanvasPresetById(canvasPresetId);
    const scaleX = canvasClientSize.width / activePreset.width;
    const scaleY = canvasClientSize.height / activePreset.height;

    return {
      left: selectedTextBoxBounds.x * scaleX,
      top: selectedTextBoxBounds.y * scaleY,
      width: selectedTextBoxBounds.width * scaleX,
      height: Math.max(selectedTextBoxBounds.height * scaleY, selectedTextBox.fontSize * scaleY * 1.2),
      fontSize: selectedTextBox.fontSize * scaleY,
      fontFamily: getFontFamily(selectedTextBox.fontKey),
      color: selectedTextBox.color,
    };
  }, [canvasClientSize.height, canvasClientSize.width, canvasPresetId, isInlineTextEditing, selectedTextBox, selectedTextBoxBounds]);

  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  const markProjectSyncable = useCallback((projectId: string) => {
    if (!projectId) {
      return;
    }
    const next = new Set(syncableProjectIdsRef.current);
    next.add(projectId);
    syncableProjectIdsRef.current = next;
  }, []);

  const removeProjectFromSyncable = useCallback((projectId: string) => {
    if (!projectId || !syncableProjectIdsRef.current.has(projectId)) {
      return;
    }
    const next = new Set(syncableProjectIdsRef.current);
    next.delete(projectId);
    syncableProjectIdsRef.current = next;
  }, []);

  const currentCanvasState = useMemo<CanvasDesignState>(
    () => ({
      canvasPresetId,
      backgroundMode,
      backgroundPrimary,
      backgroundSecondary,
      gradientAngle,
      phoneOffset,
      phoneScale,
      textBoxes: textBoxes.map((box) => ({ ...box })),
      media: {
        kind: assetKind,
        name: assetName,
      },
    }),
    [
      assetKind,
      assetName,
      canvasPresetId,
      backgroundMode,
      backgroundPrimary,
      backgroundSecondary,
      gradientAngle,
      phoneOffset,
      phoneScale,
      textBoxes,
    ],
  );

  const currentCanvasPreset = useMemo(() => getCanvasPresetById(canvasPresetId), [canvasPresetId]);
  const currentTextBoxMaxWidth = useMemo(
    () => getTextBoxMaxWidthForPresetId(canvasPresetId),
    [canvasPresetId],
  );

  const currentProjectState = useMemo<ProjectDesignState | null>(() => {
    if (!currentProject) {
      return null;
    }

    // Prevent stale global draft state from overwriting freshly switched/hydrating project state.
    if (loadedProjectIdRef.current !== currentProjectId) {
      return cloneProjectDesignState(currentProject.state);
    }

    const exists = currentProject.state.canvases.some((canvas) => canvas.id === currentCanvasId);
    const targetCanvasId = exists ? currentCanvasId : currentProject.state.currentCanvasId;
    const canvases = currentProject.state.canvases.map((canvas) =>
      canvas.id === targetCanvasId
        ? {
            ...canvas,
            state: cloneCanvasState(currentCanvasState),
          }
        : canvas,
    );

    return {
      canvases,
      currentCanvasId: targetCanvasId,
    };
  }, [currentCanvasId, currentCanvasState, currentProject, currentProjectId]);

  const currentProjectCanvases = useMemo(() => currentProjectState?.canvases ?? [], [currentProjectState]);

  const currentCanvas = useMemo(
    () => currentProjectCanvases.find((canvas) => canvas.id === currentCanvasId) ?? null,
    [currentCanvasId, currentProjectCanvases],
  );

  const canvasThumbnailPreloadSignature = useMemo(() => {
    if (!currentProject) {
      return '';
    }

    return `${currentProject.id}|${currentProject.state.canvases
      .map((canvas) => `${canvas.id}:${canvas.state.media.kind ?? 'none'}:${canvas.state.media.name}`)
      .join('|')}`;
  }, [currentProject]);

  useEffect(() => {
    const existingCanvasIds = new Set(currentProjectCanvases.map((canvas) => canvas.id));
    setCanvasNameDrafts((previous) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [canvasId, draft] of Object.entries(previous)) {
        if (existingCanvasIds.has(canvasId)) {
          next[canvasId] = draft;
          continue;
        }
        changed = true;
      }

      return changed ? next : previous;
    });
  }, [currentProjectCanvases]);

  const currentMediaStorageKey = useMemo(() => {
    if (!currentProjectId || !currentCanvasId) {
      return '';
    }

    return buildProjectCanvasMediaKey(currentProjectId, currentCanvasId);
  }, [currentCanvasId, currentProjectId]);

  const buildAppHistorySnapshot = useCallback<() => AppHistorySnapshot>(() => {
    const isCurrentProjectDraftReady =
      loadedProjectIdRef.current === currentProjectId && Boolean(currentProjectState);

    const syncedProjects: AppHistoryProjectSnapshot[] = projects.map((project) => ({
      id: project.id,
      name: project.name,
      state: cloneProjectDesignState(
        project.id === currentProjectId && isCurrentProjectDraftReady && currentProjectState
          ? currentProjectState
          : project.state,
      ),
    }));

    const fallbackProject = syncedProjects[0];
    const activeProject =
      syncedProjects.find((project) => project.id === currentProjectId) ?? fallbackProject;
    const resolvedProjectId = activeProject?.id ?? '';
    const resolvedCanvasId =
      activeProject?.state.canvases.find((canvas) => canvas.id === currentCanvasId)?.id ??
      activeProject?.state.currentCanvasId ??
      activeProject?.state.canvases[0]?.id ??
      '';

    if (activeProject && activeProject.state.currentCanvasId !== resolvedCanvasId) {
      activeProject.state.currentCanvasId = resolvedCanvasId;
    }

    return {
      projects: syncedProjects,
      currentProjectId: resolvedProjectId,
      currentCanvasId: resolvedCanvasId,
      selectedTextBoxId,
    };
  }, [currentCanvasId, currentProjectId, currentProjectState, projects, selectedTextBoxId]);

  const toCanvasPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return null;
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return null;
    }

    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }, []);

  const findTopmostTextBoxAtPoint = useCallback((point: Offset, layout: LayoutMetrics) => {
    for (let i = layout.textBoxes.length - 1; i >= 0; i -= 1) {
      const box = layout.textBoxes[i];
      if (pointInRect(point, expandRect(box.bounds, 10))) {
        return box;
      }
    }

    return null;
  }, []);

  const isPointInsidePhoneScreen = useCallback((point: Offset | null) => {
    if (!point || !layoutRef.current) {
      return false;
    }

    return pointInRect(point, layoutRef.current.phone.screen);
  }, []);

  const bringTextBoxToFront = useCallback((targetId: string) => {
    setTextBoxes((previous) => {
      const index = previous.findIndex((item) => item.id === targetId);
      if (index < 0 || index === previous.length - 1) {
        return previous;
      }

      const next = [...previous];
      const [picked] = next.splice(index, 1);
      next.push(picked);
      return next;
    });
  }, []);

  const setAssetObjectUrl = useCallback((nextUrl: string | null) => {
    if (assetUrlRef.current) {
      URL.revokeObjectURL(assetUrlRef.current);
      assetUrlRef.current = null;
    }

    assetUrlRef.current = nextUrl;
    setAssetUrl(nextUrl);
  }, []);

  const clearLoadedMedia = useCallback(() => {
    videoRef.current?.pause();
    videoRef.current = null;
    imageRef.current = null;
    setAssetKind(null);
    setAssetName('');
    setAssetObjectUrl(null);
  }, [setAssetObjectUrl]);

  const getCanvasSnapThreshold = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return { x: CENTER_SNAP_THRESHOLD_PX, y: CENTER_SNAP_THRESHOLD_PX };
    }

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return { x: CENTER_SNAP_THRESHOLD_PX, y: CENTER_SNAP_THRESHOLD_PX };
    }

    return {
      x: CENTER_SNAP_THRESHOLD_PX * (canvas.width / rect.width),
      y: CENTER_SNAP_THRESHOLD_PX * (canvas.height / rect.height),
    };
  }, []);

  const updateSnapGuide = useCallback((next: { vertical: boolean; horizontal: boolean }) => {
    setSnapGuide((previous) =>
      previous.vertical === next.vertical && previous.horizontal === next.horizontal
        ? previous
        : next,
    );
  }, []);

  const setArtifactBlob = useCallback((blob: Blob, kind: ArtifactKind, mimeType: string, fileName: string) => {
    if (artifactUrlRef.current) {
      URL.revokeObjectURL(artifactUrlRef.current);
      artifactUrlRef.current = null;
    }

    const url = URL.createObjectURL(blob);
    artifactUrlRef.current = url;
    setArtifact({ kind, mimeType, fileName, url });

    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
  }, []);

  const applyProjectState = useCallback(
    (project: ProjectRecord, preferredCanvasId?: string) => {
      const targetCanvas =
        project.state.canvases.find((canvas) => canvas.id === (preferredCanvasId ?? project.state.currentCanvasId)) ??
        project.state.canvases[0];

      if (!targetCanvas) {
        return;
      }

      const targetState = targetCanvas.state;
      setCurrentCanvasId(targetCanvas.id);
      setCanvasPresetId(targetState.canvasPresetId);
      setBackgroundMode(targetState.backgroundMode);
      setBackgroundPrimary(targetState.backgroundPrimary);
      setBackgroundSecondary(targetState.backgroundSecondary);
      setGradientAngle(targetState.gradientAngle);
      setPhoneOffset({ ...targetState.phoneOffset });
      setPhoneScale(targetState.phoneScale);
      setTextBoxes(targetState.textBoxes.map((box) => ({ ...box })));
      setSelectedTextBoxId(null);
      setIsPlacingTextBox(false);
      nextTextBoxIdRef.current = getNextTextBoxSerial(targetState.textBoxes);
    },
    [],
  );

  const restoreProjectMedia = useCallback(
    async (project: ProjectRecord, preferredCanvasId?: string) => {
      const targetCanvas =
        project.state.canvases.find((canvas) => canvas.id === (preferredCanvasId ?? project.state.currentCanvasId)) ??
        project.state.canvases[0];
      if (!targetCanvas) {
        return;
      }

      const mediaKey = buildProjectCanvasMediaKey(project.id, targetCanvas.id);
      const token = mediaRestoreTokenRef.current + 1;
      mediaRestoreTokenRef.current = token;
      clearLoadedMedia();
      setErrorMessage('');

      if (typeof indexedDB === 'undefined') {
        setStatusMessage(`${project.name} / ${targetCanvas.name} 캔버스를 불러왔습니다.`);
        return;
      }

      try {
        let record = await readProjectMediaRecord(mediaKey);
        const firstCanvasId = project.state.canvases[0]?.id ?? '';
        if (!record && targetCanvas.id === firstCanvasId) {
          record = await readProjectMediaRecord(project.id);
          if (record) {
            void saveProjectMediaRecord({
              ...record,
              projectId: mediaKey,
              updatedAt: new Date().toISOString(),
            }).catch(() => undefined);
          }
        }
        if (!record && targetCanvas.state.media.kind && targetCanvas.state.media.name) {
          const matchedRecord = await findProjectMediaRecordByKindAndName(
            targetCanvas.state.media.kind,
            targetCanvas.state.media.name,
          );
          if (matchedRecord) {
            record = matchedRecord;
            if (matchedRecord.projectId !== mediaKey) {
              void saveProjectMediaRecord({
                ...matchedRecord,
                projectId: mediaKey,
                updatedAt: new Date().toISOString(),
              }).catch(() => undefined);
            }
          }
        }

        if (token !== mediaRestoreTokenRef.current) {
          return;
        }

        if (!record) {
          setStatusMessage(`${project.name} / ${targetCanvas.name} 캔버스를 불러왔습니다.`);
          return;
        }

        const objectUrl = URL.createObjectURL(record.blob);
        setAssetObjectUrl(objectUrl);
        setAssetName(record.name);

        if (record.kind === 'image') {
          const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const instance = new Image();
            instance.onload = () => resolve(instance);
            instance.onerror = () => reject(new Error('저장된 이미지를 복원하지 못했습니다.'));
            instance.src = objectUrl;
          });

          if (token !== mediaRestoreTokenRef.current) {
            return;
          }

          videoRef.current?.pause();
          videoRef.current = null;
          imageRef.current = image;
          setAssetKind('image');
          setStatusMessage(`${project.name} / ${targetCanvas.name}: 저장된 이미지를 복원했습니다.`);
          return;
        }

        const video = await new Promise<HTMLVideoElement>((resolve, reject) => {
          const instance = document.createElement('video');
          instance.preload = 'auto';
          instance.playsInline = true;
          instance.muted = true;
          instance.loop = true;
          instance.src = objectUrl;

          const onLoadedData = () => resolve(instance);
          const onError = () => reject(new Error('저장된 영상을 복원하지 못했습니다.'));

          instance.addEventListener('loadeddata', onLoadedData, { once: true });
          instance.addEventListener('error', onError, { once: true });
        });

        if (token !== mediaRestoreTokenRef.current) {
          return;
        }

        await video.play().catch(() => undefined);
        imageRef.current = null;
        videoRef.current = video;
        setAssetKind('video');
        setStatusMessage(`${project.name} / ${targetCanvas.name}: 저장된 영상을 복원했습니다.`);
      } catch (error) {
        if (token !== mediaRestoreTokenRef.current) {
          return;
        }

        clearLoadedMedia();
        setErrorMessage(error instanceof Error ? error.message : '미디어 복원에 실패했습니다.');
        setStatusMessage(`${project.name} / ${targetCanvas.name} 캔버스를 불러왔습니다. 미디어는 다시 업로드해 주세요.`);
      }
    },
    [clearLoadedMedia, setAssetObjectUrl],
  );

  const handleSelectProject = useCallback(
    (nextProjectId: string) => {
      const nextProject = projects.find((project) => project.id === nextProjectId);
      if (!nextProject || !currentProjectState) {
        return;
      }

      const now = new Date().toISOString();
      setProjects((previous) =>
        previous.map((project) =>
          project.id === currentProjectId
            ? {
                ...project,
                updatedAt: now,
                state: currentProjectState,
              }
            : project,
        ),
      );
      clearLoadedMedia();
      setCurrentProjectId(nextProject.id);
      setCurrentCanvasId(nextProject.state.currentCanvasId);
    },
    [clearLoadedMedia, currentProjectId, currentProjectState, projects],
  );

  const handleCreateProject = useCallback(() => {
    if (!currentProjectState) {
      return;
    }

    const now = new Date().toISOString();
    const newProject = createProjectRecord(createNextProjectName(projects));
    markProjectSyncable(newProject.id);
    setProjects((previous) => [
      ...previous.map((project) =>
        project.id === currentProjectId
          ? {
              ...project,
              updatedAt: now,
              state: currentProjectState,
            }
          : project,
      ),
      newProject,
    ]);
    setCurrentProjectId(newProject.id);
    setCurrentCanvasId(newProject.state.currentCanvasId);
  }, [currentProjectId, currentProjectState, markProjectSyncable, projects]);

  const handleRenameProject = useCallback((targetProjectId: string, nextName: string) => {
    const trimmedName = nextName.trimStart();
    setProjects((previous) =>
      previous.map((project) =>
        project.id === targetProjectId
          ? {
              ...project,
              name: trimmedName || '이름 없는 프로젝트',
            }
          : project,
      ),
    );
  }, []);

  const handleDuplicateProject = useCallback(
    (sourceProjectId: string) => {
      const sourceProject = projects.find((project) => project.id === sourceProjectId);
      if (!sourceProject) {
        return;
      }

      const resolvedSourceState =
        sourceProjectId === currentProjectId && currentProjectState ? currentProjectState : sourceProject.state;
      const { duplicatedState, canvasIdMap } = duplicateProjectStateCore(resolvedSourceState);
      const duplicatedProjectId = createProjectId();
      const duplicatedProjectName = createDuplicateName(
        projects.map((project) => project.name),
        sourceProject.name,
      );

      const duplicatedProject: ProjectRecord = {
        id: duplicatedProjectId,
        name: duplicatedProjectName,
        updatedAt: new Date().toISOString(),
        revision: 0,
        state: duplicatedState,
      };

      void (async () => {
        let mediaCopyFailed = false;
        for (const sourceCanvas of resolvedSourceState.canvases) {
          if (!sourceCanvas.state.media.kind) {
            continue;
          }

          const duplicatedCanvasId = canvasIdMap.get(sourceCanvas.id);
          if (!duplicatedCanvasId) {
            continue;
          }

          try {
            const sourceMediaKey = buildProjectCanvasMediaKey(sourceProject.id, sourceCanvas.id);
            const targetMediaKey = buildProjectCanvasMediaKey(duplicatedProject.id, duplicatedCanvasId);
            let sourceRecord = await readProjectMediaRecord(sourceMediaKey);
            const firstCanvasId = resolvedSourceState.canvases[0]?.id ?? '';
            if (!sourceRecord && sourceCanvas.id === firstCanvasId) {
              sourceRecord = await readProjectMediaRecord(sourceProject.id);
            }

            if (sourceRecord) {
              await saveProjectMediaRecord({
                ...sourceRecord,
                projectId: targetMediaKey,
                updatedAt: new Date().toISOString(),
              });
            }
          } catch {
            mediaCopyFailed = true;
          }
        }

        const now = new Date().toISOString();
        markProjectSyncable(duplicatedProject.id);
        setProjects((previous) => [
          ...previous.map((project) =>
            project.id === currentProjectId && currentProjectState
              ? {
                  ...project,
                  updatedAt: now,
                  state: currentProjectState,
                }
              : project,
          ),
          duplicatedProject,
        ]);
        setCurrentProjectId(duplicatedProject.id);
        setCurrentCanvasId(duplicatedProject.state.currentCanvasId);
        applyProjectState(duplicatedProject, duplicatedProject.state.currentCanvasId);
        await restoreProjectMedia(duplicatedProject, duplicatedProject.state.currentCanvasId);

        if (mediaCopyFailed) {
          setErrorMessage('프로젝트 복제는 완료했지만 일부 미디어 복사에 실패했습니다. 필요 시 다시 업로드해 주세요.');
        } else {
          setErrorMessage('');
        }
        setStatusMessage(`${sourceProject.name} 프로젝트를 ${duplicatedProject.name}로 복제했습니다.`);
      })();
    },
    [applyProjectState, currentProjectId, currentProjectState, markProjectSyncable, projects, restoreProjectMedia],
  );

  const syncDeleteProjectToApi = useCallback(async (targetProjectId: string) => {
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(targetProjectId)}`, {
        method: 'DELETE',
      });
      return response.ok || response.status === 404;
    } catch {
      return false;
    }
  }, []);

  const handleDeleteProject = useCallback(
    (targetProjectId: string) => {
      if (projects.length <= 1) {
        setErrorMessage('프로젝트는 최소 1개가 필요합니다.');
        return;
      }

      const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
      if (targetIndex < 0) {
        return;
      }

      const targetProject = projects[targetIndex];
      if (!targetProject) {
        return;
      }

      const now = new Date().toISOString();
      const projectsWithSyncedCurrent = projects.map((project) =>
        project.id === currentProjectId && currentProjectState
          ? {
              ...project,
              updatedAt: now,
              state: currentProjectState,
            }
          : project,
      );
      const syncedTargetProject = projectsWithSyncedCurrent[targetIndex] ?? targetProject;
      const remainingProjects = projectsWithSyncedCurrent.filter((project) => project.id !== targetProjectId);

      removeProjectFromSyncable(targetProjectId);
      setProjects(remainingProjects);

      if (targetProjectId === currentProjectId) {
        const fallbackProject = remainingProjects[Math.max(0, targetIndex - 1)] ?? remainingProjects[0];
        if (fallbackProject) {
          setCurrentProjectId(fallbackProject.id);
          setCurrentCanvasId(fallbackProject.state.currentCanvasId);
          applyProjectState(fallbackProject, fallbackProject.state.currentCanvasId);
          void restoreProjectMedia(fallbackProject, fallbackProject.state.currentCanvasId);
        }
      }

      setErrorMessage('');
      setStatusMessage(`${syncedTargetProject.name} 프로젝트를 삭제했습니다.`);
      void (async () => {
        const synced = await syncDeleteProjectToApi(targetProjectId);
        if (!synced) {
          setErrorMessage('API 저장소 삭제 동기화에 실패했습니다. 새로고침 시 다시 보일 수 있습니다.');
        }
      })();
    },
    [applyProjectState, currentProjectId, currentProjectState, projects, removeProjectFromSyncable, restoreProjectMedia, syncDeleteProjectToApi],
  );

  const handleSelectCanvas = useCallback(
    (nextCanvasId: string) => {
      if (!currentProject || !currentProjectState || nextCanvasId === currentCanvasId) {
        return;
      }

      if (!currentProjectState.canvases.some((canvas) => canvas.id === nextCanvasId)) {
        return;
      }

      const now = new Date().toISOString();
      const nextState: ProjectDesignState = {
        ...currentProjectState,
        currentCanvasId: nextCanvasId,
      };
      const nextProject: ProjectRecord = {
        ...currentProject,
        updatedAt: now,
        state: nextState,
      };

      setProjects((previous) =>
        previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
      );
      clearLoadedMedia();
      applyProjectState(nextProject, nextCanvasId);
      void restoreProjectMedia(nextProject, nextCanvasId);
    },
    [applyProjectState, clearLoadedMedia, currentCanvasId, currentProject, currentProjectState, restoreProjectMedia],
  );

  const handleRenameCanvasDraftChange = useCallback((targetCanvasId: string, nextName: string) => {
    setCanvasNameDrafts((previous) => ({
      ...previous,
      [targetCanvasId]: nextName,
    }));
  }, []);

  const commitCanvasName = useCallback(
    (targetCanvasId: string, rawName: string) => {
      const resolvedName = rawName.trim() || '이름 없는 캔버스';
      const now = new Date().toISOString();

      setProjects((previous) =>
        previous.map((project) => {
          if (project.id !== currentProjectId) {
            return project;
          }

          let changed = false;
          const canvases = project.state.canvases.map((canvas) => {
            if (canvas.id !== targetCanvasId) {
              return canvas;
            }

            if (canvas.name === resolvedName) {
              return canvas;
            }

            changed = true;
            return {
              ...canvas,
              name: resolvedName,
            };
          });

          if (!changed) {
            return project;
          }

          return {
            ...project,
            updatedAt: now,
            state: {
              ...project.state,
              canvases,
            },
          };
        }),
      );

      setCanvasNameDrafts((previous) => {
        if (!(targetCanvasId in previous)) {
          return previous;
        }

        const next = { ...previous };
        delete next[targetCanvasId];
        return next;
      });
    },
    [currentProjectId],
  );

  const handleRenameCanvasBlur = useCallback(
    (targetCanvasId: string, rawName: string) => {
      commitCanvasName(targetCanvasId, rawName);
    },
    [commitCanvasName],
  );

  const handleRenameCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>, targetCanvasId: string) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitCanvasName(targetCanvasId, event.currentTarget.value);
        event.currentTarget.blur();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        setCanvasNameDrafts((previous) => {
          if (!(targetCanvasId in previous)) {
            return previous;
          }

          const next = { ...previous };
          delete next[targetCanvasId];
          return next;
        });
        event.currentTarget.blur();
      }
    },
    [commitCanvasName],
  );

  const handleReorderCanvas = useCallback(
    (sourceCanvasId: string, targetCanvasId: string) => {
      if (!currentProject || !currentProjectState || sourceCanvasId === targetCanvasId) {
        return;
      }

      const sourceIndex = currentProjectState.canvases.findIndex((canvas) => canvas.id === sourceCanvasId);
      const targetIndex = currentProjectState.canvases.findIndex((canvas) => canvas.id === targetCanvasId);
      if (sourceIndex < 0 || targetIndex < 0) {
        return;
      }

      const nextCanvases = [...currentProjectState.canvases];
      const [sourceCanvas] = nextCanvases.splice(sourceIndex, 1);
      if (!sourceCanvas) {
        return;
      }

      const insertionIndex = targetIndex;
      nextCanvases.splice(insertionIndex, 0, sourceCanvas);

      const now = new Date().toISOString();
      const nextState: ProjectDesignState = {
        ...currentProjectState,
        canvases: nextCanvases,
      };
      const nextProject: ProjectRecord = {
        ...currentProject,
        updatedAt: now,
        state: nextState,
      };

      setProjects((previous) =>
        previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
      );
      setStatusMessage(`${sourceCanvas.name} 순서를 변경했습니다.`);
      setErrorMessage('');
    },
    [currentProject, currentProjectState],
  );

  const handleCanvasCardDragStart = useCallback((event: DragEvent<HTMLDivElement>, sourceCanvasId: string) => {
    if (isEditableTarget(event.target)) {
      event.preventDefault();
      return;
    }

    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', sourceCanvasId);
    setDraggingCanvasId(sourceCanvasId);
    setCanvasDropTargetId(null);
  }, []);

  const handleCanvasCardDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>, targetCanvasId: string) => {
      if (!draggingCanvasId || draggingCanvasId === targetCanvasId) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setCanvasDropTargetId(targetCanvasId);
    },
    [draggingCanvasId],
  );

  const handleCanvasCardDrop = useCallback(
    (event: DragEvent<HTMLDivElement>, targetCanvasId: string) => {
      event.preventDefault();
      const sourceCanvasId = draggingCanvasId || event.dataTransfer.getData('text/plain');
      if (sourceCanvasId) {
        handleReorderCanvas(sourceCanvasId, targetCanvasId);
      }

      setDraggingCanvasId(null);
      setCanvasDropTargetId(null);
    },
    [draggingCanvasId, handleReorderCanvas],
  );

  const handleCanvasCardDragEnd = useCallback(() => {
    setDraggingCanvasId(null);
    setCanvasDropTargetId(null);
  }, []);

  const handleCreateCanvas = useCallback(() => {
    if (!currentProject || !currentProjectState) {
      return;
    }

    const newCanvas = createCanvasRecord(createNextCanvasName(currentProjectState.canvases), {
      ...createEmptyCanvasState(),
      canvasPresetId,
    });
    const now = new Date().toISOString();
    const nextState: ProjectDesignState = {
      canvases: [...currentProjectState.canvases, newCanvas],
      currentCanvasId: newCanvas.id,
    };
    const nextProject: ProjectRecord = {
      ...currentProject,
      updatedAt: now,
      state: nextState,
    };

    setProjects((previous) => previous.map((project) => (project.id === currentProject.id ? nextProject : project)));
    applyProjectState(nextProject, newCanvas.id);
    void restoreProjectMedia(nextProject, newCanvas.id);
    setStatusMessage('새 캔버스를 추가했습니다.');
  }, [applyProjectState, canvasPresetId, currentProject, currentProjectState, restoreProjectMedia]);

  const duplicateCanvasIntoCurrentProject = useCallback(
    async (options: {
      sourceProjectId: string;
      sourceCanvasId: string;
      sourceCanvasName: string;
      sourceCanvasState: CanvasDesignState;
      sourceThumbnailDataUrl?: string;
      preferredMediaRecord?: ProjectMediaRecord | null;
    }) => {
      if (!currentProject || !currentProjectState) {
        return false;
      }

      const duplicatedCanvas = createCanvasRecord(
        createNextCanvasName(currentProjectState.canvases),
        cloneCanvasState(options.sourceCanvasState),
      );
      duplicatedCanvas.thumbnailDataUrl = options.sourceThumbnailDataUrl;

      const now = new Date().toISOString();
      const nextState: ProjectDesignState = {
        canvases: [...currentProjectState.canvases, duplicatedCanvas],
        currentCanvasId: duplicatedCanvas.id,
      };
      const nextProject: ProjectRecord = {
        ...currentProject,
        updatedAt: now,
        state: nextState,
      };

      let mediaCopyFailed = false;
      if (duplicatedCanvas.state.media.kind) {
        try {
          let mediaRecord = options.preferredMediaRecord ?? null;
          if (!mediaRecord) {
            const sourceMediaKey = buildProjectCanvasMediaKey(options.sourceProjectId, options.sourceCanvasId);
            mediaRecord = await readProjectMediaRecord(sourceMediaKey);
            if (!mediaRecord) {
              mediaRecord = await readProjectMediaRecord(options.sourceProjectId);
            }
            if (!mediaRecord && duplicatedCanvas.state.media.name) {
              mediaRecord = await findProjectMediaRecordByKindAndName(
                duplicatedCanvas.state.media.kind,
                duplicatedCanvas.state.media.name,
              );
            }
          }

          if (mediaRecord) {
            const duplicatedMediaKey = buildProjectCanvasMediaKey(currentProject.id, duplicatedCanvas.id);
            await saveProjectMediaRecord({
              ...mediaRecord,
              projectId: duplicatedMediaKey,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch {
          mediaCopyFailed = true;
        }
      }

      setProjects((previous) =>
        previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
      );
      applyProjectState(nextProject, duplicatedCanvas.id);
      await restoreProjectMedia(nextProject, duplicatedCanvas.id);

      if (mediaCopyFailed) {
        setErrorMessage('캔버스는 복제했지만 미디어 복사에 실패했습니다. 필요 시 다시 업로드해 주세요.');
      } else {
        setErrorMessage('');
      }
      setStatusMessage(`${options.sourceCanvasName} 캔버스를 복제해 ${duplicatedCanvas.name}를 만들었습니다.`);
      return true;
    },
    [applyProjectState, currentProject, currentProjectState, restoreProjectMedia],
  );

  const handleDuplicateCanvas = useCallback(
    (sourceCanvasId: string) => {
      if (!currentProject || !currentProjectState) {
        return;
      }

      const sourceCanvas = currentProjectState.canvases.find((canvas) => canvas.id === sourceCanvasId);
      if (!sourceCanvas) {
        return;
      }

      void duplicateCanvasIntoCurrentProject({
        sourceProjectId: currentProject.id,
        sourceCanvasId,
        sourceCanvasName: sourceCanvas.name,
        sourceCanvasState: cloneCanvasState(sourceCanvas.state),
        sourceThumbnailDataUrl: sourceCanvas.thumbnailDataUrl,
      });
    },
    [currentProject, currentProjectState, duplicateCanvasIntoCurrentProject],
  );

  const handleDeleteCanvas = useCallback(
    (targetCanvasId: string) => {
      if (!currentProject || !currentProjectState) {
        return;
      }

      if (currentProjectState.canvases.length <= 1) {
        setErrorMessage('캔버스는 최소 1개가 필요합니다.');
        return;
      }

      const targetIndex = currentProjectState.canvases.findIndex((canvas) => canvas.id === targetCanvasId);
      if (targetIndex < 0) {
        return;
      }

      const targetCanvas = currentProjectState.canvases[targetIndex];
      const remainingCanvases = currentProjectState.canvases.filter((canvas) => canvas.id !== targetCanvasId);
      const fallbackCanvas = remainingCanvases[Math.max(0, targetIndex - 1)] ?? remainingCanvases[0];
      const nextCurrentCanvasId = targetCanvasId === currentCanvasId ? fallbackCanvas.id : currentCanvasId;

      const now = new Date().toISOString();
      const nextState: ProjectDesignState = {
        canvases: remainingCanvases,
        currentCanvasId: nextCurrentCanvasId,
      };
      const nextProject: ProjectRecord = {
        ...currentProject,
        updatedAt: now,
        state: nextState,
      };

      setProjects((previous) =>
        previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
      );

      if (targetCanvasId === currentCanvasId) {
        applyProjectState(nextProject, nextCurrentCanvasId);
        void restoreProjectMedia(nextProject, nextCurrentCanvasId);
      }

      setErrorMessage('');
      setStatusMessage(`${targetCanvas.name} 캔버스를 삭제했습니다.`);
    },
    [applyProjectState, currentCanvasId, currentProject, currentProjectState, restoreProjectMedia],
  );

  const persistProjectFileToDirectory = useCallback(
    async (project: ProjectRecord) => {
      if (!connectedSaveDirectory) {
        return;
      }

      const activeCanvas =
        project.state.canvases.find((canvas) => canvas.id === project.state.currentCanvasId) ?? project.state.canvases[0];
      const activeCanvasPreset = getCanvasPresetById(activeCanvas?.state.canvasPresetId ?? DEFAULT_CANVAS_PRESET_ID);

      const payload: ProjectFilePayload = {
        version: 2,
        project: {
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          revision: project.revision,
        },
        canvas: {
          width: activeCanvasPreset.width,
          height: activeCanvasPreset.height,
        },
        state: project.state,
      };

      const savesDir = await connectedSaveDirectory.getDirectoryHandle('.project-saves', { create: true });
      const safeName = sanitizeFileNameSegment(project.name);
      const fileHandle = await savesDir.getFileHandle(`${safeName}-${project.id}.appstore-preview-project.json`, {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(JSON.stringify(payload, null, 2));
      await writable.close();
    },
    [connectedSaveDirectory],
  );

  const handleConnectSaveDirectory = useCallback(async () => {
    const pickerWindow = window as Window & {
      showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
    };

    if (typeof pickerWindow.showDirectoryPicker !== 'function') {
      setErrorMessage('현재 브라우저는 폴더 자동 저장을 지원하지 않습니다. Chromium 계열 브라우저를 사용해 주세요.');
      return;
    }

    try {
      const directoryHandle = await pickerWindow.showDirectoryPicker({ mode: 'readwrite' });
      setConnectedSaveDirectory(directoryHandle);
      autoSaveErrorNotifiedRef.current = false;
      setStatusMessage('저장 폴더가 연결되었습니다. 변경사항을 .project-saves에 자동 저장합니다.');
      setErrorMessage('');
    } catch (error) {
      const domError = error as DOMException;
      if (domError?.name === 'AbortError') {
        return;
      }

      setErrorMessage(error instanceof Error ? error.message : '저장 폴더 연결에 실패했습니다.');
    }
  }, []);

  const addTextBoxAt = useCallback((point: Offset) => {
    const id = `text-${nextTextBoxIdRef.current}`;
    nextTextBoxIdRef.current += 1;

    const width = clamp(460, TEXT_BOX_MIN_WIDTH, currentTextBoxMaxWidth);
    const newBox: TextBoxModel = {
      id,
      text: '텍스트를 입력하세요',
      x: point.x - width / 2,
      y: point.y - 36,
      width,
      fontKey: FONT_OPTIONS[0].key,
      fontSize: 64,
      color: '#1f3b7c',
    };

    setTextBoxes((previous) => [...previous, newBox]);
    setSelectedTextBoxId(id);
    setIsPlacingTextBox(false);
    setStatusMessage('새 텍스트박스를 추가했습니다. 드래그로 위치를 조정하세요.');
    setErrorMessage('');
  }, [currentTextBoxMaxWidth]);

  const updateSelectedTextBox = useCallback((updater: (box: TextBoxModel) => TextBoxModel) => {
    setTextBoxes((previous) =>
      previous.map((box) => {
        if (box.id !== selectedTextBoxId) return box;
        const next = updater(box);
        // text/width/fontSize 변경 시 브라우저 실측값 즉시 갱신
        const contentChanged =
          next.text !== box.text ||
          next.width !== box.width ||
          next.fontSize !== box.fontSize ||
          next.fontKey !== box.fontKey;
        if (!contentChanged) return next;
        const measured = measureTextMetrics(next, currentTextBoxMaxWidth);
        return {
          ...next,
          measuredLineCountByCanvas: measured.lineCountByCanvas,
          measuredLineCountByDom: measured.lineCountByDom,
          measuredTextWidthByCanvas: measured.textWidthByCanvas,
          measuredTextWidthByDom: measured.textWidthByDom,
        };
      }),
    );
  }, [currentTextBoxMaxWidth, selectedTextBoxId]);

  const handleSelectedTextBoxFontSizeChange = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) {
        return;
      }

      const nextFontSize = clamp(value, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX);
      updateSelectedTextBox((box) => ({
        ...box,
        fontSize: nextFontSize,
      }));
    },
    [updateSelectedTextBox],
  );

  const handleSelectedTextBoxWidthChange = useCallback(
    (value: number) => {
      if (!Number.isFinite(value)) {
        return;
      }

      const nextWidth = clamp(value, TEXT_BOX_MIN_WIDTH, currentTextBoxMaxWidth);
      updateSelectedTextBox((box) => ({
        ...box,
        width: nextWidth,
      }));
    },
    [currentTextBoxMaxWidth, updateSelectedTextBox],
  );

  const handlePhoneScalePercentChange = useCallback((value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }

    const nextPercent = clamp(value, PHONE_SCALE_PERCENT_MIN, PHONE_SCALE_PERCENT_MAX);
    setPhoneScale(nextPercent / 100);
  }, []);

  const copySelectedTextBox = useCallback(() => {
    if (!selectedTextBox) {
      return false;
    }

    lastCopyKindRef.current = 'text-box';
    copiedTextBoxRef.current = { ...selectedTextBox };
    setHasCopiedTextBox(true);
    setStatusMessage('선택한 텍스트박스를 복사했습니다.');
    setErrorMessage('');
    return true;
  }, [selectedTextBox]);

  const pasteCopiedTextBox = useCallback(() => {
    const source = copiedTextBoxRef.current;
    if (!source) {
      return false;
    }

    const id = `text-${nextTextBoxIdRef.current}`;
    nextTextBoxIdRef.current += 1;
    const duplicated: TextBoxModel = {
      ...source,
      id,
      x: source.x + 24,
      y: source.y + 24,
      width: clamp(source.width, TEXT_BOX_MIN_WIDTH, currentTextBoxMaxWidth),
    };

    setTextBoxes((previous) => [...previous, duplicated]);
    setSelectedTextBoxId(id);
    setIsPlacingTextBox(false);
    setStatusMessage('텍스트박스를 붙여넣었습니다.');
    setErrorMessage('');
    return true;
  }, [currentTextBoxMaxWidth]);

  const copyCurrentCanvasToClipboard = useCallback(async () => {
    if (!currentProject || !currentProjectState) {
      return false;
    }

    const sourceCanvas =
      currentProjectState.canvases.find((canvas) => canvas.id === currentCanvasId) ?? currentProjectState.canvases[0];
    if (!sourceCanvas) {
      return false;
    }

    let mediaRecord: ProjectMediaRecord | null = null;
    if (sourceCanvas.state.media.kind) {
      const sourceMediaKey = buildProjectCanvasMediaKey(currentProject.id, sourceCanvas.id);
      mediaRecord = await readProjectMediaRecord(sourceMediaKey);
      if (!mediaRecord) {
        mediaRecord = await readProjectMediaRecord(currentProject.id);
      }
      if (!mediaRecord && sourceCanvas.state.media.name) {
        mediaRecord = await findProjectMediaRecordByKindAndName(
          sourceCanvas.state.media.kind,
          sourceCanvas.state.media.name,
        );
      }
    }

    const payload: CanvasClipboardPayload = {
      version: 1,
      sourceProjectId: currentProject.id,
      sourceCanvasId: sourceCanvas.id,
      canvasName: sourceCanvas.name,
      state: cloneCanvasState(sourceCanvas.state),
      copiedAt: new Date().toISOString(),
    };
    lastCopyKindRef.current = 'canvas';
    copiedCanvasRef.current = {
      ...payload,
      thumbnailDataUrl: sourceCanvas.thumbnailDataUrl,
      mediaRecord,
    };

    const clipboardText = encodeCanvasClipboardPayload(payload);
    let clipboardWriteSucceeded = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        clipboardWriteSucceeded = true;
      }
    } catch {
      clipboardWriteSucceeded = false;
    }

    if (clipboardWriteSucceeded) {
      setStatusMessage(`${sourceCanvas.name} 캔버스 메타데이터를 클립보드에 복사했습니다.`);
      setErrorMessage('');
    } else {
      setStatusMessage(`${sourceCanvas.name} 캔버스를 내부 클립보드에 복사했습니다.`);
      setErrorMessage('브라우저 클립보드 쓰기 권한이 없어 같은 탭 내 붙여넣기만 보장됩니다.');
    }
    return true;
  }, [currentCanvasId, currentProject, currentProjectState]);

  const pasteCanvasFromClipboard = useCallback(async () => {
    if (!currentProject || !currentProjectState) {
      return false;
    }

    let payload: CanvasClipboardPayload | null = null;
    let preferredMediaRecord: ProjectMediaRecord | null = null;
    let preferredThumbnailDataUrl: string | undefined;

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
        const rawText = await navigator.clipboard.readText();
        payload = decodeCanvasClipboardPayloadText(rawText);
      }
    } catch {
      payload = null;
    }

    const inMemoryPayload = copiedCanvasRef.current;
    if (payload) {
      if (
        inMemoryPayload &&
        inMemoryPayload.sourceProjectId === payload.sourceProjectId &&
        inMemoryPayload.sourceCanvasId === payload.sourceCanvasId &&
        inMemoryPayload.copiedAt === payload.copiedAt
      ) {
        preferredMediaRecord = inMemoryPayload.mediaRecord;
        preferredThumbnailDataUrl = inMemoryPayload.thumbnailDataUrl;
      }
    } else if (inMemoryPayload && lastCopyKindRef.current === 'canvas') {
      payload = {
        version: inMemoryPayload.version,
        sourceProjectId: inMemoryPayload.sourceProjectId,
        sourceCanvasId: inMemoryPayload.sourceCanvasId,
        canvasName: inMemoryPayload.canvasName,
        state: cloneCanvasState(inMemoryPayload.state),
        copiedAt: inMemoryPayload.copiedAt,
      };
      preferredMediaRecord = inMemoryPayload.mediaRecord;
      preferredThumbnailDataUrl = inMemoryPayload.thumbnailDataUrl;
    }

    if (!payload) {
      return false;
    }

    return duplicateCanvasIntoCurrentProject({
      sourceProjectId: payload.sourceProjectId,
      sourceCanvasId: payload.sourceCanvasId,
      sourceCanvasName: payload.canvasName,
      sourceCanvasState: cloneCanvasState(payload.state),
      sourceThumbnailDataUrl: preferredThumbnailDataUrl,
      preferredMediaRecord,
    });
  }, [currentProject, currentProjectState, duplicateCanvasIntoCurrentProject]);

  const applyAppHistorySnapshot = useCallback(
    (snapshot: AppHistorySnapshot) => {
      isApplyingHistoryRef.current = true;
      const updatedAtByProjectId = new Map(projects.map((project) => [project.id, project.updatedAt]));
      const revisionByProjectId = new Map(projects.map((project) => [project.id, project.revision]));
      const now = new Date().toISOString();
      const nextProjects: ProjectRecord[] = snapshot.projects.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: updatedAtByProjectId.get(project.id) ?? now,
        revision: revisionByProjectId.get(project.id) ?? 0,
        state: cloneProjectDesignState(project.state),
      }));

      const fallbackProject = nextProjects[0];
      const activeProject = nextProjects.find((project) => project.id === snapshot.currentProjectId) ?? fallbackProject;
      if (!activeProject) {
        return;
      }

      const targetCanvas =
        activeProject.state.canvases.find((canvas) => canvas.id === snapshot.currentCanvasId) ??
        activeProject.state.canvases.find((canvas) => canvas.id === activeProject.state.currentCanvasId) ??
        activeProject.state.canvases[0];
      if (!targetCanvas) {
        return;
      }

      if (activeProject.state.currentCanvasId !== targetCanvas.id) {
        activeProject.state.currentCanvasId = targetCanvas.id;
      }

      const targetState = targetCanvas.state;
      const nextSelectedTextBoxId =
        snapshot.selectedTextBoxId && targetState.textBoxes.some((box) => box.id === snapshot.selectedTextBoxId)
          ? snapshot.selectedTextBoxId
          : null;

      loadedProjectIdRef.current = activeProject.id;
      setProjects(nextProjects);
      setCurrentProjectId(activeProject.id);
      setCurrentCanvasId(targetCanvas.id);
      setCanvasPresetId(targetState.canvasPresetId);
      setBackgroundMode(targetState.backgroundMode);
      setBackgroundPrimary(targetState.backgroundPrimary);
      setBackgroundSecondary(targetState.backgroundSecondary);
      setGradientAngle(targetState.gradientAngle);
      setPhoneOffset({ ...targetState.phoneOffset });
      setPhoneScale(targetState.phoneScale);
      setTextBoxes(targetState.textBoxes.map((box) => ({ ...box })));
      setSelectedTextBoxId(nextSelectedTextBoxId);
      setIsPlacingTextBox(false);
      setIsInlineTextEditing(false);
      nextTextBoxIdRef.current = getNextTextBoxSerial(targetState.textBoxes);

      if (targetState.media.kind) {
        void restoreProjectMedia(activeProject, targetCanvas.id);
      } else {
        clearLoadedMedia();
        setStatusMessage(`${activeProject.name} / ${targetCanvas.name} 캔버스를 복원했습니다.`);
        setErrorMessage('');
      }
    },
    [clearLoadedMedia, projects, restoreProjectMedia],
  );

  const handleUndo = useCallback(() => {
    const entry = historyEntryRef.current;
    if (!entry.present || entry.past.length === 0) {
      return false;
    }

    const previousSnapshot = entry.past.pop();
    if (!previousSnapshot) {
      return false;
    }

    entry.future.unshift(cloneAppHistorySnapshot(entry.present));
    entry.present = cloneAppHistorySnapshot(previousSnapshot);
    applyAppHistorySnapshot(previousSnapshot);
    setCanUndo(entry.past.length > 0);
    setCanRedo(entry.future.length > 0);
    setStatusMessage('이전 작업으로 되돌렸습니다.');
    return true;
  }, [applyAppHistorySnapshot]);

  const handleRedo = useCallback(() => {
    const entry = historyEntryRef.current;
    if (!entry.present || entry.future.length === 0) {
      return false;
    }

    const nextSnapshot = entry.future.shift();
    if (!nextSnapshot) {
      return false;
    }

    entry.past.push(cloneAppHistorySnapshot(entry.present));
    entry.present = cloneAppHistorySnapshot(nextSnapshot);
    applyAppHistorySnapshot(nextSnapshot);
    setCanUndo(entry.past.length > 0);
    setCanRedo(entry.future.length > 0);
    setStatusMessage('되돌리기 작업을 다시 적용했습니다.');
    return true;
  }, [applyAppHistorySnapshot]);

  const drawCurrentFrame = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return;
    }

    canvas.width = currentCanvasPreset.width;
    canvas.height = currentCanvasPreset.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const media = assetKind === 'video' ? videoRef.current : imageRef.current;

    const layout = drawComposition(ctx, {
      width: currentCanvasPreset.width,
      height: currentCanvasPreset.height,
      backgroundMode,
      backgroundPrimary,
      backgroundSecondary,
      gradientAngle,
      phoneOffset,
      phoneScale,
      textBoxes,
      selectedTextBoxId,
      showGuides: true,
      snapGuide,
      emptyStateFileLabel: assetName || '선택된 파일 없음',
      media,
    });

    layoutRef.current = layout;
  }, [
    assetName,
    assetKind,
    backgroundMode,
    backgroundPrimary,
    backgroundSecondary,
    currentCanvasPreset.height,
    currentCanvasPreset.width,
    gradientAngle,
    phoneOffset,
    phoneScale,
    snapGuide,
    selectedTextBoxId,
    textBoxes,
  ]);

  useEffect(() => {
    drawCurrentFrame();
  }, [drawCurrentFrame]);

  useEffect(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (assetKind !== 'video' || !videoRef.current) {
      return;
    }

    const frame = () => {
      drawCurrentFrame();
      rafRef.current = requestAnimationFrame(frame);
    };

    frame();

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [assetKind, drawCurrentFrame]);

  useEffect(() => {
    if (selectedTextBoxId && !textBoxes.some((box) => box.id === selectedTextBoxId)) {
      setSelectedTextBoxId(null);
    }
  }, [selectedTextBoxId, textBoxes]);

  useEffect(() => {
    if (!selectedTextBoxId) {
      setIsInlineTextEditing(false);
    }
  }, [selectedTextBoxId]);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas) {
      return;
    }

    const updateClientSize = () => {
      const rect = canvas.getBoundingClientRect();
      setCanvasClientSize((previous) => {
        if (previous.width === rect.width && previous.height === rect.height) {
          return previous;
        }

        return { width: rect.width, height: rect.height };
      });
    };

    updateClientSize();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        updateClientSize();
      });
      observer.observe(canvas);
    }

    window.addEventListener('resize', updateClientSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateClientSize);
    };
  }, []);

  useEffect(() => {
    if (!isInlineTextEditing || !selectedTextBoxId) {
      return;
    }

    const editor = inlineTextEditorRef.current;
    if (!editor) {
      return;
    }

    focusElementWithoutScroll(editor);
    const end = editor.value.length;
    editor.setSelectionRange(end, end);
  }, [isInlineTextEditing, selectedTextBoxId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      const isDeleteKey = event.key === 'Backspace' || event.key === 'Delete';
      if (isDeleteKey && !event.metaKey && !event.ctrlKey && !event.altKey && selectedTextBoxId) {
        setTextBoxes((previous) => previous.filter((box) => box.id !== selectedTextBoxId));
        setSelectedTextBoxId(null);
        setIsInlineTextEditing(false);
        setStatusMessage('선택한 텍스트박스를 삭제했습니다.');
        event.preventDefault();
        return;
      }

      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && selectedTextBoxId) {
        setIsInlineTextEditing(true);
        setStatusMessage('선택한 텍스트박스를 캔버스에서 바로 편집합니다.');
        event.preventDefault();
        return;
      }

      if ((!event.metaKey && !event.ctrlKey) || event.altKey) {
        return;
      }

      const key = event.key.toLowerCase();
      const code = event.code;
      const isUndoKey = code === 'KeyZ' || key === 'z';
      const isRedoAltKey = code === 'KeyY' || key === 'y';
      const isCopyKey = code === 'KeyC' || key === 'c';
      const isPasteKey = code === 'KeyV' || key === 'v';

      if (isUndoKey) {
        const didHandle = event.shiftKey ? handleRedo() : handleUndo();
        if (didHandle) {
          event.preventDefault();
        }
        return;
      }

      if (!event.shiftKey && isRedoAltKey) {
        if (handleRedo()) {
          event.preventDefault();
        }
        return;
      }

      if (isCopyKey) {
        if (selectedTextBox && copySelectedTextBox()) {
          event.preventDefault();
          return;
        }
        event.preventDefault();
        void copyCurrentCanvasToClipboard();
        return;
      }

      if (isPasteKey) {
        event.preventDefault();
        void (async () => {
          if (lastCopyKindRef.current === 'text-box' && hasCopiedTextBox) {
            pasteCopiedTextBox();
            return;
          }

          const didPasteCanvas = await pasteCanvasFromClipboard();
          if (didPasteCanvas) {
            return;
          }
          if (hasCopiedTextBox) {
            pasteCopiedTextBox();
          }
        })();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    copyCurrentCanvasToClipboard,
    copySelectedTextBox,
    handleRedo,
    handleUndo,
    hasCopiedTextBox,
    pasteCanvasFromClipboard,
    pasteCopiedTextBox,
    selectedTextBox,
    selectedTextBoxId,
  ]);

  useEffect(() => {
    if (loadedProjectIdRef.current === currentProjectId) {
      return;
    }

    const targetProject = projects.find((project) => project.id === currentProjectId);
    if (!targetProject) {
      return;
    }

    loadedProjectIdRef.current = currentProjectId;
    clearLoadedMedia();
    applyProjectState(targetProject);
    void restoreProjectMedia(targetProject);
  }, [applyProjectState, clearLoadedMedia, currentProjectId, projects, restoreProjectMedia]);

  useEffect(() => {
    if (!currentProject || !canvasThumbnailPreloadSignature) {
      return;
    }

    if (lastCanvasPreloadSignatureRef.current === canvasThumbnailPreloadSignature) {
      return;
    }
    lastCanvasPreloadSignatureRef.current = canvasThumbnailPreloadSignature;

    let cancelled = false;
    const targetProjectId = currentProject.id;
    const canvasesSnapshot = currentProject.state.canvases.map((canvas) => ({
      ...canvas,
      state: cloneCanvasState(canvas.state),
    }));

    void (async () => {
      const nextThumbnails = new Map<string, string>();

      for (let index = 0; index < canvasesSnapshot.length; index += 1) {
        if (cancelled) {
          return;
        }

        const canvas = canvasesSnapshot[index];
        if (!canvas) {
          continue;
        }

        let objectUrl: string | null = null;
        let mediaElement: HTMLImageElement | HTMLVideoElement | null = null;

        try {
          if (typeof indexedDB !== 'undefined' && canvas.state.media.kind) {
            const mediaKey = buildProjectCanvasMediaKey(targetProjectId, canvas.id);
            let mediaRecord = await readProjectMediaRecord(mediaKey);
            const firstCanvasId = canvasesSnapshot[0]?.id ?? '';
            if (!mediaRecord && canvas.id === firstCanvasId) {
              mediaRecord = await readProjectMediaRecord(targetProjectId);
            }
            if (!mediaRecord && canvas.state.media.name) {
              mediaRecord = await findProjectMediaRecordByKindAndName(canvas.state.media.kind, canvas.state.media.name);
              if (mediaRecord && mediaRecord.projectId !== mediaKey) {
                void saveProjectMediaRecord({
                  ...mediaRecord,
                  projectId: mediaKey,
                  updatedAt: new Date().toISOString(),
                }).catch(() => undefined);
              }
            }

            if (mediaRecord) {
              objectUrl = URL.createObjectURL(mediaRecord.blob);
              if (mediaRecord.kind === 'image') {
                mediaElement = await new Promise<HTMLImageElement>((resolve, reject) => {
                  const instance = new Image();
                  instance.onload = () => resolve(instance);
                  instance.onerror = () => reject(new Error('썸네일 이미지 로드 실패'));
                  instance.src = objectUrl as string;
                });
              } else {
                mediaElement = await new Promise<HTMLVideoElement>((resolve, reject) => {
                  const instance = document.createElement('video');
                  instance.preload = 'auto';
                  instance.playsInline = true;
                  instance.muted = true;
                  instance.loop = false;
                  instance.src = objectUrl as string;

                  const onLoadedData = () => resolve(instance);
                  const onError = () => reject(new Error('썸네일 영상 로드 실패'));
                  instance.addEventListener('loadeddata', onLoadedData, { once: true });
                  instance.addEventListener('error', onError, { once: true });
                });
              }
            }
          }

          if (cancelled) {
            return;
          }

          const thumbnailDataUrl = createCanvasThumbnailDataUrl(canvas.state, mediaElement);
          if (thumbnailDataUrl) {
            nextThumbnails.set(canvas.id, thumbnailDataUrl);
          }
        } catch {
          // Ignore per-canvas failure and continue with remaining canvases.
        } finally {
          if (mediaElement instanceof HTMLVideoElement) {
            mediaElement.pause();
          }
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
        }
      }

      if (cancelled || nextThumbnails.size === 0) {
        return;
      }

      setProjects((previous) =>
        previous.map((project) => {
          if (project.id !== targetProjectId) {
            return project;
          }

          let changed = false;
          const canvases = project.state.canvases.map((canvas) => {
            const nextThumbnail = nextThumbnails.get(canvas.id);
            if (!nextThumbnail || canvas.thumbnailDataUrl === nextThumbnail) {
              return canvas;
            }

            changed = true;
            return {
              ...canvas,
              thumbnailDataUrl: nextThumbnail,
            };
          });

          if (!changed) {
            return project;
          }

          return {
            ...project,
            state: {
              ...project.state,
              canvases,
            },
          };
        }),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [canvasThumbnailPreloadSignature, currentProject]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      let hydrationSucceeded = false;
      try {
        const legacyStore = getLegacyLocalProjectStore();
        const readSummaries = async () => {
          const listResponse = await fetch('/api/projects', { signal: controller.signal });
          if (!listResponse.ok) {
            throw new Error('API project list read failed.');
          }
          const listPayload = (await listResponse.json()) as ApiProjectListPayload;
          return Array.isArray(listPayload.projects) ? listPayload.projects : [];
        };

        let summaries = await readSummaries();

        const shouldMigrateLegacyLocalProjects =
          typeof window !== 'undefined' &&
          summaries.length === 0 &&
          legacyStore.projects.length > 0 &&
          window.localStorage.getItem(API_SOT_MIGRATION_MARKER_KEY) !== 'done';

        if (shouldMigrateLegacyLocalProjects) {
          await Promise.allSettled(
            legacyStore.projects.map((project) =>
              fetch('/api/projects/import', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  payload: {
                    id: project.id,
                    name: project.name,
                    updatedAt: project.updatedAt,
                    state: project.state,
                  },
                }),
                signal: controller.signal,
              }),
            ),
          );

          if (typeof window !== 'undefined') {
            window.localStorage.setItem(API_SOT_MIGRATION_MARKER_KEY, 'done');
          }
          summaries = await readSummaries();
        }

        if (summaries.length === 0) {
          const createResponse = await fetch('/api/projects', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: '프로젝트 1',
            }),
            signal: controller.signal,
          });

          if (createResponse.ok) {
            const createdPayload = (await createResponse.json()) as ApiProjectDetailPayload;
            const createdProject = createdPayload.project;
            if (createdProject?.id && createdProject.name && createdProject.updatedAt) {
              summaries = [
                {
                  id: createdProject.id,
                  name: createdProject.name,
                  updatedAt: createdProject.updatedAt,
                  revision:
                    typeof createdProject.revision === 'number' && Number.isFinite(createdProject.revision)
                      ? Math.max(0, Math.floor(createdProject.revision))
                      : 0,
                  canvasCount: 1,
                  currentCanvasId: sanitizeProjectState(createdPayload.state).currentCanvasId,
                  source: 'api',
                },
              ];
            }
          }
        }

        if (summaries.length === 0) {
          throw new Error('No projects available from API storage.');
        }

        const orderedSummaries = [...summaries];
        const preferredSummaryId =
          orderedSummaries.find((project) => project.id === legacyStore.currentProjectId)?.id ?? orderedSummaries[0].id;
        const summaryProjects = orderedSummaries.map((summary) => ({
          id: summary.id,
          name: summary.name,
          updatedAt: summary.updatedAt,
          revision:
            typeof summary.revision === 'number' && Number.isFinite(summary.revision)
              ? Math.max(0, Math.floor(summary.revision))
              : 0,
          state: createProjectDesignState(),
        }));
        const summaryPreferredProject = summaryProjects.find((project) => project.id === preferredSummaryId) ?? summaryProjects[0];
        const summaryPreferredCanvasId = summaryPreferredProject?.state.currentCanvasId ?? '';

        syncableProjectIdsRef.current = new Set();
        loadedProjectIdRef.current = null;
        setProjects(summaryProjects);
        setCurrentProjectId(summaryPreferredProject.id);
        setCurrentCanvasId(summaryPreferredCanvasId);
        setStatusMessage(`${summaryProjects.length}개 API 프로젝트를 불러오는 중입니다...`);
        setErrorMessage('');

        const detailedProjects = await Promise.all(
          summaries.map(async (summary) => {
            try {
              const detailResponse = await fetch(
                `/api/projects/${encodeURIComponent(summary.id)}?includeThumbnails=false`,
                {
                  signal: controller.signal,
                },
              );
              if (!detailResponse.ok) {
                return null;
              }

              const detailPayload = (await detailResponse.json()) as ApiProjectDetailPayload;
              const projectId = detailPayload.project?.id ?? summary.id;
              const projectName = detailPayload.project?.name ?? summary.name;
              const updatedAt = detailPayload.project?.updatedAt ?? summary.updatedAt;
              const revisionRaw = detailPayload.project?.revision ?? summary.revision;
              const revision =
                typeof revisionRaw === 'number' && Number.isFinite(revisionRaw)
                  ? Math.max(0, Math.floor(revisionRaw))
                  : 0;

              return {
                id: projectId,
                name: projectName,
                updatedAt,
                revision,
                state: sanitizeProjectState(detailPayload.state),
              } satisfies ProjectRecord;
            } catch {
              return null;
            }
          }),
        );

        const normalizedDetailed = detailedProjects.filter((project): project is ProjectRecord => Boolean(project));
        const detailById = new Map(normalizedDetailed.map((project) => [project.id, project]));
        const mergedProjects = orderedSummaries.map((summary) => {
          const detailed = detailById.get(summary.id);
          if (detailed) {
            return detailed;
          }

          return {
            id: summary.id,
            name: summary.name,
            updatedAt: summary.updatedAt,
            revision:
              typeof summary.revision === 'number' && Number.isFinite(summary.revision)
                ? Math.max(0, Math.floor(summary.revision))
                : 0,
            state: createProjectDesignState(),
          } satisfies ProjectRecord;
        });

        if (controller.signal.aborted) {
          return;
        }

        if (normalizedDetailed.length === 0) {
          throw new Error('API detail hydration failed.');
        }

        const preferredProject = mergedProjects.find((project) => project.id === preferredSummaryId) ?? mergedProjects[0];
        const preferredCanvasId =
          preferredProject.state.canvases.find((canvas) => canvas.id === preferredProject.state.currentCanvasId)?.id ??
          preferredProject.state.canvases[0]?.id ??
          '';

        syncableProjectIdsRef.current = new Set(normalizedDetailed.map((project) => project.id));
        loadedProjectIdRef.current = null;
        setProjects(mergedProjects);
        setCurrentProjectId(preferredProject.id);
        setCurrentCanvasId(preferredCanvasId);

        setStatusMessage(`${mergedProjects.length}개 API 프로젝트를 불러왔습니다.`);
        setErrorMessage('');
        hydrationSucceeded = true;
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setErrorMessage('API 저장소를 불러오지 못했습니다. API 서버 상태를 확인해 주세요.');
      } finally {
        apiHydrationCompletedRef.current = hydrationSucceeded;
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    if (!apiHydrationCompletedRef.current || !currentProjectId) {
      return;
    }

    const pendingHydrationSet = pendingProjectDetailHydrationRef.current;
    if (syncableProjectIdsRef.current.has(currentProjectId)) {
      return;
    }

    if (pendingHydrationSet.has(currentProjectId)) {
      return;
    }

    const targetProjectId = currentProjectId;
    pendingHydrationSet.add(targetProjectId);
    const controller = new AbortController();

    void (async () => {
      try {
        const detailResponse = await fetch(`/api/projects/${encodeURIComponent(targetProjectId)}?includeThumbnails=false`, {
          signal: controller.signal,
        });
        if (!detailResponse.ok) {
          return;
        }

        const detailPayload = (await detailResponse.json()) as ApiProjectDetailPayload;
        const hydratedProject: ProjectRecord = {
          id: detailPayload.project?.id ?? targetProjectId,
          name: detailPayload.project?.name ?? '프로젝트',
          updatedAt: detailPayload.project?.updatedAt ?? new Date().toISOString(),
          revision:
            typeof detailPayload.project?.revision === 'number' && Number.isFinite(detailPayload.project.revision)
              ? Math.max(0, Math.floor(detailPayload.project.revision))
              : 0,
          state: sanitizeProjectState(detailPayload.state),
        };

        markProjectSyncable(hydratedProject.id);
        loadedProjectIdRef.current = null;
        setProjects((previous) =>
          previous.map((project) => (project.id === targetProjectId ? hydratedProject : project)),
        );
        setStatusMessage(`${hydratedProject.name} 프로젝트 상세를 다시 불러왔습니다.`);
        setErrorMessage('');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
      } finally {
        pendingHydrationSet.delete(targetProjectId);
      }
    })();

    return () => {
      controller.abort();
      pendingHydrationSet.delete(targetProjectId);
    };
  }, [currentProjectId, markProjectSyncable]);

  useEffect(() => {
    if (!apiHydrationCompletedRef.current || projects.length === 0 || isMeasuringAll) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        if (isMeasuringAllRef.current) {
          return;
        }
        const isCurrentProjectDraftReady =
          loadedProjectIdRef.current === currentProjectId && Boolean(currentProjectState);
        const syncableIds = syncableProjectIdsRef.current;
        const syncTargets = projects
          .filter((project) => syncableIds.has(project.id))
          .map((project) => ({
            id: project.id,
            name: project.name,
            updatedAt: project.id === currentProjectId ? new Date().toISOString() : project.updatedAt,
            revision: project.revision,
            state: cloneProjectDesignState(
              project.id === currentProjectId && isCurrentProjectDraftReady && currentProjectState
                ? currentProjectState
                : project.state,
            ),
          }));
        if (syncTargets.length === 0) {
          return;
        }

        const results = await Promise.allSettled(
          syncTargets.map(async (project) => {
            const response = await fetch('/api/projects/import', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                expectedRevision: project.revision,
                payload: {
                  id: project.id,
                  name: project.name,
                  updatedAt: project.updatedAt,
                  state: project.state,
                },
              }),
            });

            const responsePayload = (await response.json().catch(() => null)) as
              | (ApiProjectDetailPayload & {
                  error?: unknown;
                  message?: unknown;
                  code?: unknown;
                  expectedRevision?: unknown;
                  actualRevision?: unknown;
                })
              | null;

            if (response.ok) {
              const nextRevisionRaw = responsePayload?.project?.revision;
              const nextRevision =
                typeof nextRevisionRaw === 'number' && Number.isFinite(nextRevisionRaw)
                  ? Math.max(0, Math.floor(nextRevisionRaw))
                  : project.revision;
              return {
                ok: true as const,
                projectId: project.id,
                status: response.status,
                revision: nextRevision,
              };
            }

            let message = '';
            if (typeof responsePayload?.message === 'string') {
              message = responsePayload.message;
            } else if (typeof responsePayload?.error === 'string') {
              message = responsePayload.error;
            }
            const code = typeof responsePayload?.code === 'string' ? responsePayload.code : '';
            const actualRevision =
              typeof responsePayload?.actualRevision === 'number' && Number.isFinite(responsePayload.actualRevision)
                ? Math.max(0, Math.floor(responsePayload.actualRevision))
                : null;

            return {
              ok: false as const,
              projectId: project.id,
              status: response.status,
              message,
              code,
              actualRevision,
            };
          }),
        );

        const successfulResponses = results
          .filter(
            (result): result is PromiseFulfilledResult<{ ok: true; projectId: string; status: number; revision: number }> =>
              result.status === 'fulfilled' && result.value.ok,
          )
          .map((result) => result.value);
        if (successfulResponses.length > 0) {
          const revisionByProjectId = new Map(successfulResponses.map((result) => [result.projectId, result.revision]));
          setProjects((previous) =>
            previous.map((project) => {
              const nextRevision = revisionByProjectId.get(project.id);
              if (typeof nextRevision !== 'number' || project.revision === nextRevision) {
                return project;
              }
              return {
                ...project,
                revision: nextRevision,
              };
            }),
          );
        }

        const hasRejected = results.some((result) => result.status === 'rejected');
        const failedResponses = results
          .filter(
            (
              result,
            ): result is PromiseFulfilledResult<{
              ok: false;
              projectId: string;
              status: number;
              message: string;
              code: string;
              actualRevision: number | null;
            }> => result.status === 'fulfilled' && !result.value.ok,
          )
          .map((result) => result.value);

        if (hasRejected || failedResponses.length > 0) {
          const conflictedProjectIds = failedResponses
            .filter((result) => result.status === 409)
            .map((result) => result.projectId);
          for (const conflictedProjectId of conflictedProjectIds) {
            removeProjectFromSyncable(conflictedProjectId);
          }
          const hasConflict = conflictedProjectIds.length > 0;
          if (hasConflict) {
            setErrorMessage('데이터 보호를 위해 일부 프로젝트 동기화가 차단되었습니다. 새로고침 후 다시 확인해 주세요.');
          } else {
            setErrorMessage('일부 프로젝트를 API 저장소로 동기화하지 못했습니다.');
          }
        }
      })();
    }, PROJECT_AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [currentProjectId, currentProjectState, isMeasuringAll, projects, removeProjectFromSyncable]);

  useEffect(() => {
    if (!currentProjectState) {
      return;
    }

    if (loadedProjectIdRef.current !== currentProjectId) {
      return;
    }

    const timer = window.setTimeout(() => {
      const now = new Date().toISOString();
      setProjects((previous) =>
        previous.map((project) =>
          project.id === currentProjectId
            ? {
                ...project,
                updatedAt: now,
                state: currentProjectState,
              }
            : project,
        ),
      );
    }, PROJECT_AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [currentProjectId, currentProjectState]);

  useEffect(() => {
    if (!currentCanvasId) {
      return;
    }

    const timer = window.setTimeout(() => {
      const canUseLoadedMedia =
        currentCanvasState.media.kind !== null &&
        currentCanvasState.media.kind === assetKind &&
        currentCanvasState.media.name === assetName;
      const media =
        canUseLoadedMedia
          ? assetKind === 'video'
            ? videoRef.current
            : assetKind === 'image'
              ? imageRef.current
              : null
          : null;
      const thumbnailDataUrl = createCanvasThumbnailDataUrl(currentCanvasState, media);
      if (!thumbnailDataUrl) {
        return;
      }

      setProjects((previous) => {
        let changed = false;
        const next = previous.map((project) => {
          if (project.id !== currentProjectId) {
            return project;
          }

          const canvases = project.state.canvases.map((canvas) => {
            if (canvas.id !== currentCanvasId || canvas.thumbnailDataUrl === thumbnailDataUrl) {
              return canvas;
            }
            changed = true;
            return {
              ...canvas,
              thumbnailDataUrl,
            };
          });

          if (!changed) {
            return project;
          }

          return {
            ...project,
            state: {
              ...project.state,
              canvases,
            },
          };
        });

        return changed ? next : previous;
      });
    }, CANVAS_THUMBNAIL_AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [assetKind, assetName, assetUrl, currentCanvasId, currentCanvasState, currentProjectId]);

  useEffect(() => {
    const snapshot = buildAppHistorySnapshot();
    if (snapshot.projects.length === 0) {
      setCanUndo(false);
      setCanRedo(false);
      return;
    }

    const entry = historyEntryRef.current;
    if (!entry.present) {
      entry.present = snapshot;
      setCanUndo(false);
      setCanRedo(false);
      return;
    }

    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false;
      entry.present = snapshot;
      setCanUndo(entry.past.length > 0);
      setCanRedo(entry.future.length > 0);
      return;
    }

    if (areAppHistorySnapshotsEqual(entry.present, snapshot)) {
      setCanUndo(entry.past.length > 0);
      setCanRedo(entry.future.length > 0);
      return;
    }

    const timer = window.setTimeout(() => {
      const latestEntry = historyEntryRef.current;
      if (!latestEntry.present) {
        return;
      }

      if (areAppHistorySnapshotsEqual(latestEntry.present, snapshot)) {
        setCanUndo(latestEntry.past.length > 0);
        setCanRedo(latestEntry.future.length > 0);
        return;
      }

      latestEntry.past.push(cloneAppHistorySnapshot(latestEntry.present));
      if (latestEntry.past.length > HISTORY_LIMIT_PER_CANVAS) {
        latestEntry.past.shift();
      }
      latestEntry.present = snapshot;
      latestEntry.future = [];
      setCanUndo(latestEntry.past.length > 0);
      setCanRedo(false);
    }, HISTORY_IDLE_COMMIT_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [buildAppHistorySnapshot]);

  useEffect(() => {
    if (!connectedSaveDirectory || !currentProject) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await persistProjectFileToDirectory(currentProject);
          autoSaveErrorNotifiedRef.current = false;
          setLastAutoSavedAt(new Date().toLocaleTimeString('ko-KR', { hour12: false }));
        } catch (error) {
          if (!autoSaveErrorNotifiedRef.current) {
            setErrorMessage(
              error instanceof Error ? error.message : '자동 파일 저장에 실패했습니다. 저장 폴더를 다시 연결해 주세요.',
            );
            autoSaveErrorNotifiedRef.current = true;
          }
        }
      })();
    }, PROJECT_AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [connectedSaveDirectory, currentProject, persistProjectFileToDirectory]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }

      if (assetUrlRef.current) {
        URL.revokeObjectURL(assetUrlRef.current);
      }

      if (artifactUrlRef.current) {
        URL.revokeObjectURL(artifactUrlRef.current);
      }

      videoRef.current?.pause();
    };
  }, []);

  const processMediaFile = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        setErrorMessage('이미지 또는 영상 파일만 업로드할 수 있습니다.');
        setStatusMessage('지원 포맷을 확인해 주세요.');
        return;
      }

      if (!currentMediaStorageKey) {
        setErrorMessage('캔버스가 선택되지 않았습니다. 캔버스를 다시 선택해 주세요.');
        return;
      }
      const targetProjectId = currentProjectId;
      const targetCanvasId = currentCanvasId;
      if (!targetProjectId || !targetCanvasId) {
        setErrorMessage('프로젝트/캔버스 식별자 확인에 실패했습니다. 다시 시도해 주세요.');
        return;
      }
      const targetMediaStorageKey = buildProjectCanvasMediaKey(targetProjectId, targetCanvasId);

      const syncCanvasMediaToApi = async (kind: 'image' | 'video') => {
        const query = new URLSearchParams();
        query.set('kind', kind);
        query.set('name', file.name);

        const response = await fetch(
          `/api/projects/${encodeURIComponent(targetProjectId)}/canvases/${encodeURIComponent(targetCanvasId)}/media?${query.toString()}`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': file.type || (kind === 'image' ? 'image/png' : 'video/mp4'),
            },
            body: file,
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(
            errorText
              ? `API 미디어 동기화 실패 (${response.status}): ${errorText}`
              : `API 미디어 동기화 실패 (${response.status})`,
          );
        }

        const payload = (await response.json().catch(() => null)) as ApiCanvasMediaPutPayload | null;
        const revisionRaw = payload?.project?.revision;
        const updatedAtRaw = payload?.project?.updatedAt;
        const syncedKind = payload?.media?.kind === 'image' || payload?.media?.kind === 'video'
          ? payload.media.kind
          : kind;
        const syncedName = typeof payload?.media?.name === 'string' && payload.media.name
          ? payload.media.name
          : file.name;

        setProjects((previous) =>
          previous.map((project) => {
            if (project.id !== targetProjectId) {
              return project;
            }

            const nextRevision =
              typeof revisionRaw === 'number' && Number.isFinite(revisionRaw)
                ? Math.max(0, Math.floor(revisionRaw))
                : project.revision;
            const nextUpdatedAt =
              typeof updatedAtRaw === 'string' && updatedAtRaw
                ? updatedAtRaw
                : project.updatedAt;

            return {
              ...project,
              revision: nextRevision,
              updatedAt: nextUpdatedAt,
              state: {
                ...project.state,
                canvases: project.state.canvases.map((canvas) =>
                  canvas.id === targetCanvasId
                    ? {
                        ...canvas,
                        state: {
                          ...canvas.state,
                          media: {
                            kind: syncedKind,
                            name: syncedName,
                          },
                        },
                      }
                    : canvas,
                ),
              },
            };
          }),
        );
        markProjectSyncable(targetProjectId);
      };

      setErrorMessage('');
      setStatusMessage('미디어를 불러오는 중입니다...');
      setArtifact(null);

      if (artifactUrlRef.current) {
        URL.revokeObjectURL(artifactUrlRef.current);
        artifactUrlRef.current = null;
      }

      const nextUrl = URL.createObjectURL(file);
      setAssetObjectUrl(nextUrl);
      setAssetName(file.name);

      try {
        if (file.type.startsWith('image/')) {
          const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const instance = new Image();
            instance.onload = () => resolve(instance);
            instance.onerror = () => reject(new Error('이미지를 불러오지 못했습니다.'));
            instance.src = nextUrl;
          });

          videoRef.current?.pause();
          videoRef.current = null;
          imageRef.current = image;
          setAssetKind('image');
          setStatusMessage('이미지 업로드 완료. PNG로 출력됩니다.');
          void saveProjectMediaRecord({
            projectId: targetMediaStorageKey,
            kind: 'image',
            name: file.name,
            type: file.type,
            blob: file,
            updatedAt: new Date().toISOString(),
          }).catch(() => {
            setErrorMessage('이미지 캐시 저장에 실패했습니다. 새로고침 시 복원이 안 될 수 있습니다.');
          });
          void syncCanvasMediaToApi('image').catch((error) => {
            setErrorMessage(error instanceof Error ? error.message : 'API 미디어 동기화에 실패했습니다.');
          });
          return;
        }

        const video = await new Promise<HTMLVideoElement>((resolve, reject) => {
          const instance = document.createElement('video');
          instance.preload = 'auto';
          instance.playsInline = true;
          instance.muted = true;
          instance.loop = true;
          instance.src = nextUrl;

          const onLoadedData = () => resolve(instance);
          const onError = () => reject(new Error('영상을 불러오지 못했습니다.'));

          instance.addEventListener('loadeddata', onLoadedData, { once: true });
          instance.addEventListener('error', onError, { once: true });
        });

        await video.play().catch(() => undefined);

        imageRef.current = null;
        videoRef.current = video;
        setAssetKind('video');
        setStatusMessage('영상 업로드 완료. 영상으로 출력됩니다.');
        void saveProjectMediaRecord({
          projectId: targetMediaStorageKey,
          kind: 'video',
          name: file.name,
          type: file.type,
          blob: file,
          updatedAt: new Date().toISOString(),
        }).catch(() => {
          setErrorMessage('영상 캐시 저장에 실패했습니다. 새로고침 시 복원이 안 될 수 있습니다.');
        });
        void syncCanvasMediaToApi('video').catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : 'API 미디어 동기화에 실패했습니다.');
        });
      } catch (error) {
        imageRef.current = null;
        videoRef.current?.pause();
        videoRef.current = null;
        setAssetKind(null);
        setAssetName('');
        setAssetObjectUrl(null);
        setErrorMessage(error instanceof Error ? error.message : '업로드 처리에 실패했습니다.');
        setStatusMessage('파일을 다시 선택해 주세요.');
        void removeProjectMediaRecord(targetMediaStorageKey).catch(() => undefined);
      }
    },
    [currentCanvasId, currentMediaStorageKey, currentProjectId, markProjectSyncable, setAssetObjectUrl],
  );

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';

      if (!file) {
        return;
      }

      void processMediaFile(file);
    },
    [processMediaFile],
  );

  const handleUploadDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    uploadDropDepthRef.current += 1;
    setIsUploadDropActive(true);
  }, []);

  const handleUploadDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleUploadDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    uploadDropDepthRef.current = Math.max(uploadDropDepthRef.current - 1, 0);

    if (uploadDropDepthRef.current === 0) {
      setIsUploadDropActive(false);
    }
  }, []);

  const handleUploadDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      uploadDropDepthRef.current = 0;
      setIsUploadDropActive(false);

      const file = getFirstMediaFile(event.dataTransfer.files);
      if (!file) {
        setErrorMessage('이미지 또는 영상 파일만 업로드할 수 있습니다.');
        return;
      }

      void processMediaFile(file);
    },
    [processMediaFile],
  );

  const handleCanvasDragEnter = useCallback((event: DragEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    canvasDropDepthRef.current += 1;

    const point = toCanvasPoint(event.clientX, event.clientY);
    setIsCanvasDropActive(isPointInsidePhoneScreen(point));
  }, [isPointInsidePhoneScreen, toCanvasPoint]);

  const handleCanvasDragOver = useCallback((event: DragEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';

    const point = toCanvasPoint(event.clientX, event.clientY);
    setIsCanvasDropActive(isPointInsidePhoneScreen(point));
  }, [isPointInsidePhoneScreen, toCanvasPoint]);

  const handleCanvasDragLeave = useCallback((event: DragEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.stopPropagation();
    canvasDropDepthRef.current = Math.max(canvasDropDepthRef.current - 1, 0);

    if (canvasDropDepthRef.current === 0) {
      setIsCanvasDropActive(false);
    }
  }, []);

  const handleCanvasDrop = useCallback(
    (event: DragEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      event.stopPropagation();
      canvasDropDepthRef.current = 0;
      setIsCanvasDropActive(false);

      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!isPointInsidePhoneScreen(point)) {
        setStatusMessage('아이폰 화면 영역 안에 드롭해 주세요.');
        return;
      }

      const file = getFirstMediaFile(event.dataTransfer.files);
      if (!file) {
        setErrorMessage('이미지 또는 영상 파일만 업로드할 수 있습니다.');
        return;
      }

      void processMediaFile(file);
    },
    [isPointInsidePhoneScreen, processMediaFile, toCanvasPoint],
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      setIsInlineTextEditing(false);
      focusElementWithoutScroll(event.currentTarget);
      const point = toCanvasPoint(event.clientX, event.clientY);
      const layout = layoutRef.current;

      if (!point || !layout) {
        return;
      }

      const hitTextBox = findTopmostTextBoxAtPoint(point, layout);

      if (hitTextBox) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const isResizeHandleHit =
          selectedTextBoxId === hitTextBox.id && pointInRect(point, getTextBoxResizeHandleRect(hitTextBox.bounds));
        event.currentTarget.style.cursor = isResizeHandleHit ? 'nwse-resize' : 'grabbing';

        bringTextBoxToFront(hitTextBox.id);
        setSelectedTextBoxId(hitTextBox.id);
        updateSnapGuide({ vertical: false, horizontal: false });
        dragSessionRef.current = {
          target: isResizeHandleHit ? 'text-box-resize' : 'text-box',
          pointerId: event.pointerId,
          startPoint: point,
          startPhoneOffset: phoneOffset,
          axisLock: null,
          textBoxId: hitTextBox.id,
          startTextBoxPosition: { x: hitTextBox.x, y: hitTextBox.y },
          startTextBoxSize: { width: hitTextBox.width, height: hitTextBox.height },
          moved: false,
        };

        return;
      }

      if (pointInRect(point, layout.phone.body)) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.style.cursor = 'grabbing';

        setSelectedTextBoxId(null);
        updateSnapGuide({ vertical: false, horizontal: false });
        dragSessionRef.current = {
          target: 'phone',
          pointerId: event.pointerId,
          startPoint: point,
          startPhoneOffset: phoneOffset,
          axisLock: null,
          moved: false,
        };
        return;
      }

      setSelectedTextBoxId(null);
    },
    [bringTextBoxToFront, findTopmostTextBoxAtPoint, phoneOffset, selectedTextBoxId, toCanvasPoint, updateSnapGuide],
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const point = toCanvasPoint(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      const session = dragSessionRef.current;
      const layout = layoutRef.current;
      if (!layout) {
        return;
      }

      if (session && session.pointerId === event.pointerId) {
        const rawDx = point.x - session.startPoint.x;
        const rawDy = point.y - session.startPoint.y;
        let dx = rawDx;
        let dy = rawDy;

        if ((session.target === 'phone' || session.target === 'text-box') && event.shiftKey) {
          if (!session.axisLock && (Math.abs(rawDx) > 0 || Math.abs(rawDy) > 0)) {
            session.axisLock = Math.abs(rawDx) >= Math.abs(rawDy) ? 'x' : 'y';
          }

          if (session.axisLock === 'x') {
            dy = 0;
          } else if (session.axisLock === 'y') {
            dx = 0;
          }
        } else if (session.axisLock) {
          session.axisLock = null;
        }

        const snapThreshold = getCanvasSnapThreshold();

        if (Math.abs(rawDx) > 1 || Math.abs(rawDy) > 1) {
          session.moved = true;
        }

        if (session.target === 'phone') {
          const basePhone = getPhoneBaseMetrics(currentCanvasPreset.width, currentCanvasPreset.height, phoneScale);
          const phoneWidth = basePhone.width;
          const phoneHeight = basePhone.height;
          const basePhoneX = basePhone.x;
          const basePhoneY = basePhone.y;

          const snappedPhoneTopLeft = applyCenterSnap(
            {
              x: basePhoneX + session.startPhoneOffset.x + dx,
              y: basePhoneY + session.startPhoneOffset.y + dy,
            },
            { width: phoneWidth, height: phoneHeight },
            { width: currentCanvasPreset.width, height: currentCanvasPreset.height },
            snapThreshold,
          );

          updateSnapGuide({
            vertical: snappedPhoneTopLeft.snapX,
            horizontal: snappedPhoneTopLeft.snapY,
          });
          setPhoneOffset({
            x: snappedPhoneTopLeft.position.x - basePhoneX,
            y: snappedPhoneTopLeft.position.y - basePhoneY,
          });
          return;
        }

        if (session.target === 'text-box' && session.textBoxId && session.startTextBoxPosition) {
          const snappedTextTopLeft = applyCenterSnap(
            {
              x: session.startTextBoxPosition.x + dx,
              y: session.startTextBoxPosition.y + dy,
            },
            session.startTextBoxSize ?? { width: TEXT_BOX_MIN_WIDTH, height: 60 },
            { width: currentCanvasPreset.width, height: currentCanvasPreset.height },
            snapThreshold,
          );

          updateSnapGuide({
            vertical: snappedTextTopLeft.snapX,
            horizontal: snappedTextTopLeft.snapY,
          });
          setTextBoxes((previous) =>
            previous.map((box) =>
              box.id === session.textBoxId
                ? {
                  ...box,
                    x: snappedTextTopLeft.position.x,
                    y: snappedTextTopLeft.position.y,
                }
                : box,
            ),
          );
          return;
        }

        if (session.target === 'text-box-resize' && session.textBoxId && session.startTextBoxSize) {
          const nextWidth = clamp(session.startTextBoxSize.width + dx, TEXT_BOX_MIN_WIDTH, currentTextBoxMaxWidth);
          setTextBoxes((previous) =>
            previous.map((box) => {
              if (box.id !== session.textBoxId) return box;
              const next = { ...box, width: nextWidth };
              const measured = measureTextMetrics(next, currentTextBoxMaxWidth);
              return {
                ...next,
                measuredLineCountByCanvas: measured.lineCountByCanvas,
                measuredLineCountByDom: measured.lineCountByDom,
                measuredTextWidthByCanvas: measured.textWidthByCanvas,
                measuredTextWidthByDom: measured.textWidthByDom,
              };
            }),
          );
          event.currentTarget.style.cursor = 'nwse-resize';
          return;
        }
      }

      updateSnapGuide({ vertical: false, horizontal: false });

      if (isPlacingTextBox) {
        event.currentTarget.style.cursor = 'crosshair';
        return;
      }

      const hitTextBox = findTopmostTextBoxAtPoint(point, layout);
      if (hitTextBox) {
        if (selectedTextBoxId === hitTextBox.id && pointInRect(point, getTextBoxResizeHandleRect(hitTextBox.bounds))) {
          event.currentTarget.style.cursor = 'nwse-resize';
          return;
        }
        event.currentTarget.style.cursor = 'grab';
        return;
      }

      if (pointInRect(point, layout.phone.body)) {
        event.currentTarget.style.cursor = 'grab';
        return;
      }

      if (pointInRect(point, layout.phone.screen)) {
        event.currentTarget.style.cursor = 'pointer';
        return;
      }

      event.currentTarget.style.cursor = 'default';
    },
    [
      currentCanvasPreset.height,
      currentCanvasPreset.width,
      currentTextBoxMaxWidth,
      findTopmostTextBoxAtPoint,
      getCanvasSnapThreshold,
      isPlacingTextBox,
      phoneScale,
      selectedTextBoxId,
      toCanvasPoint,
      updateSnapGuide,
    ],
  );

  const finishCanvasDrag = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (session.moved) {
      suppressCanvasClickRef.current = true;
      setStatusMessage(
        session.target === 'phone'
          ? '아이폰 프레임 위치를 이동했습니다.'
          : session.target === 'text-box-resize'
            ? '텍스트박스 크기를 조정했습니다.'
            : '텍스트박스 위치를 이동했습니다.',
      );
    }

    dragSessionRef.current = null;
    updateSnapGuide({ vertical: false, horizontal: false });
    event.currentTarget.style.cursor = isPlacingTextBox ? 'crosshair' : 'default';
  }, [isPlacingTextBox, updateSnapGuide]);

  const handleCanvasClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      focusElementWithoutScroll(event.currentTarget);

      if (suppressCanvasClickRef.current) {
        suppressCanvasClickRef.current = false;
        return;
      }

      const point = toCanvasPoint(event.clientX, event.clientY);
      const layout = layoutRef.current;
      if (!point || !layout) {
        return;
      }

      if (isPlacingTextBox) {
        addTextBoxAt(point);
        return;
      }

      const hitTextBox = findTopmostTextBoxAtPoint(point, layout);
      if (hitTextBox) {
        bringTextBoxToFront(hitTextBox.id);
        setSelectedTextBoxId(hitTextBox.id);
        return;
      }

      if (pointInRect(point, layout.phone.screen)) {
        fileInputRef.current?.click();
        setStatusMessage('파일 선택 창을 열었습니다.');
        return;
      }

      setSelectedTextBoxId(null);
    },
    [addTextBoxAt, bringTextBoxToFront, findTopmostTextBoxAtPoint, isPlacingTextBox, toCanvasPoint],
  );

  const handleCanvasDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const point = toCanvasPoint(event.clientX, event.clientY);
      const layout = layoutRef.current;
      if (!point || !layout) {
        return;
      }

      const hitTextBox = findTopmostTextBoxAtPoint(point, layout);
      if (!hitTextBox) {
        return;
      }

      bringTextBoxToFront(hitTextBox.id);
      setSelectedTextBoxId(hitTextBox.id);
      setIsInlineTextEditing(true);
      setStatusMessage('텍스트박스를 캔버스에서 바로 편집 중입니다.');
      setErrorMessage('');
      event.preventDefault();
    },
    [bringTextBoxToFront, findTopmostTextBoxAtPoint, toCanvasPoint],
  );

  const handleToggleTextPlacement = useCallback(() => {
    setIsPlacingTextBox((previous) => {
      const next = !previous;
      setStatusMessage(
        next
          ? '텍스트박스를 배치할 캔버스 위치를 클릭해 주세요.'
          : '텍스트박스 배치를 취소했습니다.',
      );
      return next;
    });
  }, []);

  const handleChangeCanvasPreset = useCallback(
    (nextPresetId: string) => {
      const previousPreset = getCanvasPresetById(canvasPresetId);
      const nextPreset = getCanvasPresetById(nextPresetId);

      if (previousPreset.id === nextPreset.id) {
        return;
      }

      const scaleX = nextPreset.width / previousPreset.width;
      const scaleY = nextPreset.height / previousPreset.height;
      const scaleFont = Math.sqrt(scaleX * scaleY);
      const nextPresetMaxTextBoxWidth = getTextBoxMaxWidthForPresetId(nextPreset.id);

      setCanvasPresetId(nextPreset.id);
      setPhoneOffset((previous) => ({
        x: previous.x * scaleX,
        y: previous.y * scaleY,
      }));
      setTextBoxes((previous) =>
        previous.map((box) => ({
          ...box,
          x: box.x * scaleX,
          y: box.y * scaleY,
          width: clamp(box.width * scaleX, TEXT_BOX_MIN_WIDTH, nextPresetMaxTextBoxWidth),
          fontSize: clamp(box.fontSize * scaleFont, TEXT_BOX_FONT_SIZE_MIN, TEXT_BOX_FONT_SIZE_MAX),
        })),
      );
      setStatusMessage(`캔버스 규격을 ${nextPreset.label}(으)로 변경하고 기존 배치를 자동 보정했습니다.`);
      setErrorMessage('');
    },
    [canvasPresetId],
  );

  const handleDeleteSelectedTextBox = useCallback(() => {
    if (!selectedTextBoxId) {
      return;
    }

    setTextBoxes((previous) => previous.filter((box) => box.id !== selectedTextBoxId));
    setSelectedTextBoxId(null);
    setIsInlineTextEditing(false);
    setStatusMessage('선택한 텍스트박스를 삭제했습니다.');
  }, [selectedTextBoxId]);

  const resetStyle = useCallback(() => {
    setBackgroundMode(DEFAULTS.backgroundMode);
    setBackgroundPrimary(DEFAULTS.backgroundPrimary);
    setBackgroundSecondary(DEFAULTS.backgroundSecondary);
    setGradientAngle(DEFAULTS.gradientAngle);
    setPhoneOffset({ x: 0, y: 0 });
    setPhoneScale(DEFAULTS.phoneScale);
    setIsPlacingTextBox(false);
    setStatusMessage('배경/프레임 설정을 기본값으로 초기화했습니다.');
    setErrorMessage('');
  }, []);

  const handleCenterCurrentCanvasElements = useCallback(() => {
    const centeredState = centerCanvasElements(currentCanvasState);
    setPhoneOffset({ ...centeredState.phoneOffset });
    setTextBoxes(centeredState.textBoxes.map((box) => ({ ...box })));
    setStatusMessage('현재 캔버스의 iPhone 프레임/텍스트박스를 가로 중앙 정렬했습니다.');
    setErrorMessage('');
  }, [currentCanvasState]);

  const handleCenterCurrentProjectCanvases = useCallback(() => {
    if (!currentProject || !currentProjectState) {
      return;
    }

    const centeredCanvases = currentProjectState.canvases.map((canvas) => ({
      ...canvas,
      state: centerCanvasElements(canvas.state),
    }));
    const nextProject: ProjectRecord = {
      ...currentProject,
      updatedAt: new Date().toISOString(),
      state: {
        ...currentProjectState,
        canvases: centeredCanvases,
      },
    };

    markProjectSyncable(currentProject.id);
    setProjects((previous) =>
      previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
    );

    const centeredCurrentCanvas = centeredCanvases.find((canvas) => canvas.id === currentCanvasId)?.state;
    if (centeredCurrentCanvas) {
      setPhoneOffset({ ...centeredCurrentCanvas.phoneOffset });
      setTextBoxes(centeredCurrentCanvas.textBoxes.map((box) => ({ ...box })));
    }

    setStatusMessage(`현재 프로젝트의 ${centeredCanvases.length}개 캔버스를 모두 가로 중앙 정렬했습니다.`);
    setErrorMessage('');
  }, [currentCanvasId, currentProject, currentProjectState, markProjectSyncable]);

  const handleCenterAllProjectsCanvases = useCallback(() => {
    if (projects.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const isCurrentProjectDraftReady =
      loadedProjectIdRef.current === currentProjectId && Boolean(currentProjectState);

    const nextProjects = projects.map((project) => {
      const sourceState =
        project.id === currentProjectId && isCurrentProjectDraftReady && currentProjectState
          ? currentProjectState
          : project.state;

      const centeredCanvases = sourceState.canvases.map((canvas) => ({
        ...canvas,
        state: centerCanvasElements(canvas.state),
      }));

      return {
        ...project,
        updatedAt: now,
        state: {
          ...sourceState,
          canvases: centeredCanvases,
        },
      };
    });

    for (const project of nextProjects) {
      markProjectSyncable(project.id);
    }

    setProjects(nextProjects);

    const centeredCurrentCanvas = nextProjects
      .find((project) => project.id === currentProjectId)
      ?.state.canvases.find((canvas) => canvas.id === currentCanvasId)?.state;

    if (centeredCurrentCanvas) {
      setPhoneOffset({ ...centeredCurrentCanvas.phoneOffset });
      setTextBoxes(centeredCurrentCanvas.textBoxes.map((box) => ({ ...box })));
    }

    setStatusMessage(
      `${nextProjects.length}개 프로젝트의 모든 캔버스(iPhone 프레임/텍스트박스)를 가로 중앙 정렬했습니다.`,
    );
    setErrorMessage('');
  }, [currentCanvasId, currentProjectId, currentProjectState, markProjectSyncable, projects]);

  const shrinkCanvasTextBoxesToSingleLine = useCallback((state: CanvasDesignState): CanvasDesignState => {
    const maxTextBoxWidth = getTextBoxMaxWidthForPresetId(state.canvasPresetId);
    return {
      ...state,
      textBoxes: state.textBoxes.map((box) => {
        const nextWidth = computeSingleLineMinWidthByCanvas(box, maxTextBoxWidth);
        const nextBox = nextWidth === box.width ? box : { ...box, width: nextWidth };
        const measured = measureTextMetrics(nextBox, maxTextBoxWidth);
        return {
          ...nextBox,
          measuredLineCountByCanvas: measured.lineCountByCanvas,
          measuredLineCountByDom: measured.lineCountByDom,
          measuredTextWidthByCanvas: measured.textWidthByCanvas,
          measuredTextWidthByDom: measured.textWidthByDom,
        };
      }),
    };
  }, []);

  const handleShrinkCurrentCanvasTextWidths = useCallback(() => {
    const nextState = shrinkCanvasTextBoxesToSingleLine(currentCanvasState);
    setTextBoxes(nextState.textBoxes.map((box) => ({ ...box })));
    setStatusMessage('현재 캔버스의 모든 텍스트박스를 한 줄 최소 너비로 조정했습니다.');
    setErrorMessage('');
  }, [currentCanvasState, shrinkCanvasTextBoxesToSingleLine]);

  const handleShrinkCurrentProjectTextWidths = useCallback(() => {
    if (!currentProject || !currentProjectState) {
      return;
    }

    const nextCanvases = currentProjectState.canvases.map((canvas) => ({
      ...canvas,
      state: shrinkCanvasTextBoxesToSingleLine(canvas.state),
    }));

    const nextProject: ProjectRecord = {
      ...currentProject,
      updatedAt: new Date().toISOString(),
      state: {
        ...currentProjectState,
        canvases: nextCanvases,
      },
    };

    markProjectSyncable(currentProject.id);
    setProjects((previous) =>
      previous.map((project) => (project.id === currentProject.id ? nextProject : project)),
    );

    const nextCurrentCanvasState = nextCanvases.find((canvas) => canvas.id === currentCanvasId)?.state;
    if (nextCurrentCanvasState) {
      setTextBoxes(nextCurrentCanvasState.textBoxes.map((box) => ({ ...box })));
    }

    setStatusMessage(`현재 프로젝트의 ${nextCanvases.length}개 캔버스 텍스트박스를 한 줄 최소 너비로 조정했습니다.`);
    setErrorMessage('');
  }, [
    currentCanvasId,
    currentProject,
    currentProjectState,
    markProjectSyncable,
    shrinkCanvasTextBoxesToSingleLine,
  ]);

  const handleShrinkAllProjectsTextWidths = useCallback(() => {
    if (projects.length === 0) {
      return;
    }

    const now = new Date().toISOString();
    const isCurrentProjectDraftReady =
      loadedProjectIdRef.current === currentProjectId && Boolean(currentProjectState);

    const nextProjects = projects.map((project) => {
      const sourceState =
        project.id === currentProjectId && isCurrentProjectDraftReady && currentProjectState
          ? currentProjectState
          : project.state;

      return {
        ...project,
        updatedAt: now,
        state: {
          ...sourceState,
          canvases: sourceState.canvases.map((canvas) => ({
            ...canvas,
            state: shrinkCanvasTextBoxesToSingleLine(canvas.state),
          })),
        },
      };
    });

    for (const project of nextProjects) {
      markProjectSyncable(project.id);
    }
    setProjects(nextProjects);

    const nextCurrentCanvasState = nextProjects
      .find((project) => project.id === currentProjectId)
      ?.state.canvases.find((canvas) => canvas.id === currentCanvasId)?.state;
    if (nextCurrentCanvasState) {
      setTextBoxes(nextCurrentCanvasState.textBoxes.map((box) => ({ ...box })));
    }

    setStatusMessage(`${nextProjects.length}개 프로젝트 전체 캔버스 텍스트박스를 한 줄 최소 너비로 조정했습니다.`);
    setErrorMessage('');
  }, [
    currentCanvasId,
    currentProjectId,
    currentProjectState,
    markProjectSyncable,
    projects,
    shrinkCanvasTextBoxesToSingleLine,
  ]);

  const readCanvasMediaRecordForExport = useCallback(
    async (projectId: string, canvasId: string, canvasIndex: number, state: CanvasDesignState) => {
      const mediaKey = buildProjectCanvasMediaKey(projectId, canvasId);
      let record = await readProjectMediaRecord(mediaKey);
      if (!record && canvasIndex === 0) {
        record = await readProjectMediaRecord(projectId);
      }
      if (!record && state.media.kind && state.media.name) {
        record = await findProjectMediaRecordByKindAndName(state.media.kind, state.media.name);
        if (record && record.projectId !== mediaKey) {
          void saveProjectMediaRecord({
            ...record,
            projectId: mediaKey,
            updatedAt: new Date().toISOString(),
          }).catch(() => undefined);
        }
      }
      return record;
    },
    [],
  );

  const renderCanvasImageArtifact = useCallback(
    async (state: CanvasDesignState, media: HTMLImageElement | HTMLVideoElement | null): Promise<CanvasExportArtifact> => {
      const canvasSize = getCanvasDimensionsFromState(state);
      const offscreen = document.createElement('canvas');
      offscreen.width = canvasSize.width;
      offscreen.height = canvasSize.height;

      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('캔버스 초기화에 실패했습니다.');
      }

      drawComposition(ctx, {
        width: canvasSize.width,
        height: canvasSize.height,
        backgroundMode: state.backgroundMode,
        backgroundPrimary: state.backgroundPrimary,
        backgroundSecondary: state.backgroundSecondary,
        gradientAngle: state.gradientAngle,
        phoneOffset: state.phoneOffset,
        phoneScale: state.phoneScale,
        textBoxes: state.textBoxes,
        selectedTextBoxId: null,
        showGuides: false,
        snapGuide: undefined,
        emptyStateFileLabel: undefined,
        media,
      });

      const blob = await blobFromCanvas(offscreen);
      return {
        blob,
        mimeType: 'image/png',
        extension: 'png',
      };
    },
    [],
  );

  const renderCanvasVideoArtifact = useCallback(
    async (state: CanvasDesignState, sourceUrl: string): Promise<CanvasExportArtifact> => {
      if (typeof MediaRecorder === 'undefined') {
        throw new Error('현재 브라우저는 영상 내보내기를 지원하지 않습니다.');
      }

      const source = await new Promise<HTMLVideoElement>((resolve, reject) => {
        const instance = document.createElement('video');
        instance.preload = 'auto';
        instance.playsInline = true;
        instance.muted = true;
        instance.loop = false;
        instance.src = sourceUrl;

        const onLoaded = () => resolve(instance);
        const onError = () => reject(new Error('영상 메타데이터를 읽지 못했습니다.'));

        instance.addEventListener('loadedmetadata', onLoaded, { once: true });
        instance.addEventListener('error', onError, { once: true });
      });

      const canvasSize = getCanvasDimensionsFromState(state);
      const offscreen = document.createElement('canvas');
      offscreen.width = canvasSize.width;
      offscreen.height = canvasSize.height;

      const ctx = offscreen.getContext('2d');
      if (!ctx) {
        throw new Error('캔버스 초기화에 실패했습니다.');
      }

      const stream = offscreen.captureStream(30);
      const mimeType = pickRecorderMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      const done = new Promise<Blob>((resolve, reject) => {
        recorder.onerror = () => reject(new Error('영상 변환 중 오류가 발생했습니다.'));
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || 'video/webm' }));
        };
      });

      recorder.start(1000 / 30);

      try {
        await source.play();

        await new Promise<void>((resolve, reject) => {
          let rafId = 0;

          const onError = () => {
            cancelAnimationFrame(rafId);
            reject(new Error('영상 프레임을 읽는 중 오류가 발생했습니다.'));
          };

          source.addEventListener('error', onError, { once: true });

          const frame = () => {
            drawComposition(ctx, {
              width: canvasSize.width,
              height: canvasSize.height,
              backgroundMode: state.backgroundMode,
              backgroundPrimary: state.backgroundPrimary,
              backgroundSecondary: state.backgroundSecondary,
              gradientAngle: state.gradientAngle,
              phoneOffset: state.phoneOffset,
              phoneScale: state.phoneScale,
              textBoxes: state.textBoxes,
              selectedTextBoxId: null,
              showGuides: false,
              snapGuide: undefined,
              emptyStateFileLabel: undefined,
              media: source,
            });

            if (source.ended) {
              resolve();
              return;
            }

            rafId = requestAnimationFrame(frame);
          };

          frame();
        });

        await new Promise((resolve) => window.setTimeout(resolve, 150));
      } finally {
        source.pause();
        stream.getTracks().forEach((track) => track.stop());

        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }

      const blob = await done;
      const outputMime = blob.type || recorder.mimeType || mimeType || 'video/webm';
      return {
        blob,
        mimeType: outputMime,
        extension: outputMime.includes('mp4') ? 'mp4' : 'webm',
      };
    },
    [],
  );

  const exportImage = useCallback(async () => {
    const artifactResult = await renderCanvasImageArtifact(currentCanvasState, imageRef.current);
    setArtifactBlob(
      artifactResult.blob,
      'image',
      artifactResult.mimeType,
      buildOutputFileName(assetName || 'preview', artifactResult.extension),
    );
  }, [assetName, currentCanvasState, renderCanvasImageArtifact, setArtifactBlob]);

  const exportVideo = useCallback(async () => {
    if (!assetUrl) {
      throw new Error('영상 소스가 없습니다.');
    }

    const artifactResult = await renderCanvasVideoArtifact(currentCanvasState, assetUrl);
    setArtifactBlob(
      artifactResult.blob,
      'video',
      artifactResult.mimeType,
      buildOutputFileName(assetName || 'preview', artifactResult.extension),
    );
    return artifactResult.mimeType;
  }, [assetName, assetUrl, currentCanvasState, renderCanvasVideoArtifact, setArtifactBlob]);

  const handleExport = useCallback(async () => {
    if (!assetKind) {
      setErrorMessage('먼저 이미지 또는 영상을 업로드해 주세요.');
      return;
    }

    setIsExporting(true);
    setErrorMessage('');

    try {
      if (assetKind === 'image') {
        await exportImage();
        setStatusMessage('이미지 출력 완료: PNG 파일이 저장되었습니다.');
      } else {
        const outputMime = await exportVideo();
        const isMp4Output = outputMime.includes('mp4');
        const sourceIsMp4 = /\.mp4$/i.test(assetName);
        if (sourceIsMp4 && !isMp4Output) {
          setStatusMessage('영상 출력 완료: 현재 브라우저 인코더 제한으로 WebM으로 저장되었습니다.');
        } else {
          setStatusMessage(`영상 출력 완료: ${isMp4Output ? 'MP4' : 'WebM'} 파일이 저장되었습니다.`);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '내보내기에 실패했습니다.');
      setStatusMessage('오류를 확인한 뒤 다시 시도해 주세요.');
    } finally {
      setIsExporting(false);
    }
  }, [assetKind, assetName, exportImage, exportVideo]);

  const measureProjectsTextBoxes = useCallback(
    async (targetProjectIds: string[]) => {
      const uniqueTargetIds = Array.from(new Set(targetProjectIds.filter((id) => typeof id === 'string' && id.length > 0)));
      if (uniqueTargetIds.length === 0) {
        return;
      }

      const projectById = new Map(projects.map((project) => [project.id, project]));
      const targetProjects = uniqueTargetIds
        .map((projectId) => projectById.get(projectId))
        .filter((project): project is ProjectRecord => Boolean(project));

      if (targetProjects.length === 0) {
        return;
      }

      setIsMeasuringAll(true);
      setStatusMessage('실측 중...');
      setErrorMessage('');
      isMeasuringAllRef.current = true;

      let patchCount = 0;
      let failCount = 0;
      const touchedProjectIds = new Set<string>();
      const latestRevisionByProjectId = new Map<string, number>();
      const measuredByProjectCanvas = new Map<
        string,
        Map<
          string,
          Map<
            string,
            {
              lineCountByCanvas: number;
              lineCountByDom: number | null;
              textWidthByCanvas: number;
              textWidthByDom: number | null;
            }
          >
        >
      >();

      try {
        for (let projectIndex = 0; projectIndex < targetProjects.length; projectIndex += 1) {
          const project = targetProjects[projectIndex];
          const sourceState =
            project.id === currentProjectId && loadedProjectIdRef.current === currentProjectId && currentProjectState
              ? currentProjectState
              : project.state;
          let latestRevision = project.revision;
          const measuredByCanvas = new Map<
            string,
            Map<
              string,
              {
                lineCountByCanvas: number;
                lineCountByDom: number | null;
                textWidthByCanvas: number;
                textWidthByDom: number | null;
              }
            >
          >();

          setStatusMessage(
            `실측 중... (${projectIndex + 1}/${targetProjects.length}) ${project.name}`,
          );

          for (const canvas of sourceState.canvases) {
            const maxTextBoxWidth = getTextBoxMaxWidthForPresetId(canvas.state.canvasPresetId);
            const updates = canvas.state.textBoxes.map((box) => {
              const measured = measureTextMetrics(box, maxTextBoxWidth);
              return {
                id: box.id,
                measuredLineCountByCanvas: measured.lineCountByCanvas,
                measuredLineCountByDom: measured.lineCountByDom,
                measuredTextWidthByCanvas: measured.textWidthByCanvas,
                measuredTextWidthByDom: measured.textWidthByDom,
              };
            });

            if (updates.length === 0) continue;

            let canvasPatched = false;
            for (let attempt = 0; attempt < 3; attempt += 1) {
              try {
                const res = await fetch(
                  `/api/projects/${encodeURIComponent(project.id)}/canvases/${encodeURIComponent(canvas.id)}/text-boxes`,
                  {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ updates }),
                  },
                );
                if (res.ok) {
                  patchCount += updates.length;
                  touchedProjectIds.add(project.id);
                  const payload = (await res.json().catch(() => null)) as { project?: { revision?: unknown } } | null;
                  const revisionRaw = payload?.project?.revision;
                  if (typeof revisionRaw === 'number' && Number.isFinite(revisionRaw)) {
                    latestRevision = Math.max(0, Math.floor(revisionRaw));
                  }
                  measuredByCanvas.set(
                    canvas.id,
                    new Map(
                      updates.map((update) => [
                        update.id,
                        {
                          lineCountByCanvas: update.measuredLineCountByCanvas,
                          lineCountByDom: update.measuredLineCountByDom,
                          textWidthByCanvas: update.measuredTextWidthByCanvas,
                          textWidthByDom: update.measuredTextWidthByDom,
                        },
                      ]),
                    ),
                  );
                  canvasPatched = true;
                  break;
                }

                const shouldRetryConflict = res.status === 409 && attempt < 2;
                await res.body?.cancel().catch(() => null);
                if (shouldRetryConflict) {
                  await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
                  continue;
                }
                break;
              } catch {
                if (attempt < 2) {
                  await new Promise((resolve) => window.setTimeout(resolve, 120 * (attempt + 1)));
                  continue;
                }
                break;
              }
            }

            if (!canvasPatched) {
              failCount += updates.length;
            }
          }

          latestRevisionByProjectId.set(project.id, latestRevision);
          if (measuredByCanvas.size > 0) {
            measuredByProjectCanvas.set(project.id, measuredByCanvas);
          }
        }
      } finally {
        setIsMeasuringAll(false);
        isMeasuringAllRef.current = false;
      }

      if (patchCount > 0) {
        for (const projectId of touchedProjectIds) {
          markProjectSyncable(projectId);
        }

        const now = new Date().toISOString();
        setProjects((previous) =>
          previous.map((project) => {
            const measuredByCanvas = measuredByProjectCanvas.get(project.id);
            if (!measuredByCanvas) {
              return project;
            }

            const latestRevision = latestRevisionByProjectId.get(project.id) ?? project.revision;
            return {
              ...project,
              updatedAt: now,
              revision: Math.max(project.revision, latestRevision),
              state: {
                ...project.state,
                canvases: project.state.canvases.map((canvas) => {
                  const measuredByTextBoxId = measuredByCanvas.get(canvas.id);
                  if (!measuredByTextBoxId) {
                    return canvas;
                  }

                  return {
                    ...canvas,
                    state: {
                      ...canvas.state,
                      textBoxes: canvas.state.textBoxes.map((box) => {
                        const measured = measuredByTextBoxId.get(box.id);
                        if (!measured) {
                          return box;
                        }

                        return {
                          ...box,
                          measuredLineCountByCanvas: measured.lineCountByCanvas,
                          measuredLineCountByDom: measured.lineCountByDom,
                          measuredTextWidthByCanvas: measured.textWidthByCanvas,
                          measuredTextWidthByDom: measured.textWidthByDom,
                        };
                      }),
                    },
                  };
                }),
              },
            };
          }),
        );

        const measuredCurrentCanvas =
          measuredByProjectCanvas.get(currentProjectId)?.get(currentCanvasId) ?? null;
        if (measuredCurrentCanvas) {
          setTextBoxes((previous) =>
            previous.map((box) => {
              const measured = measuredCurrentCanvas.get(box.id);
              if (!measured) {
                return box;
              }

              return {
                ...box,
                measuredLineCountByCanvas: measured.lineCountByCanvas,
                measuredLineCountByDom: measured.lineCountByDom,
                measuredTextWidthByCanvas: measured.textWidthByCanvas,
                measuredTextWidthByDom: measured.textWidthByDom,
              };
            }),
          );
        }
      }

      if (patchCount === 0 && failCount === 0) {
        setStatusMessage('실측할 텍스트박스가 없습니다.');
        setErrorMessage('');
        return;
      }

      if (failCount === 0) {
        if (targetProjects.length === 1) {
          setStatusMessage(`${patchCount}개 텍스트박스 실측 완료.`);
        } else {
          setStatusMessage(
            `${targetProjects.length}개 프로젝트에서 ${patchCount}개 텍스트박스 실측 완료.`,
          );
        }
        setErrorMessage('');
      } else {
        setStatusMessage(`실측 완료: ${patchCount}개 성공, ${failCount}개 실패.`);
        setErrorMessage('일부 캔버스 실측 저장에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
    },
    [currentCanvasId, currentProjectId, currentProjectState, markProjectSyncable, projects],
  );

  const handleMeasureAll = useCallback(async () => {
    if (!currentProjectId) return;
    await measureProjectsTextBoxes([currentProjectId]);
  }, [currentProjectId, measureProjectsTextBoxes]);

  const handleMeasureAllProjects = useCallback(async () => {
    if (projects.length === 0) return;
    await measureProjectsTextBoxes(projects.map((project) => project.id));
  }, [measureProjectsTextBoxes, projects]);

  const handleExportProjectZip = useCallback(async () => {
    if (!currentProject || !currentProjectState) {
      setErrorMessage('내보낼 프로젝트를 찾지 못했습니다.');
      return;
    }

    setIsExportingProjectZip(true);
    setErrorMessage('');

    try {
      const zip = new JSZip();
      const warnings: string[] = [];
      let exportedCount = 0;

      for (let index = 0; index < currentProjectState.canvases.length; index += 1) {
        const canvas = currentProjectState.canvases[index];
        const state = canvas.state;

        try {
          if (state.media.kind === 'video') {
            let sourceUrl: string | null = null;
            const canUseCurrentLoadedVideo =
              canvas.id === currentCanvasId && assetKind === 'video' && typeof assetUrl === 'string' && assetUrl.length > 0;

            if (canUseCurrentLoadedVideo) {
              sourceUrl = assetUrl;
            } else {
              const mediaRecord = await readCanvasMediaRecordForExport(currentProject.id, canvas.id, index, state);
              if (mediaRecord) {
                sourceUrl = URL.createObjectURL(mediaRecord.blob);
              }
            }

            if (!sourceUrl) {
              warnings.push(`${index + 1}번 캔버스(${canvas.name}): 영상 미디어를 찾지 못해 건너뛰었습니다.`);
              continue;
            }

            try {
              const result = await renderCanvasVideoArtifact(state, sourceUrl);
              zip.file(
                buildBatchCanvasOutputFileName(index, canvas.name, result.extension),
                result.blob,
              );
              exportedCount += 1;
            } finally {
              if (!canUseCurrentLoadedVideo) {
                URL.revokeObjectURL(sourceUrl);
              }
            }
            continue;
          }

          let media: HTMLImageElement | null = null;
          let revokeUrl: string | null = null;
          const canUseCurrentLoadedImage = canvas.id === currentCanvasId && assetKind === 'image' && Boolean(imageRef.current);

          if (state.media.kind === 'image') {
            if (canUseCurrentLoadedImage) {
              media = imageRef.current;
            } else {
              const mediaRecord = await readCanvasMediaRecordForExport(currentProject.id, canvas.id, index, state);
              if (!mediaRecord) {
                warnings.push(`${index + 1}번 캔버스(${canvas.name}): 이미지 미디어를 찾지 못해 빈 화면으로 내보냅니다.`);
              } else {
                revokeUrl = URL.createObjectURL(mediaRecord.blob);
                media = await new Promise<HTMLImageElement>((resolve, reject) => {
                  const instance = new Image();
                  instance.onload = () => resolve(instance);
                  instance.onerror = () => reject(new Error('이미지 복원에 실패했습니다.'));
                  instance.src = revokeUrl as string;
                });
              }
            }
          }

          try {
            const result = await renderCanvasImageArtifact(state, media);
            zip.file(
              buildBatchCanvasOutputFileName(index, canvas.name, result.extension),
              result.blob,
            );
            exportedCount += 1;
          } finally {
            if (revokeUrl) {
              URL.revokeObjectURL(revokeUrl);
            }
          }
        } catch (canvasError) {
          const message = canvasError instanceof Error ? canvasError.message : '알 수 없는 오류';
          warnings.push(`${index + 1}번 캔버스(${canvas.name}): ${message}`);
        }
      }

      if (exportedCount === 0) {
        throw new Error('내보낼 캔버스 결과물을 생성하지 못했습니다.');
      }

      if (warnings.length > 0) {
        zip.file('export-warnings.txt', warnings.join('\n'));
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const zipName = `${sanitizeFileNameSegment(currentProject.name)}-all-canvases-${Date.now()}.zip`;
      const zipUrl = URL.createObjectURL(zipBlob);

      const link = document.createElement('a');
      link.href = zipUrl;
      link.download = zipName;
      link.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(zipUrl);
      }, 0);

      if (warnings.length > 0) {
        setStatusMessage(
          `${exportedCount}개 캔버스를 ZIP으로 저장했습니다. 누락/대체 내보내기 정보는 export-warnings.txt를 확인해 주세요.`,
        );
      } else {
        setStatusMessage(`${exportedCount}개 캔버스를 ZIP으로 저장했습니다.`);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '프로젝트 ZIP 내보내기에 실패했습니다.');
      setStatusMessage('오류를 확인한 뒤 다시 시도해 주세요.');
    } finally {
      setIsExportingProjectZip(false);
    }
  }, [
    assetKind,
    assetUrl,
    currentCanvasId,
    currentProject,
    currentProjectState,
    readCanvasMediaRecordForExport,
    renderCanvasImageArtifact,
    renderCanvasVideoArtifact,
  ]);

  const renderPrimaryActionButtons = () => (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" onClick={resetStyle}>
        <RotateCcw className="h-4 w-4" />
        배경/프레임 초기화
      </Button>
      <Button type="button" variant="outline" onClick={handleCenterCurrentCanvasElements}>
        현재 캔버스 가로 중앙 정렬
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleCenterCurrentProjectCanvases}
        disabled={!currentProjectId || !currentProjectState}
      >
        현재 프로젝트 전체 가로 중앙 정렬
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleCenterAllProjectsCanvases}
        disabled={projects.length === 0}
      >
        모든 프로젝트 전체 가로 중앙 정렬
      </Button>
      <Button type="button" variant="outline" onClick={handleShrinkCurrentCanvasTextWidths}>
        현재 캔버스 텍스트 최소 너비
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleShrinkCurrentProjectTextWidths}
        disabled={!currentProjectId || !currentProjectState}
      >
        현재 프로젝트 텍스트 최소 너비
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={handleShrinkAllProjectsTextWidths}
        disabled={projects.length === 0}
      >
        모든 프로젝트 텍스트 최소 너비
      </Button>
      <Button type="button" variant="outline" onClick={handleUndo} disabled={!canUndo}>
        <Undo2 className="h-4 w-4" />
        되돌리기
      </Button>
      <Button type="button" variant="outline" onClick={handleRedo} disabled={!canRedo}>
        <Redo2 className="h-4 w-4" />
        다시실행
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={handleMeasureAll}
        disabled={isMeasuringAll || !currentProjectId}
      >
        {isMeasuringAll ? '실측 중...' : '현재 프로젝트 전체 캔버스 실측'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={handleMeasureAllProjects}
        disabled={isMeasuringAll || projects.length === 0}
      >
        {isMeasuringAll ? '실측 중...' : '모든 프로젝트 전체 캔버스 실측'}
      </Button>
      <Button
        type="button"
        onClick={handleExport}
        disabled={isExporting || isExportingProjectZip || !assetKind}
      >
        <Download className="h-4 w-4" />
        {isExporting ? '내보내는 중...' : '소스 타입에 맞춰 내보내기'}
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={handleExportProjectZip}
        disabled={isExporting || isExportingProjectZip || !currentProjectState}
      >
        <Download className="h-4 w-4" />
        {isExportingProjectZip ? 'ZIP 생성 중...' : '프로젝트 전체 ZIP 내보내기'}
      </Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_15%_20%,#d9f4ff_0,#f2f4f7_42%,#eef2ff_100%)] px-4 py-8 text-zinc-900">
      <div className="mx-auto max-w-7xl">
        <header className="rounded-2xl border border-white/70 bg-white/80 px-6 py-5 shadow-sm backdrop-blur">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">App Store Preview Composer</h1>
            <p className="mt-2 text-sm text-zinc-600">
              iPhone 규격(886x1920) 기준으로 업로드/드래그 배치 후 결과물을 생성합니다.
            </p>
          </div>

          <div className="mt-4 space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs text-zinc-500">프로젝트</Label>
              <p className="text-xs text-zinc-500">
                {currentProject ? `${currentProject.name} 선택됨` : '프로젝트 없음'}
                {lastAutoSavedAt ? ` · 마지막 자동저장 ${lastAutoSavedAt}` : ''}
              </p>
            </div>

            <div className="flex items-stretch gap-3 overflow-x-auto pb-2">
              {projects.map((project) => {
                const isActive = project.id === currentProjectId;
                return (
                  <div
                    key={project.id}
                    className={`w-[210px] shrink-0 rounded-lg border p-3 ${
                      isActive ? 'border-blue-300 bg-blue-50/60' : 'border-zinc-200 bg-white'
                    }`}
                  >
                    <div className="flex h-full min-h-[196px] flex-col gap-2">
                      <Input
                        value={project.name}
                        onChange={(event) => handleRenameProject(project.id, event.target.value)}
                        className="h-9 min-w-0 border-zinc-300 bg-white text-sm"
                      />
                      <p className="text-xs text-zinc-500">{project.state.canvases.length}개 캔버스</p>

                      <button
                        type="button"
                        onClick={() => handleSelectProject(project.id)}
                        className={`mt-auto h-9 w-full whitespace-nowrap rounded-md border px-3 text-sm font-medium ${
                          isActive
                            ? 'border-blue-300 bg-white text-blue-700'
                            : 'border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50'
                        }`}
                      >
                        {isActive ? '선택됨' : '열기'}
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleDuplicateProject(project.id)}
                          className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
                          title="프로젝트 복제"
                          aria-label={`${project.name} 복제`}
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteProject(project.id)}
                          disabled={projects.length <= 1}
                          className="inline-flex h-9 flex-1 items-center justify-center rounded-md border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                          title={projects.length <= 1 ? '프로젝트는 최소 1개 필요' : '프로젝트 삭제'}
                          aria-label={`${project.name} 삭제`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" onClick={handleCreateProject}>
                <Plus className="h-4 w-4" />
                새 프로젝트
              </Button>
              <Button type="button" variant="outline" onClick={handleConnectSaveDirectory}>
                <FolderOpen className="h-4 w-4" />
                자동저장 폴더 연결
              </Button>
              <span className="text-xs text-zinc-500">
                {connectedSaveDirectory ? '.project-saves 자동저장 연결됨' : '폴더 미연결'}
              </span>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
            {renderPrimaryActionButtons()}
          </div>
        </header>

        <section className="mt-4 rounded-2xl border border-zinc-200/80 bg-white/90 px-4 py-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-zinc-800">캔버스 목록</p>
            <p className="text-xs text-zinc-500">{currentCanvas ? `${currentCanvas.name} 편집 중` : '캔버스 없음'}</p>
          </div>
          <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
            {currentProjectCanvases.map((canvas) => {
              const isActive = canvas.id === currentCanvasId;
              const canvasNameValue = canvasNameDrafts[canvas.id] ?? canvas.name;
              const isDragSource = draggingCanvasId === canvas.id;
              const isDropTarget = canvasDropTargetId === canvas.id && draggingCanvasId !== canvas.id;
              const canvasPreset = getCanvasPresetById(canvas.state.canvasPresetId);
              const thumbnailHeight = getCanvasThumbnailHeight(canvasPreset.width, canvasPreset.height);
              const kindLabel =
                canvas.state.media.kind === 'video' ? '영상' : canvas.state.media.kind === 'image' ? '이미지' : '미디어 없음';
              return (
                <div
                  key={canvas.id}
                  draggable
                  onDragStart={(event) => handleCanvasCardDragStart(event, canvas.id)}
                  onDragOver={(event) => handleCanvasCardDragOver(event, canvas.id)}
                  onDrop={(event) => handleCanvasCardDrop(event, canvas.id)}
                  onDragEnd={handleCanvasCardDragEnd}
                  className={`w-[170px] shrink-0 rounded-lg border px-2 py-2 text-left transition ${
                    isDropTarget
                      ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                      : isActive
                        ? 'border-blue-400 bg-blue-50 text-blue-900'
                        : 'border-zinc-200 bg-white text-zinc-700'
                  }`}
                  style={{ opacity: isDragSource ? 0.7 : 1 }}
                >
                  <div className="space-y-1.5">
                    <Input
                      value={canvasNameValue}
                      onChange={(event) => handleRenameCanvasDraftChange(canvas.id, event.target.value)}
                      onBlur={(event) => handleRenameCanvasBlur(canvas.id, event.target.value)}
                      onKeyDown={(event) => handleRenameCanvasKeyDown(event, canvas.id)}
                      draggable={false}
                      className="h-7 border-zinc-300 bg-white px-2 text-[11px]"
                    />
                    <p className="truncate text-[11px] opacity-80">{canvas.state.media.name || '빈 캔버스'}</p>
                    <p className="text-[10px] opacity-70">{kindLabel}</p>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleSelectCanvas(canvas.id)}
                        className="h-7 min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 text-[10px] text-zinc-700 hover:bg-zinc-50"
                        title={isActive ? '현재 캔버스' : '캔버스 열기'}
                        aria-label={`${canvas.name} 열기`}
                      >
                        {isActive ? '선택중' : '열기'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicateCanvas(canvas.id)}
                        className="h-7 w-7 rounded-md border border-zinc-300 bg-white p-0 text-zinc-600 hover:bg-zinc-50"
                        title="캔버스 복제"
                        aria-label={`${canvas.name} 복제`}
                      >
                        <Copy className="mx-auto h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteCanvas(canvas.id)}
                        disabled={currentProjectCanvases.length <= 1}
                        className="h-7 w-7 rounded-md border border-zinc-300 bg-white p-0 text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                        title={currentProjectCanvases.length <= 1 ? '캔버스는 최소 1개 필요' : '캔버스 삭제'}
                        aria-label={`${canvas.name} 삭제`}
                      >
                        <Trash2 className="mx-auto h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <button type="button" onClick={() => handleSelectCanvas(canvas.id)} className="mt-2 block w-full">
                    <div className="rounded-md border border-zinc-200/80 bg-zinc-100/70 p-1">
                      <div
                        className="mx-auto overflow-hidden rounded-[8px] border border-zinc-300 bg-zinc-200"
                        style={{ width: CANVAS_THUMBNAIL_WIDTH / 2, height: thumbnailHeight / 2 }}
                      >
                        {canvas.thumbnailDataUrl ? (
                          <img
                            src={canvas.thumbnailDataUrl}
                            alt={`${canvas.name} 미리보기`}
                            className="h-full w-full object-cover"
                            draggable={false}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-zinc-100 text-[10px] text-zinc-500">
                            미리보기 없음
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                </div>
              );
            })}
            <Button
              type="button"
              variant="secondary"
              onClick={handleCreateCanvas}
              className="min-w-[150px] shrink-0 self-stretch"
            >
              <Plus className="h-4 w-4" /> 캔버스 추가
            </Button>
          </div>
        </section>

        <div className="mt-6 grid gap-6 xl:grid-cols-[430px_minmax(0,1fr)]">
          <Card className="border-zinc-200/80 bg-white/90">
            <CardHeader>
              <CardTitle>디자인 설정</CardTitle>
              <CardDescription>입력 파일 타입에 따라 출력 타입이 자동으로 맞춰집니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label>캔버스 규격</Label>
                <select
                  value={canvasPresetId}
                  onChange={(event) => handleChangeCanvasPreset(event.target.value)}
                  className="h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm text-zinc-700"
                >
                  {CANVAS_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-zinc-500">
                  현재 캔버스 기준: {currentCanvasPreset.width} x {currentCanvasPreset.height}px
                </p>
              </div>

              <div className="space-y-3">
                <Label>1. iPhone 화면 미디어</Label>
                {currentCanvas && <p className="text-xs text-zinc-500">{currentCanvas.name} 전용 미디어</p>}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  className="hidden"
                  onChange={handleFileChange}
                />

                <div
                  className={`rounded-xl border border-dashed p-4 transition-colors ${
                    isUploadDropActive
                      ? 'border-emerald-500 bg-emerald-50'
                      : 'border-zinc-300 bg-zinc-50'
                  }`}
                  onDragEnter={handleUploadDragEnter}
                  onDragOver={handleUploadDragOver}
                  onDragLeave={handleUploadDragLeave}
                  onDrop={handleUploadDrop}
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                      <Upload className="h-4 w-4" />
                      이미지/영상 업로드
                    </Button>
                    <span className="text-sm text-zinc-600">드래그 앤 드롭 지원</span>
                  </div>
                  <div className="mt-3 flex items-center gap-2 text-sm text-zinc-700">
                    {assetKind === 'video' ? <Film className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
                    <span className="truncate">{assetName || '선택된 파일 없음'}</span>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <Label>2. 배경 설정</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <select
                    value={backgroundMode}
                    onChange={(event) => setBackgroundMode(event.target.value as BackgroundMode)}
                    className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm"
                  >
                    <option value="solid">단색</option>
                    <option value="gradient">그라데이션</option>
                  </select>

                  <div className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3">
                    <Palette className="h-4 w-4 text-zinc-500" />
                    <Label className="text-xs text-zinc-500">기본</Label>
                    <Input
                      type="color"
                      value={backgroundPrimary}
                      onChange={(event) => setBackgroundPrimary(event.target.value)}
                      className="h-8 w-full border-0 bg-transparent px-0"
                    />
                  </div>
                </div>

                {backgroundMode === 'gradient' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-center gap-2 rounded-md border border-zinc-300 bg-white px-3">
                      <Label className="text-xs text-zinc-500">보조</Label>
                      <Input
                        type="color"
                        value={backgroundSecondary}
                        onChange={(event) => setBackgroundSecondary(event.target.value)}
                        className="h-8 w-full border-0 bg-transparent px-0"
                      />
                    </div>
                    <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span>각도</span>
                        <span>{gradientAngle}°</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={360}
                        value={gradientAngle}
                        onChange={(event) => setGradientAngle(Number(event.target.value))}
                        className="mt-1 w-full"
                      />
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-3">
                <Label>3. 텍스트박스</Label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant={isPlacingTextBox ? 'default' : 'secondary'} onClick={handleToggleTextPlacement}>
                    <Plus className="h-4 w-4" />
                    {isPlacingTextBox ? '배치 취소' : '텍스트박스 추가(클릭 배치)'}
                  </Button>
                  <Button type="button" variant="outline" onClick={copySelectedTextBox} disabled={!selectedTextBox}>
                    <Copy className="h-4 w-4" />
                    복사
                  </Button>
                  <Button type="button" variant="outline" onClick={pasteCopiedTextBox} disabled={!hasCopiedTextBox}>
                    <ClipboardPaste className="h-4 w-4" />
                    붙여넣기
                  </Button>
                  <Button type="button" variant="outline" onClick={handleDeleteSelectedTextBox} disabled={!selectedTextBox}>
                    <Trash2 className="h-4 w-4" />
                    선택 박스 삭제
                  </Button>
                </div>

                <div className="max-h-36 space-y-2 overflow-auto rounded-md border border-zinc-200 bg-zinc-50 p-2">
                  {textBoxes.length === 0 ? (
                    <p className="text-xs text-zinc-500">텍스트박스가 없습니다.</p>
                  ) : (
                    textBoxes.map((box) => (
                      <button
                        key={box.id}
                        type="button"
                        className={`w-full rounded-md border px-2 py-1 text-left text-xs ${
                          box.id === selectedTextBoxId
                            ? 'border-blue-400 bg-blue-50 text-blue-800'
                            : 'border-zinc-200 bg-white text-zinc-700'
                        }`}
                        onClick={() => {
                          bringTextBoxToFront(box.id);
                          setSelectedTextBoxId(box.id);
                        }}
                      >
                        {box.text.trim() || '(빈 텍스트)'}
                      </button>
                    ))
                  )}
                </div>

                {selectedTextBox ? (
                  <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
                    <Textarea
                      value={selectedTextBox.text}
                      onChange={(event) =>
                        updateSelectedTextBox((box) => ({
                          ...box,
                          text: event.target.value,
                        }))
                      }
                      placeholder="텍스트를 입력하세요"
                    />

                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label className="text-xs text-zinc-500">서체</Label>
                        <select
                          value={selectedTextBox.fontKey}
                          onChange={(event) =>
                            updateSelectedTextBox((box) => ({
                              ...box,
                              fontKey: event.target.value as FontKey,
                            }))
                          }
                          className="h-10 w-full rounded-md border border-zinc-300 bg-white px-3 text-sm"
                        >
                          {FONT_OPTIONS.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <Label className="text-xs text-zinc-500">텍스트 색상</Label>
                        <Input
                          type="color"
                          value={selectedTextBox.color}
                          onChange={(event) =>
                            updateSelectedTextBox((box) => ({
                              ...box,
                              color: event.target.value,
                            }))
                          }
                          className="h-10"
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span>폰트 크기</span>
                        <span>{selectedTextBox.fontSize}px</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="range"
                          min={TEXT_BOX_FONT_SIZE_MIN}
                          max={TEXT_BOX_FONT_SIZE_MAX}
                          value={selectedTextBox.fontSize}
                          onChange={(event) => handleSelectedTextBoxFontSizeChange(Number(event.target.value))}
                          className="w-full"
                        />
                        <Input
                          type="number"
                          min={TEXT_BOX_FONT_SIZE_MIN}
                          max={TEXT_BOX_FONT_SIZE_MAX}
                          step={1}
                          value={selectedTextBox.fontSize}
                          onChange={(event) => {
                            const raw = event.target.value;
                            if (raw === '') {
                              return;
                            }
                            handleSelectedTextBoxFontSizeChange(Number(raw));
                          }}
                          className="h-8 w-24 bg-white text-xs"
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span>텍스트박스 너비</span>
                        <span>{Math.round(selectedTextBox.width)}px</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="range"
                          min={TEXT_BOX_MIN_WIDTH}
                          max={currentTextBoxMaxWidth}
                          value={selectedTextBox.width}
                          onChange={(event) => handleSelectedTextBoxWidthChange(Number(event.target.value))}
                          className="w-full"
                        />
                        <Input
                          type="number"
                          min={TEXT_BOX_MIN_WIDTH}
                          max={currentTextBoxMaxWidth}
                          step={1}
                          value={Math.round(selectedTextBox.width)}
                          onChange={(event) => {
                            const raw = event.target.value;
                            if (raw === '') {
                              return;
                            }
                            handleSelectedTextBoxWidthChange(Number(raw));
                          }}
                          className="h-8 w-24 bg-white text-xs"
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-zinc-500">편집할 텍스트박스를 선택해 주세요.</p>
                )}
              </div>

              <div className="space-y-3">
                <Label>4. iPhone 프레임</Label>
                <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                  <div className="flex items-center justify-between text-xs text-zinc-500">
                    <span>크기</span>
                    <span>{Math.round(phoneScale * 100)}%</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type="range"
                      min={PHONE_SCALE_PERCENT_MIN}
                      max={PHONE_SCALE_PERCENT_MAX}
                      value={Math.round(phoneScale * 100)}
                      onChange={(event) => handlePhoneScalePercentChange(Number(event.target.value))}
                      className="w-full"
                    />
                    <Input
                      type="number"
                      min={PHONE_SCALE_PERCENT_MIN}
                      max={PHONE_SCALE_PERCENT_MAX}
                      step={1}
                      value={Math.round(phoneScale * 100)}
                      onChange={(event) => {
                        const raw = event.target.value;
                        if (raw === '') {
                          return;
                        }
                        handlePhoneScalePercentChange(Number(raw));
                      }}
                      className="h-8 w-24 bg-white text-xs"
                    />
                  </div>
                </div>
              </div>

              {renderPrimaryActionButtons()}

              <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm text-zinc-700">
                <p>{statusMessage}</p>
                {errorMessage && <p className="mt-2 font-medium text-rose-600">{errorMessage}</p>}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card className="border-zinc-200/80 bg-white/90">
              <CardHeader>
                <CardTitle>라이브 미리보기</CardTitle>
                <CardDescription>
                  프레임/텍스트박스는 캔버스 밖으로도 이동 가능하며, 바깥 부분은 잘려 보이지 않습니다.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col items-center gap-3">
                <div
                  className={`w-full max-w-[360px] rounded-[28px] border bg-zinc-100 p-3 shadow-inner transition-all ${
                    isCanvasDropActive ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-zinc-200'
                  }`}
                >
                  <div className="relative overflow-hidden rounded-[22px]">
                    <canvas
                      ref={previewCanvasRef}
                      className="block h-auto w-full rounded-[22px] focus-visible:outline-none"
                      tabIndex={0}
                      style={{
                        aspectRatio: `${currentCanvasPreset.width}/${currentCanvasPreset.height}`,
                        cursor: isPlacingTextBox ? 'crosshair' : 'default',
                      }}
                      onPointerDown={handleCanvasPointerDown}
                      onPointerMove={handleCanvasPointerMove}
                      onPointerUp={finishCanvasDrag}
                      onPointerCancel={finishCanvasDrag}
                      onClick={handleCanvasClick}
                      onDoubleClick={handleCanvasDoubleClick}
                      onDragEnter={handleCanvasDragEnter}
                      onDragOver={handleCanvasDragOver}
                      onDragLeave={handleCanvasDragLeave}
                      onDrop={handleCanvasDrop}
                    />

                    {selectedTextBox && inlineTextEditorLayout && (
                      <textarea
                        ref={inlineTextEditorRef}
                        value={selectedTextBox.text}
                        onChange={(event) =>
                          updateSelectedTextBox((box) => ({
                            ...box,
                            text: event.target.value,
                          }))
                        }
                        onBlur={() => setIsInlineTextEditing(false)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setIsInlineTextEditing(false);
                            focusElementWithoutScroll(previewCanvasRef.current);
                          }
                        }}
                        className={`absolute z-20 resize-none border-2 px-1 py-0.5 font-extrabold leading-[1.2] outline-none ${
                          isInlineTextEditing
                            ? 'border-blue-500 bg-white/70 shadow-lg'
                            : 'pointer-events-none border-transparent bg-transparent'
                        }`}
                        style={{
                          left: inlineTextEditorLayout.left,
                          top: inlineTextEditorLayout.top,
                          width: inlineTextEditorLayout.width,
                          height: inlineTextEditorLayout.height,
                          fontSize: inlineTextEditorLayout.fontSize,
                          fontFamily: inlineTextEditorLayout.fontFamily,
                          color: inlineTextEditorLayout.color,
                          opacity: isInlineTextEditing ? 1 : 0,
                        }}
                      />
                    )}
                  </div>
                </div>
                <p className="text-center text-xs text-zinc-500">
                  드래그 이동: iPhone 프레임/텍스트박스 · 업로드: 좌측 영역 DnD 또는 iPhone 화면 클릭/DnD
                </p>
                <p className="text-center text-[11px] text-zinc-500">
                  텍스트박스 더블클릭 또는 선택 후 Enter로 박스 내부에서 바로 텍스트 편집
                </p>

                <div className="w-full max-w-[360px] rounded-xl border border-zinc-200 bg-zinc-50/70 p-3">
                  <p className="mb-2 text-xs font-semibold text-zinc-700">캔버스 텍스트 빠른 편집</p>
                  {selectedTextBox ? (
                    <div className="space-y-3">
                      <Textarea
                        value={selectedTextBox.text}
                        onChange={(event) =>
                          updateSelectedTextBox((box) => ({
                            ...box,
                            text: event.target.value,
                          }))
                        }
                        placeholder="텍스트를 입력하세요"
                        className="min-h-[72px] bg-white"
                      />

                      <div className="grid gap-2 sm:grid-cols-2">
                        <select
                          value={selectedTextBox.fontKey}
                          onChange={(event) =>
                            updateSelectedTextBox((box) => ({
                              ...box,
                              fontKey: event.target.value as FontKey,
                            }))
                          }
                          className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-xs"
                        >
                          {FONT_OPTIONS.map((option) => (
                            <option key={option.key} value={option.key}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                        <Input
                          type="color"
                          value={selectedTextBox.color}
                          onChange={(event) =>
                            updateSelectedTextBox((box) => ({
                              ...box,
                              color: event.target.value,
                            }))
                          }
                          className="h-9 bg-white"
                        />
                      </div>

                      <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                        <div className="flex items-center justify-between text-[11px] text-zinc-500">
                          <span>폰트 크기</span>
                          <span>{selectedTextBox.fontSize}px</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="range"
                            min={TEXT_BOX_FONT_SIZE_MIN}
                            max={TEXT_BOX_FONT_SIZE_MAX}
                            value={selectedTextBox.fontSize}
                            onChange={(event) => handleSelectedTextBoxFontSizeChange(Number(event.target.value))}
                            className="w-full"
                          />
                          <Input
                            type="number"
                            min={TEXT_BOX_FONT_SIZE_MIN}
                            max={TEXT_BOX_FONT_SIZE_MAX}
                            step={1}
                            value={selectedTextBox.fontSize}
                            onChange={(event) => {
                              const raw = event.target.value;
                              if (raw === '') {
                                return;
                              }
                              handleSelectedTextBoxFontSizeChange(Number(raw));
                            }}
                            className="h-8 w-24 bg-white text-xs"
                          />
                        </div>
                      </div>

                      <div className="rounded-md border border-zinc-300 bg-white px-3 py-2">
                        <div className="flex items-center justify-between text-[11px] text-zinc-500">
                          <span>텍스트박스 너비</span>
                          <span>{Math.round(selectedTextBox.width)}px</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2">
                          <input
                            type="range"
                            min={TEXT_BOX_MIN_WIDTH}
                            max={currentTextBoxMaxWidth}
                            value={selectedTextBox.width}
                            onChange={(event) => handleSelectedTextBoxWidthChange(Number(event.target.value))}
                            className="w-full"
                          />
                          <Input
                            type="number"
                            min={TEXT_BOX_MIN_WIDTH}
                            max={currentTextBoxMaxWidth}
                            step={1}
                            value={Math.round(selectedTextBox.width)}
                            onChange={(event) => {
                              const raw = event.target.value;
                              if (raw === '') {
                                return;
                              }
                              handleSelectedTextBoxWidthChange(Number(raw));
                            }}
                            className="h-8 w-24 bg-white text-xs"
                          />
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 flex-1 text-xs"
                          onClick={() => setSelectedTextBoxId(null)}
                        >
                          선택 해제
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-8 flex-1 text-xs"
                          onClick={handleDeleteSelectedTextBox}
                        >
                          선택 박스 삭제
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-500">캔버스에서 텍스트박스를 클릭하면 여기서 바로 수정됩니다.</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card className="border-zinc-200/80 bg-white/90">
              <CardHeader>
                <CardTitle>출력 결과</CardTitle>
                <CardDescription>
                  입력이 이미지면 PNG, 입력이 영상이면 VIDEO(WebM/브라우저 지원 포맷)로 저장됩니다.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {artifact ? (
                  <div className="space-y-3">
                    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
                      <p>파일명: {artifact.fileName}</p>
                      <p className="mt-1">MIME: {artifact.mimeType}</p>
                    </div>
                    {artifact.kind === 'image' ? (
                      <img src={artifact.url} alt="output preview" className="max-h-[420px] rounded-lg border border-zinc-200 object-contain" />
                    ) : (
                      <video src={artifact.url} controls loop className="max-h-[420px] rounded-lg border border-zinc-200" />
                    )}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-8 text-center text-sm text-zinc-500">
                    아직 생성된 결과물이 없습니다.
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
