import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Download,
  FileImage,
  FileOutput,
  FileText,
  GripVertical,
  ImagePlus,
  Info,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import heic2any from 'heic2any';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = pdfWorker;

type Mode = 'images' | 'pdf';
type PageSize = 'a4' | 'letter' | 'original';
type Orientation = 'auto' | 'portrait' | 'landscape';
type Margin = 0 | 24 | 48;
type ImageFormat = 'png' | 'jpg';
type NoticeKind = 'success' | 'error' | 'info';

interface ImageItem {
  id: string;
  name: string;
  size: number;
  width: number;
  height: number;
  previewUrl: string;
  blob: Blob;
  format: 'png' | 'jpg';
}

interface PdfPagePreview {
  pageNumber: number;
  dataUrl: string;
}

interface PdfSource {
  name: string;
  size: number;
  pageCount: number;
  previews: PdfPagePreview[];
}

interface Notice {
  kind: NoticeKind;
  message: string;
}

const MAX_IMAGE_COUNT = 60;
const MAX_PDF_PAGE_COUNT = 100;
const MAX_RENDER_DIMENSION = 6000;

const IMAGE_ACCEPT = '.jpg,.jpeg,.png,.heic,.heif,image/jpeg,image/png,image/heic,image/heif';
const PDF_ACCEPT = '.pdf,application/pdf';

const PAGE_SIZE_OPTIONS: { id: PageSize; label: string; detail: string }[] = [
  { id: 'a4', label: 'A4', detail: '가장 일반적인 문서' },
  { id: 'letter', label: 'Letter', detail: '북미 표준 용지' },
  { id: 'original', label: '원본 크기', detail: '이미지 비율 그대로' },
];

const MARGIN_OPTIONS: { value: Margin; label: string }[] = [
  { value: 0, label: '없음' },
  { value: 24, label: '보통 · 8 mm' },
  { value: 48, label: '넉넉하게 · 17 mm' },
];

const PDF_SCALE_OPTIONS: { value: number; label: string; detail: string }[] = [
  { value: 1.5, label: '표준', detail: '1.5×' },
  { value: 2, label: '고화질', detail: '2×' },
  { value: 3, label: '최고 화질', detail: '3×' },
];

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileStem(fileName: string) {
  return fileName
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9가-힣-_]+/gi, '-')
    .replace(/^-+|-+$/g, '') || 'document';
}

function isHeicFile(file: File) {
  return file.type === 'image/heic'
    || file.type === 'image/heif'
    || /\.(heic|heif)$/i.test(file.name);
}

function isSupportedImage(file: File) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|heic|heif)$/i.test(file.name);
}

function isPdfFile(file: File) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function getImageFormat(file: File): 'png' | 'jpg' {
  return file.type === 'image/png' || /\.png$/i.test(file.name) ? 'png' : 'jpg';
}

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지 디코딩에 실패했습니다.'));
    image.src = url;
  });
}

async function decodeImage(blob: Blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Fall back to the browser image decoder for browsers without HEIC bitmap support.
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    return await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('이미지를 변환하지 못했습니다.'));
      }
    }, type, quality);
  });
}

