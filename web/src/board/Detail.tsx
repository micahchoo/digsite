// The board's detail panel: clicking an already-selected image in the side
// panel (Board.tsx's selection list) opens this — the original at fit size,
// its metadata, and its properties, editable through PATCH /images/:id
// (docs/phases/1-map.md section 3). Distinct from sheet/Inspector.tsx, which
// edits a scene element's customData; this edits an image row
// directly, so the type/coerce helpers are duplicated rather than shared —
// the two panels edit unrelated things that happen to look similar.
import type { GetImageResponse, PropertyValue } from '@digsite/shared';
import { useState } from 'react';
import { Icon } from '../components/Icon.tsx';

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

  const added = new Date(image.uploadedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  return (
    <section className="board-panel-section" data-testid="detail-panel">
      <div className="board-image-identity">
        {image.missing ? (
          <div
            className="board-detail-thumb is-missing"
            data-testid="detail-missing"
          >
            Missing
          </div>
        ) : (
          <img
            src={originalUrl}
            alt={image.name}
            className="board-detail-thumb"
          />
        )}
        <div className="board-image-identity-copy">
          <h2 className="board-image-name">{image.name}</h2>
          <span className="board-image-facts">
            {image.width} × {image.height} · Added {added}
          </span>
          {image.missing && (
            <span
              className="board-image-facts"
              data-testid="detail-missing-note"
            >
              The original file is no longer available.
            </span>
          )}
        </div>
        <button
          type="button"
          className="board-icon-button board-icon-button--small"
          aria-label="Close image details"
          title="Close"
          data-testid="detail-close"
          onClick={onClose}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="board-panel-heading">
        <h3>Properties</h3>
        <span
          data-testid="detail-save-state"
          className="board-save-state"
          data-state={saveState}
          aria-live="polite"
        >
          {saveState === 'saving'
            ? 'Saving…'
            : saveState === 'saved'
              ? 'Saved'
              : saveState === 'error'
                ? 'Not saved'
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
          <input
            id={`detail-property-${k}`}
            data-testid={`detail-prop-${k}`}
            aria-label={k}
            value={String(v)}
            onChange={(e) =>
              onSetProperty(k, coerce(e.target.value, typeOf(v)))
            }
          />
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
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Yes/no</option>
          </select>
          <button
            type="button"
            className="board-property-remove"
            aria-label={`Remove ${k}`}
            title={`Remove ${k}`}
            data-testid={`detail-prop-remove-${k}`}
            onClick={() => onRemoveProperty(k)}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <form
        className="board-property-add"
        onSubmit={(e) => {
          e.preventDefault();
          const key = newKey.trim();
          if (!key) return;
          onSetProperty(key, '');
          setNewKey('');
        }}
      >
        <input
          data-testid="detail-new-key"
          aria-label="New property name"
          placeholder="Add a property…"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <button
          type="submit"
          data-testid="detail-add-property"
          disabled={!newKey.trim()}
        >
          Add
        </button>
      </form>

      {!image.missing &&
        (confirmingDelete ? (
          <div className="board-inline-confirm" role="alert">
            <span>Delete this image from the board?</span>
            <button
              type="button"
              className="board-danger-button"
              data-testid="detail-delete-confirm"
              onClick={onDelete}
            >
              Delete
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
        ))}
    </section>
  );
}
