import {
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Textarea } from './components/ui/textarea';

type ProjectType = 'venn' | 'quadrant';
type Scene = 'home' | 'new' | 'editor';

type CanvasItem = CanvasTextItem | CanvasImageItem;

interface CanvasItemBase {
  id: string;
  type: 'text' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasTextItem extends CanvasItemBase {
  type: 'text';
  text: string;
  fontSize: number;
  color: string;
}

interface CanvasImageItem extends CanvasItemBase {
  type: 'image';
  src: string;
  alt: string;
}

interface VennSet {
  id: string;
  name: string;
  labelItemId: string | null;
  iconItemId: string | null;
  slot?: number;
  cx?: number;
  cy?: number;
  radius?: number;
}

interface ServiceNode {
  id: string;
  name: string;
  labelItemId: string | null;
  iconItemId: string | null;
}

interface VennProjectData {
  sets: VennSet[];
  services: ServiceNode[];
  headerTitle?: string;
  headerSubtitle?: string;
}

interface QuadrantProjectData {
  xAxisLeftName: string;
  xAxisRightName: string;
  yAxisTopName: string;
  yAxisBottomName: string;
  headerTitle?: string;
  headerSubtitle?: string;
  xAxisBottomName?: string;
  xAxisTopName?: string;
  yAxisLeftName?: string;
  yAxisRightName?: string;
  xAxisName?: string;
  yAxisName?: string;
  services: ServiceNode[];
}

interface DiagramProject {
  id: string;
  name: string;
  type: ProjectType;
  createdAt: string;
  updatedAt: string;
  items: CanvasItem[];
  venn?: VennProjectData;
  quadrant?: QuadrantProjectData;
}

interface DragSession {
  pointerId: number;
  target: 'item' | 'venn-set';
  itemId?: string;
  setId?: string;
  mode: 'move' | 'resize';
  itemType?: CanvasItem['type'];
  startClientX: number;
  startClientY: number;
  originX: number;
  originY: number;
  originWidth: number;
  originHeight: number;
  originRadius?: number;
}

const STORAGE_KEY = 'business-diagram-studio.projects.v1';
const PROJECT_SNAPSHOT_API_ENDPOINT = '/api/projects/snapshot';
const PROJECT_AUTOSAVE_INTERVAL_MS = 100;
const PROJECT_HISTORY_LIMIT = 200;

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 720;
const TEXT_ITEM_MIN_WIDTH = 48;
const TEXT_ITEM_MIN_HEIGHT = 52;
const VENN_SET_RADIUS_MIN = 90;
const VENN_SET_RADIUS_MAX = 320;

interface VennCircleLayout {
  cx: number;
  cy: number;
  radius: number;
  labelX: number;
  labelY: number;
  iconX: number;
  iconY: number;
}

const VENN_LAYOUT_SLOTS: readonly VennCircleLayout[] = [
  { cx: 405, cy: 302, radius: 210, labelX: 230, labelY: 88, iconX: 278, iconY: 158 },
  { cx: 795, cy: 302, radius: 210, labelX: 670, labelY: 88, iconX: 718, iconY: 158 },
  { cx: 600, cy: 454, radius: 210, labelX: 500, labelY: 562, iconX: 548, iconY: 496 },
  { cx: 600, cy: 238, radius: 184, labelX: 492, labelY: 44, iconX: 540, iconY: 114 },
  { cx: 345, cy: 462, radius: 184, labelX: 178, labelY: 552, iconX: 226, iconY: 482 },
  { cx: 855, cy: 462, radius: 184, labelX: 728, labelY: 552, iconX: 776, iconY: 482 },
] as const;

const VENN_SERVICE_POINTS = [
  { x: 548, y: 330 },
  { x: 430, y: 312 },
  { x: 706, y: 318 },
  { x: 600, y: 250 },
  { x: 600, y: 430 },
  { x: 510, y: 448 },
  { x: 690, y: 448 },
] as const;

const QUADRANT_SERVICE_POINTS = [
  { x: 830, y: 180 },
  { x: 355, y: 172 },
  { x: 840, y: 510 },
  { x: 348, y: 508 },
  { x: 615, y: 300 },
  { x: 515, y: 190 },
  { x: 706, y: 532 },
] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

interface ProjectHistory {
  past: DiagramProject[];
  future: DiagramProject[];
}

function resolveVennSetSlot(setItem: VennSet, index: number) {
  const fallback = index % VENN_LAYOUT_SLOTS.length;
  if (typeof setItem.slot !== 'number') {
    return fallback;
  }

  const normalized = Math.floor(setItem.slot);
  if (normalized < 0 || normalized >= VENN_LAYOUT_SLOTS.length) {
    return fallback;
  }

  return normalized;
}

function getVennSetLayout(setItem: VennSet, index: number) {
  const slot = resolveVennSetSlot(setItem, index);
  const base = VENN_LAYOUT_SLOTS[slot] ?? VENN_LAYOUT_SLOTS[0];
  return {
    ...base,
    cx: typeof setItem.cx === 'number' ? setItem.cx : base.cx,
    cy: typeof setItem.cy === 'number' ? setItem.cy : base.cy,
    radius: typeof setItem.radius === 'number' ? setItem.radius : base.radius,
  };
}

function getNextAvailableVennSlot(sets: VennSet[]) {
  const usedSlots = new Set(sets.map((setItem, index) => resolveVennSetSlot(setItem, index)));
  for (let slot = 0; slot < VENN_LAYOUT_SLOTS.length; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return null;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tag = target.tagName;
  return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function blurActiveEditableElement() {
  if (typeof document === 'undefined') {
    return;
  }

  const active = document.activeElement;
  if (active instanceof HTMLElement && isEditableTarget(active)) {
    active.blur();
  }
}

function cloneProject(project: DiagramProject) {
  return JSON.parse(JSON.stringify(project)) as DiagramProject;
}

function projectSignature(project: DiagramProject) {
  return JSON.stringify({
    ...project,
    updatedAt: '',
  });
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('이미지 인코딩에 실패했습니다.'));
      }
    };
    reader.onerror = () => reject(new Error('파일 읽기에 실패했습니다.'));
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(src: string) {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
    image.onerror = () => resolve({ width: 1, height: 1 });
    image.src = src;
  });
}

function fitWithinBox(width: number, height: number, maxWidth: number, maxHeight: number) {
  const safeWidth = Math.max(width, 1);
  const safeHeight = Math.max(height, 1);
  const ratio = Math.min(maxWidth / safeWidth, maxHeight / safeHeight, 1);

  return {
    width: Math.max(32, Math.round(safeWidth * ratio)),
    height: Math.max(32, Math.round(safeHeight * ratio)),
  };
}

function createTextItem(options: {
  id?: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  fontSize?: number;
  color?: string;
}): CanvasTextItem {
  return {
    id: options.id ?? createId('item'),
    type: 'text',
    text: options.text,
    x: options.x,
    y: options.y,
    width: options.width ?? 228,
    height: options.height ?? 68,
    fontSize: options.fontSize ?? 28,
    color: options.color ?? '#0f172a',
  };
}

function createImageItem(options: {
  id?: string;
  src: string;
  alt: string;
  x: number;
  y: number;
  width: number;
  height: number;
}): CanvasImageItem {
  return {
    id: options.id ?? createId('item'),
    type: 'image',
    src: options.src,
    alt: options.alt,
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
  };
}

function getNextProjectName(projects: DiagramProject[]) {
  const existing = new Set(projects.map((project) => project.name));
  let index = projects.length + 1;

  while (existing.has(`프로젝트 ${index}`)) {
    index += 1;
  }

  return `프로젝트 ${index}`;
}

function createVennProject(name: string): DiagramProject {
  const now = new Date().toISOString();

  const seedNames = ['고객 니즈', '핵심 역량', '시장 기회'];
  const sets: VennSet[] = [];
  const items: CanvasItem[] = [];

  seedNames.forEach((seedName, index) => {
    const layout = VENN_LAYOUT_SLOTS[index] ?? VENN_LAYOUT_SLOTS[0];
    const labelItemId = createId('item');

    sets.push({
      id: createId('set'),
      name: seedName,
      labelItemId,
      iconItemId: null,
      slot: index,
    });

    items.push(
      createTextItem({
        id: labelItemId,
        text: seedName,
        x: layout.labelX,
        y: layout.labelY,
        width: 240,
        height: 68,
        fontSize: 30,
      }),
    );
  });

  return {
    id: createId('project'),
    name,
    type: 'venn',
    createdAt: now,
    updatedAt: now,
    items,
    venn: {
      sets,
      services: [],
      headerTitle: 'Venn Diagram Canvas',
      headerSubtitle: '서비스 라벨/아이콘을 드래그해서 교집합 위치로 배치하세요.',
    },
  };
}

function createQuadrantProject(name: string): DiagramProject {
  const now = new Date().toISOString();

  return {
    id: createId('project'),
    name,
    type: 'quadrant',
    createdAt: now,
    updatedAt: now,
    items: [],
    quadrant: {
      xAxisLeftName: '비용 효율성 (낮음)',
      xAxisRightName: '비용 효율성 (높음)',
      yAxisTopName: '시장 영향력 (높음)',
      yAxisBottomName: '시장 영향력 (낮음)',
      headerTitle: 'Competitive Quadrant Canvas',
      headerSubtitle: '서비스 라벨/아이콘을 사분면에 배치해 경쟁 포지셔닝을 비교하세요.',
      services: [],
    },
  };
}

function createProject(name: string, type: ProjectType) {
  if (type === 'venn') {
    return createVennProject(name);
  }

  return createQuadrantProject(name);
}

function loadProjectsFromStorage() {
  if (typeof window === 'undefined') {
    return [] as DiagramProject[];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [] as DiagramProject[];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [] as DiagramProject[];
    }

    return parsed as DiagramProject[];
  } catch {
    return [] as DiagramProject[];
  }
}

async function loadProjectsFromApi() {
  const response = await fetch(PROJECT_SNAPSHOT_API_ENDPOINT, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`프로젝트 로드 실패: ${response.status}`);
  }

  const payload = (await response.json()) as { projects?: unknown };
  if (!payload || !Array.isArray(payload.projects)) {
    return [] as DiagramProject[];
  }

  return payload.projects as DiagramProject[];
}

async function saveProjectsToApi(projects: DiagramProject[]) {
  const response = await fetch(PROJECT_SNAPSHOT_API_ENDPOINT, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ projects }),
  });

  if (!response.ok) {
    throw new Error(`프로젝트 저장 실패: ${response.status}`);
  }
}

function detachItemRefs(services: ServiceNode[], itemId: string) {
  return services.map((service) => ({
    ...service,
    labelItemId: service.labelItemId === itemId ? null : service.labelItemId,
    iconItemId: service.iconItemId === itemId ? null : service.iconItemId,
  }));
}

function getQuadrantAxisLabels(quadrant: QuadrantProjectData | undefined) {
  // Legacy compatibility:
  // - Old schema accidentally mapped X to top/bottom and Y to left/right.
  // - We remap old values into the corrected schema (X=left/right, Y=top/bottom).
  const legacyHorizontalLeft = quadrant?.yAxisLeftName ?? quadrant?.xAxisName ?? '';
  const legacyHorizontalRight = quadrant?.yAxisRightName ?? '';
  const legacyVerticalTop = quadrant?.xAxisTopName ?? quadrant?.yAxisName ?? '';
  const legacyVerticalBottom = quadrant?.xAxisBottomName ?? '';

  return {
    xLeft: (quadrant?.xAxisLeftName ?? legacyHorizontalLeft) || 'X 축',
    xRight: (quadrant?.xAxisRightName ?? legacyHorizontalRight) || '',
    yTop: (quadrant?.yAxisTopName ?? legacyVerticalTop) || 'Y 축',
    yBottom: (quadrant?.yAxisBottomName ?? legacyVerticalBottom) || '',
  };
}

