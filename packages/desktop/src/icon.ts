/** The menu bar icon: a thin ring over a horizon line, drawn at 2x as a
 * template image so macOS tints it for light and dark menu bars.
 */
import { nativeImage, type NativeImage } from "electron";

export function trayIcon(): NativeImage {
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      const ring = Math.max(0, 1 - Math.abs(distance - 11) / 1.6);
      const horizon = Math.abs(y - centre - 2) < 1.2 && Math.abs(x - centre) < 8.5 ? 1 : 0;
      const alpha = Math.round(255 * Math.min(1, Math.max(ring, horizon)));
      const offset = (y * size + x) * 4;
      // BGRA; template images use only alpha.
      pixels[offset + 3] = alpha;
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}
