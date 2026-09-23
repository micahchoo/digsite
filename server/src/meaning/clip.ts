// CONTEXT.md "Embedding": CLIP ViT-B/32 through transformers.js (ONNX
// Runtime), 8-bit weights. Measured under Bun 2026-09-23: 6.8 s to load
// both halves, 75 ms per image on one core.
//
// Loaded lazily and once per process: the worker loads only the image half
// (it embeds uploads), the API only the text half (it embeds queries).
// Weights download on first use into DATA_DIR/models; a deployment without
// network access must place them there first. Nothing here runs unless
// env.EMBEDDINGS is on.
import { join } from 'node:path';
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  RawImage,
  env as runtime,
} from '@huggingface/transformers';
import sharp from 'sharp';
import { env } from '../env.ts';
import { MODEL } from './model.ts';

/** CLIP's input side; sharp scales to it before the processor sees it. */
const INPUT = 224;

runtime.cacheDir = join(env.DATA_DIR, 'models');

let vision:
  | Promise<{
      processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
      model: Awaited<
        ReturnType<typeof CLIPVisionModelWithProjection.from_pretrained>
      >;
    }>
  | undefined;
let text:
  | Promise<{
      tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
      model: Awaited<
        ReturnType<typeof CLIPTextModelWithProjection.from_pretrained>
      >;
    }>
  | undefined;

function loadVision() {
  vision ??= (async () => ({
    processor: await AutoProcessor.from_pretrained(MODEL),
    model: await CLIPVisionModelWithProjection.from_pretrained(MODEL, {
      dtype: 'q8',
    }),
  }))();
  return vision;
}

function loadText() {
  text ??= (async () => ({
    tokenizer: await AutoTokenizer.from_pretrained(MODEL),
    model: await CLIPTextModelWithProjection.from_pretrained(MODEL, {
      dtype: 'q8',
    }),
  }))();
  return text;
}

/** Unit length, so cosine similarity is a plain dot product. */
export function unit(values: Float32Array): Float32Array {
  let norm = 0;
  for (const v of values) norm += v * v;
  const scale = 1 / (Math.sqrt(norm) || 1);
  return Float32Array.from(values, (v) => v * scale);
}

/** The model's input for one image. libvips scales it, so the model
 * never sees more than INPUT x INPUT pixels of a large original. */
async function toModelInput(bytes: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize(INPUT, INPUT, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new RawImage(
    new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    info.width,
    info.height,
    3,
  );
}

/** Embeddings for several images in ONE model call. Measured 2026-09-23:
 * 29 ms per image one at a time, 10 ms in batches of 8-16, 6.6 ms at 32. */
export async function embedImages(
  images: Uint8Array[],
): Promise<Float32Array[]> {
  if (images.length === 0) return [];
  const { processor, model } = await loadVision();
  const inputs = await Promise.all(images.map(toModelInput));
  const { image_embeds } = await model(await processor(inputs));
  const flat = image_embeds.data as Float32Array;
  const dims = flat.length / images.length;
  return images.map((_, i) => unit(flat.subarray(i * dims, (i + 1) * dims)));
}

/** One image's embedding: `embedImages` with one image. */
export async function embedImage(bytes: Uint8Array): Promise<Float32Array> {
  const [vector] = await embedImages([bytes]);
  return vector as Float32Array;
}

/** A text query's embedding, comparable with image embeddings. */
export async function embedText(query: string): Promise<Float32Array> {
  const { tokenizer, model } = await loadText();
  const { text_embeds } = await model(
    tokenizer([query], { padding: true, truncation: true }),
  );
  return unit(text_embeds.data as Float32Array);
}
