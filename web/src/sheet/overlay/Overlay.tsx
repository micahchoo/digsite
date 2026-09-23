// Foreign claims and presentation-only labels share one SVG layer above the
// native canvas. Foreign geometry stays outside the native scene, scene
// history, persistence, native hit testing, and collaboration.
import { type Foreign, dataOf } from '@digsite/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SceneElement } from '../canvas/types.ts';
import {
  type Focus,
  connectionOpacity,
  endImages,
  focusOf,
  inFocus,
  relationOpacity,
} from '../connection-emphasis.ts';
import { regionChip, regionLabelOf, truncateLabel } from '../labels.ts';
import type { PeerCursor } from '../presence.ts';
import { edgePaths, midSegment } from '../routing.ts';
import {
  type ConnectionLabelJob,
  type ContainerOffset,
  type LabelObstacle,
  type PlacedConnectionLabel,
  type PlacedRegionLabel,
  type Rect,
  type RegionLabelJob,
  type Viewport,
  foreignShapes,
  placeConnectionLabels,
  placeRegionLabels,
  rectToScreen,
  sceneToScreen,
} from './screen.ts';

interface Props {
  rows: Foreign;
  elements: readonly SceneElement[];
  viewport: Viewport;
  offset: ContainerOffset;
  selectedId: string | null;
  /** Every selected own element: what the connections are dimmed around. */
  selectedOwnIds: readonly string[];
  connectionRelation: string | null;
  onSelect: (id: string) => void;
  onSelectOwn: (id: string) => void;
  peers?: PeerCursor[];
}

interface EdgeLabel extends PlacedConnectionLabel {
  line: ConnectionLabelJob['line'];
  ignoreObstacleIds?: readonly string[];
  relation: string;
  foreign: boolean;
  /** Dimmed because its relation is not the emphasised one. */
  dimmed: boolean;
  opacity: number;
}

interface ForeignRegionLabel extends PlacedRegionLabel {
  shapeId: string;
  selected: boolean;
}

