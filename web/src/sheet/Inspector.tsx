// What is selected, and everything a person can say about it here
// (CONTEXT.md "Making sense"). A region: its crop and its label. A
// connection: its evidence (both ends side by side), its relation,
// direction, confidence and note, and what other sheets say about the same
// pair. Several: name them all at once. An image: its board record, through
// `PATCH /images/:id`, the same panel the board's Detail uses.
//
// A foreign claim shows the same, read-only, with Jump and Copy. It is
// never edited: there is no foreign element to edit
// (../../.claude/rules/foreign-never-in-scene.md).
import type {
  AliasMap,
  ElementData,
  Foreign,
  GetImageResponse,
  PropertyValue,
  Stamp,
  VocabularyTerm,
} from '@digsite/shared';
import { dataOf } from '@digsite/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Detail } from '../board/Detail.tsx';
import { Icon } from '../components/Icon.tsx';
import { TermInput } from '../components/TermInput.tsx';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import { ago } from '../lib/when.ts';
import {
  CONFIDENCE_LABEL,
  ConfidenceControl,
  DirectionControl,
} from './ClaimControls.tsx';
import { Discussion } from './Discussion.tsx';
import { LooksLike } from './LooksLike.tsx';
import type { SceneElement } from './canvas/types.ts';
import {
  type EvidenceEnd,
  type PairClaim,
  claimsOnPair,
  cropStyle,
  foreignEvidence,
  ownEvidence,
  ownPairEdges,
} from './evidence.ts';
import type { Selected } from './tools.ts';

export interface InspectorProps {
  selected: Selected | null;
  elements: readonly SceneElement[];
  foreign: Foreign;
  sheetName: string;
  labelTerms: readonly VocabularyTerm[];
  relationTerms: readonly VocabularyTerm[];
  relationAliases: AliasMap;
  /** The loaded picture for an image id, for crops. */
  imageSrc: (imageId: string) => string;
  onSetProperty: (id: string, key: string, value: PropertyValue) => void;
  onRemoveProperty: (id: string, key: string) => void;
  onSetTermOn: (ids: readonly string[], term: string) => void;
  onCopyForeign: (id: string) => void;
  onDeleteSelected: () => void;
  /** Selects a claim listed on the same pair: an element or a foreign id. */
  onSelectClaim: (id: string) => void;
  /** This sheet, where its own claims' replies live. */
  sheetId: string;
  /** The signed-in person, who may remove their own replies. */
  userId: string | null;
  /** "Looks like" under a picture: suggestions, chosen by a person. */
  looksLike?: {
    boardId: string;
    sort: string;
    onSheet: ReadonlySet<string>;
    onBring: (parentImageId: string, imageId: string) => Promise<string | null>;
    onConnect: (
      parentImageId: string,
      elementId: string,
      relation: string,
    ) => void;
  };
  /** Opens the web of claims around the given pictures. */
  onOpenWeb?: (imageIds: string[]) => void;
  /** Makes a picture of its own from a region, beside its parent. */
  onExtract?: (regionId: string) => void;
  /** Opens the two ends of a connection side by side, to check the claim. */
  onCompare?: (ends: [EvidenceEnd, EvidenceEnd], relation: string) => void;
}

export function Inspector(props: InspectorProps) {
  const { selected } = props;
  if (!selected) {
    return (
      <div data-testid="inspector" className="claim-empty">
        <p>Select an image, a region or a connection to see what it says.</p>
        <p>
          Drag the handle on a selected image to connect it to another. Draw a
          region with <kbd>R</kbd>.
        </p>
      </div>
    );
  }
  if (selected.kind === 'foreign') return <ForeignClaim {...props} />;
  if (selected.elements.length > 1) return <Several {...props} />;
  const el = selected.elements[0];
  const data = el ? dataOf(el) : null;
  if (!el || !data) return <div data-testid="inspector" />;
  if (data.kind === 'image')
    return (
      <ImageInspector imageId={data.imageId} looksLike={props.looksLike} />
    );
  return <OwnClaim {...props} element={el} data={data} />;
}

// -- pieces -------------------------------------------------------------------

function Crop({
  end,
  src,
  size = 116,
}: {
  end: EvidenceEnd;
  src: string;
  size?: number;
}) {
  return (
    <figure className="claim-crop">
      <div
        className="claim-crop-image"
        role="img"
        aria-label={end.label ? `Region "${end.label}"` : 'Whole image'}
        style={cropStyle(end, src, size)}
      />
      <figcaption>{end.label || 'Whole image'}</figcaption>
    </figure>
  );
}