function getQuadrantHeaderTexts(quadrant: QuadrantProjectData | undefined) {
  return {
    title: quadrant?.headerTitle ?? 'Competitive Quadrant Canvas',
    subtitle: quadrant?.headerSubtitle ?? '서비스 라벨/아이콘을 사분면에 배치해 경쟁 포지셔닝을 비교하세요.',
  };
}

function getVennHeaderTexts(venn: VennProjectData | undefined) {
  return {
    title: venn?.headerTitle ?? 'Venn Diagram Canvas',
    subtitle: venn?.headerSubtitle ?? '서비스 라벨/아이콘을 드래그해서 교집합 위치로 배치하세요.',
  };
}

interface AppRoute {
  scene: Scene;
  projectId: string | null;
}

function parseAppRoute(pathname: string): AppRoute {
  const normalized =
    pathname !== '/' && pathname.endsWith('/') ? pathname.replace(/\/+$/, '') || '/' : pathname;

  if (normalized === '/new') {
    return { scene: 'new', projectId: null };
  }

  if (normalized.startsWith('/projects/')) {
    const encodedProjectId = normalized.slice('/projects/'.length).split('/')[0];
    if (encodedProjectId) {
      return {
        scene: 'editor',
        projectId: decodeURIComponent(encodedProjectId),
      };
    }
  }

  return { scene: 'home', projectId: null };
}

function buildAppRoutePath(scene: Scene, projectId: string | null) {
  if (scene === 'new') {
    return '/new';
  }

  if (scene === 'editor' && projectId) {
    return `/projects/${encodeURIComponent(projectId)}`;
  }

  return '/';
}

function getInitialRoute() {
  if (typeof window === 'undefined') {
    return { scene: 'home', projectId: null } as AppRoute;
  }

  return parseAppRoute(window.location.pathname);
}

