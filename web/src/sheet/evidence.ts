// What an edge rests on, and who else speaks about the same pair
// (CONTEXT.md "Evidence", "Pair", "Agreement"). Pure: scene elements and
// polled rows in, plain data out, so the inspector only draws.
import {
  type Agreement,
  type AliasMap,
  type Confidence,
  type Direction,
  type EdgeRow,
  type ForeignEdge,
  type ForeignRegion,
  type Fraction,
  agreementOf,
  dataOf,
  pairKey,
  toFraction,
} from '@digsite/shared';
import { type ElementLike, foreignShapeId } from './overlay/screen.ts';

/** One end of an edge: its image, and the region's fraction when the end
 * is a region rather than the whole image. */
export type EvidenceEnd = {
  imageId: string;
  /** The image's rect on this sheet, for the crop's proportions. */
  imageSize: { width: number; height: number } | null;
  fraction: Fraction | null;
  /** The region's label, or null for a whole image. */
  label: string | null;
};

type Bound = ElementLike & {
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};

function imageElementOf(
  imageId: string,
  elements: readonly ElementLike[],
): ElementLike | undefined {
  return elements.find((el) => {
    if (el.isDeleted) return false;
    const d = dataOf(el);
    return d?.kind === 'image' && d.imageId === imageId;
  });
}

function endOfElement(
  id: string | undefined,
  elements: readonly ElementLike[],
): EvidenceEnd | null {
  if (!id) return null;
  const el = elements.find((e) => e.id === id);
  const data = el ? dataOf(el) : null;
  if (!el || !data) return null;
  if (data.kind === 'image') {
    return {
      imageId: data.imageId,
      imageSize: { width: el.width, height: el.height },
      fraction: null,
      label: null,
    };
  }
  if (data.kind !== 'region') return null;
  const image = imageElementOf(data.imageId, elements);
  if (!image) return null;
  return {
    imageId: data.imageId,
    imageSize: { width: image.width, height: image.height },
    // A deleted region is a dangling end: show the whole image.
    fraction: el.isDeleted ? null : toFraction(el, image),
    label: el.isDeleted ? null : data.label,
  };
}

/** The two ends of an edge drawn on this sheet. */
export function ownEvidence(
  edge: Bound,
  elements: readonly ElementLike[],
): [EvidenceEnd, EvidenceEnd] | null {
  const a = endOfElement(edge.startBinding?.elementId, elements);
  const b = endOfElement(edge.endBinding?.elementId, elements);
  return a && b ? [a, b] : null;
}

/** The two ends of another sheet's edge, from its row and that sheet's
 * regions as last polled. */
export function foreignEvidence(
  edge: ForeignEdge,
  regions: readonly ForeignRegion[],
  elements: readonly ElementLike[],
): [EvidenceEnd, EvidenceEnd] {
  const end = (e: EdgeRow['source']): EvidenceEnd => {
    const image = imageElementOf(e.imageId, elements);
    const region = e.regionSourceId
      ? regions.find(
          (r) => r.sheetId === edge.sheetId && r.sourceId === e.regionSourceId,
        )
      : undefined;
    return {
      imageId: e.imageId,
      imageSize: image ? { width: image.width, height: image.height } : null,
      fraction: region
        ? { fx: region.fx, fy: region.fy, fw: region.fw, fh: region.fh }
        : null,
      label: region?.label ?? null,
    };
  };
  return [end(edge.source), end(edge.target)];
}

/** An edge reduced to what agreement compares. */
export type PairEdge = {
  source: { imageId: string };
  target: { imageId: string };
  relation: string;
  direction: Direction;
};

export type PairClaim = {
  /** What selects this claim: an element id for one of this sheet's, the
   * overlay's shape id for another sheet's (screen.ts#foreignShapeId). */
  id: string;
  sheetName: string;
  /** True for a claim this sheet owns. */
  own: boolean;
  relation: string;
  direction: Direction;
  confidence: Confidence | null;
  note: string;
  agreement: Agreement;
};

/** Every other claim on the same pair as `subject`, and whether it agrees. */
export function claimsOnPair(
  subject: PairEdge & { id: string },
  own: readonly (PairEdge & {
    id: string;
    confidence: Confidence | null;
    note: string;
  })[],
  foreign: readonly ForeignEdge[],
  relations: AliasMap,
  thisSheetName: string,
): PairClaim[] {
  const key = pairKey(subject.source.imageId, subject.target.imageId);
  const out: PairClaim[] = [];
  for (const e of own) {
    if (e.id === subject.id) continue;
    if (pairKey(e.source.imageId, e.target.imageId) !== key) continue;
    out.push({
      id: e.id,
      sheetName: thisSheetName,
      own: true,
      relation: e.relation,
      direction: e.direction,
      confidence: e.confidence,
      note: e.note,
      agreement: agreementOf(subject, e, relations),
    });
  }
  for (const e of foreign) {
    if (e.id === subject.id) continue;
    if (pairKey(e.source.imageId, e.target.imageId) !== key) continue;
    out.push({
      id: foreignShapeId('edge', e.id),
      sheetName: e.sheetName,
      own: false,
      relation: e.relation,
      direction: e.direction,
      confidence: e.confidence,
      note: e.note,
      agreement: agreementOf(subject, e, relations),
    });
  }
  return out;
}

/** This sheet's own edges as pair edges: each end resolved to its image. */
export function ownPairEdges(elements: readonly ElementLike[]) {
  const out: (PairEdge & {
    id: string;
    confidence: Confidence | null;
    note: string;
  })[] = [];
  for (const el of elements as readonly Bound[]) {
    if (el.isDeleted) continue;
    const data = dataOf(el);
    if (data?.kind !== 'edge') continue;
    const ends = ownEvidence(el, elements);
    if (!ends) continue;
    out.push({
      id: el.id,
      source: { imageId: ends[0].imageId },
      target: { imageId: ends[1].imageId },
      relation: data.relation,
      direction: data.direction,
      confidence: data.confidence ?? null,
      note: data.note ?? '',
    });
  }
  return out;
}

/** CSS for a crop box: the region (or the whole image) fills the box, and
 * the box takes the region's proportions within `max` pixels. */
export function cropStyle(
  end: EvidenceEnd,
  src: string,
  max: number,
): React.CSSProperties {
  const f = end.fraction ?? { fx: 0, fy: 0, fw: 1, fh: 1 };
  const size = end.imageSize ?? { width: 1, height: 1 };
  const aspect = (f.fw * size.width) / Math.max(1e-6, f.fh * size.height) || 1;
  const width = aspect >= 1 ? max : Math.round(max * aspect);
  const height = aspect >= 1 ? Math.round(max / aspect) : max;
  const pos = (start: number, span: number) =>
    span >= 1 ? 0 : (start / (1 - span)) * 100;
  return {
    width,
    height,
    backgroundImage: `url("${src}")`,
    backgroundSize: `${100 / f.fw}% ${100 / f.fh}%`,
    backgroundPosition: `${pos(f.fx, f.fw)}% ${pos(f.fy, f.fh)}%`,
  };
}
