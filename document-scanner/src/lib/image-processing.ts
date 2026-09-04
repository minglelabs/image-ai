export type ScanMode = 'document' | 'grayscale' | 'color';

export interface Point {
  x: number;
  y: number;
}

export interface PaperSize {
  id: string;
  label: string;
  dimensions: string;
  width: number;
  height: number;
}

export interface ScanSettings {
  mode: ScanMode;
  shadowRemoval: boolean;
  contrast: number;
  sharpness: number;
}

interface Homography {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
}

const MAX_SOURCE_EDGE = 2200;

export const PAPER_SIZES: PaperSize[] = [
  { id: 'a4', label: 'A4', dimensions: '210 × 297 mm', width: 210, height: 297 },
  { id: 'b5', label: 'B5', dimensions: '182 × 257 mm', width: 182, height: 257 },
  { id: 'a5', label: 'A5', dimensions: '148 × 210 mm', width: 148, height: 210 },
  { id: 'letter', label: 'Letter', dimensions: '8.5 × 11 in', width: 215.9, height: 279.4 },
];

export const DEFAULT_CORNERS: Point[] = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 },
];

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  mode: 'document',
  shadowRemoval: true,
  contrast: 68,
  sharpness: 48,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function solveLinearSystem(matrix: number[][], values: number[]) {
  const size = values.length;
  const augmented = matrix.map((row, rowIndex) => [...row, values[rowIndex] ?? 0]);

  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]?.[column] ?? 0) > Math.abs(augmented[pivotRow]?.[column] ?? 0)) {
        pivotRow = row;
      }
    }

    const pivot = augmented[pivotRow]?.[column] ?? 0;
    if (Math.abs(pivot) < 1e-10) {
      throw new Error('문서 원근 보정 계산에 실패했습니다.');
    }

    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!];
    const pivotValues = augmented[column]!;
    for (let index = column; index <= size; index += 1) {
      pivotValues[index] = (pivotValues[index] ?? 0) / pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) {
        continue;
      }

      const factor = augmented[row]?.[column] ?? 0;
      if (Math.abs(factor) < 1e-12) {
        continue;
      }

      for (let index = column; index <= size; index += 1) {
        augmented[row]![index] = (augmented[row]![index] ?? 0) - factor * (pivotValues[index] ?? 0);
      }
    }
  }

  return augmented.map((row) => row[size] ?? 0);
}

function getHomography(from: Point[], to: Point[]): Homography {
  const matrix: number[][] = [];
  const values: number[] = [];

  from.forEach((point, index) => {
    const destination = to[index] ?? { x: 0, y: 0 };
    const { x, y } = point;
    const { x: u, y: v } = destination;

    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  });

  const solved = solveLinearSystem(matrix, values);
  return {
    a: solved[0] ?? 0,
    b: solved[1] ?? 0,
    c: solved[2] ?? 0,
    d: solved[3] ?? 0,
    e: solved[4] ?? 0,
    f: solved[5] ?? 0,
    g: solved[6] ?? 0,
    h: solved[7] ?? 0,
  };
}

function mapPoint(homography: Homography, point: Point) {
  const denominator = homography.g * point.x + homography.h * point.y + 1;
  return {
    x: (homography.a * point.x + homography.b * point.y + homography.c) / denominator,
    y: (homography.d * point.x + homography.e * point.y + homography.f) / denominator,
  };
}

function getOutputDimensions(paper: PaperSize, landscape: boolean, maxWidth: number) {
  const paperWidth = landscape ? paper.height : paper.width;
  const paperHeight = landscape ? paper.width : paper.height;
  const width = Math.max(360, Math.min(maxWidth, 1600));
  return {
    width,
    height: Math.max(280, Math.round((width * paperHeight) / paperWidth)),
  };
}

