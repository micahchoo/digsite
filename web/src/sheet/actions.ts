// What the sheet does that takes more than one step: bring a board picture
// beside another, make a region into a picture of its own (CONTEXT.md
// "Extract"), and gather the sheet's claims into a report. Each is a
// sequence of server calls and scene writes, and each step waits for the
// one before.
//
// The pure pieces (beside.ts, evidence.ts, report.ts) were tested; the
// sequences lived in the view and were not, and both defects found in them
// this week were in how the pieces were called: `besideSpot` measured the
// element's own position instead of the spot, and a picture without
// `groupIds` crashed the move. So the sequences live here, behind a port
// that takes only what they use, and a test hands them an in-memory scene
// and a fake server (image-graph's Exploration seam, moved to the sheet).
import {
  type Direction,
  type Fraction,
  dataOf,
  toFraction,
} from '@digsite/shared';
import type { ClaimReply } from '@digsite/shared/api';
import type { api } from '../lib/api.ts';
import { besideSpot } from './beside.ts';
import type { SceneElement } from './canvas/types.ts';
import { ownEvidence } from './evidence.ts';
import type { ReportClaim } from './report.ts';
import type { Tools } from './tools.ts';

/** The scene as the actions see it: what is on it, and what is selected. */
export interface ActionScene {
  elements(): readonly SceneElement[];
  select(ids: string[]): void;
}

export type ActionServer = Pick<
  typeof api,
  'addSheetImages' | 'extractRegion' | 'uploadImageStatuses' | 'getReplies'
>;

export interface ActionDeps {
  sheetId: string;
  /** The sheet's board, once the sheet has loaded. */
  boardId: () => string | null;
  scene: () => ActionScene | null;
  tools: Pick<Tools, 'moveImage' | 'connect'>;
  server: ActionServer;
  /** A picture, or a region of it, as a data URL; null when unreadable. */
  crop: (imageId: string, fraction: Fraction | null) => Promise<string | null>;
  /** A picture's name on the board. */
  nameOf: (imageId: string) => string;
  /** Where the app lives, for the links a report carries. */
  origin: string;
  /** Tells the view the scene changed. */
  changed: () => void;
  wait?: (ms: number) => Promise<void>;
}

/** A connection to make again on a new sheet, named by its pictures: the
 * neighbourhood's edges that Explore hands a sheet it creates. */
export interface PendingCopyEdge {
  sourceImageId: string;
  targetImageId: string;
  relation: string;
  direction: Direction;
}

/** How long a new picture may take to reach the sheet through the room,
 * and to be read by the worker. */
const ARRIVE_TRIES = 80;
const ARRIVE_MS = 125;
const READ_TRIES = 60;
const READ_MS = 250;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The element that shows `imageId` on a scene, if any. */
export function imageElementOf(
  elements: readonly SceneElement[],
  imageId: string,
): SceneElement | undefined {
  return elements.find((el) => {
    if (el.isDeleted) return false;
    const d = dataOf(el);
    return d?.kind === 'image' && d.imageId === imageId;
  });
}

