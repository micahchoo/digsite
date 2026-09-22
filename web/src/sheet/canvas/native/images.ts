// A cache of decoded `HTMLImageElement`s, keyed by fileId — ported from
// image-graph's own thumbnail/original caches (`sizes.ts`, `thumbnails.ts`:
// decode once, keep the bitmap, never re-decode a frame that already has
// it). Our source is `../../images.ts#loadImageFiles`'s `CanvasFile.dataURL`
// rather than a vault file's object URL (the sheet loads every image once,
// as a data URL, before handing `files` to whichever canvas adapter is
// mounted — see canvas/types.ts's own comment on `CanvasProps.files`), so
// there is no object URL to revoke here: a `data:` URL costs nothing to
// leave assigned, and this cache never removes an entry once added, the
// same lifetime rule Excalidraw's own file store keeps
// (excalidraw/ExcalidrawCanvas.tsx's `addedFileIds`).
import type { CanvasFile } from '../types.ts';

export class ImageCache {
  private readonly images = new Map<string, HTMLImageElement>();
  private readonly loading = new Set<string>();

  /** The decoded image for `fileId`, or null if it is not loaded (not
   * requested yet, still decoding, or failed) — render.ts falls back to a
   * placeholder rect in every one of those cases, deliberately treating
   * them alike. */
  get(fileId: string): HTMLImageElement | null {
    const img = this.images.get(fileId);
    return img?.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Starts decoding `file` if it is not already cached or in flight; calls
   * `onReady` once decoding finishes (success or failure) so the caller can
   * schedule a redraw. A no-op for a fileId already resolved. */
  ensure(file: CanvasFile, onReady: () => void): void {
    if (this.images.has(file.id) || this.loading.has(file.id)) return;
    this.loading.add(file.id);
    const img = new Image();
    img.onload = () => {
      this.loading.delete(file.id);
      this.images.set(file.id, img);
      onReady();
    };
    img.onerror = () => {
      this.loading.delete(file.id);
      onReady();
    };
    img.src = file.dataURL;
  }

  /** Brings every entry of `files` into the cache, calling `onReady` after
   * each newly-decoded one — `NativeCanvas.tsx`'s effect on the `files`
   * prop, the same "add once, never remove" pass Excalidraw's adapter runs
   * over its own file store. */
  sync(files: ReadonlyMap<string, CanvasFile>, onReady: () => void): void {
    for (const file of files.values()) this.ensure(file, onReady);
  }
}