export function Overlay({
  rows,
  elements,
  viewport,
  offset,
  selectedId,
  selectedOwnIds,
  connectionRelation,
  onSelect,
  onSelectOwn,
  peers = [],
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const shapes = useMemo(() => foreignShapes(rows, elements), [rows, elements]);
  // What the connections are dimmed around: the own selection, or the one
  // foreign claim selected and the two pictures it joins.
  const focus = useMemo((): Focus | null => {
    const own = focusOf(elements, selectedOwnIds);
    if (own) return own;
    const shape = selectedId
      ? shapes.find((candidate) => candidate.id === selectedId)
      : undefined;
    if (!shape) return null;
    const images =
      shape.kind === 'edge'
        ? [shape.row.source.imageId, shape.row.target.imageId]
        : [shape.row.imageId];
    return { ids: new Set([shape.id]), images: new Set(images) };
  }, [elements, selectedOwnIds, selectedId, shapes]);
  const measureLabel = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) ctx.font = '11px system-ui, sans-serif';
    return (label: string) => ctx?.measureText(label).width ?? label.length * 7;
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const resize = () => {
      const box = svg.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const labels = useMemo(() => {
    const jobs: (ConnectionLabelJob & {
      relation: string;
      foreign: boolean;
      dimmed: boolean;
      opacity: number;
    })[] = [];
    const paths = edgePaths(elements, viewport.zoom);
    const byId = new Map(elements.map((element) => [element.id, element]));
    const endpointImageId = (elementId: string | undefined): string | null => {
      if (!elementId) return null;
      const endpoint = byId.get(elementId);
      if (!endpoint) return null;
      const data = dataOf(endpoint);
      return data?.kind === 'image' || data?.kind === 'region'
        ? data.imageId
        : null;
    };
    for (const element of elements) {
      if (element.isDeleted) continue;
      const data = dataOf(element);
      if (data?.kind !== 'edge' || !data.relation) continue;
      const path = paths.get(element.id);
      if (!path) continue;
      // On the segment half way along the path the canvas drew.
      const [from, to] = midSegment(path);
      const relation = data.relation;
      const focused = inFocus(focus, element.id, endImages(element, byId));
      const opacity = connectionOpacity(relation, connectionRelation, focused);
      jobs.push({
        id: `own-${element.id}`,
        label: relation,
        line: [
          sceneToScreen(from, viewport, offset),
          sceneToScreen(to, viewport, offset),
        ],
        relation,
        foreign: false,
        ignoreObstacleIds: [
          endpointImageId(element.startBinding?.elementId),
          endpointImageId(element.endBinding?.elementId),
        ].filter((imageId): imageId is string => imageId !== null),
        dimmed: relationOpacity(relation, connectionRelation) < 1,
        opacity,
        priority:
          (opacity === 1 ? 10 : 0) + (focus?.ids.has(element.id) ? 100 : 0),
      });
    }
    for (const shape of shapes) {
      if (shape.kind !== 'edge' || !shape.label) continue;
      const opacity = foreignEdgeOpacity(shape, connectionRelation, focus);
      jobs.push({
        id: shape.id,
        label: shape.label,
        line: [
          sceneToScreen(shape.line[0], viewport, offset),
          sceneToScreen(shape.line[1], viewport, offset),
        ],
        relation: shape.row.relation,
        foreign: true,
        ignoreObstacleIds: [shape.row.source.imageId, shape.row.target.imageId],
        dimmed: relationOpacity(shape.row.relation, connectionRelation) < 1,
        opacity,
        priority:
          (opacity === 1 ? 10 : 0) + (selectedId === shape.id ? 100 : 0),
      });
    }
    const obstacles: LabelObstacle[] = elements.flatMap((element) => {
      if (element.isDeleted) return [];
      const data = dataOf(element);
      if (data?.kind !== 'image') return [];
      return [
        {
          ...rectToScreen(
            {
              x: element.x,
              y: element.y,
              width: element.width,
              height: element.height,
            },
            viewport,
            offset,
          ),
          id: data.imageId,
        },
      ];
    });
    // Labels with no clear candidate are omitted; a selected connection still
    // exposes its relation and properties in the inspector.
    const placed = placeConnectionLabels(
      jobs,
      obstacles,
      size.width,
      size.height,
      measureLabel,
    );
    const metadata = new Map(jobs.map((job) => [job.id, job]));
    return placed.flatMap((placedLabel): EdgeLabel[] => {
      const job = metadata.get(placedLabel.id);
      return job ? [{ ...placedLabel, ...job }] : [];
    });
  }, [
    connectionRelation,
    elements,
    focus,
    measureLabel,
    offset,
    selectedId,
    shapes,
    size,
    viewport,
  ]);

  const regionLabels = useMemo(() => {
    const jobs: RegionLabelJob[] = shapes.flatMap((shape) => {
      if (shape.kind !== 'region' || !shape.label) return [];
      return [
        {
          id: shape.id,
          label: shape.label,
          rect: rectToScreen(shape.rect, viewport, offset),
          priority: shape.id === selectedId ? 100 : 0,
        },
      ];
    });
    const byId = new Map(elements.map((element) => [element.id, element]));
    // The chip render.ts draws above each own region's corner.
    const ownLabelObstacles: Rect[] = elements.flatMap((element) => {
      if (element.isDeleted) return [];
      const data = dataOf(element);
      if (data?.kind !== 'region') return [];
      const label = regionLabelOf(element, byId);
      if (!label) return [];
      const rect = rectToScreen(
        {
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        },
        viewport,
        offset,
      );
      return [regionChip(rect, measureLabel(truncateLabel(label)))];
    });
    const edgeLabelObstacles: Rect[] = labels.map(
      ({ x, y, width, height }) => ({
        x,
        y,
        width,
        height,
      }),
    );
    const placed = placeRegionLabels(
      jobs,
      [...ownLabelObstacles, ...edgeLabelObstacles],
      size.width,
      size.height,
      measureLabel,
    );
    const metadata = new Map(
      shapes.flatMap((shape) =>
        shape.kind === 'region' ? [[shape.id, shape] as const] : [],
      ),
    );
    return placed.flatMap((label): ForeignRegionLabel[] => {
      const shape = metadata.get(label.id);
      return shape
        ? [{ ...label, shapeId: shape.id, selected: shape.id === selectedId }]
        : [];
    });
  }, [
    elements,
    labels,
    measureLabel,
    offset,
    selectedId,
    shapes,
    size,
    viewport,
  ]);

  return (
    <svg
      ref={svgRef}
      data-testid="foreign-overlay"
      role="presentation"
      className="sheet-overlay-svg"
    >
      {shapes.map((shape) => {
        const selected = shape.id === selectedId;
        const stroke = selected
          ? 'var(--region-stroke)'
          : 'var(--foreign-stroke)';
        const strokeWidth = selected ? 2 : 1.5;
        const handlePointerDown = (e: React.PointerEvent) => {
          e.stopPropagation();
          e.preventDefault();
          onSelect(shape.id);
        };

        if (shape.kind === 'region') {
          const r = rectToScreen(shape.rect, viewport, offset);
          return (
            <g key={shape.id}>
              <rect
                data-testid="foreign-shape"
                data-foreign-id={shape.id}
                data-foreign-kind="region"
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                fill="none"
                stroke={stroke}
                strokeWidth={strokeWidth}
                strokeDasharray="6 4"
                opacity={0.7}
                className="sheet-overlay-hit"
                onPointerDown={handlePointerDown}
              />
            </g>
          );
        }

        const a = sceneToScreen(shape.line[0], viewport, offset);
        const b = sceneToScreen(shape.line[1], viewport, offset);
        const dimmed =
          relationOpacity(shape.row.relation, connectionRelation) < 1;
        const opacity =
          0.7 * foreignEdgeOpacity(shape, connectionRelation, focus);
        return (
          <g key={shape.id}>
            <line
              data-testid="foreign-shape"
              data-foreign-id={shape.id}
              data-foreign-kind="edge"
              data-relation-dimmed={dimmed || undefined}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeDasharray="6 4"
              opacity={opacity}
              className="sheet-overlay-hit"
              onPointerDown={handlePointerDown}
            />
            {shape.danglingStart && (
              <circle
                data-testid="foreign-dangling-marker"
                cx={a.x}
                cy={a.y}
                r={5}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                className="sheet-overlay-static"
              />
            )}
            {shape.danglingEnd && (
              <circle
                data-testid="foreign-dangling-marker"
                cx={b.x}
                cy={b.y}
                r={5}
                fill="none"
                stroke={stroke}
                strokeWidth={1.5}
                className="sheet-overlay-static"
              />
            )}
          </g>
        );
      })}
      {regionLabels.map((label) => (
        <g
          key={label.shapeId}
          data-testid="foreign-region-label"
          data-foreign-id={label.shapeId}
          className="sheet-overlay-static"
        >
          {label.leader && (
            <line
              x1={label.leader.x}
              y1={label.leader.y}
              x2={label.x + label.width / 2}
              y2={label.y + label.height / 2}
              stroke={
                label.selected
                  ? 'var(--region-stroke)'
                  : 'var(--foreign-stroke)'
              }
              strokeWidth={1}
              opacity={0.45}
            />
          )}
          <foreignObject
            data-testid="foreign-region-label-box"
            data-label-owner={label.shapeId}
            x={label.x}
            y={label.y}
            width={label.width}
            height={label.height}
          >
            <button
              type="button"
              className="sheet-foreign-region-label"
              data-selected={label.selected || undefined}
              aria-label={`Select foreign region: ${label.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(label.shapeId);
              }}
            >
              {label.label}
            </button>
          </foreignObject>
        </g>
      ))}
      {labels.map((label) => (
        <g
          key={label.id}
          data-testid="connection-label"
          data-connection-id={label.id}
          data-connection-source={label.foreign ? 'foreign' : 'own'}
          data-relation-dimmed={label.dimmed || undefined}
          pointerEvents="all"
          className="sheet-overlay-static"
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            if (label.foreign) onSelect(label.id);
            else onSelectOwn(label.id.slice('own-'.length));
          }}
        >
          {(() => {
            const [a, b] = label.line;
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lengthSquared = dx * dx + dy * dy || 1;
            const center = {
              x: label.x + label.width / 2,
              y: label.y + label.height / 2,
            };
            const t = Math.max(
              0,
              Math.min(
                1,
                ((center.x - a.x) * dx + (center.y - a.y) * dy) / lengthSquared,
              ),
            );
            const anchor = { x: a.x + t * dx, y: a.y + t * dy };
            return Math.hypot(anchor.x - center.x, anchor.y - center.y) > 12 ? (
              <line
                x1={anchor.x}
                y1={anchor.y}
                x2={center.x}
                y2={center.y}
                stroke={
                  label.foreign ? 'var(--foreign-stroke)' : 'var(--edge-stroke)'
                }
                strokeWidth={1}
                opacity={label.opacity * 0.45}
              />
            ) : null;
          })()}
          <rect
            x={label.x}
            y={label.y}
            width={label.width}
            height={label.height}
            rx={4}
            fill="var(--sheet-label-bg, #fff)"
            stroke="var(--sheet-label-border, #d0d7de)"
            strokeOpacity={label.opacity}
          />
          <text
            x={label.x + label.width / 2}
            y={label.y + label.height / 2}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fill={
              label.foreign ? 'var(--foreign-stroke)' : 'var(--edge-stroke)'
            }
            // A dimmed label fades its words, never its background: a
            // see-through chip lets the line strike through the text.
            fillOpacity={label.opacity}
            textLength={Math.min(label.width - 10, label.textWidth)}
            lengthAdjust="spacingAndGlyphs"
          >
            {label.label}
          </text>
        </g>
      ))}
      {peers.map((p) => {
        const pt = sceneToScreen({ x: p.x, y: p.y }, viewport, offset);
        return (
          <g
            key={p.user}
            data-testid="peer-cursor"
            data-peer-user={p.user}
            data-peer-name={p.name}
            className="sheet-overlay-static"
          >
            {p.rects.map((r) => {
              const rr = rectToScreen(r, viewport, offset);
              return (
                <rect
                  key={`${r.x},${r.y},${r.width},${r.height}`}
                  x={rr.x}
                  y={rr.y}
                  width={rr.width}
                  height={rr.height}
                  fill="none"
                  stroke={p.color}
                  strokeWidth={1.5}
                  opacity={0.35}
                />
              );
            })}
            <circle
              cx={pt.x}
              cy={pt.y}
              r={5}
              fill={p.color}
              stroke="#fff"
              strokeWidth={1.5}
            />
            <text
              x={pt.x + 8}
              y={pt.y - 8}
              fontSize={11}
              fontWeight={600}
              fill={p.color}
              stroke="#fff"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {p.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** A foreign connection dims the same way an own one does, around the
 * pictures it joins. */
function foreignEdgeOpacity(
  shape: {
    id: string;
    row: {
      relation: string;
      source: { imageId: string };
      target: { imageId: string };
    };
  },
  emphasisedRelation: string | null,
  focus: Focus | null,
): number {
  return connectionOpacity(
    shape.row.relation,
    emphasisedRelation,
    inFocus(focus, shape.id, [
      shape.row.source.imageId,
      shape.row.target.imageId,
    ]),
  );
}
