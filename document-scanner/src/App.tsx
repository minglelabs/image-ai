import {
  Check,
  ChevronRight,
  CircleHelp,
  Contrast,
  Crop,
  Download,
  FileImage,
  FileScan,
  Image as ImageIcon,
  MoveDiagonal,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
  SunMedium,
  UploadCloud,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  DEFAULT_CORNERS,
  DEFAULT_SCAN_SETTINGS,
  PAPER_SIZES,
  getPaperRatio,
  renderScannedDocument,
  type Point,
  type ScanMode,
  type ScanSettings,
} from './lib/image-processing';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type PointerEvent } from 'react';

type PreviewMode = 'original' | 'result';

interface SourceImage {
  url: string;
  fileName: string;
  size: number;
  width: number;
  height: number;
  image: HTMLImageElement;
}

interface RenderSize {
  width: number;
  height: number;
}

const CORNER_LABELS = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];

const MODE_OPTIONS: { id: ScanMode; label: string; description: string; icon: typeof FileScan }[] = [
  { id: 'document', label: '문서 흑백', description: '선명하고 평평하게', icon: FileScan },
  { id: 'grayscale', label: '부드러운 회색', description: '톤을 살려 자연스럽게', icon: Contrast },
  { id: 'color', label: '컬러 유지', description: '원본 색감 그대로', icon: ImageIcon },
];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadImageFromUrl(url: string, fileName: string, size: number) {
  return new Promise<SourceImage>((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      resolve({
        url,
        fileName,
        size,
        width: image.naturalWidth,
        height: image.naturalHeight,
        image,
      });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 불러오지 못했습니다.'));
    };
    image.src = url;
  });
}

async function fileToImage(file: File) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) {
        bitmap.close();
        throw new Error('이미지 캔버스를 만들 수 없습니다.');
      }

      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const normalizedBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!normalizedBlob) {
        throw new Error('이미지 방향을 정리하지 못했습니다.');
      }

      return loadImageFromUrl(URL.createObjectURL(normalizedBlob), file.name, file.size);
    } catch {
      // Some browsers cannot decode HEIC/HEIF with ImageBitmap. Fall back to the native image decoder.
    }
  }

  return loadImageFromUrl(URL.createObjectURL(file), file.name, file.size);
}

function getInitialCorners(): Point[] {
  return DEFAULT_CORNERS.map((point) => ({ ...point }));
}

