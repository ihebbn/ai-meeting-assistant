import { desktopCapturer, nativeImage, screen as electronScreen } from 'electron';
import type { NativeImage } from 'electron';

export type ScreenFrame = {
  mimeType: 'image/jpeg';
  base64: string;
  width: number;
  height: number;
  label: string;
  capturedAt: string;
  signature: string;
  changed: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compact perceptual signature from a downscaled bitmap. */
export function signatureFromImage(image: NativeImage): string {
  try {
    const small = image.resize({ width: 32, height: 18, quality: 'good' });
    const bitmap = small.toBitmap();
    const bins: number[] = [];
    for (let i = 0; i + 3 < bitmap.length; i += 16) {
      const r = bitmap[i]!;
      const g = bitmap[i + 1]!;
      const b = bitmap[i + 2]!;
      const luma = Math.round((r * 0.3 + g * 0.59 + b * 0.11) / 16);
      bins.push(luma);
    }
    return bins.join('.');
  } catch {
    return `fallback-${Date.now()}`;
  }
}

export function signaturesDiffer(
  a: string | null | undefined,
  b: string | null | undefined,
  threshold = 0.12,
): boolean {
  if (!a || !b || a === b) {
    return a !== b;
  }
  const aa = a.split('.').map((n) => Number(n) || 0);
  const bb = b.split('.').map((n) => Number(n) || 0);
  const n = Math.min(aa.length, bb.length);
  if (!n) {
    return true;
  }
  let diff = 0;
  for (let i = 0; i < n; i += 1) {
    diff += Math.abs(aa[i]! - bb[i]!) / 16;
  }
  return diff / n >= threshold;
}

/**
 * Grab a JPEG still of the primary display via desktopCapturer thumbnails.
 * Overlay hide/show is owned by the caller so capture stays independent of UI visibility.
 */
export async function capturePrimaryScreen(options?: {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  previousSignature?: string | null;
}): Promise<ScreenFrame | null> {
  const maxWidth = options?.maxWidth ?? 1280;
  const maxHeight = options?.maxHeight ?? 720;
  const quality = options?.quality ?? 72;

  try {
    await sleep(30);

    const display = electronScreen.getPrimaryDisplay();
    const scale = Math.min(
      1,
      maxWidth / Math.max(1, display.size.width),
      maxHeight / Math.max(1, display.size.height),
    );
    const thumbWidth = Math.max(640, Math.round(display.size.width * scale));
    const thumbHeight = Math.max(360, Math.round(display.size.height * scale));

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbWidth, height: thumbHeight },
      fetchWindowIcons: false,
    });

    if (!sources.length) {
      return null;
    }

    const primaryId = String(display.id);
    const source =
      sources.find((item) => item.display_id === primaryId) ||
      sources.find((item) => /screen 1|entire screen|affichage/i.test(item.name)) ||
      sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      return null;
    }

    const image = source.thumbnail;
    const signature = signatureFromImage(image);
    const changed = signaturesDiffer(options?.previousSignature, signature);
    const size = image.getSize();
    const jpeg = image.toJPEG(quality);
    return {
      mimeType: 'image/jpeg',
      base64: jpeg.toString('base64'),
      width: size.width,
      height: size.height,
      label: source.name || 'Primary screen',
      capturedAt: new Date().toISOString(),
      signature,
      changed,
    };
  } catch {
    return null;
  }
}

/** Decode a stored frame for rare debug use. */
export function frameToNativeImage(frame: ScreenFrame): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(frame.base64, 'base64'));
}