function createSourceCanvas(image: HTMLImageElement) {
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('이미지 캔버스를 만들 수 없습니다.');
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function sampleBilinear(data: Uint8ClampedArray, width: number, height: number, point: Point) {
  const x = clamp(point.x, 0, width - 1);
  const y = clamp(point.y, 0, height - 1);
  const left = Math.floor(x);
  const top = Math.floor(y);
  const right = Math.min(width - 1, left + 1);
  const bottom = Math.min(height - 1, top + 1);
  const xRatio = x - left;
  const yRatio = y - top;
  const topLeft = (top * width + left) * 4;
  const topRight = (top * width + right) * 4;
  const bottomLeft = (bottom * width + left) * 4;
  const bottomRight = (bottom * width + right) * 4;
  const result = [0, 0, 0, 255];

  for (let channel = 0; channel < 3; channel += 1) {
    const topValue = (data[topLeft + channel] ?? 0) * (1 - xRatio) + (data[topRight + channel] ?? 0) * xRatio;
    const bottomValue =
      (data[bottomLeft + channel] ?? 0) * (1 - xRatio) + (data[bottomRight + channel] ?? 0) * xRatio;
    result[channel] = Math.round(topValue * (1 - yRatio) + bottomValue * yRatio);
  }

  return result;
}

function warpDocument(image: HTMLImageElement, corners: Point[], width: number, height: number) {
  const sourceCanvas = createSourceCanvas(image);
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) {
    throw new Error('원본 이미지를 읽을 수 없습니다.');
  }

  const sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  const sourcePoints = corners.map((point) => ({
    x: clamp(point.x, 0, 1) * (sourceCanvas.width - 1),
    y: clamp(point.y, 0, 1) * (sourceCanvas.height - 1),
  }));
  const destinationPoints: Point[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const destinationToSource = getHomography(destinationPoints, sourcePoints);
  const warpedData = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourcePoint = mapPoint(destinationToSource, { x, y });
      const sample = sampleBilinear(sourceData, sourceCanvas.width, sourceCanvas.height, sourcePoint);
      const outputIndex = (y * width + x) * 4;
      warpedData[outputIndex] = sample[0] ?? 0;
      warpedData[outputIndex + 1] = sample[1] ?? 0;
      warpedData[outputIndex + 2] = sample[2] ?? 0;
      warpedData[outputIndex + 3] = 255;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('보정 캔버스를 만들 수 없습니다.');
  }
  context.putImageData(new ImageData(warpedData, width, height), 0, 0);
  return canvas;
}

function luminance(red: number, green: number, blue: number) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function createBlurredBackground(rectified: HTMLCanvasElement) {
  const canvas = document.createElement('canvas');
  canvas.width = rectified.width;
  canvas.height = rectified.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('배경 보정 캔버스를 만들 수 없습니다.');
  }

  const sourceContext = rectified.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) {
    throw new Error('보정된 이미지를 읽을 수 없습니다.');
  }
  const sourceData = sourceContext.getImageData(0, 0, rectified.width, rectified.height);
  const grayData = new Uint8ClampedArray(sourceData.data.length);
  for (let index = 0; index < sourceData.data.length; index += 4) {
    const value = Math.round(luminance(sourceData.data[index] ?? 0, sourceData.data[index + 1] ?? 0, sourceData.data[index + 2] ?? 0));
    grayData[index] = value;
    grayData[index + 1] = value;
    grayData[index + 2] = value;
    grayData[index + 3] = 255;
  }
  const grayCanvas = document.createElement('canvas');
  grayCanvas.width = rectified.width;
  grayCanvas.height = rectified.height;
  grayCanvas.getContext('2d')?.putImageData(new ImageData(grayData, rectified.width, rectified.height), 0, 0);
  context.filter = `blur(${Math.max(12, Math.round(Math.min(rectified.width, rectified.height) * 0.018))}px)`;
  context.drawImage(grayCanvas, 0, 0);
  context.filter = 'none';
  return { data: context.getImageData(0, 0, canvas.width, canvas.height).data, sourceData };
}

function adjustContrast(value: number, amount: number) {
  const factor = (259 * (amount + 255)) / (255 * (259 - amount));
  return clamp(factor * (value - 128) + 128, 0, 255);
}