function getFileStem(fileName: string) {
  return fileName.replace(/\.[^/.]+$/, '').replace(/[^a-z0-9가-힣-_]+/gi, '-').replace(/^-+|-+$/g, '') || 'document';
}

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sourceFrameRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<SourceImage | null>(null);
  const [paperId, setPaperId] = useState('a4');
  const [landscape, setLandscape] = useState(false);
  const [corners, setCorners] = useState<Point[]>(getInitialCorners);
  const [settings, setSettings] = useState<ScanSettings>({ ...DEFAULT_SCAN_SETTINGS });
  const [previewMode, setPreviewMode] = useState<PreviewMode>('result');
  const [resultUrl, setResultUrl] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [draggingCorner, setDraggingCorner] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [renderSize, setRenderSize] = useState<RenderSize>({ width: 720, height: 480 });

  const selectedPaper = useMemo(() => PAPER_SIZES.find((paper) => paper.id === paperId) ?? PAPER_SIZES[0]!, [paperId]);
  const paperRatio = getPaperRatio(selectedPaper, landscape);
  const outputFileName = `${getFileStem(source?.fileName ?? 'document')}-${selectedPaper.label.toLowerCase()}-scan.png`;

  const clearSource = useCallback(() => {
    setSource((current) => {
      if (current) {
        URL.revokeObjectURL(current.url);
      }
      return null;
    });
    setResultUrl('');
    setErrorMessage('');
    setPreviewMode('result');
    setCorners(getInitialCorners());
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const acceptFile = useCallback(async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const isImageFile = file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name);
    if (!isImageFile) {
      setErrorMessage('JPG, PNG, WEBP, HEIC 이미지 파일만 올려주세요.');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setErrorMessage('30MB 이하의 이미지를 사용해주세요.');
      return;
    }

    try {
      setErrorMessage('');
      const nextSource = await fileToImage(file);
      setSource((current) => {
        if (current) {
          URL.revokeObjectURL(current.url);
        }
        return nextSource;
      });
      setCorners(getInitialCorners());
      setLandscape(nextSource.width > nextSource.height * 1.08);
      setPreviewMode('result');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '이미지를 불러오지 못했습니다.');
    }
  }, []);

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void acceptFile(event.target.files?.[0]);
    },
    [acceptFile],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDraggingFile(false);
      void acceptFile(event.dataTransfer.files[0]);
    },
    [acceptFile],
  );

  useEffect(() => {
    if (!source) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsProcessing(true);
      try {
        const canvas = renderScannedDocument(source.image, corners, selectedPaper, landscape, settings);
        if (!cancelled) {
          setResultUrl(canvas.toDataURL(settings.mode === 'document' ? 'image/png' : 'image/jpeg', 0.92));
          setIsProcessing(false);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error instanceof Error ? error.message : '이미지를 처리하지 못했습니다.');
          setIsProcessing(false);
        }
      }
    }, 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [corners, landscape, selectedPaper, settings, source]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !source) {
      return;
    }

    const updateRenderSize = () => {
      const availableWidth = Math.max(280, stage.clientWidth - 48);
      const availableHeight = Math.max(280, stage.clientHeight - 48);
      const sourceRatio = source.width / source.height;
      let width = availableWidth;
      let height = width / sourceRatio;
      if (height > availableHeight) {
        height = availableHeight;
        width = height * sourceRatio;
      }
      setRenderSize({ width: Math.round(width), height: Math.round(height) });
    };

    updateRenderSize();
    const observer = new ResizeObserver(updateRenderSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [source]);

  useEffect(() => {
    return () => {
      if (source) {
        URL.revokeObjectURL(source.url);
      }
    };
  }, [source]);

  const resetCorners = useCallback(() => {
    setCorners(getInitialCorners());
  }, []);

  const updateCorner = useCallback((index: number, event: PointerEvent<HTMLButtonElement>) => {
    const frame = sourceFrameRef.current;
    if (!frame) {
      return;
    }
    const bounds = frame.getBoundingClientRect();
    const nextPoint = {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0.02, 0.98),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0.02, 0.98),
    };
    setCorners((current) => current.map((point, pointIndex) => (pointIndex === index ? nextPoint : point)));
  }, []);

  const handleCornerPointerDown = useCallback((index: number, event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingCorner(index);
  }, []);

  const handleCornerPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (draggingCorner !== null) {
        updateCorner(draggingCorner, event);
      }
    },
    [draggingCorner, updateCorner],
  );

  const handleCornerPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDraggingCorner(null);
  }, []);

  const updateSettings = useCallback((patch: Partial<ScanSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const handleDownload = useCallback(async () => {
    if (!source) {
      return;
    }
    try {
      setIsExporting(true);
      const canvas = renderScannedDocument(source.image, corners, selectedPaper, landscape, settings, 1600);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        throw new Error('파일을 만들지 못했습니다.');
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = outputFileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '스캔본을 저장하지 못했습니다.');
    } finally {
      setIsExporting(false);
    }
  }, [corners, landscape, outputFileName, selectedPaper, settings, source]);

  const renderSourcePreview = () => {
    if (!source) {
      return null;
    }

    return (
      <div
        ref={sourceFrameRef}
        className="source-frame"
        style={{ width: renderSize.width, height: renderSize.height }}
      >
        <img src={source.url} alt="업로드한 계약서 원본" />
        <svg className="crop-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points={corners.map((point) => `${point.x * 100},${point.y * 100}`).join(' ')} />
          <line x1={corners[0]!.x * 100} y1={corners[0]!.y * 100} x2={corners[2]!.x * 100} y2={corners[2]!.y * 100} />
          <line x1={corners[1]!.x * 100} y1={corners[1]!.y * 100} x2={corners[3]!.x * 100} y2={corners[3]!.y * 100} />
        </svg>
        {corners.map((point, index) => (
          <button
            key={CORNER_LABELS[index]}
            type="button"
            className={`crop-handle crop-handle-${index} ${draggingCorner === index ? 'is-dragging' : ''}`}
            style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
            aria-label={`${CORNER_LABELS[index]} 모서리 이동`}
            onPointerDown={(event) => handleCornerPointerDown(index, event)}
            onPointerMove={handleCornerPointerMove}
            onPointerUp={handleCornerPointerUp}
            onPointerCancel={handleCornerPointerUp}
          >
            <span />
          </button>
        ))}
      </div>
    );
  };

  const renderEmptyState = () => (
    <main className="empty-layout">
      <section
        className={`upload-card ${isDraggingFile ? 'is-dragging' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDraggingFile(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) {
            setIsDraggingFile(false);
          }
        }}
        onDrop={handleDrop}
      >
        <div className="upload-visual" aria-hidden="true">
          <div className="upload-scan-line" />
          <FileImage size={42} strokeWidth={1.5} />
          <span className="upload-plus">+</span>
        </div>
        <p className="eyebrow">사진 한 장이면 충분해요</p>
        <h1>계약서 사진을<br /><em>스캔본처럼</em> 정리하세요.</h1>
        <p className="upload-description">모서리를 맞추고, 용지 비율을 고른 뒤<br />그림자와 입체감까지 한 번에 정리합니다.</p>
        <button type="button" className="primary-button upload-button" onClick={() => fileInputRef.current?.click()}>
          <UploadCloud size={18} />
          사진 업로드하기
          <ChevronRight size={17} />
        </button>
        <p className="upload-note">JPG · PNG · WEBP · 최대 30MB</p>
        <div className="feature-trail">
          <span><Crop size={14} /> 4점 원근 보정</span>
          <span><WandSparkles size={14} /> 그림자 제거</span>
          <span><ShieldCheck size={14} /> 브라우저에서 처리</span>
        </div>
      </section>
      <section className="empty-info-row" aria-label="작업 순서">
        <div className="empty-info-item"><span>01</span><strong>용지 선택</strong><p>A4, B5, Letter 등</p></div>
        <div className="empty-info-divider" />
        <div className="empty-info-item"><span>02</span><strong>모서리 맞추기</strong><p>사진 속 문서만 정확하게</p></div>
        <div className="empty-info-divider" />
        <div className="empty-info-item"><span>03</span><strong>스캔본 저장</strong><p>선명한 PNG로 다운로드</p></div>
      </section>
    </main>
  );

  const renderWorkspace = () => (
    <main className="workspace-layout">
      <section className="preview-panel panel-surface">
        <div className="preview-panel-header">
          <div>
            <p className="section-kicker">PREVIEW</p>
            <h1>문서를 정돈하는 중입니다<span>.</span></h1>
          </div>
          <div className="preview-switcher" role="tablist" aria-label="미리보기 전환">
            <button type="button" className={previewMode === 'original' ? 'active' : ''} onClick={() => setPreviewMode('original')}>
              <ImageIcon size={14} /> 원본 + 모서리
            </button>
            <button type="button" className={previewMode === 'result' ? 'active' : ''} onClick={() => setPreviewMode('result')}>
              <ScanLine size={14} /> 스캔 결과
            </button>
          </div>
        </div>

        <div ref={stageRef} className={`preview-stage ${previewMode === 'result' ? 'result-stage' : 'original-stage'}`}>
          {previewMode === 'original' ? (
            <div className="source-preview-wrap">
              {renderSourcePreview()}
              <div className="stage-hint"><MoveDiagonal size={14} /> 네 모서리를 문서 끝에 맞춰주세요</div>
            </div>
          ) : (
            <div className="result-preview-wrap">
              <div className="result-sheet-shadow" />
              <div className={`result-sheet ${landscape ? 'landscape' : ''}`} style={{ aspectRatio: paperRatio }}>
                {resultUrl ? <img src={resultUrl} alt="스캔 처리된 문서 미리보기" /> : <div className="result-loading"><RefreshCw size={20} className="spin" /><span>스캔본을 만드는 중</span></div>}
              </div>
              <div className="result-badge"><Check size={14} /> {selectedPaper.label} · {landscape ? '가로' : '세로'}</div>
            </div>
          )}
          {isProcessing && previewMode === 'result' && <div className="processing-pill"><RefreshCw size={13} className="spin" /> 자동 보정 중</div>}
        </div>

        <div className="preview-panel-footer">
          <div className="file-summary">
            <div className="file-icon"><FileImage size={17} /></div>
            <div><strong title={source?.fileName}>{source?.fileName}</strong><span>{source ? `${source.width.toLocaleString()} × ${source.height.toLocaleString()} px · ${formatFileSize(source.size)}` : ''}</span></div>
          </div>
          <button type="button" className="text-button" onClick={resetCorners}><RefreshCw size={15} /> 모서리 초기화</button>
        </div>
      </section>

      <aside className="controls-panel panel-surface">
        <div className="controls-heading">
          <div>
            <p className="section-kicker">DOCUMENT SETUP</p>
            <h2>스캔 설정</h2>
          </div>
          <button type="button" className="icon-button" aria-label="도움말" title="도움말"><CircleHelp size={18} /></button>
        </div>

        <div className="control-scroll">
          <section className="control-section">
            <div className="control-section-title"><span className="step-number">01</span><div><h3>용지 선택</h3><p>결과물의 실제 비율을 정합니다.</p></div></div>
            <div className="paper-grid">
              {PAPER_SIZES.map((paper) => (
                <button type="button" key={paper.id} className={`paper-option ${paper.id === selectedPaper.id ? 'active' : ''}`} onClick={() => setPaperId(paper.id)}>
                  <span className="paper-shape" style={{ aspectRatio: `${paper.width} / ${paper.height}` }}><span>{paper.label}</span></span>
                  <span className="paper-copy"><strong>{paper.label}</strong><small>{paper.dimensions}</small></span>
                  {paper.id === selectedPaper.id && <Check size={15} className="paper-check" />}
                </button>
              ))}
            </div>
            <div className="orientation-row">
              <span>방향</span>
              <div className="segmented-control" role="group" aria-label="용지 방향">
                <button type="button" className={!landscape ? 'active' : ''} onClick={() => setLandscape(false)}>세로</button>
                <button type="button" className={landscape ? 'active' : ''} onClick={() => setLandscape(true)}>가로</button>
              </div>
            </div>
          </section>

          <section className="control-section crop-section">
            <div className="control-section-title"><span className="step-number">02</span><div><h3>문서 영역</h3><p>사진 속 용지의 네 모서리를 맞춥니다.</p></div></div>
            <div className="crop-summary"><div className="crop-icon"><Crop size={17} /></div><span>선택한 영역이 {selectedPaper.label} 비율로 펴집니다.</span></div>
            <button type="button" className="secondary-button full-width" onClick={() => { setPreviewMode('original'); resetCorners(); }}><MoveDiagonal size={16} /> 원본에서 모서리 조정하기</button>
          </section>

          <section className="control-section">
            <div className="control-section-title"><span className="step-number">03</span><div><h3>스캔 느낌</h3><p>글씨는 선명하게, 사진의 흔적은 가볍게.</p></div></div>
            <div className="mode-list">
              {MODE_OPTIONS.map((mode) => {
                const Icon = mode.icon;
                return <button type="button" key={mode.id} className={`mode-option ${settings.mode === mode.id ? 'active' : ''}`} onClick={() => updateSettings({ mode: mode.id })}><span className="mode-icon"><Icon size={16} /></span><span><strong>{mode.label}</strong><small>{mode.description}</small></span>{settings.mode === mode.id && <Check size={15} className="mode-check" />}</button>;
              })}
            </div>
            <label className="toggle-row"><span><SunMedium size={16} /><span><strong>그림자·입체감 제거</strong><small>빛의 방향과 종이의 굴곡을 평평하게 보정</small></span></span><input type="checkbox" checked={settings.shadowRemoval} onChange={(event) => updateSettings({ shadowRemoval: event.target.checked })} /><span className="toggle-track" aria-hidden="true"><span /></span></label>
            <div className="range-list">
              <label className="range-row"><span><Contrast size={15} /> 대비</span><output>{settings.contrast}</output><input type="range" min="0" max="100" value={settings.contrast} style={{ '--value': `${settings.contrast}%` } as CSSProperties} onChange={(event) => updateSettings({ contrast: Number(event.target.value) })} /></label>
              <label className="range-row"><span><Sparkles size={15} /> 선명도</span><output>{settings.sharpness}</output><input type="range" min="0" max="100" value={settings.sharpness} style={{ '--value': `${settings.sharpness}%` } as CSSProperties} onChange={(event) => updateSettings({ sharpness: Number(event.target.value) })} /></label>
            </div>
          </section>
        </div>

        <div className="download-area">
          <button type="button" className="primary-button download-button" onClick={() => void handleDownload()} disabled={isExporting || !resultUrl}>
            {isExporting ? <RefreshCw size={18} className="spin" /> : <Download size={18} />}
            {isExporting ? '고화질 스캔본 만드는 중' : '스캔본 PNG 저장'}
            {!isExporting && <ChevronRight size={17} />}
          </button>
          <p><ShieldCheck size={13} /> 사진은 서버로 전송되지 않습니다.</p>
        </div>
      </aside>
    </main>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark"><ScanLine size={18} strokeWidth={2.3} /></div><span>paperform</span><span className="brand-divider" /><span className="brand-product">DOCUMENT SCANNER</span></div>
        <div className="topbar-actions"><span className="privacy-chip"><ShieldCheck size={14} /> 로컬 처리</span>{source && <button type="button" className="new-scan-button" onClick={clearSource}><X size={15} /> 새 사진</button>}</div>
      </header>
      {errorMessage && <div className="error-banner" role="alert"><CircleHelp size={16} />{errorMessage}<button type="button" aria-label="오류 닫기" onClick={() => setErrorMessage('')}><X size={15} /></button></div>}
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" onChange={handleFileChange} />
      {source ? renderWorkspace() : renderEmptyState()}
      <footer className="app-footer"><span>paperform</span><span>사진을 문서로, 문서를 더 또렷하게.</span><span>v1.0 · browser only</span></footer>
    </div>
  );
}

export default App;
