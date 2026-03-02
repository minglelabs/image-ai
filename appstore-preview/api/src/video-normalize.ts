import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MIN_DURATION_SECONDS = 15.2;

interface NormalizeVideoOptions {
  sourceName?: string;
  minDurationSeconds?: number;
}

export interface NormalizedVideoResult {
  fileName: string;
  mimeType: string;
  data: Buffer;
  inputDurationSeconds: number;
  outputDurationSeconds: number;
  padded: boolean;
  paddedSeconds: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function sanitizeOutputStem(name: string) {
  const stem = name.replace(/\.[^/.]+$/, '').trim();
  const normalized = stem
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'appstore-preview';
}

function ensureFiniteDuration(value: number, fallback: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const errorMessage = stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? 'unknown'}`;
      reject(new Error(errorMessage));
    });
  });
}

async function probeDurationSeconds(inputPath: string) {
  const result = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    inputPath,
  ]);
  const parsed = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('Could not read video duration with ffprobe.');
  }
  return parsed;
}

export async function normalizeVideoForAppStore(
  inputBuffer: Buffer,
  options?: NormalizeVideoOptions,
): Promise<NormalizedVideoResult> {
  if (!Buffer.isBuffer(inputBuffer) || inputBuffer.byteLength === 0) {
    throw new Error('Video normalization requires a non-empty binary payload.');
  }

  const minDurationSecondsRaw = options?.minDurationSeconds ?? DEFAULT_MIN_DURATION_SECONDS;
  const minDurationSeconds = ensureFiniteDuration(minDurationSecondsRaw, DEFAULT_MIN_DURATION_SECONDS);
  const sourceName = (options?.sourceName ?? 'appstore-preview').trim() || 'appstore-preview';

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'appstore-preview-normalize-'));
  const inputPath = path.join(tempDir, 'input.bin');
  const outputPath = path.join(tempDir, 'output-appstore.mp4');

  try {
    await writeFile(inputPath, inputBuffer);
    const inputDurationSeconds = await probeDurationSeconds(inputPath);
    const targetDurationSeconds = Math.max(inputDurationSeconds, minDurationSeconds);
    const paddedSeconds = Math.max(0, targetDurationSeconds - inputDurationSeconds);
    const padded = paddedSeconds > 0.0005;

    const vfFilters: string[] = [];
    if (padded) {
      vfFilters.push(`tpad=stop_mode=clone:stop_duration=${paddedSeconds.toFixed(3)}`);
    }
    vfFilters.push('fps=30');

    const ffmpegArgs: string[] = [
      '-y',
      '-i',
      inputPath,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
    ];

    if (vfFilters.length > 0) {
      ffmpegArgs.push('-vf', vfFilters.join(','));
    }

    ffmpegArgs.push(
      '-t',
      targetDurationSeconds.toFixed(3),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-profile:v',
      'high',
      '-movflags',
      '+faststart',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-shortest',
      outputPath,
    );

    await runCommand('ffmpeg', ffmpegArgs);
    const outputDurationSeconds = await probeDurationSeconds(outputPath);
    const data = await readFile(outputPath);
    const safeStem = sanitizeOutputStem(sourceName);

    return {
      fileName: `${safeStem}-appstore.mp4`,
      mimeType: 'video/mp4',
      data,
      inputDurationSeconds,
      outputDurationSeconds,
      padded,
      paddedSeconds,
    };
  } catch (error) {
    if (error instanceof Error && /ENOENT/i.test(error.message)) {
      throw new Error('ffmpeg/ffprobe is required for App Store video normalization but was not found.');
    }
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