export function createSheetActions(deps: ActionDeps) {
  const wait = deps.wait ?? sleep;
  const imageElement = (imageId: string) => {
    const scene = deps.scene();
    return scene ? imageElementOf(scene.elements(), imageId) : undefined;
  };

  /**
   * Adds a board picture to this sheet and moves it to the first free side
   * of `parentImageId`'s picture (beside.ts). Waits for it to arrive
   * through the room; its element, or null when it never came.
   */
  async function bringBeside(
    parentImageId: string,
    imageId: string,
  ): Promise<SceneElement | null> {
    const scene = deps.scene();
    const boardId = deps.boardId();
    const parent = imageElement(parentImageId);
    if (!scene || !boardId || !parent) return null;
    await deps.server.addSheetImages(boardId, deps.sheetId, {
      imageIds: [imageId],
    });
    let added = imageElement(imageId);
    for (let i = 0; i < ARRIVE_TRIES && !added; i++) {
      await wait(ARRIVE_MS);
      added = imageElement(imageId);
    }
    if (!added) return null;
    const placed = added;
    const others = scene
      .elements()
      .filter(
        (el) =>
          !el.isDeleted && el.id !== placed.id && dataOf(el)?.kind === 'image',
      );
    const spot = besideSpot(parent, placed, others);
    if (spot)
      deps.tools.moveImage(imageId, spot.x - placed.x, spot.y - placed.y);
    deps.changed();
    return imageElement(imageId) ?? placed;
  }

  /** Connects the element showing `parentImageId` to `elementId`: the
   * second half of "Looks like", once the person chose the relation. */
  function connectFrom(
    parentImageId: string,
    elementId: string,
    relation: string,
  ): string | null {
    const from = imageElement(parentImageId);
    const edge = from ? deps.tools.connect(from.id, elementId, relation) : null;
    deps.changed();
    return edge;
  }

  /**
   * A region made into a picture of its own: the server crops the
   * original; once the new picture is read it joins the sheet beside its
   * parent, and a "derived from" connection says where it came from.
   * `say` reports each step; it throws with a reason a person can read.
   */
  async function extract(
    regionId: string,
    say: (step: string) => void,
  ): Promise<void> {
    const scene = deps.scene();
    const boardId = deps.boardId();
    if (!scene || !boardId) return;
    const region = scene.elements().find((el) => el.id === regionId);
    const data = region ? dataOf(region) : null;
    if (!region || data?.kind !== 'region') return;
    const parent = imageElement(data.imageId);
    if (!parent) return;
    const label = data.label || 'Region';
    say(`Making a picture of "${label}"…`);
    const made = await deps.server.extractRegion(data.imageId, {
      ...toFraction(region, parent),
      label: data.label,
    });
    // A picture the worker has not read has no size yet to place it by.
    for (let i = 0; i < READ_TRIES; i++) {
      const { images } = await deps.server.uploadImageStatuses(boardId, [
        made.id,
      ]);
      const status = images[0]?.status;
      if (status === 'ready') break;
      if (status === 'failed')
        throw new Error('the new picture could not be read');
      await wait(READ_MS);
    }
    say(`Adding "${label}" to the sheet…`);
    const added = await bringBeside(data.imageId, made.id);
    if (!added) throw new Error('the new picture did not reach the sheet');
    deps.tools.connect(added.id, region.id, 'derived from');
    scene.select([added.id]);
    deps.changed();
  }

  /** Every claim on the sheet, with its ends as crops, its reasons, who
   * made it and what was said about it (report.ts draws the document). */
  async function reportClaims(): Promise<ReportClaim[]> {
    const scene = deps.scene();
    if (!scene) return [];
    const elements = scene.elements().filter((el) => !el.isDeleted);
    const { replies } = await deps.server
      .getReplies(deps.sheetId)
      .catch(() => ({ replies: [] as ClaimReply[] }));
    const claims: ReportClaim[] = [];
    for (const el of elements) {
      const data = dataOf(el);
      if (data?.kind !== 'edge' && data?.kind !== 'region') continue;
      const common = {
        made: data.made ?? null,
        edited: data.edited ?? null,
        properties: data.properties,
        replies: replies
          .filter((r) => r.elementId === el.id)
          .map((r) => ({ name: r.by.name, at: r.at, text: r.text })),
        link: `${deps.origin}/s/${deps.sheetId}?claim=${el.id}`,
      };
      if (data.kind === 'edge') {
        const ends = ownEvidence(el, elements);
        claims.push({
          ...common,
          kind: 'connection',
          term: data.relation,
          direction: data.direction,
          confidence: data.confidence ?? null,
          note: data.note ?? '',
          ends: ends
            ? await Promise.all(
                ends.map(async (end) => ({
                  name: deps.nameOf(end.imageId),
                  label: end.label,
                  crop: await deps.crop(end.imageId, end.fraction),
                })),
              )
            : [],
        });
      } else {
        const image = imageElementOf(elements, data.imageId);
        claims.push({
          ...common,
          kind: 'region',
          term: data.label,
          ends: [
            {
              name: deps.nameOf(data.imageId),
              label: data.label,
              crop: image
                ? await deps.crop(data.imageId, toFraction(el, image))
                : null,
            },
          ],
        });
      }
    }
    return claims;
  }

  /**
   * "Copy connections" (docs/phases/2-sheet.md section 4): makes each edge
   * between the pictures it names, by imageId, never by element id. An
   * edge whose picture is not on the sheet is left out. Every edge made is
   * this sheet's own. Returns how many were made.
   */
  function copyConnections(pending: readonly PendingCopyEdge[]): number {
    const scene = deps.scene();
    if (!scene) return 0;
    const elements = scene.elements();
    let made = 0;
    for (const edge of pending) {
      const from = imageElementOf(elements, edge.sourceImageId);
      const to = imageElementOf(elements, edge.targetImageId);
      if (!from || !to) continue;
      deps.tools.connect(from.id, to.id, edge.relation, edge.direction);
      made += 1;
    }
    if (made) deps.changed();
    return made;
  }

  return { bringBeside, connectFrom, copyConnections, extract, reportClaims };
}

export type SheetActions = ReturnType<typeof createSheetActions>;
