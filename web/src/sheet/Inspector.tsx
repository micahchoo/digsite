// For an own element: kind, label/relation, direction, properties as
// editable rows. For an image: name, size, board properties through
// `PATCH /images/:id` — the same panel Board.tsx's Detail.tsx already
// implements, reused here since both edit an image row, not a scene element
// (docs/phases/2-sheet.md section 2). For several: count and a delete
// button. For a foreign selection: the sheet name, a jump link and "Copy to
// this sheet" (docs/design.md "web/"). Never edits a foreign element —
// there isn't one; see ../../.claude/rules/foreign-never-in-scene.md.
import type { GetImageResponse, PropertyValue } from '@digsite/shared';
import { dataOf } from '@digsite/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Detail } from '../board/Detail.tsx';
import { ApiError, api } from '../lib/api.ts';
import type { Selected } from './tools.ts';

interface Props {
  selected: Selected | null;
  onSetProperty: (id: string, key: string, value: PropertyValue) => void;
  onRemoveProperty: (id: string, key: string) => void;
  onCopyForeign: (id: string) => void;
  onDeleteSelected: () => void;
}

function typeOf(v: PropertyValue): 'text' | 'number' | 'boolean' {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'text';
}

function coerce(
  raw: string,
  type: 'text' | 'number' | 'boolean',
): PropertyValue {
  if (type === 'number') return Number(raw) || 0;
  if (type === 'boolean') return raw === 'true';
  return raw;
}

export function Inspector({
  selected,
  onSetProperty,
  onRemoveProperty,
  onCopyForeign,
  onDeleteSelected,
}: Props) {
  const [newKey, setNewKey] = useState('');

  if (!selected) {
    return (
      <div data-testid="inspector" className="muted">
        nothing selected
      </div>
    );
  }

  if (selected.kind === 'own' && selected.elements.length > 1) {
    return (
      <div data-testid="inspector">
        <div data-testid="inspector-count">
          {selected.elements.length} selected
        </div>
        <button
          type="button"
          data-testid="inspector-delete"
          onClick={onDeleteSelected}
        >
          Delete
        </button>
      </div>
    );
  }

  if (selected.kind === 'foreign') {
    const { shape } = selected;
    return (
      <div data-testid="inspector">
        <div>
          <b>kind:</b> {shape.kind} (foreign)
        </div>
        {shape.label && <div>label: {shape.label}</div>}
        <div className="sheet-foreign-box">
          <div>foreign from: {shape.sheetName}</div>
          <Link to={`/s/${shape.row.sheetId}`}>Jump to sheet</Link>
          <div className="sheet-field">
            <button
              type="button"
              data-testid="copy-foreign"
              onClick={() => onCopyForeign(shape.id)}
            >
              Copy to this sheet
            </button>
          </div>
        </div>
      </div>
    );
  }

  const el = selected.elements[0];
  if (!el) {
    return (
      <div data-testid="inspector" className="muted">
        nothing selected
      </div>
    );
  }
  const data = dataOf(el);
  if (!data) {
    return (
      <div data-testid="inspector" className="muted">
        unrecognised element
      </div>
    );
  }

  if (data.kind === 'image') {
    return <ImageInspector imageId={data.imageId} />;
  }

  return (
    <div data-testid="inspector">
      <div className="sheet-row-between">
        <span>
          <b>kind:</b> {data.kind}
        </span>
        {/* A click on a grouped element (a region shares groupIds with its
            image) selects the whole group by default — clicking again to
            narrow the selection gets a single region back,
            or `tools.select(id)` does directly. Either way, deleting from
            here deletes exactly what is currently selected: the group, or
            just this element. */}
        <button
          type="button"
          data-testid="inspector-delete"
          onClick={onDeleteSelected}
        >
          Delete
        </button>
      </div>

      {(data.kind === 'region' || data.kind === 'edge') && (
        <div className="sheet-field">
          <label>
            {data.kind === 'region' ? 'label' : 'relation'}:{' '}
            <input
              data-testid="inspector-text"
              value={data.kind === 'region' ? data.label : data.relation}
              onChange={(e) =>
                onSetProperty(
                  el.id,
                  data.kind === 'region' ? 'label' : 'relation',
                  e.target.value,
                )
              }
            />
          </label>
        </div>
      )}

      {data.kind === 'edge' && (
        <div className="sheet-field">
          <label>
            direction:{' '}
            <select
              data-testid="inspector-direction"
              value={data.direction}
              onChange={(e) =>
                onSetProperty(el.id, 'direction', e.target.value)
              }
            >
              <option value="none">none</option>
              <option value="forward">forward</option>
              <option value="reverse">reverse</option>
              <option value="both">both</option>
            </select>
          </label>
        </div>
      )}

      {(data.kind === 'region' || data.kind === 'edge') && (
        <div className="sheet-field-lg">
          <div>
            <b>properties</b>
          </div>
          {Object.entries(data.properties).map(([k, v]) => (
            <div key={k} className="sheet-prop-row">
              <span className="sheet-prop-key">{k}</span>
              <select
                value={typeOf(v)}
                onChange={(e) =>
                  onSetProperty(
                    el.id,
                    k,
                    coerce(
                      String(v),
                      e.target.value as 'text' | 'number' | 'boolean',
                    ),
                  )
                }
              >
                <option value="text">text</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
              </select>
              <input
                className="sheet-prop-value"
                value={String(v)}
                onChange={(e) =>
                  onSetProperty(el.id, k, coerce(e.target.value, typeOf(v)))
                }
              />
              <button type="button" onClick={() => onRemoveProperty(el.id, k)}>
                x
              </button>
            </div>
          ))}
          <div className="sheet-prop-add">
            <input
              placeholder="new key"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                if (!newKey) return;
                onSetProperty(el.id, newKey, '');
                setNewKey('');
              }}
            >
              add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Board-owned data, not scene data: fetched by imageId on selection and
 * saved through `PATCH /images/:id`, same as Board.tsx's Detail panel
 * (docs/phases/2-sheet.md section 2). */
function ImageInspector({ imageId }: { imageId: string }) {
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
      <div data-testid="inspector" className="muted">
        {error}
      </div>
    );
  }
  if (!image) {
    return (
      <div data-testid="inspector" className="muted">
        loading…
      </div>
    );
  }

  return (
    <div data-testid="inspector">
      <div>
        <b>kind:</b> image
      </div>
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
    </div>
  );
}
