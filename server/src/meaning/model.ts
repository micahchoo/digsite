// Which model an embedding came from. Its own module so that code naming
// the model does not load it: meaning/clip.ts pulls in ONNX Runtime, and is
// imported only where an embedding is actually computed.
export const MODEL = 'Xenova/clip-vit-base-patch32';

/** pgvector's text form, `[0.1,0.2,...]`, for a `halfvec` parameter. */
export function toVectorText(values: Float32Array): string {
  return `[${Array.from(values).join(',')}]`;
}