function Evidence({
  ends,
  imageSrc,
  direction,
  onCompare,
  onOpenWeb,
}: {
  ends: [EvidenceEnd, EvidenceEnd];
  imageSrc: (imageId: string) => string;
  direction: ElementDataEdge['direction'];
  onCompare?: () => void;
  onOpenWeb?: () => void;
}) {
  const icon =
    direction === 'forward'
      ? 'arrowRight'
      : direction === 'reverse'
        ? 'arrowLeft'
        : direction === 'both'
          ? 'arrowBoth'
          : 'minus';
  return (
    <div className="claim-evidence-block">
      <div className="claim-evidence" data-testid="inspector-evidence">
        <Crop end={ends[0]} src={imageSrc(ends[0].imageId)} size={104} />
        <Icon name={icon} size={16} className="claim-evidence-arrow" />
        <Crop end={ends[1]} src={imageSrc(ends[1].imageId)} size={104} />
      </div>
      {onCompare && (
        <button
          type="button"
          className="claim-compare"
          data-testid="inspector-compare"
          onClick={onCompare}
        >
          <Icon name="panel" size={15} />
          Compare side by side
        </button>
      )}
      {onOpenWeb && (
        <button
          type="button"
          className="claim-compare"
          data-testid="inspector-open-web"
          onClick={onOpenWeb}
        >
          <Icon name="connect" size={15} />
          See the web around both
        </button>
      )}
    </div>
  );
}