async function normalizeImage(file: File): Promise<ImageItem> {
  let sourceBlob: Blob = file;

  if (isHeicFile(file)) {
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    sourceBlob = Array.isArray(converted) ? converted[0]! : converted;
  }

  const decoded = await decodeImage(sourceBlob);
  const width = 'naturalWidth' in decoded ? decoded.naturalWidth : decoded.width;
  const height = 'naturalHeight' in decoded ? decoded.naturalHeight : decoded.height;

  if (!width || !height) {
    if ('close' in decoded) {
      decoded.close();
    }
    throw new Error('이미지 크기를 확인하지 못했습니다.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');

  if (!context) {
    if ('close' in decoded) {
      decoded.close();
    }
    throw new Error('이미지 캔버스를 만들지 못했습니다.');
  }

  context.drawImage(decoded, 0, 0, width, height);
  if ('close' in decoded) {
    decoded.close();
  }

  const format = getImageFormat(file);
  const blob = await canvasToBlob(canvas, format === 'png' ? 'image/png' : 'image/jpeg', 0.92);

  return {
    id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
    name: file.name,
    size: file.size,
    width,
    height,
    previewUrl: URL.createObjectURL(blob),
    blob,
    format,
  };
}

function getPageSize(item: ImageItem, pageSize: PageSize, orientation: Orientation, margin: Margin) {
  if (pageSize === 'original') {
    return {
      width: (item.width * 72) / 96 + margin * 2,
      height: (item.height * 72) / 96 + margin * 2,
    };
  }

  const base = pageSize === 'a4'
    ? { width: 595.28, height: 841.89 }
    : { width: 612, height: 792 };
  const imageIsLandscape = item.width > item.height;
  const useLandscape = orientation === 'landscape' || (orientation === 'auto' && imageIsLandscape);

  return useLandscape
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

async function createPdfFromImages(items: ImageItem[], pageSize: PageSize, orientation: Orientation, margin: Margin) {
  const pdf = await PDFDocument.create();

  for (const item of items) {
    const bytes = new Uint8Array(await item.blob.arrayBuffer());
    const embeddedImage = item.format === 'png'
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);
    const pageDimensions = getPageSize(item, pageSize, orientation, margin);
    const availableWidth = Math.max(1, pageDimensions.width - margin * 2);
    const availableHeight = Math.max(1, pageDimensions.height - margin * 2);
    const scale = Math.min(availableWidth / embeddedImage.width, availableHeight / embeddedImage.height);
    const drawWidth = embeddedImage.width * scale;
    const drawHeight = embeddedImage.height * scale;
    const page = pdf.addPage([pageDimensions.width, pageDimensions.height]);

    page.drawImage(embeddedImage, {
      x: (pageDimensions.width - drawWidth) / 2,
      y: (pageDimensions.height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return pdf.save();
}

async function renderPdfPageToDataUrl(pdf: PDFDocumentProxy, pageNumber: number) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(0.55, 240 / baseViewport.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d');

  if (!context) {
    page.cleanup();
    throw new Error('PDF 미리보기 캔버스를 만들지 못했습니다.');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas, canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function renderPdfPageToBlob(pdf: PDFDocumentProxy, pageNumber: number, requestedScale: number, format: ImageFormat) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const largestDimension = Math.max(baseViewport.width, baseViewport.height);
  const scale = Math.min(requestedScale, MAX_RENDER_DIMENSION / largestDimension);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const context = canvas.getContext('2d');

  if (!context) {
    page.cleanup();
    throw new Error('PDF 페이지를 렌더링할 캔버스를 만들지 못했습니다.');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas, canvasContext: context, viewport }).promise;
  page.cleanup();
  return canvasToBlob(canvas, format === 'png' ? 'image/png' : 'image/jpeg', format === 'jpg' ? 0.92 : undefined);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function App() {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const imageItemsRef = useRef<ImageItem[]>([]);
  const pdfLoadIdRef = useRef(0);

  const [mode, setMode] = useState<Mode>('images');
  const [imageItems, setImageItems] = useState<ImageItem[]>([]);
  const [pageSize, setPageSize] = useState<PageSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('auto');
  const [margin, setMargin] = useState<Margin>(24);
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null);
  const [isImageDropActive, setIsImageDropActive] = useState(false);
  const [isPdfDropActive, setIsPdfDropActive] = useState(false);
  const [isImageBusy, setIsImageBusy] = useState(false);
  const [imageProgress, setImageProgress] = useState({ current: 0, total: 0 });
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [isPdfBusy, setIsPdfBusy] = useState(false);
  const [pdfProgress, setPdfProgress] = useState({ current: 0, total: 0 });
  const [pdfFormat, setPdfFormat] = useState<ImageFormat>('png');
  const [pdfScale, setPdfScale] = useState(2);
  const [isExporting, setIsExporting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    imageItemsRef.current = imageItems;
  }, [imageItems]);

  useEffect(() => () => {
    imageItemsRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    if (pdfRef.current) {
      void pdfRef.current.destroy();
    }
  }, []);

  const setError = useCallback((message: string) => {
    setNotice({ kind: 'error', message });
  }, []);

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(isSupportedImage);
    if (imageFiles.length === 0) {
      setError('JPG, PNG, HEIC 또는 HEIF 이미지를 선택해주세요.');
      return;
    }

    const remainingSlots = MAX_IMAGE_COUNT - imageItemsRef.current.length;
    if (remainingSlots <= 0) {
      setError(`이미지는 한 번에 최대 ${MAX_IMAGE_COUNT}장까지 추가할 수 있습니다.`);
      return;
    }

    const filesToProcess = imageFiles.slice(0, remainingSlots);
    if (filesToProcess.length < imageFiles.length) {
      setError(`이미지는 한 번에 최대 ${MAX_IMAGE_COUNT}장까지 추가할 수 있어 일부 파일만 추가합니다.`);
    } else {
      setNotice(null);
    }

    setIsImageBusy(true);
    setImageProgress({ current: 0, total: filesToProcess.length });

    for (const [index, file] of filesToProcess.entries()) {
      try {
        const item = await normalizeImage(file);
        setImageItems((current) => [...current, item]);
      } catch {
        setError(`${file.name}을(를) 읽지 못했습니다. HEIC 파일은 브라우저에서 지원되지 않을 수 있습니다.`);
      } finally {
        setImageProgress({ current: index + 1, total: filesToProcess.length });
      }
    }

    setIsImageBusy(false);
  }, [setError]);

  const resetImages = useCallback(() => {
    setImageItems((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
    if (imageInputRef.current) {
      imageInputRef.current.value = '';
    }
    setNotice(null);
  }, []);

  const removeImage = useCallback((id: string) => {
    setImageItems((current) => {
      const item = current.find((candidate) => candidate.id === id);
      if (item) {
        URL.revokeObjectURL(item.previewUrl);
      }
      return current.filter((candidate) => candidate.id !== id);
    });
  }, []);

  const moveImage = useCallback((id: string, direction: -1 | 1) => {
    setImageItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) {
        next.splice(targetIndex, 0, moved);
      }
      return next;
    });
  }, []);

  const handleImageDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsImageDropActive(false);
    void addImageFiles(Array.from(event.dataTransfer.files));
  }, [addImageFiles]);

  const handleImageInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    void addImageFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  }, [addImageFiles]);

  const reorderByDrop = useCallback((targetId: string) => {
    if (!draggedImageId || draggedImageId === targetId) {
      return;
    }
    setImageItems((current) => {
      const fromIndex = current.findIndex((item) => item.id === draggedImageId);
      const targetIndex = current.findIndex((item) => item.id === targetId);
      if (fromIndex < 0 || targetIndex < 0) {
        return current;
      }
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (moved) {
        next.splice(targetIndex, 0, moved);
      }
      return next;
    });
    setDraggedImageId(null);
  }, [draggedImageId]);

  const resetPdf = useCallback(() => {
    pdfLoadIdRef.current += 1;
    if (pdfRef.current) {
      void pdfRef.current.destroy();
      pdfRef.current = null;
    }
    setPdfSource(null);
    setIsPdfBusy(false);
    setIsExporting(false);
    setPdfProgress({ current: 0, total: 0 });
    if (pdfInputRef.current) {
      pdfInputRef.current.value = '';
    }
    setNotice(null);
  }, []);

  const loadPdfFile = useCallback(async (file: File) => {
    if (!isPdfFile(file)) {
      setError('PDF 파일만 선택해주세요.');
      return;
    }

    const loadId = pdfLoadIdRef.current + 1;
    pdfLoadIdRef.current = loadId;
    if (pdfRef.current) {
      void pdfRef.current.destroy();
      pdfRef.current = null;
    }
    setPdfSource(null);
    setIsPdfBusy(true);
    setNotice(null);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pdf = await getDocument({ data: bytes }).promise;

      if (loadId !== pdfLoadIdRef.current) {
        void pdf.destroy();
        return;
      }
      if (pdf.numPages > MAX_PDF_PAGE_COUNT) {
        void pdf.destroy();
        throw new Error(`PDF는 최대 ${MAX_PDF_PAGE_COUNT}페이지까지 처리할 수 있습니다.`);
      }

      pdfRef.current = pdf;
      const previews: PdfPagePreview[] = [];
      setPdfProgress({ current: 0, total: pdf.numPages });
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        previews.push({
          pageNumber,
          dataUrl: await renderPdfPageToDataUrl(pdf, pageNumber),
        });
        setPdfProgress({ current: pageNumber, total: pdf.numPages });
      }

      if (loadId !== pdfLoadIdRef.current) {
        return;
      }
      setPdfSource({ name: file.name, size: file.size, pageCount: pdf.numPages, previews });
    } catch (error) {
      if (loadId === pdfLoadIdRef.current) {
        if (pdfRef.current) {
          void pdfRef.current.destroy();
          pdfRef.current = null;
        }
        const message = error instanceof Error ? error.message : 'PDF를 읽지 못했습니다.';
        setError(message.includes('페이지') ? message : 'PDF를 읽지 못했습니다. 파일이 손상되지 않았는지 확인해주세요.');
      }
    } finally {
      if (loadId === pdfLoadIdRef.current) {
        setIsPdfBusy(false);
      }
    }
  }, [setError]);

  const handlePdfInput = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const [file] = Array.from(event.target.files ?? []);
    if (file) {
      void loadPdfFile(file);
    }
    event.target.value = '';
  }, [loadPdfFile]);

  const handlePdfDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsPdfDropActive(false);
    const [file] = Array.from(event.dataTransfer.files);
    if (file) {
      void loadPdfFile(file);
    }
  }, [loadPdfFile]);

  const createPdf = useCallback(async () => {
    if (imageItems.length === 0) {
      return;
    }

    setIsExporting(true);
    setNotice(null);
    try {
      const bytes = await createPdfFromImages(imageItems, pageSize, orientation, margin);
      const name = imageItems.length === 1
        ? `${getFileStem(imageItems[0]!.name)}.pdf`
        : 'image-bundle.pdf';
      const pdfBuffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(pdfBuffer).set(bytes);
      downloadBlob(new Blob([pdfBuffer], { type: 'application/pdf' }), name);
      setNotice({ kind: 'success', message: `${imageItems.length}장의 이미지를 하나의 PDF로 저장했습니다.` });
    } catch {
      setError('PDF를 만드는 중 문제가 발생했습니다. 이미지 크기를 줄인 뒤 다시 시도해주세요.');
    } finally {
      setIsExporting(false);
    }
  }, [imageItems, margin, orientation, pageSize, setError]);

  const exportPdfPages = useCallback(async () => {
    const pdf = pdfRef.current;
    if (!pdf || !pdfSource) {
      return;
    }

    setIsExporting(true);
    setNotice(null);
    setPdfProgress({ current: 0, total: pdfSource.pageCount });

    try {
      const zip = new JSZip();
      const stem = getFileStem(pdfSource.name);
      const extension = pdfFormat === 'png' ? 'png' : 'jpg';

      for (let pageNumber = 1; pageNumber <= pdfSource.pageCount; pageNumber += 1) {
        const blob = await renderPdfPageToBlob(pdf, pageNumber, pdfScale, pdfFormat);
        const fileName = `${stem}-page-${String(pageNumber).padStart(3, '0')}.${extension}`;
        zip.file(fileName, blob);
        setPdfProgress({ current: pageNumber, total: pdfSource.pageCount });
      }

      const archive = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      downloadBlob(archive, `${stem}-images.zip`);
      setNotice({ kind: 'success', message: `${pdfSource.pageCount}개 페이지를 개별 이미지 ZIP으로 저장했습니다.` });
    } catch {
      setError('PDF 페이지를 이미지로 내보내는 중 문제가 발생했습니다.');
    } finally {
      setIsExporting(false);
    }
  }, [pdfFormat, pdfScale, pdfSource, setError]);

  const imageSummary = useMemo(() => {
    if (imageItems.length === 0) {
      return '이미지를 추가하면 순서와 페이지 설정을 정할 수 있습니다.';
    }
    return `${imageItems.length}장 · ${formatBytes(imageItems.reduce((total, item) => total + item.size, 0))}`;
  }, [imageItems]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup" aria-label="pdf-manager">
          <span className="brand-mark"><Layers3 size={17} strokeWidth={2.4} /></span>
          <span className="brand-name">pdf-manager</span>
          <span className="brand-divider" />
          <span className="brand-product">FILE WORKSPACE</span>
        </div>
        <div className="topbar-status">
          <span className="local-chip"><LockKeyhole size={13} /> 기기에서 안전하게 처리</span>
          <button className="help-button" type="button" aria-label="도움말">
            <Info size={16} />
          </button>
        </div>
      </header>

      <main className="page-content">
        <section className="intro-row">
          <div>
            <p className="eyebrow">SIMPLE FILE TOOLS</p>
            <h1>이미지와 PDF,<br /><em>필요한 형태로</em> 정리하세요.</h1>
            <p className="intro-copy">사진 여러 장을 하나의 PDF로 묶거나, 긴 PDF를 페이지별 이미지로 나눌 수 있습니다.</p>
          </div>
          <div className="intro-badge" aria-hidden="true">
            <Sparkles size={16} />
            <span>빠르고 간단하게</span>
          </div>
        </section>

        <nav className="mode-tabs" aria-label="작업 선택">
          <button
            className={mode === 'images' ? 'mode-tab active' : 'mode-tab'}
            type="button"
            onClick={() => setMode('images')}
            aria-selected={mode === 'images'}
          >
            <span className="tab-icon"><ImagePlus size={18} /></span>
            <span>
              <strong>이미지를 PDF로</strong>
              <small>JPG · PNG · HEIC 여러 장 묶기</small>
            </span>
            {mode === 'images' && <Check size={16} className="tab-check" />}
          </button>
          <button
            className={mode === 'pdf' ? 'mode-tab active' : 'mode-tab'}
            type="button"
            onClick={() => setMode('pdf')}
            aria-selected={mode === 'pdf'}
          >
            <span className="tab-icon pdf-tab-icon"><FileOutput size={18} /></span>
            <span>
              <strong>PDF를 이미지로</strong>
              <small>페이지마다 PNG 또는 JPG로 저장</small>
            </span>
            {mode === 'pdf' && <Check size={16} className="tab-check" />}
          </button>
        </nav>

        {notice && (
          <div className={`notice-banner ${notice.kind}`} role="status">
            {notice.kind === 'success' ? <Check size={16} /> : <Info size={16} />}
            <span>{notice.message}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기"><X size={15} /></button>
          </div>
        )}

        {mode === 'images' ? (
          <div className="workspace image-workspace">
            <section className="workspace-main">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">STEP 01 · ADD IMAGES</p>
                  <h2>페이지 순서를 정해보세요.</h2>
                  <p>{imageSummary}</p>
                </div>
                {imageItems.length > 0 && (
                  <button className="text-button" type="button" onClick={resetImages}>
                    <RefreshCw size={14} /> 모두 지우기
                  </button>
                )}
              </div>

              {imageItems.length === 0 ? (
                <button
                  className={`dropzone image-dropzone ${isImageDropActive ? 'is-dragging' : ''}`}
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setIsImageDropActive(true); }}
                  onDragLeave={() => setIsImageDropActive(false)}
                  onDrop={handleImageDrop}
                >
                  <span className="dropzone-icon"><Upload size={23} /></span>
                  <strong>이미지를 여기에 놓으세요.</strong>
                  <span>또는 클릭해서 파일 선택</span>
                  <small>JPG · JPEG · PNG · HEIC · HEIF <i>최대 60장</i></small>
                </button>
              ) : (
                <>
                  <div className="image-grid">
                    {imageItems.map((item, index) => (
                      <article
                        className={`image-card ${draggedImageId === item.id ? 'is-dragging' : ''}`}
                        key={item.id}
                        draggable
                        onDragStart={() => setDraggedImageId(item.id)}
                        onDragEnd={() => setDraggedImageId(null)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => { event.preventDefault(); reorderByDrop(item.id); }}
                      >
                        <div className="image-preview">
                          <img src={item.previewUrl} alt={`${item.name} 미리보기`} />
                          <span className="page-number">{String(index + 1).padStart(2, '0')}</span>
                          <span className="drag-hint"><GripVertical size={15} /></span>
                        </div>
                        <div className="image-card-footer">
                          <div className="image-card-copy">
                            <strong title={item.name}>{item.name}</strong>
                            <span>{item.width} × {item.height} · {formatBytes(item.size)}</span>
                          </div>
                          <div className="card-actions">
                            <button type="button" onClick={() => moveImage(item.id, -1)} disabled={index === 0} aria-label="앞으로 이동"><ArrowUp size={14} /></button>
                            <button type="button" onClick={() => moveImage(item.id, 1)} disabled={index === imageItems.length - 1} aria-label="뒤로 이동"><ArrowDown size={14} /></button>
                            <button type="button" className="delete-action" onClick={() => removeImage(item.id)} aria-label={`${item.name} 삭제`}><Trash2 size={14} /></button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                  <button className="add-more-button" type="button" onClick={() => imageInputRef.current?.click()}>
                    <Plus size={17} /> 이미지 더 추가하기
                  </button>
                </>
              )}

              <input ref={imageInputRef} className="visually-hidden" type="file" accept={IMAGE_ACCEPT} multiple onChange={handleImageInput} />

              {isImageBusy && (
                <ProgressBar label="이미지 준비 중" current={imageProgress.current} total={imageProgress.total} />
              )}

              <div className="privacy-note">
                <ShieldCheck size={17} />
                <span><strong>파일은 브라우저 안에서만 처리됩니다.</strong> 업로드하거나 저장하지 않으니 안심하세요.</span>
              </div>
            </section>

            <aside className="settings-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">STEP 02 · PDF SETTINGS</p>
                  <h2>PDF 설정</h2>
                </div>
                <Settings2 size={19} />
              </div>

              <div className="setting-group">
                <div className="setting-label-row"><label>페이지 크기</label><span>용지</span></div>
                <div className="size-options">
                  {PAGE_SIZE_OPTIONS.map((option) => (
                    <button
                      className={pageSize === option.id ? 'size-option selected' : 'size-option'}
                      type="button"
                      key={option.id}
                      onClick={() => setPageSize(option.id)}
                    >
                      <span className="size-option-check">{pageSize === option.id && <Check size={11} />}</span>
                      <strong>{option.label}</strong>
                      <small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-label-row"><label>방향</label><span>페이지 방향</span></div>
                <div className="segmented-control">
                  {([['auto', '자동'], ['portrait', '세로'], ['landscape', '가로']] as const).map(([value, label]) => (
                    <button className={orientation === value ? 'selected' : ''} type="button" key={value} onClick={() => setOrientation(value)}>{label}</button>
                  ))}
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-label-row"><label htmlFor="margin-select">여백</label><span>이미지 주변 공간</span></div>
                <div className="select-wrap">
                  <select id="margin-select" value={margin} onChange={(event) => setMargin(Number(event.target.value) as Margin)}>
                    {MARGIN_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-summary">
                <div><span>예상 페이지 수</span><strong>{imageItems.length || '—'} {imageItems.length ? '페이지' : ''}</strong></div>
                <div><span>출력 방식</span><strong>이미지당 1페이지</strong></div>
              </div>

              <button className="primary-action" type="button" onClick={() => void createPdf()} disabled={imageItems.length === 0 || isImageBusy || isExporting}>
                {isExporting ? <LoaderCircle className="spin" size={18} /> : <Download size={18} />}
                {isExporting ? 'PDF 만드는 중…' : 'PDF로 저장하기'}
              </button>
              <p className="action-caption">설정한 순서와 크기로 PDF를 다운로드합니다.</p>
            </aside>
          </div>
        ) : (
          <div className="workspace pdf-workspace">
            <section className="workspace-main">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">STEP 01 · OPEN PDF</p>
                  <h2>PDF 페이지를 확인해보세요.</h2>
                  <p>{pdfSource ? `${pdfSource.pageCount}페이지 · ${formatBytes(pdfSource.size)}` : 'PDF를 올리면 페이지별 미리보기가 나타납니다.'}</p>
                </div>
                {pdfSource && (
                  <button className="text-button" type="button" onClick={resetPdf}>
                    <RefreshCw size={14} /> 다른 PDF 열기
                  </button>
                )}
              </div>

              {!pdfSource ? (
                <button
                  className={`dropzone pdf-dropzone ${isPdfDropActive ? 'is-dragging' : ''}`}
                  type="button"
                  onClick={() => pdfInputRef.current?.click()}
                  onDragOver={(event) => { event.preventDefault(); setIsPdfDropActive(true); }}
                  onDragLeave={() => setIsPdfDropActive(false)}
                  onDrop={handlePdfDrop}
                >
                  <span className="dropzone-icon pdf-drop-icon"><FileText size={23} /></span>
                  <strong>PDF를 여기에 놓으세요.</strong>
                  <span>또는 클릭해서 파일 선택</span>
                  <small>PDF <i>최대 100페이지</i></small>
                </button>
              ) : (
                <>
                  <div className="pdf-file-strip">
                    <span className="pdf-file-icon"><FileText size={20} /></span>
                    <div><strong>{pdfSource.name}</strong><span>{formatBytes(pdfSource.size)} · {pdfSource.pageCount}페이지</span></div>
                    <button type="button" onClick={resetPdf} aria-label="PDF 닫기"><X size={16} /></button>
                  </div>
                  <div className="pdf-page-grid">
                    {pdfSource.previews.map((preview) => (
                      <article className="pdf-page-card" key={preview.pageNumber}>
                        <div className="pdf-page-preview"><img src={preview.dataUrl} alt={`PDF ${preview.pageNumber}페이지 미리보기`} /><span>{String(preview.pageNumber).padStart(2, '0')}</span></div>
                        <p>페이지 {preview.pageNumber}</p>
                      </article>
                    ))}
                  </div>
                </>
              )}

              <input ref={pdfInputRef} className="visually-hidden" type="file" accept={PDF_ACCEPT} onChange={handlePdfInput} />

              {(isPdfBusy || (isExporting && pdfSource)) && (
                <ProgressBar label={isPdfBusy ? 'PDF 미리보기 생성 중' : '이미지 파일 묶는 중'} current={pdfProgress.current} total={pdfProgress.total} />
              )}

              <div className="privacy-note">
                <ShieldCheck size={17} />
                <span><strong>이 PDF도 기기 안에서만 열립니다.</strong> 변환이 끝나면 브라우저에서 바로 다운로드합니다.</span>
              </div>
            </section>

            <aside className="settings-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">STEP 02 · EXPORT IMAGES</p>
                  <h2>이미지 설정</h2>
                </div>
                <FileImage size={19} />
              </div>

              <div className="setting-group">
                <div className="setting-label-row"><label>파일 형식</label><span>페이지별 이미지</span></div>
                <div className="format-options">
                  {(['png', 'jpg'] as const).map((format) => (
                    <button className={pdfFormat === format ? 'format-option selected' : 'format-option'} type="button" key={format} onClick={() => setPdfFormat(format)}>
                      <span className={`format-swatch ${format}`}>{format === 'png' ? 'PNG' : 'JPG'}</span>
                      <span><strong>{format === 'png' ? 'PNG' : 'JPG'}</strong><small>{format === 'png' ? '선명한 무손실 이미지' : '작은 파일 크기'}</small></span>
                      {pdfFormat === format && <Check size={15} />}
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-group">
                <div className="setting-label-row"><label>출력 화질</label><span>렌더링 크기</span></div>
                <div className="quality-options">
                  {PDF_SCALE_OPTIONS.map((option) => (
                    <button className={pdfScale === option.value ? 'selected' : ''} type="button" key={option.value} onClick={() => setPdfScale(option.value)}>
                      <strong>{option.label}</strong><small>{option.detail}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-summary">
                <div><span>내보낼 이미지</span><strong>{pdfSource ? `${pdfSource.pageCount}개` : '—'}</strong></div>
                <div><span>다운로드 방식</span><strong>ZIP 한 개로 묶기</strong></div>
              </div>

              <button className="primary-action" type="button" onClick={() => void exportPdfPages()} disabled={!pdfSource || isPdfBusy || isExporting}>
                {isExporting ? <LoaderCircle className="spin" size={18} /> : <Archive size={18} />}
                {isExporting ? '이미지 만드는 중…' : '이미지 ZIP 다운로드'}
              </button>
              <p className="action-caption">모든 페이지가 순서대로 ZIP 파일에 담깁니다.</p>
            </aside>
          </div>
        )}
      </main>

      <footer className="footer">
        <span>pdf-manager <b>·</b> local-first file tools</span>
        <span>JPG · PNG · HEIC · PDF</span>
      </footer>
    </div>
  );
}

function ProgressBar({ label, current, total }: { label: string; current: number; total: number }) {
  const progress = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <div className="progress-area" role="status" aria-live="polite">
      <div className="progress-label"><span>{label}</span><strong>{current}/{total}</strong></div>
      <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
    </div>
  );
}

export default App;