function smoothStep(value: number) {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function sharpen(data: Uint8ClampedArray, width: number, height: number, strength: number) {
  if (strength <= 0) {
    return;
  }

  const source = new Uint8ClampedArray(data);
  const amount = strength / 100;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const centerIndex = (y * width + x) * 4;
      const neighbors = [
        ((y - 1) * width + x) * 4,
        ((y + 1) * width + x) * 4,
        (y * width + x - 1) * 4,
        (y * width + x + 1) * 4,
      ];
      for (let channel = 0; channel < 3; channel += 1) {
        const average = neighbors.reduce((sum, index) => sum + (source[index + channel] ?? 0), 0) / neighbors.length;
        const center = source[centerIndex + channel] ?? 0;
        data[centerIndex + channel] = clamp(Math.round(center + (center - average) * amount * 1.5), 0, 255);
      }
    }
  }
}

export function getPaperRatio(paper: PaperSize, landscape: boolean) {
  return landscape ? paper.height / paper.width : paper.width / paper.height;
}

export function renderScannedDocument(
  image: HTMLImageElement,
  corners: Point[],
  paper: PaperSize,
  landscape: boolean,
  settings: ScanSettings,
  maxWidth = 920,
) {
  const dimensions = getOutputDimensions(paper, landscape, maxWidth);
  const rectified = warpDocument(image, corners, dimensions.width, dimensions.height);
  const rectifiedContext = rectified.getContext('2d', { willReadFrequently: true });
  if (!rectifiedContext) {
    throw new Error('스캔 결과를 읽을 수 없습니다.');
  }
  const { data: sourceData } = rectifiedContext.getImageData(0, 0, rectified.width, rectified.height);
  const background = settings.shadowRemoval ? createBlurredBackground(rectified) : null;
  const outputData = new Uint8ClampedArray(sourceData.length);

  for (let index = 0; index < sourceData.length; index += 4) {
    const red = sourceData[index] ?? 0;
    const green = sourceData[index + 1] ?? 0;
    const blue = sourceData[index + 2] ?? 0;
    const gray = luminance(red, green, blue);
    const blurredPaper = background?.data[index] ?? 232;
    const corrected = settings.shadowRemoval
      ? clamp(((gray - 18) / Math.max(blurredPaper - 18, 90)) * 255, 0, 255)
      : gray;
    const outputIndex = index;

    if (settings.mode === 'color') {
      const colorLift = settings.shadowRemoval ? 255 / Math.max(blurredPaper, 125) : 1;
      outputData[outputIndex] = clamp(Math.round(adjustContrast(red * colorLift, (settings.contrast - 50) * 1.1)), 0, 255);
      outputData[outputIndex + 1] = clamp(Math.round(adjustContrast(green * colorLift, (settings.contrast - 50) * 1.1)), 0, 255);
      outputData[outputIndex + 2] = clamp(Math.round(adjustContrast(blue * colorLift, (settings.contrast - 50) * 1.1)), 0, 255);
    } else if (settings.mode === 'document') {
      const threshold = 168 - settings.contrast * 0.22;
      const whiteLevel = smoothStep((corrected - (threshold - 24)) / 54);
      const documentGray = Math.round(whiteLevel * 255);
      outputData[outputIndex] = documentGray;
      outputData[outputIndex + 1] = documentGray;
      outputData[outputIndex + 2] = documentGray;
    } else {
      const grayscale = Math.round(adjustContrast(corrected, (settings.contrast - 50) * 1.5));
      outputData[outputIndex] = grayscale;
      outputData[outputIndex + 1] = grayscale;
      outputData[outputIndex + 2] = grayscale;
    }
    outputData[outputIndex + 3] = 255;
  }

  sharpen(outputData, rectified.width, rectified.height, settings.sharpness);
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = rectified.width;
  outputCanvas.height = rectified.height;
  outputCanvas.getContext('2d')?.putImageData(new ImageData(outputData, outputCanvas.width, outputCanvas.height), 0, 0);
  return outputCanvas;
}