function PairClaims({
  claims,
  onSelect,
}: {
  claims: PairClaim[];
  onSelect: (id: string) => void;
}) {
  if (!claims.length) return null;
  const disagree = claims.filter((c) => c.agreement === 'disagree').length;
  const agree = claims.filter((c) => c.agreement === 'agree').length;
  return (
    <section className="claim-section" data-testid="inspector-pair">
      <h3>
        Also said about this pair
        <span className="claim-pair-summary">
          {agree > 0 && <span data-agreement="agree">{agree} agree</span>}
          {disagree > 0 && (
            <span data-agreement="disagree">{disagree} disagree</span>
          )}
        </span>
      </h3>
      <ul className="claim-pair-list">
        {claims.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="claim-pair-item"
              data-agreement={c.agreement}
              onClick={() => onSelect(c.id)}
            >
              <span className="claim-pair-mark" aria-hidden="true" />
              <span className="claim-pair-relation">
                {c.relation || 'Unnamed'}
              </span>
              <span className="claim-pair-meta">
                {c.own ? 'This sheet' : c.sheetName}
                {c.confidence ? ` · ${CONFIDENCE_LABEL[c.confidence]}` : ''}
              </span>
              <span className="visually-hidden">
                {c.agreement === 'agree'
                  ? 'agrees'
                  : c.agreement === 'disagree'
                    ? 'disagrees'
                    : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Properties({
  id,
  properties,
  onSetProperty,
  onRemoveProperty,
}: {
  id: string;
  properties: Record<string, PropertyValue>;
  onSetProperty: InspectorProps['onSetProperty'];
  onRemoveProperty: InspectorProps['onRemoveProperty'];
}) {
  const [newKey, setNewKey] = useState('');
  return (
    <section className="claim-section">
      <h3>Properties</h3>
      {Object.entries(properties).map(([k, v]) => (
        <div key={k} className="claim-property">
          <label htmlFor={`claim-prop-${id}-${k}`}>{k}</label>
          <input
            id={`claim-prop-${id}-${k}`}
            value={String(v)}
            onChange={(e) => {
              const raw = e.target.value;
              onSetProperty(
                id,
                k,
                typeof v === 'number' &&
                  raw.trim() !== '' &&
                  !Number.isNaN(Number(raw))
                  ? Number(raw)
                  : typeof v === 'boolean'
                    ? raw === 'true'
                    : raw,
              );
            }}
          />
          <button
            type="button"
            className="claim-icon-button"
            aria-label={`Remove ${k}`}
            title={`Remove ${k}`}
            onClick={() => onRemoveProperty(id, k)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <form
        className="claim-property-add"
        onSubmit={(e) => {
          e.preventDefault();
          const key = newKey.trim();
          if (!key) return;
          onSetProperty(id, key, '');
          setNewKey('');
        }}
      >
        <input
          aria-label="New property name"
          placeholder="Add a property…"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button type="submit" disabled={!newKey.trim()}>
          Add
        </button>
      </form>
    </section>
  );
}

/** Who made this claim and who last changed it (CONTEXT.md "Stamp"). */
function Stamps({ made, edited }: { made?: Stamp; edited?: Stamp }) {
  if (!made && !edited) return null;
  // A change within a minute of the making, by the same hand, is the making.
  const sameHand =
    made &&
    edited &&
    made.id === edited.id &&
    Date.parse(edited.at) - Date.parse(made.at) < 60_000;
  return (
    <p className="claim-stamps" data-testid="inspector-stamps">
      {made && (
        <span>
          Added by <b>{made.name}</b> {ago(made.at)}
        </span>
      )}
      {edited && !sameHand && (
        <span>
          Changed by <b>{edited.name}</b> {ago(edited.at)}
        </span>
      )}
    </p>
  );
}

function Heading({
  title,
  from,
  onDelete,
}: {
  title: string;
  from?: string;
  onDelete?: () => void;
}) {
  return (
    <header className="claim-heading">
      <h2>
        {title}
        {from && <span className="claim-from">from {from}</span>}
      </h2>
      {onDelete && (
        <button
          type="button"
          className="claim-icon-button claim-icon-button--danger"
          data-testid="inspector-delete"
          aria-label={`Delete this ${title.toLowerCase()}`}
          title="Delete"
          onClick={onDelete}
        >
          <Icon name="trash" size={16} />
        </button>
      )}
    </header>
  );
}

// -- views --------------------------------------------------------------------

type ElementDataEdge = Extract<ElementData, { kind: 'edge' }>;

function OwnClaim(
  props: InspectorProps & { element: SceneElement; data: ElementData },
) {
  const {
    element: el,
    data,
    elements,
    imageSrc,
    onSetProperty,
    onRemoveProperty,
    onDeleteSelected,
  } = props;

  if (data.kind === 'region') {
    const image = elements.find((e) => {
      const d = dataOf(e);
      return !e.isDeleted && d?.kind === 'image' && d.imageId === data.imageId;
    });
    const end: EvidenceEnd | null = image
      ? {
          imageId: data.imageId,
          imageSize: { width: image.width, height: image.height },
          fraction: {
            fx: (el.x - image.x) / image.width,
            fy: (el.y - image.y) / image.height,
            fw: el.width / image.width,
            fh: el.height / image.height,
          },
          label: data.label,
        }
      : null;
    return (
      <div data-testid="inspector" className="claim">
        <Heading title="Region" onDelete={onDeleteSelected} />
        <Stamps made={data.made} edited={data.edited} />
        {end && (
          <div className="claim-evidence claim-evidence--single">
            <Crop end={end} src={imageSrc(data.imageId)} size={160} />
          </div>
        )}
        {props.onExtract && (
          <button
            type="button"
            className="claim-compare"
            data-testid="inspector-extract"
            onClick={() => props.onExtract?.(el.id)}
          >
            <Icon name="plus" size={15} />
            Make a picture of this region
          </button>
        )}
        <section className="claim-section">
          <h3>Label</h3>
          <TermInput
            aria-label="Label"
            data-testid="inspector-text"
            value={data.label}
            terms={props.labelTerms}
            placeholder="What does this region show?"
            onChange={(v) => onSetProperty(el.id, 'label', v)}
            onCommit={(v) => onSetProperty(el.id, 'label', v.trim())}
          />
        </section>
        <Properties
          id={el.id}
          properties={data.properties}
          onSetProperty={onSetProperty}
          onRemoveProperty={onRemoveProperty}
        />
        <Discussion
          sheetId={props.sheetId}
          elementId={el.id}
          userId={props.userId}
        />
      </div>
    );
  }

  if (data.kind !== 'edge') return null;
  const ends = ownEvidence(el, elements);
  const own = ownPairEdges(elements);
  const subject = own.find((e) => e.id === el.id);
  const claims = subject
    ? claimsOnPair(
        subject,
        own,
        props.foreign.edges,
        props.relationAliases,
        props.sheetName,
      )
    : [];
  return (
    <div data-testid="inspector" className="claim">
      <Heading title="Connection" onDelete={onDeleteSelected} />
      <Stamps made={data.made} edited={data.edited} />
      {ends && (
        <Evidence
          ends={ends}
          imageSrc={imageSrc}
          direction={data.direction}
          onCompare={
            props.onCompare
              ? () => props.onCompare?.(ends, data.relation)
              : undefined
          }
          onOpenWeb={
            props.onOpenWeb
              ? () => props.onOpenWeb?.([ends[0].imageId, ends[1].imageId])
              : undefined
          }
        />
      )}
      <section className="claim-section">
        <h3>Relation</h3>
        <TermInput
          aria-label="Relation"
          data-testid="inspector-text"
          value={data.relation}
          terms={props.relationTerms}
          placeholder="How are these connected?"
          onChange={(v) => onSetProperty(el.id, 'relation', v)}
          onCommit={(v) => onSetProperty(el.id, 'relation', v.trim())}
        />
      </section>
      <section className="claim-section claim-section--row">
        <h3>Direction</h3>
        <DirectionControl
          value={data.direction}
          testId="inspector-direction"
          onChange={(d) => onSetProperty(el.id, 'direction', d)}
        />
      </section>
      <section className="claim-section">
        <h3>How sure</h3>
        <ConfidenceControl
          value={data.confidence}
          testId="inspector-confidence"
          onChange={(c) => onSetProperty(el.id, 'confidence', c ?? '')}
        />
      </section>
      <section className="claim-section">
        <h3>
          <label htmlFor={`claim-note-${el.id}`}>Why</label>
        </h3>
        <textarea
          id={`claim-note-${el.id}`}
          data-testid="inspector-note"
          className="claim-note"
          rows={3}
          placeholder="What makes this connection hold?"
          value={data.note ?? ''}
          onChange={(e) => onSetProperty(el.id, 'note', e.target.value)}
        />
      </section>
      <PairClaims claims={claims} onSelect={props.onSelectClaim} />
      <Properties
        id={el.id}
        properties={data.properties}
        onSetProperty={onSetProperty}
        onRemoveProperty={onRemoveProperty}
      />
      <Discussion
        sheetId={props.sheetId}
        elementId={el.id}
        userId={props.userId}
      />
    </div>
  );
}

function ForeignClaim(props: InspectorProps) {
  const { selected, foreign, elements, imageSrc, onCopyForeign } = props;
  if (selected?.kind !== 'foreign') return null;
  const { shape } = selected;
  const actions = (
    <div className="claim-actions">
      <Link className="claim-link-button" to={`/s/${shape.row.sheetId}`}>
        Open {shape.sheetName}
      </Link>
      <button
        type="button"
        data-testid="copy-foreign"
        onClick={() => onCopyForeign(shape.id)}
      >
        Copy to this sheet
      </button>
    </div>
  );

  if (shape.kind === 'region') {
    const image = elements.find((e) => {
      const d = dataOf(e);
      return (
        !e.isDeleted && d?.kind === 'image' && d.imageId === shape.row.imageId
      );
    });
    const end: EvidenceEnd = {
      imageId: shape.row.imageId,
      imageSize: image ? { width: image.width, height: image.height } : null,
      fraction: shape.row,
      label: shape.row.label,
    };
    return (
      <div data-testid="inspector" className="claim claim--foreign">
        <Heading title="Region" from={shape.sheetName} />
        <div className="claim-evidence claim-evidence--single">
          <Crop end={end} src={imageSrc(end.imageId)} size={160} />
        </div>
        <section className="claim-section">
          <h3>Label</h3>
          <p className="claim-readonly">{shape.row.label || 'Unlabelled'}</p>
        </section>
        {actions}
        <Discussion
          sheetId={shape.row.sheetId}
          elementId={shape.row.sourceId}
          userId={props.userId}
        />
      </div>
    );
  }

  const row = shape.row;
  const ends = foreignEvidence(row, foreign.regions, elements);
  const claims = claimsOnPair(
    { ...row, id: row.id },
    ownPairEdges(elements),
    foreign.edges,
    props.relationAliases,
    props.sheetName,
  );
  return (
    <div data-testid="inspector" className="claim claim--foreign">
      <Heading title="Connection" from={shape.sheetName} />
      <Evidence
        ends={ends}
        imageSrc={imageSrc}
        direction={row.direction}
        onCompare={
          props.onCompare
            ? () => props.onCompare?.(ends, row.relation)
            : undefined
        }
        onOpenWeb={
          props.onOpenWeb
            ? () => props.onOpenWeb?.([ends[0].imageId, ends[1].imageId])
            : undefined
        }
      />
      <section className="claim-section">
        <h3>Relation</h3>
        <p className="claim-readonly">{row.relation || 'Unnamed'}</p>
      </section>
      {row.confidence && (
        <section className="claim-section">
          <h3>How sure</h3>
          <p className="claim-readonly">{CONFIDENCE_LABEL[row.confidence]}</p>
        </section>
      )}
      {row.note && (
        <section className="claim-section">
          <h3>Why</h3>
          <p className="claim-readonly claim-readonly--note">{row.note}</p>
        </section>
      )}
      <PairClaims claims={claims} onSelect={props.onSelectClaim} />
      {actions}
      <Discussion
        sheetId={row.sheetId}
        elementId={row.sourceId}
        userId={props.userId}
      />
    </div>
  );
}

function Several(props: InspectorProps) {
  const { selected, onDeleteSelected, onSetTermOn } = props;
  const [term, setTerm] = useState('');
  if (selected?.kind !== 'own') return null;
  const kinds = selected.elements.map((e) => dataOf(e)?.kind);
  const regions = kinds.filter((k) => k === 'region').length;
  const edges = kinds.filter((k) => k === 'edge').length;
  const claimIds = selected.elements
    .filter((e) => {
      const k = dataOf(e)?.kind;
      return k === 'region' || k === 'edge';
    })
    .map((e) => e.id);
  // Both kinds selected: a term means a label to one and a relation to the
  // other, so naming them together would mix vocabularies. Offer it only
  // for one kind.
  const nameable = claimIds.length > 1 && (regions === 0 || edges === 0);
  const noun = regions > 0 ? 'region' : 'connection';
  return (
    <div data-testid="inspector" className="claim">
      <header className="claim-heading">
        <h2 data-testid="inspector-count">
          {selected.elements.length} selected
        </h2>
        <button
          type="button"
          className="claim-icon-button claim-icon-button--danger"
          data-testid="inspector-delete"
          aria-label={`Delete ${plural(selected.elements.length, 'item')}`}
          title="Delete"
          onClick={onDeleteSelected}
        >
          <Icon name="trash" size={16} />
        </button>
      </header>
      {nameable && (
        <section className="claim-section">
          <h3>
            {regions > 0 ? 'Label' : 'Relation'} all{' '}
            {plural(claimIds.length, noun)}
          </h3>
          <TermInput
            aria-label={`Name all ${plural(claimIds.length, noun)}`}
            data-testid="inspector-name-all"
            value={term}
            terms={regions > 0 ? props.labelTerms : props.relationTerms}
            placeholder={regions > 0 ? 'Label them all…' : 'Name them all…'}
            onChange={setTerm}
            onCommit={(v) => {
              if (!v.trim()) return;
              onSetTermOn(claimIds, v.trim());
              setTerm('');
            }}
          />
        </section>
      )}
    </div>
  );
}

/** Board-owned data, not scene data: fetched by imageId on selection and
 * saved through `PATCH /images/:id`, same as Board.tsx's Detail panel
 * (docs/phases/2-sheet.md section 2). */
function ImageInspector({
  imageId,
  looksLike,
}: {
  imageId: string;
  looksLike?: InspectorProps['looksLike'];
}) {
  const [image, setImage] = useState<GetImageResponse | null>(null);
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setImage(null);
    setError(null);
    void api
      .getImage(imageId)
      .then((img) => {
        if (!cancelled) setImage(img);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof ApiError ? err.reason : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [imageId]);

  async function save(properties: GetImageResponse['properties']) {
    setImage((prev) => (prev ? { ...prev, properties } : prev));
    setSaveState('saving');
    try {
      const res = await api.updateImageProperties(imageId, { properties });
      setImage((prev) =>
        prev ? { ...prev, properties: res.properties } : prev,
      );
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }

  // Deletes the underlying image row (docs/phases/3-groups.md section 4) —
  // distinct from `onDeleteSelected`, which removes this scene's own
  // element. `Detail` already renders the "missing" placeholder once
  // `missing` flips true; the map and any other sheet holding this image
  // pick up the change on their own next load/tile refetch.
  async function deleteImage() {
    try {
      await api.deleteImage(imageId);
      setImage((prev) => (prev ? { ...prev, missing: true } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  if (error) {
    return (
      <div data-testid="inspector" className="claim-empty">
        <p>{error}</p>
      </div>
    );
  }
  if (!image) {
    return (
      <div data-testid="inspector" className="claim-empty" aria-busy="true" />
    );
  }

  return (
    <div data-testid="inspector" className="claim">
      <Detail
        image={image}
        originalUrl={api.originalUrl(imageId)}
        saveState={saveState}
        onSetProperty={(key, value) =>
          void save({ ...image.properties, [key]: value })
        }
        onRemoveProperty={(key) => {
          const next = { ...image.properties };
          delete next[key];
          void save(next);
        }}
        onDelete={() => void deleteImage()}
        onClose={() => {}}
      />
      {looksLike && !image.missing && (
        <LooksLike
          boardId={looksLike.boardId}
          sort={looksLike.sort}
          imageId={imageId}
          onSheet={looksLike.onSheet}
          onBring={(id) => looksLike.onBring(imageId, id)}
          onConnect={(elementId, relation) =>
            looksLike.onConnect(imageId, elementId, relation)
          }
        />
      )}
    </div>
  );
}