function App() {
  const initialRoute = getInitialRoute();
  const [projects, setProjects] = useState<DiagramProject[]>([]);
  const [scene, setScene] = useState<Scene>(initialRoute.scene);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(initialRoute.projectId);
  const [newProjectType, setNewProjectType] = useState<ProjectType>('venn');
  const [newProjectName, setNewProjectName] = useState('');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [selectedVennSetId, setSelectedVennSetId] = useState<string | null>(null);
  const [editingTextItemId, setEditingTextItemId] = useState<string | null>(null);
  const [isPlacingTextBox, setIsPlacingTextBox] = useState(false);
  const [statusMessage, setStatusMessage] = useState('기존 프로젝트를 열거나 새 프로젝트를 만들어주세요.');
  const [canvasScale, setCanvasScale] = useState(1);
  const [isCanvasDropActive, setIsCanvasDropActive] = useState(false);

  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const textEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const canvasDropDepthRef = useRef(0);
  const apiHydratedRef = useRef(false);
  const projectsRef = useRef<DiagramProject[]>([]);
  const projectHistoriesRef = useRef<Record<string, ProjectHistory>>({});
  const dragHistoryRef = useRef<{ projectId: string; before: DiagramProject } | null>(null);
  const saveDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const autoSaveErrorNotifiedRef = useRef(false);
  const lastSavedSignatureRef = useRef('');
  const routeSyncLockRef = useRef(false);
  const [isApiHydrated, setIsApiHydrated] = useState(false);

  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  );

  useEffect(() => {
    if (!isApiHydrated || scene !== 'editor' || !currentProjectId) {
      return;
    }

    const exists = projects.some((project) => project.id === currentProjectId);
    if (exists) {
      return;
    }

    setCurrentProjectId(null);
    setScene('home');
    setSelectedItemId(null);
    setSelectedVennSetId(null);
    setStatusMessage('프로젝트 경로를 찾을 수 없어 메인으로 이동했습니다.');
  }, [currentProjectId, isApiHydrated, projects, scene]);

  const selectedItem = useMemo(
    () => currentProject?.items.find((item) => item.id === selectedItemId) ?? null,
    [currentProject, selectedItemId],
  );

  useEffect(() => {
    if (!editingTextItemId) {
      return;
    }

    const node = textEditorRef.current;
    if (!node) {
      return;
    }

    node.focus();
    const cursor = node.value.length;
    node.setSelectionRange(cursor, cursor);
  }, [editingTextItemId]);

  useEffect(() => {
    if (!editingTextItemId) {
      return;
    }

    if (!currentProject) {
      setEditingTextItemId(null);
      return;
    }

    const editingItem = currentProject.items.find((item) => item.id === editingTextItemId);
    if (!editingItem || editingItem.type !== 'text') {
      setEditingTextItemId(null);
    }
  }, [currentProject, editingTextItemId]);

  const selectedVennSetLayout = useMemo(() => {
    if (!currentProject || currentProject.type !== 'venn' || !currentProject.venn || !selectedVennSetId) {
      return null;
    }

    const index = currentProject.venn.sets.findIndex((setItem) => setItem.id === selectedVennSetId);
    if (index < 0) {
      return null;
    }

    const setItem = currentProject.venn.sets[index];
    return {
      setItem,
      index,
      layout: getVennSetLayout(setItem, index),
    };
  }, [currentProject, selectedVennSetId]);

  const currentServices = useMemo(() => {
    if (!currentProject) {
      return [] as ServiceNode[];
    }

    if (currentProject.type === 'venn') {
      return currentProject.venn?.services ?? [];
    }

    return currentProject.quadrant?.services ?? [];
  }, [currentProject]);

  const quadrantAxisLabels = useMemo(() => {
    if (!currentProject || currentProject.type !== 'quadrant') {
      return null;
    }

    return getQuadrantAxisLabels(currentProject.quadrant);
  }, [currentProject]);

  const quadrantHeaderTexts = useMemo(() => {
    if (!currentProject || currentProject.type !== 'quadrant') {
      return null;
    }

    return getQuadrantHeaderTexts(currentProject.quadrant);
  }, [currentProject]);

  const vennHeaderTexts = useMemo(() => {
    if (!currentProject || currentProject.type !== 'venn') {
      return null;
    }

    return getVennHeaderTexts(currentProject.venn);
  }, [currentProject]);

  useEffect(() => {
    projectsRef.current = projects;
    if (apiHydratedRef.current) {
      saveDirtyRef.current = true;
    }
  }, [projects]);

  useEffect(() => {
    let cancelled = false;

    const hydrateProjects = async () => {
      let loadedProjects: DiagramProject[] = [];

      try {
        loadedProjects = await loadProjectsFromApi();
      } catch {
        loadedProjects = [];
      }

      if (!loadedProjects.length) {
        const legacyProjects = loadProjectsFromStorage();
        if (legacyProjects.length) {
          loadedProjects = legacyProjects;
          try {
            await saveProjectsToApi(legacyProjects);
            window.localStorage.removeItem(STORAGE_KEY);
          } catch {
            // ignore migration write failure here; autosave loop will retry once API is reachable.
          }
        }
      }

      if (cancelled) {
        return;
      }

      setProjects(loadedProjects);
      lastSavedSignatureRef.current = JSON.stringify(loadedProjects);
      apiHydratedRef.current = true;
      setIsApiHydrated(true);
      saveDirtyRef.current = false;
    };

    void hydrateProjects();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      if (typeof window === 'undefined') {
        return;
      }

      const route = parseAppRoute(window.location.pathname);
      routeSyncLockRef.current = true;
      setScene(route.scene);
      setCurrentProjectId(route.projectId);
      setSelectedItemId(null);
      setSelectedVennSetId(null);
      setIsPlacingTextBox(false);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const nextPath = buildAppRoutePath(scene, currentProjectId);
    if (window.location.pathname === nextPath) {
      routeSyncLockRef.current = false;
      return;
    }

    if (routeSyncLockRef.current) {
      routeSyncLockRef.current = false;
      window.history.replaceState(null, '', nextPath);
      return;
    }

    window.history.pushState(null, '', nextPath);
  }, [currentProjectId, scene]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!apiHydratedRef.current || !saveDirtyRef.current || saveInFlightRef.current) {
        return;
      }

      const snapshot = projectsRef.current;
      const nextSignature = JSON.stringify(snapshot);
      if (nextSignature === lastSavedSignatureRef.current) {
        saveDirtyRef.current = false;
        return;
      }

      saveInFlightRef.current = true;
      void saveProjectsToApi(snapshot)
        .then(() => {
          lastSavedSignatureRef.current = nextSignature;
          saveDirtyRef.current = false;
          autoSaveErrorNotifiedRef.current = false;
        })
        .catch(() => {
          saveDirtyRef.current = true;
          if (!autoSaveErrorNotifiedRef.current) {
            setStatusMessage('자동 저장이 실패했습니다. API 연결 상태를 확인해 주세요.');
            autoSaveErrorNotifiedRef.current = true;
          }
        })
        .finally(() => {
          saveInFlightRef.current = false;
        });
    }, PROJECT_AUTOSAVE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (scene !== 'editor') {
      return;
    }

    const node = canvasViewportRef.current;
    if (!node) {
      return;
    }

    const updateScale = () => {
      const availableWidth = Math.max(node.clientWidth - 28, 1);
      const availableHeight = Math.max(node.clientHeight - 28, 1);
      const widthScale = availableWidth / CANVAS_WIDTH;
      const heightScale = availableHeight / CANVAS_HEIGHT;
      const nextScale = clamp(Math.min(widthScale, heightScale), 0.34, 1);
      setCanvasScale(nextScale);
    };

    updateScale();

    const observer = new ResizeObserver(() => updateScale());
    observer.observe(node);

    return () => observer.disconnect();
  }, [scene, currentProject?.type, currentProjectId]);

  useEffect(() => {
    if (scene === 'editor' && currentProject?.type === 'quadrant') {
      return;
    }

    canvasDropDepthRef.current = 0;
    setIsCanvasDropActive(false);
  }, [currentProject?.type, scene]);

  useEffect(() => {
    if (scene !== 'editor') {
      setIsPlacingTextBox(false);
      setSelectedVennSetId(null);
      return;
    }

    setIsPlacingTextBox(false);
    setSelectedVennSetId(null);
  }, [currentProjectId, scene]);

  useEffect(() => {
    const existingIds = new Set(projects.map((project) => project.id));
    const nextHistories: Record<string, ProjectHistory> = {};

    Object.entries(projectHistoriesRef.current).forEach(([projectId, history]) => {
      if (existingIds.has(projectId)) {
        nextHistories[projectId] = history;
      }
    });

    projectHistoriesRef.current = nextHistories;
  }, [projects]);

  const ensureProjectHistory = useCallback((projectId: string) => {
    const existing = projectHistoriesRef.current[projectId];
    if (existing) {
      return existing;
    }

    const created: ProjectHistory = { past: [], future: [] };
    projectHistoriesRef.current[projectId] = created;
    return created;
  }, []);

  const pushProjectHistory = useCallback(
    (projectId: string, snapshot: DiagramProject, clearFuture: boolean) => {
      const history = ensureProjectHistory(projectId);
      history.past.push(cloneProject(snapshot));

      if (history.past.length > PROJECT_HISTORY_LIMIT) {
        history.past.splice(0, history.past.length - PROJECT_HISTORY_LIMIT);
      }

      if (clearFuture) {
        history.future = [];
      }
    },
    [ensureProjectHistory],
  );

  const replaceCurrentProject = useCallback(
    (
      mutator: (project: DiagramProject) => DiagramProject,
      options?: {
        trackHistory?: boolean;
        clearFuture?: boolean;
      },
    ) => {
      if (!currentProjectId) {
        return;
      }

      const trackHistory = options?.trackHistory ?? true;
      const clearFuture = options?.clearFuture ?? true;

      setProjects((previous) =>
        previous.map((project) => {
          if (project.id !== currentProjectId) {
            return project;
          }

          const nextProject = mutator(project);
          if (nextProject === project) {
            return project;
          }

          if (trackHistory) {
            pushProjectHistory(currentProjectId, project, clearFuture);
          }

          return {
            ...nextProject,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
    },
    [currentProjectId, pushProjectHistory],
  );

  const stageDragHistorySnapshot = useCallback(() => {
    if (!currentProjectId) {
      dragHistoryRef.current = null;
      return;
    }

    const current = projectsRef.current.find((project) => project.id === currentProjectId);
    if (!current) {
      dragHistoryRef.current = null;
      return;
    }

    dragHistoryRef.current = {
      projectId: currentProjectId,
      before: cloneProject(current),
    };
  }, [currentProjectId]);

  const openProject = useCallback((projectId: string) => {
    setCurrentProjectId(projectId);
    setScene('editor');
    setSelectedItemId(null);
    setSelectedVennSetId(null);
    setEditingTextItemId(null);
    setStatusMessage('프로젝트를 열었습니다.');
  }, []);

  const handleCreateProject = useCallback(() => {
    const name = newProjectName.trim() || getNextProjectName(projects);
    const project = createProject(name, newProjectType);

    setProjects((previous) => [project, ...previous]);
    setCurrentProjectId(project.id);
    setScene('editor');
    setSelectedItemId(null);
    setSelectedVennSetId(null);
    setEditingTextItemId(null);
    setNewProjectName('');
    setStatusMessage('새 프로젝트를 생성했습니다.');
  }, [newProjectName, projects, newProjectType]);

  const handleDeleteProject = useCallback(
    (projectId: string) => {
      setProjects((previous) => previous.filter((project) => project.id !== projectId));

      if (currentProjectId === projectId) {
        setCurrentProjectId(null);
        setScene('home');
        setSelectedItemId(null);
        setSelectedVennSetId(null);
        setEditingTextItemId(null);
      }
    },
    [currentProjectId],
  );

  const updateItem = useCallback(
    (itemId: string, mutator: (item: CanvasItem) => CanvasItem) => {
      replaceCurrentProject((project) => {
        const index = project.items.findIndex((item) => item.id === itemId);
        if (index < 0) {
          return project;
        }

        const nextItems = [...project.items];
        nextItems[index] = mutator(nextItems[index]);

        return {
          ...project,
          items: nextItems,
        };
      });
    },
    [replaceCurrentProject],
  );

  const removeItem = useCallback(
    (itemId: string) => {
      replaceCurrentProject((project) => {
        const nextItems = project.items.filter((item) => item.id !== itemId);
        if (nextItems.length === project.items.length) {
          return project;
        }

        if (project.type === 'venn' && project.venn) {
          const nextSets = project.venn.sets.map((setItem) => ({
            ...setItem,
            labelItemId: setItem.labelItemId === itemId ? null : setItem.labelItemId,
            iconItemId: setItem.iconItemId === itemId ? null : setItem.iconItemId,
          }));

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              sets: nextSets,
              services: detachItemRefs(project.venn.services, itemId),
            },
          };
        }

        if (project.type === 'quadrant' && project.quadrant) {
          return {
            ...project,
            items: nextItems,
            quadrant: {
              ...project.quadrant,
              services: detachItemRefs(project.quadrant.services, itemId),
            },
          };
        }

        return {
          ...project,
          items: nextItems,
        };
      });

      setSelectedItemId((previous) => (previous === itemId ? null : previous));
      setStatusMessage('선택 항목을 삭제했습니다.');
      setEditingTextItemId((previous) => (previous === itemId ? null : previous));
    },
    [replaceCurrentProject],
  );

  const resetCanvasSelection = useCallback(() => {
    dragSessionRef.current = null;
    setSelectedItemId(null);
    setSelectedVennSetId(null);
    setEditingTextItemId(null);
    setIsPlacingTextBox(false);
  }, []);

  const undoCurrentProject = useCallback(() => {
    if (!currentProjectId) {
      return;
    }

    let undone = false;
    setProjects((previous) => {
      const index = previous.findIndex((project) => project.id === currentProjectId);
      if (index < 0) {
        return previous;
      }

      const history = ensureProjectHistory(currentProjectId);
      const previousSnapshot = history.past.pop();
      if (!previousSnapshot) {
        return previous;
      }

      const currentSnapshot = previous[index];
      history.future.push(cloneProject(currentSnapshot));
      if (history.future.length > PROJECT_HISTORY_LIMIT) {
        history.future.splice(0, history.future.length - PROJECT_HISTORY_LIMIT);
      }

      const nextProjects = [...previous];
      nextProjects[index] = {
        ...cloneProject(previousSnapshot),
        updatedAt: new Date().toISOString(),
      };

      undone = true;
      return nextProjects;
    });

    if (!undone) {
      setStatusMessage('되돌릴 변경이 없습니다.');
      return;
    }

    resetCanvasSelection();
    setStatusMessage('이전 변경을 되돌렸습니다.');
  }, [currentProjectId, ensureProjectHistory, resetCanvasSelection]);

  const redoCurrentProject = useCallback(() => {
    if (!currentProjectId) {
      return;
    }

    let redone = false;
    setProjects((previous) => {
      const index = previous.findIndex((project) => project.id === currentProjectId);
      if (index < 0) {
        return previous;
      }

      const history = ensureProjectHistory(currentProjectId);
      const nextSnapshot = history.future.pop();
      if (!nextSnapshot) {
        return previous;
      }

      history.past.push(cloneProject(previous[index]));
      if (history.past.length > PROJECT_HISTORY_LIMIT) {
        history.past.splice(0, history.past.length - PROJECT_HISTORY_LIMIT);
      }

      const nextProjects = [...previous];
      nextProjects[index] = {
        ...cloneProject(nextSnapshot),
        updatedAt: new Date().toISOString(),
      };

      redone = true;
      return nextProjects;
    });

    if (!redone) {
      setStatusMessage('다시 실행할 변경이 없습니다.');
      return;
    }

    resetCanvasSelection();
    setStatusMessage('되돌린 변경을 다시 적용했습니다.');
  }, [currentProjectId, ensureProjectHistory, resetCanvasSelection]);

  useEffect(() => {
    const handleUndoRedoKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) {
        return;
      }

      if (!event.metaKey && !event.ctrlKey) {
        return;
      }

      const key = event.key.toLowerCase();
      const isZ = key === 'z' || event.code === 'KeyZ';
      const isY = key === 'y' || event.code === 'KeyY';

      if (isZ) {
        event.preventDefault();
        if (event.shiftKey) {
          redoCurrentProject();
          return;
        }

        undoCurrentProject();
        return;
      }

      if (isY) {
        event.preventDefault();
        redoCurrentProject();
      }
    };

    window.addEventListener('keydown', handleUndoRedoKeyDown);
    return () => window.removeEventListener('keydown', handleUndoRedoKeyDown);
  }, [redoCurrentProject, undoCurrentProject]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedItemId || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeItem(selectedItemId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [removeItem, selectedItemId]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      const deltaX = (event.clientX - session.startClientX) / canvasScale;
      const deltaY = (event.clientY - session.startClientY) / canvasScale;

      replaceCurrentProject((project) => {
        if (session.target === 'item') {
          if (!session.itemId) {
            return project;
          }

          const index = project.items.findIndex((item) => item.id === session.itemId);
          if (index < 0) {
            return project;
          }

          const currentItem = project.items[index];
          const minWidth = session.itemType === 'text' ? TEXT_ITEM_MIN_WIDTH : 48;
          const minHeight = session.itemType === 'text' ? TEXT_ITEM_MIN_HEIGHT : 48;

          let nextX = currentItem.x;
          let nextY = currentItem.y;
          let nextWidth = currentItem.width;
          let nextHeight = currentItem.height;

          if (session.mode === 'move') {
            nextX = clamp(session.originX + deltaX, 0, CANVAS_WIDTH - session.originWidth);
            nextY = clamp(session.originY + deltaY, 0, CANVAS_HEIGHT - session.originHeight);
          } else {
            nextWidth = clamp(session.originWidth + deltaX, minWidth, CANVAS_WIDTH - session.originX);
            nextHeight = clamp(session.originHeight + deltaY, minHeight, CANVAS_HEIGHT - session.originY);
          }

          if (
            nextX === currentItem.x &&
            nextY === currentItem.y &&
            nextWidth === currentItem.width &&
            nextHeight === currentItem.height
          ) {
            return project;
          }

          const nextItems = [...project.items];
          nextItems[index] = {
            ...currentItem,
            x: nextX,
            y: nextY,
            width: nextWidth,
            height: nextHeight,
          };

          return {
            ...project,
            items: nextItems,
          };
        }

        if (session.target === 'venn-set') {
          if (project.type !== 'venn' || !project.venn || !session.setId) {
            return project;
          }

          const setIndex = project.venn.sets.findIndex((setItem) => setItem.id === session.setId);
          if (setIndex < 0) {
            return project;
          }

          const targetSet = project.venn.sets[setIndex];
          const currentLayout = getVennSetLayout(targetSet, setIndex);
          const nextSets = [...project.venn.sets];
          let nextItems = project.items;

          let nextCx = currentLayout.cx;
          let nextCy = currentLayout.cy;
          let nextRadius = currentLayout.radius;

          if (session.mode === 'move') {
            const sessionRadius = clamp(
              session.originRadius ?? currentLayout.radius,
              VENN_SET_RADIUS_MIN,
              VENN_SET_RADIUS_MAX,
            );
            nextCx = clamp(session.originX + deltaX, sessionRadius, CANVAS_WIDTH - sessionRadius);
            nextCy = clamp(session.originY + deltaY, sessionRadius, CANVAS_HEIGHT - sessionRadius);
            nextRadius = sessionRadius;

            const movedDeltaX = nextCx - currentLayout.cx;
            const movedDeltaY = nextCy - currentLayout.cy;
            if (movedDeltaX !== 0 || movedDeltaY !== 0) {
              const linkedIds = new Set([targetSet.labelItemId ?? '', targetSet.iconItemId ?? '']);
              nextItems = project.items.map((item) => {
                if (!linkedIds.has(item.id)) {
                  return item;
                }

                return {
                  ...item,
                  x: clamp(item.x + movedDeltaX, 0, CANVAS_WIDTH - item.width),
                  y: clamp(item.y + movedDeltaY, 0, CANVAS_HEIGHT - item.height),
                };
              });
            }
          } else {
            const baseRadius = session.originRadius ?? currentLayout.radius;
            const rawRadius = baseRadius + Math.max(deltaX, deltaY);
            const maxAllowedByCanvas = Math.min(
              VENN_SET_RADIUS_MAX,
              session.originX,
              CANVAS_WIDTH - session.originX,
              session.originY,
              CANVAS_HEIGHT - session.originY,
            );
            const cappedMax = Math.max(VENN_SET_RADIUS_MIN, maxAllowedByCanvas);
            nextRadius = clamp(rawRadius, VENN_SET_RADIUS_MIN, cappedMax);
            nextCx = session.originX;
            nextCy = session.originY;
          }

          if (
            nextCx === currentLayout.cx &&
            nextCy === currentLayout.cy &&
            nextRadius === currentLayout.radius &&
            nextItems === project.items
          ) {
            return project;
          }

          nextSets[setIndex] = {
            ...targetSet,
            cx: nextCx,
            cy: nextCy,
            radius: nextRadius,
          };

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              sets: nextSets,
            },
          };
        }

        return project;
      }, { trackHistory: false, clearFuture: false });
    };

    const handlePointerEnd = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }

      const dragHistorySnapshot = dragHistoryRef.current;
      dragSessionRef.current = null;
      dragHistoryRef.current = null;

      if (!dragHistorySnapshot) {
        return;
      }

      const current = projectsRef.current.find((project) => project.id === dragHistorySnapshot.projectId);
      if (!current) {
        return;
      }

      if (projectSignature(current) === projectSignature(dragHistorySnapshot.before)) {
        return;
      }

      pushProjectHistory(dragHistorySnapshot.projectId, dragHistorySnapshot.before, true);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [canvasScale, pushProjectHistory, replaceCurrentProject]);

  const beginItemInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>, item: CanvasItem, mode: 'move' | 'resize') => {
    if (isEditableTarget(event.target)) {
      return;
    }

    stageDragHistorySnapshot();
    blurActiveEditableElement();
    event.preventDefault();
    event.stopPropagation();
    setSelectedItemId(item.id);
    setSelectedVennSetId(null);
    if (item.type !== 'text' || mode === 'resize') {
      setEditingTextItemId(null);
    }

    dragSessionRef.current = {
      target: 'item',
      pointerId: event.pointerId,
      itemId: item.id,
      mode,
      itemType: item.type,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: item.x,
      originY: item.y,
      originWidth: item.width,
      originHeight: item.height,
    };
  }, [stageDragHistorySnapshot]);

  const beginVennSetInteraction = useCallback(
    (event: ReactPointerEvent<SVGCircleElement | HTMLDivElement>, setId: string, mode: 'move' | 'resize') => {
      if (isPlacingTextBox) {
        return;
      }

      if (!currentProject || currentProject.type !== 'venn' || !currentProject.venn) {
        return;
      }

      const setIndex = currentProject.venn.sets.findIndex((setItem) => setItem.id === setId);
      if (setIndex < 0) {
        return;
      }

      const setItem = currentProject.venn.sets[setIndex];
      const layout = getVennSetLayout(setItem, setIndex);

      stageDragHistorySnapshot();
      blurActiveEditableElement();
      event.preventDefault();
      event.stopPropagation();
      setSelectedItemId(null);
      setSelectedVennSetId(setId);
      setEditingTextItemId(null);

      dragSessionRef.current = {
        target: 'venn-set',
        pointerId: event.pointerId,
        setId,
        mode,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originX: layout.cx,
        originY: layout.cy,
        originWidth: 0,
        originHeight: 0,
        originRadius: layout.radius,
      };
    },
    [currentProject, isPlacingTextBox, stageDragHistorySnapshot],
  );

  const addTextBoxAt = useCallback((point: { x: number; y: number }) => {
    const id = createId('item');
    const width = 250;
    const height = 70;
    const x = clamp(point.x - width / 2, 0, CANVAS_WIDTH - width);
    const y = clamp(point.y - height / 2, 0, CANVAS_HEIGHT - height);

    replaceCurrentProject((project) => ({
      ...project,
      items: [
        ...project.items,
        createTextItem({
          id,
          text: '텍스트를 입력하세요',
          x,
          y,
          width,
          height,
          fontSize: 30,
        }),
      ],
    }));

    setSelectedItemId(id);
    setSelectedVennSetId(null);
    setIsPlacingTextBox(false);
    setEditingTextItemId(id);
    setStatusMessage('텍스트 박스를 추가했습니다.');
  }, [replaceCurrentProject]);

  const startTextBoxPlacement = useCallback(() => {
    setIsPlacingTextBox(true);
    setSelectedItemId(null);
    setSelectedVennSetId(null);
    setEditingTextItemId(null);
    setStatusMessage('캔버스를 클릭해 텍스트 박스를 배치해 주세요.');
  }, []);

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isPlacingTextBox) {
        const boardRect = event.currentTarget.getBoundingClientRect();
        const point = {
          x: clamp((event.clientX - boardRect.left) / canvasScale, 0, CANVAS_WIDTH),
          y: clamp((event.clientY - boardRect.top) / canvasScale, 0, CANVAS_HEIGHT),
        };

        addTextBoxAt(point);
        return;
      }

      setSelectedItemId(null);
      setSelectedVennSetId(null);
      setEditingTextItemId(null);
    },
    [addTextBoxAt, canvasScale, isPlacingTextBox],
  );

  const createImageDescriptors = useCallback(async (files: File[]) => {
    return Promise.all(
      files.map(async (file) => {
        const src = await readFileAsDataUrl(file);
        const dimensions = await readImageDimensions(src);
        const fit = fitWithinBox(dimensions.width, dimensions.height, 240, 180);

        return {
          src,
          alt: file.name,
          width: fit.width,
          height: fit.height,
        };
      }),
    );
  }, []);

  const appendImageDescriptorsToCanvas = useCallback(
    (
      descriptors: Array<{ src: string; alt: string; width: number; height: number }>,
      options?: { dropPoint?: { x: number; y: number } },
    ) => {
      if (!descriptors.length) {
        return [] as string[];
      }

      const createdIds = descriptors.map(() => createId('item'));

      replaceCurrentProject((project) => {
        const nextItems = [...project.items];
        const dropPoint = options?.dropPoint;

        descriptors.forEach((descriptor, index) => {
          const id = createdIds[index];

          let x = 90 + ((project.items.length + index) % 8) * 26;
          let y = 90 + ((project.items.length + index) % 8) * 24;

          if (dropPoint) {
            const col = index % 4;
            const row = Math.floor(index / 4);
            const offsetX = col * 28;
            const offsetY = row * 28;
            x = clamp(dropPoint.x - descriptor.width / 2 + offsetX, 0, CANVAS_WIDTH - descriptor.width);
            y = clamp(dropPoint.y - descriptor.height / 2 + offsetY, 0, CANVAS_HEIGHT - descriptor.height);
          }

          nextItems.push(
            createImageItem({
              id,
              src: descriptor.src,
              alt: descriptor.alt,
              width: descriptor.width,
              height: descriptor.height,
              x,
              y,
            }),
          );
        });

        return {
          ...project,
          items: nextItems,
        };
      });

      return createdIds;
    },
    [replaceCurrentProject],
  );

  const attachImageFilesToCanvas = useCallback(
    async (files: File[], options?: { dropPoint?: { x: number; y: number } }) => {
      const imageFiles = files.filter((file) => file.type.startsWith('image/'));
      if (!imageFiles.length) {
        return false;
      }

      const descriptors = await createImageDescriptors(imageFiles);
      const createdIds = appendImageDescriptorsToCanvas(descriptors, options);
      setSelectedItemId(createdIds.at(-1) ?? null);
      setStatusMessage(`${imageFiles.length}개의 이미지를 캔버스에 첨부했습니다.`);
      return true;
    },
    [appendImageDescriptorsToCanvas, createImageDescriptors],
  );

  const handleAttachImages = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      if (!files.length) {
        return;
      }

      await attachImageFilesToCanvas(files);
      event.target.value = '';
    },
    [attachImageFilesToCanvas],
  );

  const handleCanvasDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (currentProject?.type !== 'quadrant') {
        return;
      }

      if (!event.dataTransfer.types.includes('Files')) {
        return;
      }

      event.preventDefault();
      canvasDropDepthRef.current += 1;
      setIsCanvasDropActive(true);
    },
    [currentProject?.type],
  );

  const handleCanvasDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (currentProject?.type !== 'quadrant') {
        return;
      }

      if (!event.dataTransfer.types.includes('Files')) {
        return;
      }

      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsCanvasDropActive(true);
    },
    [currentProject?.type],
  );

  const handleCanvasDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (currentProject?.type !== 'quadrant') {
        return;
      }

      if (!event.dataTransfer.types.includes('Files')) {
        return;
      }

      event.preventDefault();
      canvasDropDepthRef.current = Math.max(0, canvasDropDepthRef.current - 1);
      if (canvasDropDepthRef.current === 0) {
        setIsCanvasDropActive(false);
      }
    },
    [currentProject?.type],
  );

  const handleCanvasDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      if (currentProject?.type !== 'quadrant') {
        return;
      }

      event.preventDefault();
      canvasDropDepthRef.current = 0;
      setIsCanvasDropActive(false);

      const files = Array.from(event.dataTransfer.files ?? []).filter((file) => file.type.startsWith('image/'));
      if (!files.length) {
        return;
      }

      const boardRect = event.currentTarget.getBoundingClientRect();
      const dropPoint = {
        x: clamp((event.clientX - boardRect.left) / canvasScale, 0, CANVAS_WIDTH),
        y: clamp((event.clientY - boardRect.top) / canvasScale, 0, CANVAS_HEIGHT),
      };

      await attachImageFilesToCanvas(files, { dropPoint });
      setStatusMessage(`${files.length}개의 이미지를 드롭 위치에 추가했습니다.`);
    },
    [attachImageFilesToCanvas, canvasScale, currentProject?.type],
  );

  const updateVennSetName = useCallback(
    (setId: string, nextName: string) => {
      replaceCurrentProject((project) => {
        if (project.type !== 'venn' || !project.venn) {
          return project;
        }

        const sets = [...project.venn.sets];
        const targetIndex = sets.findIndex((setItem) => setItem.id === setId);
        if (targetIndex < 0) {
          return project;
        }

        const currentSet = sets[targetIndex];
        const nextItems = [...project.items];
        let labelItemId = currentSet.labelItemId;

        if (labelItemId) {
          const itemIndex = nextItems.findIndex((item) => item.id === labelItemId && item.type === 'text');
          if (itemIndex >= 0) {
            const targetItem = nextItems[itemIndex] as CanvasTextItem;
            nextItems[itemIndex] = {
              ...targetItem,
              text: nextName || `집합 ${targetIndex + 1}`,
            };
          } else {
            labelItemId = null;
          }
        }

        if (!labelItemId) {
          const layout = getVennSetLayout(currentSet, targetIndex);
          const freshLabelItemId = createId('item');
          labelItemId = freshLabelItemId;

          nextItems.push(
            createTextItem({
              id: freshLabelItemId,
              text: nextName || `집합 ${targetIndex + 1}`,
              x: layout.labelX,
              y: layout.labelY,
              width: 240,
              height: 68,
              fontSize: 30,
            }),
          );
        }

        sets[targetIndex] = {
          ...currentSet,
          name: nextName,
          labelItemId,
        };

        return {
          ...project,
          items: nextItems,
          venn: {
            ...project.venn,
            sets,
          },
        };
      });
    },
    [replaceCurrentProject],
  );

  const uploadVennSetIcon = useCallback(
    async (setId: string, event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const src = await readFileAsDataUrl(file);
      const dimensions = await readImageDimensions(src);
      const fit = fitWithinBox(dimensions.width, dimensions.height, 92, 92);

      replaceCurrentProject((project) => {
        if (project.type !== 'venn' || !project.venn) {
          return project;
        }

        const sets = [...project.venn.sets];
        const targetIndex = sets.findIndex((setItem) => setItem.id === setId);
        if (targetIndex < 0) {
          return project;
        }

        const currentSet = sets[targetIndex];
        const nextItems = [...project.items];
        let iconItemId = currentSet.iconItemId;

        if (iconItemId) {
          const itemIndex = nextItems.findIndex((item) => item.id === iconItemId && item.type === 'image');
          if (itemIndex >= 0) {
            const targetItem = nextItems[itemIndex] as CanvasImageItem;
            nextItems[itemIndex] = {
              ...targetItem,
              src,
              alt: file.name,
              width: fit.width,
              height: fit.height,
            };
          } else {
            iconItemId = null;
          }
        }

        if (!iconItemId) {
          const layout = getVennSetLayout(currentSet, targetIndex);
          const maybeLabel = currentSet.labelItemId
            ? nextItems.find((item) => item.id === currentSet.labelItemId)
            : null;

          const iconX = maybeLabel ? maybeLabel.x + 8 : layout.iconX;
          const iconY = maybeLabel ? maybeLabel.y + maybeLabel.height + 6 : layout.iconY;
          iconItemId = createId('item');

          nextItems.push(
            createImageItem({
              id: iconItemId,
              src,
              alt: file.name,
              x: iconX,
              y: iconY,
              width: fit.width,
              height: fit.height,
            }),
          );
        }

        sets[targetIndex] = {
          ...currentSet,
          iconItemId,
        };

        return {
          ...project,
          items: nextItems,
          venn: {
            ...project.venn,
            sets,
          },
        };
      });

      event.target.value = '';
      setStatusMessage('집합 아이콘을 반영했습니다.');
    },
    [replaceCurrentProject],
  );

  const removeVennSetIcon = useCallback(
    (setId: string) => {
      replaceCurrentProject((project) => {
        if (project.type !== 'venn' || !project.venn) {
          return project;
        }

        const sets = [...project.venn.sets];
        const targetIndex = sets.findIndex((setItem) => setItem.id === setId);
        if (targetIndex < 0) {
          return project;
        }

        const targetSet = sets[targetIndex];
        if (!targetSet.iconItemId) {
          return project;
        }

        const nextItems = project.items.filter((item) => item.id !== targetSet.iconItemId);

        sets[targetIndex] = {
          ...targetSet,
          iconItemId: null,
        };

        return {
          ...project,
          items: nextItems,
          venn: {
            ...project.venn,
            sets,
          },
        };
      });
    },
    [replaceCurrentProject],
  );

  const addVennSet = useCallback(() => {
    let addedLabelItemId: string | null = null;
    let isAdded = false;

    replaceCurrentProject((project) => {
      if (project.type !== 'venn' || !project.venn) {
        return project;
      }

      const nextSlot = getNextAvailableVennSlot(project.venn.sets);
      if (nextSlot === null) {
        return project;
      }

      const nextSetNumber = project.venn.sets.length + 1;
      const nextSetName = `집합 ${nextSetNumber}`;
      const labelItemId = createId('item');
      const layout = VENN_LAYOUT_SLOTS[nextSlot] ?? VENN_LAYOUT_SLOTS[0];

      addedLabelItemId = labelItemId;
      isAdded = true;

      return {
        ...project,
        items: [
          ...project.items,
          createTextItem({
            id: labelItemId,
            text: nextSetName,
            x: layout.labelX,
            y: layout.labelY,
            width: 240,
            height: 68,
            fontSize: 30,
          }),
        ],
        venn: {
          ...project.venn,
          sets: [
            ...project.venn.sets,
            {
              id: createId('set'),
              name: nextSetName,
              labelItemId,
              iconItemId: null,
              slot: nextSlot,
            },
          ],
        },
      };
    });

    if (isAdded) {
      setSelectedItemId(addedLabelItemId);
      setStatusMessage('집합을 추가했습니다.');
      return;
    }

    setStatusMessage(`집합은 최대 ${VENN_LAYOUT_SLOTS.length}개까지 추가할 수 있습니다.`);
  }, [replaceCurrentProject]);

  const removeVennSet = useCallback(
    (setId: string) => {
      let removedItemIds = new Set<string>();
      let removed = false;

      replaceCurrentProject((project) => {
        if (project.type !== 'venn' || !project.venn) {
          return project;
        }

        if (project.venn.sets.length <= 1) {
          return project;
        }

        const targetSet = project.venn.sets.find((setItem) => setItem.id === setId);
        if (!targetSet) {
          return project;
        }

        removed = true;
        removedItemIds = new Set([targetSet.labelItemId ?? '', targetSet.iconItemId ?? '']);
        const nextSets = project.venn.sets.filter((setItem) => setItem.id !== setId);
        const nextItems = project.items.filter((item) => !removedItemIds.has(item.id));

        return {
          ...project,
          items: nextItems,
          venn: {
            ...project.venn,
            sets: nextSets,
          },
        };
      });

      if (!removed) {
        setStatusMessage('집합은 최소 1개가 필요합니다.');
        return;
      }

      setSelectedItemId((previous) => (previous && removedItemIds.has(previous) ? null : previous));
      setSelectedVennSetId((previous) => (previous === setId ? null : previous));
      setStatusMessage('집합을 삭제했습니다.');
    },
    [replaceCurrentProject],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!selectedVennSetId || selectedItemId || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeVennSet(selectedVennSetId);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [removeVennSet, selectedItemId, selectedVennSetId]);

  const addService = useCallback(() => {
    const labelItemId = createId('item');
    const serviceId = createId('service');

    replaceCurrentProject((project) => {
      if (project.type === 'venn' && project.venn) {
        const index = project.venn.services.length;
        const point = VENN_SERVICE_POINTS[index % VENN_SERVICE_POINTS.length] ?? VENN_SERVICE_POINTS[0];
        const name = `서비스 ${index + 1}`;

        return {
          ...project,
          items: [
            ...project.items,
            createTextItem({
              id: labelItemId,
              text: name,
              x: point.x,
              y: point.y,
              width: 170,
              height: 56,
              fontSize: 24,
            }),
          ],
          venn: {
            ...project.venn,
            services: [
              ...project.venn.services,
              {
                id: serviceId,
                name,
                labelItemId,
                iconItemId: null,
              },
            ],
          },
        };
      }

      if (project.type === 'quadrant' && project.quadrant) {
        const index = project.quadrant.services.length;
        const point = QUADRANT_SERVICE_POINTS[index % QUADRANT_SERVICE_POINTS.length] ?? QUADRANT_SERVICE_POINTS[0];
        const name = `서비스 ${index + 1}`;

        return {
          ...project,
          items: [
            ...project.items,
            createTextItem({
              id: labelItemId,
              text: name,
              x: point.x,
              y: point.y,
              width: 180,
              height: 56,
              fontSize: 24,
            }),
          ],
          quadrant: {
            ...project.quadrant,
            services: [
              ...project.quadrant.services,
              {
                id: serviceId,
                name,
                labelItemId,
                iconItemId: null,
              },
            ],
          },
        };
      }

      return project;
    });

    setSelectedItemId(labelItemId);
    setStatusMessage('서비스 항목을 추가했습니다.');
  }, [replaceCurrentProject]);

  const updateServiceName = useCallback(
    (serviceId: string, nextName: string) => {
      replaceCurrentProject((project) => {
        if (project.type === 'venn' && project.venn) {
          const nextServices = [...project.venn.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const nextItems = [...project.items];
          const service = nextServices[targetIndex];
          const fallbackPoint = VENN_SERVICE_POINTS[targetIndex % VENN_SERVICE_POINTS.length] ?? VENN_SERVICE_POINTS[0];
          let labelItemId = service.labelItemId;

          if (labelItemId) {
            const itemIndex = nextItems.findIndex((item) => item.id === labelItemId && item.type === 'text');
            if (itemIndex >= 0) {
              const targetItem = nextItems[itemIndex] as CanvasTextItem;
              nextItems[itemIndex] = {
                ...targetItem,
                text: nextName || `서비스 ${targetIndex + 1}`,
              };
            } else {
              labelItemId = null;
            }
          }

          if (!labelItemId) {
            labelItemId = createId('item');
            nextItems.push(
              createTextItem({
                id: labelItemId,
                text: nextName || `서비스 ${targetIndex + 1}`,
                x: fallbackPoint.x,
                y: fallbackPoint.y,
                width: 170,
                height: 56,
                fontSize: 24,
              }),
            );
          }

          nextServices[targetIndex] = {
            ...service,
            name: nextName,
            labelItemId,
          };

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              services: nextServices,
            },
          };
        }

        if (project.type === 'quadrant' && project.quadrant) {
          const nextServices = [...project.quadrant.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const nextItems = [...project.items];
          const service = nextServices[targetIndex];
          const fallbackPoint =
            QUADRANT_SERVICE_POINTS[targetIndex % QUADRANT_SERVICE_POINTS.length] ?? QUADRANT_SERVICE_POINTS[0];
          let labelItemId = service.labelItemId;

          if (labelItemId) {
            const itemIndex = nextItems.findIndex((item) => item.id === labelItemId && item.type === 'text');
            if (itemIndex >= 0) {
              const targetItem = nextItems[itemIndex] as CanvasTextItem;
              nextItems[itemIndex] = {
                ...targetItem,
                text: nextName || `서비스 ${targetIndex + 1}`,
              };
            } else {
              labelItemId = null;
            }
          }

          if (!labelItemId) {
            labelItemId = createId('item');
            nextItems.push(
              createTextItem({
                id: labelItemId,
                text: nextName || `서비스 ${targetIndex + 1}`,
                x: fallbackPoint.x,
                y: fallbackPoint.y,
                width: 180,
                height: 56,
                fontSize: 24,
              }),
            );
          }

          nextServices[targetIndex] = {
            ...service,
            name: nextName,
            labelItemId,
          };

          return {
            ...project,
            items: nextItems,
            quadrant: {
              ...project.quadrant,
              services: nextServices,
            },
          };
        }

        return project;
      });
    },
    [replaceCurrentProject],
  );

  const uploadServiceIcon = useCallback(
    async (serviceId: string, event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      const src = await readFileAsDataUrl(file);
      const dimensions = await readImageDimensions(src);
      const fit = fitWithinBox(dimensions.width, dimensions.height, 92, 92);

      replaceCurrentProject((project) => {
        if (project.type === 'venn' && project.venn) {
          const nextServices = [...project.venn.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const nextItems = [...project.items];
          const service = nextServices[targetIndex];
          let iconItemId = service.iconItemId;

          if (iconItemId) {
            const imageIndex = nextItems.findIndex((item) => item.id === iconItemId && item.type === 'image');
            if (imageIndex >= 0) {
              const imageItem = nextItems[imageIndex] as CanvasImageItem;
              nextItems[imageIndex] = {
                ...imageItem,
                src,
                alt: file.name,
                width: fit.width,
                height: fit.height,
              };
            } else {
              iconItemId = null;
            }
          }

          if (!iconItemId) {
            const maybeLabel = service.labelItemId ? nextItems.find((item) => item.id === service.labelItemId) : null;
            iconItemId = createId('item');

            nextItems.push(
              createImageItem({
                id: iconItemId,
                src,
                alt: file.name,
                width: fit.width,
                height: fit.height,
                x: maybeLabel ? maybeLabel.x + 16 : 560,
                y: maybeLabel ? maybeLabel.y - fit.height - 10 : 290,
              }),
            );
          }

          nextServices[targetIndex] = {
            ...service,
            iconItemId,
          };

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              services: nextServices,
            },
          };
        }

        if (project.type === 'quadrant' && project.quadrant) {
          const nextServices = [...project.quadrant.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const nextItems = [...project.items];
          const service = nextServices[targetIndex];
          let iconItemId = service.iconItemId;

          if (iconItemId) {
            const imageIndex = nextItems.findIndex((item) => item.id === iconItemId && item.type === 'image');
            if (imageIndex >= 0) {
              const imageItem = nextItems[imageIndex] as CanvasImageItem;
              nextItems[imageIndex] = {
                ...imageItem,
                src,
                alt: file.name,
                width: fit.width,
                height: fit.height,
              };
            } else {
              iconItemId = null;
            }
          }

          if (!iconItemId) {
            const maybeLabel = service.labelItemId ? nextItems.find((item) => item.id === service.labelItemId) : null;
            iconItemId = createId('item');

            nextItems.push(
              createImageItem({
                id: iconItemId,
                src,
                alt: file.name,
                width: fit.width,
                height: fit.height,
                x: maybeLabel ? maybeLabel.x + 18 : 560,
                y: maybeLabel ? maybeLabel.y - fit.height - 10 : 290,
              }),
            );
          }

          nextServices[targetIndex] = {
            ...service,
            iconItemId,
          };

          return {
            ...project,
            items: nextItems,
            quadrant: {
              ...project.quadrant,
              services: nextServices,
            },
          };
        }

        return project;
      });

      event.target.value = '';
      setStatusMessage('서비스 아이콘을 반영했습니다.');
    },
    [replaceCurrentProject],
  );

  const removeServiceIcon = useCallback(
    (serviceId: string) => {
      replaceCurrentProject((project) => {
        if (project.type === 'venn' && project.venn) {
          const nextServices = [...project.venn.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const target = nextServices[targetIndex];
          if (!target.iconItemId) {
            return project;
          }

          const nextItems = project.items.filter((item) => item.id !== target.iconItemId);
          nextServices[targetIndex] = {
            ...target,
            iconItemId: null,
          };

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              services: nextServices,
            },
          };
        }

        if (project.type === 'quadrant' && project.quadrant) {
          const nextServices = [...project.quadrant.services];
          const targetIndex = nextServices.findIndex((service) => service.id === serviceId);
          if (targetIndex < 0) {
            return project;
          }

          const target = nextServices[targetIndex];
          if (!target.iconItemId) {
            return project;
          }

          const nextItems = project.items.filter((item) => item.id !== target.iconItemId);
          nextServices[targetIndex] = {
            ...target,
            iconItemId: null,
          };

          return {
            ...project,
            items: nextItems,
            quadrant: {
              ...project.quadrant,
              services: nextServices,
            },
          };
        }

        return project;
      });
    },
    [replaceCurrentProject],
  );

  const removeService = useCallback(
    (serviceId: string) => {
      replaceCurrentProject((project) => {
        if (project.type === 'venn' && project.venn) {
          const target = project.venn.services.find((service) => service.id === serviceId);
          if (!target) {
            return project;
          }

          const nextServices = project.venn.services.filter((service) => service.id !== serviceId);
          const nextItems = project.items.filter(
            (item) => item.id !== target.labelItemId && item.id !== target.iconItemId,
          );

          return {
            ...project,
            items: nextItems,
            venn: {
              ...project.venn,
              services: nextServices,
            },
          };
        }

        if (project.type === 'quadrant' && project.quadrant) {
          const target = project.quadrant.services.find((service) => service.id === serviceId);
          if (!target) {
            return project;
          }

          const nextServices = project.quadrant.services.filter((service) => service.id !== serviceId);
          const nextItems = project.items.filter(
            (item) => item.id !== target.labelItemId && item.id !== target.iconItemId,
          );

          return {
            ...project,
            items: nextItems,
            quadrant: {
              ...project.quadrant,
              services: nextServices,
            },
          };
        }

        return project;
      });

      setStatusMessage('서비스 항목을 삭제했습니다.');
    },
    [replaceCurrentProject],
  );

  const updateQuadrantAxis = useCallback(
    (axis: 'x-left' | 'x-right' | 'y-top' | 'y-bottom', value: string) => {
      replaceCurrentProject((project) => {
        if (project.type !== 'quadrant' || !project.quadrant) {
          return project;
        }

        if (axis === 'x-left') {
          return {
            ...project,
            quadrant: {
              ...project.quadrant,
              xAxisLeftName: value,
            },
          };
        }

        if (axis === 'x-right') {
          return {
            ...project,
            quadrant: {
              ...project.quadrant,
              xAxisRightName: value,
            },
          };
        }

        if (axis === 'y-top') {
          return {
            ...project,
            quadrant: {
              ...project.quadrant,
              yAxisTopName: value,
            },
          };
        }

        return {
          ...project,
          quadrant: {
            ...project.quadrant,
            yAxisBottomName: value,
          },
        };
      });
    },
    [replaceCurrentProject],
  );

  const updateQuadrantHeader = useCallback(
    (field: 'title' | 'subtitle', value: string) => {
      replaceCurrentProject((project) => {
        if (project.type !== 'quadrant' || !project.quadrant) {
          return project;
        }

        if (field === 'title') {
          return {
            ...project,
            quadrant: {
              ...project.quadrant,
              headerTitle: value,
            },
          };
        }

        return {
          ...project,
          quadrant: {
            ...project.quadrant,
            headerSubtitle: value,
          },
        };
      });
    },
    [replaceCurrentProject],
  );

  const updateVennHeader = useCallback(
    (field: 'title' | 'subtitle', value: string) => {
      replaceCurrentProject((project) => {
        if (project.type !== 'venn' || !project.venn) {
          return project;
        }

        if (field === 'title') {
          return {
            ...project,
            venn: {
              ...project.venn,
              headerTitle: value,
            },
          };
        }

        return {
          ...project,
          venn: {
            ...project.venn,
            headerSubtitle: value,
          },
        };
      });
    },
    [replaceCurrentProject],
  );

  const swapQuadrantAxes = useCallback(() => {
    replaceCurrentProject((project) => {
      if (project.type !== 'quadrant' || !project.quadrant) {
        return project;
      }

      const labels = getQuadrantAxisLabels(project.quadrant);

      return {
        ...project,
        quadrant: {
          ...project.quadrant,
          xAxisLeftName: labels.yBottom,
          xAxisRightName: labels.yTop,
          yAxisTopName: labels.xRight,
          yAxisBottomName: labels.xLeft,
        },
      };
    });

    setStatusMessage('가로 X축과 세로 Y축 라벨을 서로 교체했습니다.');
  }, [replaceCurrentProject]);

  if (scene === 'home') {
    return (
      <div className="page-shell">
        <div className="hero-panel">
          <p className="eyebrow">Business Diagram Studio</p>
          <h1>벤다이어그램/경쟁 포지셔닝 차트를 정보 입력만으로 제작하세요.</h1>
          <p>
            프로젝트를 선택하면 바로 편집을 이어갈 수 있고, 신규 프로젝트에서는 Venn Diagram 또는 Competitive
            Quadrant Chart를 즉시 시작할 수 있습니다.
          </p>
          <Button className="primary-btn" onClick={() => setScene('new')}>
            신규 프로젝트 시작
          </Button>
        </div>

        <section className="project-list-panel">
          <div className="panel-title-row">
            <h2>기존 프로젝트</h2>
            <span>{projects.length}개</span>
          </div>

          {projects.length === 0 ? (
            <div className="empty-box">
              아직 생성된 프로젝트가 없습니다.<br />
              <Button className="ghost-btn" variant="outline" onClick={() => setScene('new')}>
                첫 프로젝트 만들기
              </Button>
            </div>
          ) : (
            <div className="project-grid">
              {projects.map((project) => (
                <article className="project-card" key={project.id}>
                  <div>
                    <p className="project-type">{project.type === 'venn' ? 'Venn Diagram' : 'Competitive Quadrant'}</p>
                    <h3>{project.name}</h3>
                    <p className="project-date">
                      수정일 {new Date(project.updatedAt).toLocaleString('ko-KR', { hour12: false })}
                    </p>
                  </div>
                  <div className="project-card-actions">
                    <Button className="primary-btn" onClick={() => openProject(project.id)}>
                      열기
                    </Button>
                    <Button className="danger-btn" variant="destructive" onClick={() => handleDeleteProject(project.id)}>
                      삭제
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  if (scene === 'new') {
    return (
      <div className="page-shell">
        <section className="create-panel">
          <p className="eyebrow">New Project</p>
          <h1>새로운 다이어그램 프로젝트 생성</h1>
          <p>프로젝트 이름을 입력하고 차트 타입을 선택해 주세요.</p>

          <Label className="field-label" htmlFor="project-name-input">프로젝트 이름</Label>
          <Input
            id="project-name-input"
            className="text-input"
            value={newProjectName}
            onChange={(event) => setNewProjectName(event.target.value)}
            placeholder={getNextProjectName(projects)}
          />

          <div className="type-grid">
            <Button
              className={`type-card ${newProjectType === 'venn' ? 'active' : ''}`}
              variant="outline"
              onClick={() => setNewProjectType('venn')}
            >
              <strong>Venn Diagram</strong>
              <span>집합 이름/아이콘 + 서비스 이름/아이콘 배치</span>
            </Button>

            <Button
              className={`type-card ${newProjectType === 'quadrant' ? 'active' : ''}`}
              variant="outline"
              onClick={() => setNewProjectType('quadrant')}
            >
              <strong>Competitive Quadrant</strong>
              <span>x/y축 이름 + 서비스 이름/아이콘 배치</span>
            </Button>
          </div>

          <div className="create-actions">
            <Button className="ghost-btn" variant="outline" onClick={() => setScene('home')}>
              메인으로
            </Button>
            <Button className="primary-btn" onClick={handleCreateProject}>
              프로젝트 생성
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (!currentProject) {
    return (
      <div className="page-shell">
        <section className="create-panel">
          <h1>선택된 프로젝트가 없습니다.</h1>
          <p>메인으로 이동해 프로젝트를 선택해 주세요.</p>
          <Button className="primary-btn" onClick={() => setScene('home')}>
            메인으로 이동
          </Button>
        </section>
      </div>
    );
  }

  return (
    <div className="editor-shell">
      <header className="editor-header">
        <div className="header-left">
          <Button className="ghost-btn" variant="outline" onClick={() => setScene('home')}>
            메인
          </Button>
          <Input
            className="project-name-input"
            value={currentProject.name}
            onChange={(event) => {
              const nextValue = event.target.value;
              replaceCurrentProject((project) => ({
                ...project,
                name: nextValue,
              }));
            }}
          />
          <span className="type-chip">
            {currentProject.type === 'venn' ? 'Venn Diagram' : 'Competitive Quadrant'}
          </span>
        </div>
        <div className="header-right">
          <Button className="ghost-btn" variant="outline" onClick={() => setScene('new')}>
            신규
          </Button>
        </div>
      </header>

      <main className="editor-main">
        <aside className="inspector-panel">
          <section className="inspector-section">
            <h3>캔버스 첨부</h3>
            <div className="inline-actions">
              <Button className="primary-btn" onClick={startTextBoxPlacement}>
                {isPlacingTextBox ? '텍스트박스 위치 선택 중' : '텍스트박스 추가'}
              </Button>
              <label className="file-btn">
                이미지 여러개 첨부
                <input type="file" accept="image/*" multiple onChange={handleAttachImages} />
              </label>
            </div>
          </section>

          {selectedItem ? (
            <section className="inspector-section">
              <div className="panel-title-row">
                <h3>선택 요소 편집</h3>
                <Button className="danger-btn" variant="destructive" onClick={() => removeItem(selectedItem.id)}>
                  삭제
                </Button>
              </div>

              {selectedItem.type === 'text' ? (
                <>
                  <Label className="field-label" htmlFor="selected-text-content">텍스트</Label>
                  <Textarea
                    id="selected-text-content"
                    className="text-area"
                    value={selectedItem.text}
                    onChange={(event) => {
                      updateItem(selectedItem.id, (item) =>
                        item.type === 'text' ? { ...item, text: event.target.value } : item,
                      );
                    }}
                  />

                  <div className="field-grid-two">
                    <div>
                      <Label className="field-label" htmlFor="selected-text-size">폰트 크기</Label>
                      <Input
                        id="selected-text-size"
                        className="number-input"
                        type="number"
                        min={12}
                        max={120}
                        value={selectedItem.fontSize}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (!Number.isFinite(value)) {
                            return;
                          }

                          updateItem(selectedItem.id, (item) =>
                            item.type === 'text' ? { ...item, fontSize: clamp(value, 12, 120) } : item,
                          );
                        }}
                      />
                    </div>

                    <div>
                      <Label className="field-label" htmlFor="selected-text-color">텍스트 색상</Label>
                      <input
                        id="selected-text-color"
                        className="color-input"
                        type="color"
                        value={selectedItem.color}
                        onChange={(event) => {
                          updateItem(selectedItem.id, (item) =>
                            item.type === 'text' ? { ...item, color: event.target.value } : item,
                          );
                        }}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <Label className="field-label" htmlFor="selected-image-alt">이미지 이름/대체 텍스트</Label>
                  <Input
                    id="selected-image-alt"
                    className="text-input"
                    value={selectedItem.alt}
                    onChange={(event) => {
                      updateItem(selectedItem.id, (item) =>
                        item.type === 'image' ? { ...item, alt: event.target.value } : item,
                      );
                    }}
                  />
                </>
              )}

              <div className="field-grid-two">
                <div>
                  <Label className="field-label" htmlFor="selected-item-x">X</Label>
                  <Input
                    id="selected-item-x"
                    className="number-input"
                    type="number"
                    value={Math.round(selectedItem.x)}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) {
                        return;
                      }
                      updateItem(selectedItem.id, (item) => ({
                        ...item,
                        x: clamp(value, 0, CANVAS_WIDTH - item.width),
                      }));
                    }}
                  />
                </div>

                <div>
                  <Label className="field-label" htmlFor="selected-item-y">Y</Label>
                  <Input
                    id="selected-item-y"
                    className="number-input"
                    type="number"
                    value={Math.round(selectedItem.y)}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) {
                        return;
                      }
                      updateItem(selectedItem.id, (item) => ({
                        ...item,
                        y: clamp(value, 0, CANVAS_HEIGHT - item.height),
                      }));
                    }}
                  />
                </div>
              </div>

              <div className="field-grid-two">
                <div>
                  <Label className="field-label" htmlFor="selected-item-width">너비</Label>
                  <Input
                    id="selected-item-width"
                    className="number-input"
                    type="number"
                    value={Math.round(selectedItem.width)}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) {
                        return;
                      }

                      updateItem(selectedItem.id, (item) => ({
                        ...item,
                        width: clamp(value, item.type === 'text' ? TEXT_ITEM_MIN_WIDTH : 48, CANVAS_WIDTH - item.x),
                      }));
                    }}
                  />
                </div>

                <div>
                  <Label className="field-label" htmlFor="selected-item-height">높이</Label>
                  <Input
                    id="selected-item-height"
                    className="number-input"
                    type="number"
                    value={Math.round(selectedItem.height)}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (!Number.isFinite(value)) {
                        return;
                      }

                      updateItem(selectedItem.id, (item) => ({
                        ...item,
                        height: clamp(value, item.type === 'text' ? TEXT_ITEM_MIN_HEIGHT : 48, CANVAS_HEIGHT - item.y),
                      }));
                    }}
                  />
                </div>
              </div>
            </section>
          ) : null}

          {currentProject.type === 'venn' && currentProject.venn ? (
            <>
              <section className="inspector-section">
                <h3>상단 텍스트</h3>
                <Label className="field-label" htmlFor="venn-header-title">차트 타이틀</Label>
                <Input
                  id="venn-header-title"
                  className="text-input"
                  value={vennHeaderTexts?.title ?? ''}
                  onChange={(event) => updateVennHeader('title', event.target.value)}
                />

                <Label className="field-label" htmlFor="venn-header-subtitle">차트 설명</Label>
                <Textarea
                  id="venn-header-subtitle"
                  className="text-area"
                  value={vennHeaderTexts?.subtitle ?? ''}
                  onChange={(event) => updateVennHeader('subtitle', event.target.value)}
                />
                <p className="hint-text">값을 비우면 해당 상단 텍스트는 캔버스에서 숨겨집니다.</p>
              </section>

              <section className="inspector-section">
                <div className="panel-title-row">
                  <h3>집합 정보</h3>
                  <Button className="primary-btn" onClick={addVennSet}>집합 추가</Button>
                </div>
                <p className="hint-text">
                  현재 {currentProject.venn?.sets.length ?? 0}개 / 최대 {VENN_LAYOUT_SLOTS.length}개
                </p>
                {currentProject.venn.sets.map((setItem, index) => (
                  <article className="row-card" key={setItem.id}>
                    <Label className="field-label" htmlFor={`set-name-${setItem.id}`}>
                      집합 {index + 1} 이름
                    </Label>
                    <Input
                      id={`set-name-${setItem.id}`}
                      className="text-input"
                      value={setItem.name}
                      onChange={(event) => updateVennSetName(setItem.id, event.target.value)}
                      placeholder={`집합 ${index + 1}`}
                    />

                    <label className="file-btn">
                      집합 아이콘/이미지 업로드
                      <input type="file" accept="image/*" onChange={(event) => void uploadVennSetIcon(setItem.id, event)} />
                    </label>

                    {setItem.iconItemId ? (
                      <Button className="danger-btn" variant="destructive" onClick={() => removeVennSetIcon(setItem.id)}>
                        집합 아이콘 제거
                      </Button>
                    ) : null}

                    <Button
                      className="danger-btn"
                      variant="destructive"
                      disabled={(currentProject.venn?.sets.length ?? 0) <= 1}
                      onClick={() => removeVennSet(setItem.id)}
                    >
                      집합 삭제
                    </Button>
                  </article>
                ))}
              </section>

              <section className="inspector-section">
                <div className="panel-title-row">
                  <h3>서비스 정보</h3>
                  <Button className="primary-btn" onClick={addService}>서비스 추가</Button>
                </div>

                {currentServices.length === 0 ? <p className="hint-text">서비스를 추가해서 원 안/밖에 배치해 주세요.</p> : null}

                {currentServices.map((service) => (
                  <article className="row-card" key={service.id}>
                    <Label className="field-label" htmlFor={`service-name-${service.id}`}>서비스 이름</Label>
                    <Input
                      id={`service-name-${service.id}`}
                      className="text-input"
                      value={service.name}
                      onChange={(event) => updateServiceName(service.id, event.target.value)}
                    />

                    <label className="file-btn">
                      서비스 아이콘/이미지 업로드
                      <input type="file" accept="image/*" onChange={(event) => void uploadServiceIcon(service.id, event)} />
                    </label>

                    <div className="inline-actions">
                      {service.iconItemId ? (
                        <Button className="ghost-btn" variant="outline" onClick={() => removeServiceIcon(service.id)}>
                          아이콘 제거
                        </Button>
                      ) : null}
                      <Button className="danger-btn" variant="destructive" onClick={() => removeService(service.id)}>
                        서비스 삭제
                      </Button>
                    </div>
                  </article>
                ))}
              </section>
            </>
          ) : null}

          {currentProject.type === 'quadrant' && currentProject.quadrant ? (
            <>
              <section className="inspector-section">
                <h3>상단 텍스트</h3>
                <Label className="field-label" htmlFor="quadrant-header-title">차트 타이틀</Label>
                <Input
                  id="quadrant-header-title"
                  className="text-input"
                  value={quadrantHeaderTexts?.title ?? ''}
                  onChange={(event) => updateQuadrantHeader('title', event.target.value)}
                />

                <Label className="field-label" htmlFor="quadrant-header-subtitle">차트 설명</Label>
                <Textarea
                  id="quadrant-header-subtitle"
                  className="text-area"
                  value={quadrantHeaderTexts?.subtitle ?? ''}
                  onChange={(event) => updateQuadrantHeader('subtitle', event.target.value)}
                />
              </section>

              <section className="inspector-section">
                <div className="panel-title-row">
                  <h3>축 정보</h3>
                  <Button className="ghost-btn" variant="outline" onClick={swapQuadrantAxes}>
                    X/Y 축 교체
                  </Button>
                </div>
                <p className="hint-text">가로는 X축, 세로는 Y축으로 고정됩니다.</p>
                <Label className="field-label" htmlFor="axis-x-left-name">가로 X축(왼쪽) 이름</Label>
                <Input
                  id="axis-x-left-name"
                  className="text-input"
                  value={quadrantAxisLabels?.xLeft ?? ''}
                  onChange={(event) => updateQuadrantAxis('x-left', event.target.value)}
                />

                <Label className="field-label" htmlFor="axis-x-right-name">가로 X축(오른쪽) 이름</Label>
                <Input
                  id="axis-x-right-name"
                  className="text-input"
                  value={quadrantAxisLabels?.xRight ?? ''}
                  onChange={(event) => updateQuadrantAxis('x-right', event.target.value)}
                />

                <Label className="field-label" htmlFor="axis-y-top-name">세로 Y축(위) 이름</Label>
                <Input
                  id="axis-y-top-name"
                  className="text-input"
                  value={quadrantAxisLabels?.yTop ?? ''}
                  onChange={(event) => updateQuadrantAxis('y-top', event.target.value)}
                />

                <Label className="field-label" htmlFor="axis-y-bottom-name">세로 Y축(아래) 이름</Label>
                <Input
                  id="axis-y-bottom-name"
                  className="text-input"
                  value={quadrantAxisLabels?.yBottom ?? ''}
                  onChange={(event) => updateQuadrantAxis('y-bottom', event.target.value)}
                />
              </section>

              <section className="inspector-section">
                <div className="panel-title-row">
                  <h3>서비스 정보</h3>
                  <Button className="primary-btn" onClick={addService}>서비스 추가</Button>
                </div>

                {currentServices.length === 0 ? (
                  <p className="hint-text">서비스를 추가하고 각 사분면으로 드래그해 배치해 주세요.</p>
                ) : null}

                {currentServices.map((service) => (
                  <article className="row-card" key={service.id}>
                    <Label className="field-label" htmlFor={`service-name-${service.id}`}>서비스 이름</Label>
                    <Input
                      id={`service-name-${service.id}`}
                      className="text-input"
                      value={service.name}
                      onChange={(event) => updateServiceName(service.id, event.target.value)}
                    />

                    <label className="file-btn">
                      서비스 아이콘/이미지 업로드
                      <input type="file" accept="image/*" onChange={(event) => void uploadServiceIcon(service.id, event)} />
                    </label>

                    <div className="inline-actions">
                      {service.iconItemId ? (
                        <Button className="ghost-btn" variant="outline" onClick={() => removeServiceIcon(service.id)}>
                          아이콘 제거
                        </Button>
                      ) : null}
                      <Button className="danger-btn" variant="destructive" onClick={() => removeService(service.id)}>
                        서비스 삭제
                      </Button>
                    </div>
                  </article>
                ))}
              </section>
            </>
          ) : null}

          <section className="inspector-section">
            <h3>상태</h3>
            <p className="status-text">{statusMessage}</p>
            <p className="hint-text">
              {isPlacingTextBox
                ? '현재 텍스트박스 배치 모드입니다. 캔버스를 클릭해 원하는 위치에 추가하세요.'
                : '요소를 클릭해 이동/리사이즈하고, Quadrant 캔버스에 이미지 파일을 드롭해 추가할 수 있습니다.'}
            </p>
          </section>
        </aside>

        <section className="canvas-panel" ref={canvasViewportRef}>
          <div className="canvas-stage" style={{ width: CANVAS_WIDTH * canvasScale, height: CANVAS_HEIGHT * canvasScale }}>
            <div
              className={`canvas-board ${
                isCanvasDropActive && currentProject.type === 'quadrant' ? 'drop-active' : ''
              }`}
              style={{
                width: CANVAS_WIDTH,
                height: CANVAS_HEIGHT,
                transform: `scale(${canvasScale})`,
                transformOrigin: 'top left',
              }}
              onPointerDown={handleCanvasPointerDown}
              onDragEnter={handleCanvasDragEnter}
              onDragOver={handleCanvasDragOver}
              onDragLeave={handleCanvasDragLeave}
              onDrop={(event) => void handleCanvasDrop(event)}
            >
              {currentProject.type === 'venn' ? (
                <VennBackdrop
                  sets={currentProject.venn?.sets ?? []}
                  headerTitle={vennHeaderTexts?.title ?? 'Venn Diagram Canvas'}
                  headerSubtitle={vennHeaderTexts?.subtitle ?? '서비스 라벨/아이콘을 드래그해서 교집합 위치로 배치하세요.'}
                  selectedSetId={selectedVennSetId}
                  onSetPointerDown={(event, setId) => beginVennSetInteraction(event, setId, 'move')}
                />
              ) : (
                <QuadrantBackdrop
                  xAxisLeftName={quadrantAxisLabels?.xLeft ?? 'X 축'}
                  xAxisRightName={quadrantAxisLabels?.xRight ?? ''}
                  yAxisTopName={quadrantAxisLabels?.yTop ?? 'Y 축'}
                  yAxisBottomName={quadrantAxisLabels?.yBottom ?? ''}
                  headerTitle={quadrantHeaderTexts?.title ?? 'Competitive Quadrant Canvas'}
                  headerSubtitle={quadrantHeaderTexts?.subtitle ?? '서비스 라벨/아이콘을 사분면에 배치해 경쟁 포지셔닝을 비교하세요.'}
                />
              )}

              {currentProject.type === 'venn' && selectedVennSetLayout ? (
                <div
                  className="venn-set-outline"
                  style={{
                    left: selectedVennSetLayout.layout.cx - selectedVennSetLayout.layout.radius,
                    top: selectedVennSetLayout.layout.cy - selectedVennSetLayout.layout.radius,
                    width: selectedVennSetLayout.layout.radius * 2,
                    height: selectedVennSetLayout.layout.radius * 2,
                  }}
                >
                  <Button
                    className="venn-set-delete-btn"
                    variant="destructive"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      removeVennSet(selectedVennSetLayout.setItem.id);
                    }}
                    disabled={(currentProject.venn?.sets.length ?? 0) <= 1}
                  >
                    집합 삭제
                  </Button>

                  <div
                    className="venn-set-resize-handle"
                    onPointerDown={(event) => beginVennSetInteraction(event, selectedVennSetLayout.setItem.id, 'resize')}
                  />
                </div>
              ) : null}

              {currentProject.items.map((item, index) => (
                <div
                  key={item.id}
                  className={`canvas-item ${selectedItemId === item.id ? 'selected' : ''}`}
                  style={{
                    left: item.x,
                    top: item.y,
                    width: item.width,
                    height: item.height,
                    zIndex: selectedItemId === item.id ? 50 : 10 + index,
                  }}
                  onPointerDown={(event) => beginItemInteraction(event, item, 'move')}
                  onDoubleClick={(event) => {
                    if (item.type !== 'text') {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    setSelectedItemId(item.id);
                    setSelectedVennSetId(null);
                    setIsPlacingTextBox(false);
                    setEditingTextItemId(item.id);
                  }}
                >
                  {item.type === 'text' ? (
                    editingTextItemId === item.id ? (
                      <textarea
                        ref={(node) => {
                          if (editingTextItemId === item.id) {
                            textEditorRef.current = node;
                          }
                        }}
                        className="canvas-text-editor"
                        value={item.text}
                        style={{
                          fontSize: item.fontSize,
                          color: item.color,
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          updateItem(item.id, (current) =>
                            current.type === 'text' ? { ...current, text: event.target.value } : current,
                          );
                        }}
                        onBlur={() => {
                          setEditingTextItemId((previous) => (previous === item.id ? null : previous));
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
                            event.preventDefault();
                            event.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <div
                        className="item-text"
                        style={{
                          fontSize: item.fontSize,
                          color: item.color,
                        }}
                      >
                        {item.text || '텍스트'}
                      </div>
                    )
                  ) : (
                    <img
                      className="item-image"
                      src={item.src}
                      alt={item.alt}
                      draggable={false}
                      onDragStart={(event) => event.preventDefault()}
                    />
                  )}

                  {selectedItemId === item.id ? (
                    <div
                      className="resize-handle"
                      onPointerDown={(event) => beginItemInteraction(event, item, 'resize')}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function VennBackdrop({
  sets,
  headerTitle,
  headerSubtitle,
  selectedSetId,
  onSetPointerDown,
}: {
  sets: VennSet[];
  headerTitle: string;
  headerSubtitle: string;
  selectedSetId: string | null;
  onSetPointerDown?: (event: ReactPointerEvent<SVGCircleElement>, setId: string) => void;
}) {
  const fillColors = [
    'rgba(249, 115, 22, 0.24)',
    'rgba(59, 130, 246, 0.24)',
    'rgba(16, 185, 129, 0.24)',
    'rgba(217, 70, 239, 0.2)',
    'rgba(234, 179, 8, 0.22)',
    'rgba(20, 184, 166, 0.2)',
  ];
  const strokeColors = ['#ea580c', '#2563eb', '#0f766e', '#c026d3', '#ca8a04', '#0f766e'];
  const safeHeaderTitle = headerTitle ?? '';
  const safeHeaderSubtitle = headerSubtitle ?? '';

  return (
    <svg className="diagram-backdrop" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden="true">
      <defs>
        <linearGradient id="venn-bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#fff7ed" />
          <stop offset="100%" stopColor="#eff6ff" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#venn-bg)" rx="26" />

      {sets.map((setItem, index) => {
        const circle = getVennSetLayout(setItem, index);
        return (
          <g key={setItem.id}>
            <circle
              cx={circle.cx}
              cy={circle.cy}
              r={circle.radius}
              fill={fillColors[index % fillColors.length] ?? 'rgba(71,85,105,0.24)'}
              stroke={selectedSetId === setItem.id ? '#0f172a' : strokeColors[index % strokeColors.length] ?? '#334155'}
              strokeWidth={selectedSetId === setItem.id ? 4 : 2.6}
              className="venn-set-circle"
              onPointerDown={(event) => onSetPointerDown?.(event, setItem.id)}
            />
            <text
              x={circle.cx}
              y={circle.cy + circle.radius + 34}
              textAnchor="middle"
              fill="rgba(15,23,42,0.6)"
              fontSize={18}
              fontWeight={600}
            >
              {setItem.name || `집합 ${index + 1}`}
            </text>
          </g>
        );
      })}

      {safeHeaderTitle ? (
        <text x={CANVAS_WIDTH / 2} y={54} textAnchor="middle" fill="#0f172a" fontSize={28} fontWeight={700}>
          {safeHeaderTitle}
        </text>
      ) : null}
      {safeHeaderSubtitle ? (
        <text x={CANVAS_WIDTH / 2} y={84} textAnchor="middle" fill="rgba(15,23,42,0.68)" fontSize={16}>
          {safeHeaderSubtitle}
        </text>
      ) : null}
    </svg>
  );
}

function QuadrantBackdrop({
  xAxisLeftName,
  xAxisRightName,
  yAxisTopName,
  yAxisBottomName,
  headerTitle,
  headerSubtitle,
}: {
  xAxisLeftName: string;
  xAxisRightName: string;
  yAxisTopName: string;
  yAxisBottomName: string;
  headerTitle: string;
  headerSubtitle: string;
}) {
  const safeXLeft = xAxisLeftName || 'X 축';
  const safeXRight = xAxisRightName || '';
  const safeYTop = yAxisTopName || 'Y 축';
  const safeYBottom = yAxisBottomName || '';
  const safeHeaderTitle = headerTitle ?? '';
  const safeHeaderSubtitle = headerSubtitle ?? '';
  const centerX = CANVAS_WIDTH / 2;
  const centerY = CANVAS_HEIGHT / 2;
  const plotLeft = 84;
  const plotRight = CANVAS_WIDTH - 84;
  const plotTop = 116;
  const plotBottom = CANVAS_HEIGHT - 84;
  const xLeftOutsideX = 46;
  const xRightOutsideX = CANVAS_WIDTH - 46;
  const headerTitleY = 22;
  const headerSubtitleY = 44;
  const yTopAxisLabelY = 86;
  const yBottomAxisLabelY = CANVAS_HEIGHT - 22;

  return (
    <svg className="diagram-backdrop" viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} aria-hidden="true">
      <defs>
        <linearGradient id="quad-bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#f0fdfa" />
          <stop offset="100%" stopColor="#fff7ed" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={CANVAS_WIDTH} height={CANVAS_HEIGHT} fill="url(#quad-bg)" rx="26" />
      <line x1={centerX} y1={plotTop} x2={centerX} y2={plotBottom} stroke="#0f766e" strokeWidth={2.5} />
      <line x1={plotLeft} y1={centerY} x2={plotRight} y2={centerY} stroke="#0f766e" strokeWidth={2.5} />

      <text
        x={xLeftOutsideX}
        y={centerY}
        textAnchor="middle"
        dominantBaseline="middle"
        transform={`rotate(-90 ${xLeftOutsideX} ${centerY})`}
        fill="#0f172a"
        fontSize={18}
        fontWeight={700}
      >
        {safeXLeft}
      </text>

      {safeXRight ? (
        <text
          x={xRightOutsideX}
          y={centerY}
          textAnchor="middle"
          dominantBaseline="middle"
          transform={`rotate(90 ${xRightOutsideX} ${centerY})`}
          fill="#0f172a"
          fontSize={18}
          fontWeight={700}
        >
          {safeXRight}
        </text>
      ) : null}

      <text x={centerX} y={yTopAxisLabelY} textAnchor="middle" fill="#0f172a" fontSize={18} fontWeight={700}>
        {safeYTop}
      </text>

      {safeYBottom ? (
        <text x={centerX} y={yBottomAxisLabelY} textAnchor="middle" fill="#0f172a" fontSize={18} fontWeight={700}>
          {safeYBottom}
        </text>
      ) : null}

      {safeHeaderTitle ? (
        <text x={CANVAS_WIDTH / 2} y={headerTitleY} textAnchor="middle" fill="#0f172a" fontSize={28} fontWeight={700}>
          {safeHeaderTitle}
        </text>
      ) : null}
      {safeHeaderSubtitle ? (
        <text x={CANVAS_WIDTH / 2} y={headerSubtitleY} textAnchor="middle" fill="rgba(15,23,42,0.68)" fontSize={16}>
          {safeHeaderSubtitle}
        </text>
      ) : null}

    </svg>
  );
}

export default App;
