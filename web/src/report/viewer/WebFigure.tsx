// A board, relation or path report has no one sheet to show, so its live
// figure is the web of its connections, drawn by the board's own
// WebDiagram on hop rings: a path from its first picture, anything else
// around its busiest ones.
import type { ReportData } from '@digsite/shared';
import { useMemo, useRef } from 'react';
import {
  WebDiagram,
  type WebDiagramHandle,
  type WebEdge,
} from '../../board/WebDiagram.tsx';
import { ringLayout } from '../../board/web-layout.ts';
import { Icon } from '../../components/Icon.tsx';

/** About the shape of the figure (viewer.css `.rv-sheet`), so a web of
 * many small parts fills it. */
const FRAME_ASPECT = 4 / 3;

interface Props {
  data: ReportData;
  pictures: Readonly<Record<string, string>>;
  selected: string | null;
  onSelect: (imageId: string | null) => void;
}

export function WebFigure({ data, pictures, selected, onSelect }: Props) {
  const diagramRef = useRef<WebDiagramHandle | null>(null);
  const edges = useMemo<WebEdge[]>(
    () =>
      data.claims.flatMap((c) => {
        const [a, b] = c.ends;
        return c.kind === 'connection' && a && b
          ? [
              {
                id: c.key,
                source: { imageId: a.imageId },
                target: { imageId: b.imageId },
                relation: c.term,
                confidence: c.confidence,
              },
            ]
          : [];
      }),
    [data],
  );
  const roots = useMemo(() => (data.path?.[0] ? [data.path[0]] : []), [data]);
  const placed = useMemo(
    () =>
      ringLayout(
        roots,
        data.images.map((img) => img.id),
        edges,
        FRAME_ASPECT,
      ),
    [roots, data, edges],
  );
  const names = useMemo(
    () => new Map(data.images.map((img) => [img.id, img.name])),
    [data],
  );

  return (
    <div className="rv-sheet">
      <div className="rv-canvas">
        <WebDiagram
          ref={diagramRef}
          edges={edges}
          placed={placed}
          roots={roots}
          srcOf={(id) => pictures[id] ?? ''}
          nameOf={(id) => names.get(id) ?? 'Picture'}
          selected={selected}
          onSelect={onSelect}
          emphasis={null}
          label="The web of this report's connections"
          testId="report-web"
          inPage
        />
      </div>
      <div className="rv-tools" role="toolbar" aria-label="The web">
        <button
          type="button"
          aria-label="Fit every picture"
          onClick={() => diagramRef.current?.fit()}
        >
          <Icon name="fit" size={16} />
        </button>
      </div>
    </div>
  );
}
