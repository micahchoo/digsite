// Label suggestions (roadmap horizon 4, "the machine suggests, never
// decides"): the board's own label terms, scored against one image's
// embedding. Only words people on this board already use, canonical after
// aliases, so a suggestion never invents a term. The web shows them as
// chips a person may click; nothing is filled in for them.
//
// A term's text embedding is cached per process: a vocabulary changes
// slowly, and one CLIP text call costs milliseconds. Whole-image scoring;
// a region's own embedding would suit better and is not built.
import type { LabelSuggestion } from '@digsite/shared/api';
import { vocabularyOf } from '../boards/vocabulary.ts';
import { vectorOf } from './embeddings.ts';
import { MODEL } from './model.ts';

/** The most-used terms scored per request. A board with thousands of
 * labels costs one embedding per new term, once; this bounds the first. */
export const MAX_TERMS = 500;
/** How a term is put to CLIP: the CLIP paper's default zero-shot prompt.
 * NOT measured here: on 2026-09-23 no board held real labels, only e2e
 * test strings. Measure it against the raw term (a region's own label in
 * its image's top 5) once one does. */
export const PROMPT = (term: string) => `a photo of ${term}`;

const CACHE_LIMIT = 20_000;
const termVectors = new Map<string, Float32Array>();

type Embed = (text: string) => Promise<Float32Array>;

async function termVector(term: string, embed: Embed): Promise<Float32Array> {
  const key = `${MODEL}\u0000${term}`;
  const hit = termVectors.get(key);
  if (hit) {
    termVectors.delete(key); // re-insert: the Map's order is the LRU
    termVectors.set(key, hit);
    return hit;
  }
  const vector = await embed(PROMPT(term));
  termVectors.set(key, vector);
  if (termVectors.size > CACHE_LIMIT) {
    termVectors.delete(termVectors.keys().next().value as string);
  }
  return vector;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

/** The board's label terms that best describe `imageId`, best first.
 * `score` is CLIP's cosine similarity. Null when the image has no
 * embedding yet; empty when the board has no labels. */
export async function suggestLabels(
  boardId: string,
  imageId: string,
  limit: number,
  embed: Embed = async (text) => (await import('./clip.ts')).embedText(text),
): Promise<LabelSuggestion[] | null> {
  // The route has checked the image is on this board.
  const image = await vectorOf(imageId);
  if (!image) return null;
  const { labels } = await vocabularyOf(boardId);
  const scored: LabelSuggestion[] = [];
  for (const { term } of labels.slice(0, MAX_TERMS)) {
    scored.push({ term, score: dot(image, await termVector(term, embed)) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Test-only: forget every cached term vector. */
export function resetLabelCacheForTest(): void {
  termVectors.clear();
}
