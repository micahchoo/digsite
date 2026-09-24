// What a report's reader can do beyond reading (docs/roadmap.md "Report
// export", R1b): the sheet or the web live in figure 1, each claim's
// "Compare" and "Show", and the two kept in step. A claim clicked on the
// canvas lights its card and names it under the figure; a card's "Show"
// frames its claim on the canvas.
//
// One React root, inside the figure's shadow root. The card actions are
// portals into the document's own claim cards, so they sit where the
// reader is reading and take the document's styles.
import {
  type ReportClaim,
  type ReportData,
  claimGroups,
  numbered,
  reportFiles,
} from '@digsite/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compare, type CompareEnd } from '../../components/Compare.tsx';
import { WHOLE } from '../../components/compare-view.ts';
import { SheetFigure, type SheetFigureHandle } from './SheetFigure.tsx';
import { WebFigure } from './WebFigure.tsx';

export type Card = { key: string; article: HTMLElement; slot: HTMLElement };

interface Props {
  data: ReportData;
  pictures: Readonly<Record<string, string>>;
  cards: readonly Card[];
  /** The figure the reader scrolls back to when a card asks to show. */
  figure: HTMLElement;
  /** Where the Data section's downloads go. */
  files: HTMLElement | null;
}

const ARROW: Record<string, string> = {
  forward: '→',
  reverse: '←',
  both: '↔',
  none: '—',
};

/** The Data section's files (shared/report/formats.ts), by name. */
const DATA_FILES: Record<string, string> = {
  'report.json': 'The report (JSON)',
  'annotations.jsonld': 'Web Annotations (JSON-LD)',
  'claims.csv': 'Claims (CSV)',
  'graph.graphml': 'Graph (GraphML)',
};

function save(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function Reader({ data, pictures, cards, figure, files }: Props) {
  const sheetRef = useRef<SheetFigureHandle | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [comparing, setComparing] = useState<{
    a: CompareEnd;
    b: CompareEnd;
    title: string;
  } | null>(null);

  const n = useMemo(() => numbered(claimGroups(data)), [data]);
  const names = useMemo(
    () => new Map(data.images.map((img) => [img.id, img.name])),
    [data],
  );
  const onSheet = useMemo(
    () =>
      new Map(
        data.claims
          .filter((c) => c.sheetId === data.scene?.sheetId)
          .map((c) => [c.elementId, c]),
      ),
    [data],
  );
  const titleOf = useCallback(
    (c: ReportClaim) => {
      const [a, b] = c.ends;
      const name = (id?: string) => names.get(id ?? '') ?? 'picture';
      return c.kind === 'connection'
        ? `${name(a?.imageId)} ${ARROW[c.direction ?? 'none']} ${name(b?.imageId)}`
        : `${c.term || 'Unlabelled region'} on ${name(a?.imageId)}`;
    },
    [names],
  );

  // What the figure has chosen: claims clicked on the sheet, or every
  // claim touching the picture picked in the web.
  const focused = useMemo(() => {
    if (data.scene)
      return selectedIds
        .map((id) => onSheet.get(id))
        .filter((c): c is ReportClaim => !!c);
    return picked
      ? data.claims.filter((c) => c.ends.some((e) => e.imageId === picked))
      : [];
  }, [data, selectedIds, onSheet, picked]);

  useEffect(() => {
    const keys = new Set(focused.map((c) => c.key));
    for (const card of cards)
      card.article.classList.toggle('is-focus', keys.has(card.key));
  }, [focused, cards]);

  const read = (c: ReportClaim) =>
    cards
      .find((card) => card.key === c.key)
      ?.article.scrollIntoView({ behavior: 'smooth', block: 'start' });

  function show(c: ReportClaim) {
    figure.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (data.scene) sheetRef.current?.show(c.elementId);
    else setPicked(c.ends[0]?.imageId ?? null);
  }

  function compare(c: ReportClaim) {
    const [a, b] = c.ends;
    if (!a || !b) return;
    const end = (e: typeof a): CompareEnd => ({
      src: pictures[e.imageId] ?? '',
      name: names.get(e.imageId) ?? 'picture',
      label: e.label,
      focus: e.fraction ?? WHOLE,
    });
    setComparing({
      a: end(a),
      b: end(b),
      title: c.term ? `${c.term}: ${titleOf(c)}` : titleOf(c),
    });
  }

  const byKey = useMemo(
    () => new Map(data.claims.map((c) => [c.key, c])),
    [data],
  );

  return (
    <>
      {data.scene ? (
        <SheetFigure
          ref={sheetRef}
          data={data}
          pictures={pictures}
          onSelect={setSelectedIds}
        />
      ) : (
        <WebFigure
          data={data}
          pictures={pictures}
          selected={picked}
          onSelect={setPicked}
        />
      )}
      <p className="rv-status" aria-live="polite" data-testid="report-status">
        {focused.length ? (
          <>
            {focused.length === 1 ? 'Chosen: ' : `${focused.length} chosen: `}
            {focused.slice(0, 6).map((c, i) => (
              <span key={c.key}>
                {i > 0 && ', '}
                <button
                  type="button"
                  className="rv-link"
                  onClick={() => read(c)}
                >
                  {n.get(c.key)}. {titleOf(c)}
                </button>
              </span>
            ))}
            {focused.length > 6 && ` and ${focused.length - 6} more`}
          </>
        ) : data.scene ? (
          'Click a claim to find it below. Drag to move around; the wheel zooms.'
        ) : (
          'Click a picture to light its claims. Drag to move around; the wheel zooms.'
        )}
      </p>
      {cards.map((card) => {
        const c = byKey.get(card.key);
        if (!c) return null;
        const canCompare =
          c.kind === 'connection' &&
          c.ends.length === 2 &&
          c.ends.every((e) => pictures[e.imageId]);
        const canShow = data.scene ? onSheet.has(c.elementId) : true;
        return createPortal(
          <>
            {canCompare && (
              <button
                type="button"
                data-testid="report-compare"
                onClick={() => compare(c)}
              >
                Compare the two
              </button>
            )}
            {canShow && (
              <button
                type="button"
                data-testid="report-show"
                onClick={() => show(c)}
              >
                {data.scene ? 'Show on the sheet' : 'Show in the web'}
              </button>
            )}
          </>,
          card.slot,
          card.key,
        );
      })}
      {files &&
        createPortal(
          Object.entries(DATA_FILES).map(([name, label]) => (
            <button
              key={name}
              type="button"
              data-testid={`report-data-${name}`}
              onClick={() => save(name, reportFiles(data)[name] ?? '')}
            >
              {label}
            </button>
          )),
          files,
        )}
      {comparing && (
        <Compare
          a={comparing.a}
          b={comparing.b}
          title={comparing.title}
          onClose={() => setComparing(null)}
        />
      )}
    </>
  );
}
