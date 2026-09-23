// The board's detail panel: clicking an already-selected image in the side
// panel (Board.tsx's selection list) opens this — the original at fit size,
// its metadata, and its properties, editable through PATCH /images/:id
// (docs/phases/1-map.md section 3). Distinct from sheet/Inspector.tsx, which
// edits a scene element's customData; this edits an image row
// directly, so the type/coerce helpers are duplicated rather than shared —
// the two panels edit unrelated things that happen to look similar.
import type { GetImageResponse, PropertyValue } from '@digsite/shared';
import { useState } from 'react';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

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

interface Props {
  image: GetImageResponse;
  originalUrl: string;
  saveState: SaveState;
  onSetProperty: (key: string, value: PropertyValue) => void;
  onRemoveProperty: (key: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function Detail({
  image,
  originalUrl,
  saveState,
  onSetProperty,
  onRemoveProperty,
  onDelete,
  onClose,
}: Props) {
  const [newKey, setNewKey] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <section className="board-detail" data-testid="detail-panel">
      <div className="board-panel-heading">
        <span className="board-eyebrow">SELECTED IMAGE</span>
        <button
          type="button"
          className="board-text-button"
          aria-label="Close image details"
          data-testid="detail-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="board-image-identity">
        {image.missing ? (
          <div
            data-testid="detail-missing"
            style={{
              width: 56,
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--surface-sunken)',
              color: 'var(--text-faint)',
              borderRadius: 'var(--radius-s)',
            }}
          >
            missing
          </div>
        ) : (
          <img
            src={originalUrl}
            alt={image.name}
            className="board-detail-thumb"
          />
        )}
        <div className="board-image-identity-copy">
          <div className="board-image-name">{image.name}</div>
          <div className="muted">
            {image.width} × {image.height}
          </div>
          <div className="muted">
            Added {new Date(image.uploadedAt).toLocaleDateString()}
          </div>
        </div>
      </div>
      {image.missing ? (
        <div className="muted" data-testid="detail-missing-note">
          Original file is no longer available
        </div>
      ) : confirmingDelete ? (
        <div className="board-detail-delete-confirm">
          <span className="error">delete this image?</span>
          <button
            type="button"
            data-testid="detail-delete-confirm"
            onClick={onDelete}
          >
            delete
          </button>
          <button type="button" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="detail-delete"
          className="board-danger-link"
          onClick={() => setConfirmingDelete(true)}
        >
          Delete image
        </button>
      )}

      <div className="board-property-section">
        <div className="board-detail-section-title">
          <span className="board-eyebrow">IMAGE RECORD</span>
          <b>Properties</b>
          <span data-testid="detail-save-state" className="muted">
            {saveState === 'saving'
              ? 'saving…'
              : saveState === 'saved'
                ? 'saved'
                : saveState === 'error'
                  ? 'save failed'
                  : ''}
          </span>
        </div>
        {Object.entries(image.properties).map(([k, v]) => (
          <div key={k} className="board-property-row">
            <label
              className="board-property-name"
              htmlFor={`detail-property-${k}`}
            >
              {k}
            </label>
            <select
              value={typeOf(v)}
              aria-label={`Type of ${k}`}
              onChange={(e) =>
                onSetProperty(
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
              id={`detail-property-${k}`}
              data-testid={`detail-prop-${k}`}
              aria-label={k}
              value={String(v)}
              onChange={(e) =>
                onSetProperty(k, coerce(e.target.value, typeOf(v)))
              }
            />
            <button
              type="button"
              className="board-property-remove"
              aria-label={`Remove ${k}`}
              data-testid={`detail-prop-remove-${k}`}
              onClick={() => onRemoveProperty(k)}
            >
              ×
            </button>
          </div>
        ))}
        <div className="board-property-add">
          <input
            data-testid="detail-new-key"
            aria-label="New property name"
            placeholder="new key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <button
            type="button"
            data-testid="detail-add-property"
            onClick={() => {
              if (!newKey) return;
              onSetProperty(newKey, '');
              setNewKey('');
            }}
          >
            Add
          </button>
        </div>
      </div>
    </section>
  );
}
