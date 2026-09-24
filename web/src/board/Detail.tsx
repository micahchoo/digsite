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
import { api } from '../lib/api.ts';
import { bytesLabel } from '../lib/bytes.ts';
import { FileFacts } from './FileFacts.tsx';
import { captured, isCaptured } from './captured.ts';
import {
  type PropertyType,
  TYPE_LABELS,
  convert,
  draftOf,
  parseDraft,
  typeOfValue,
} from './property-edit.ts';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  image: GetImageResponse;
  originalUrl: string;
  saveState: SaveState;
  onSetProperty: (key: string, value: PropertyValue) => void;
  onRemoveProperty: (key: string) => void;
  onDelete: () => void;
  onClose: () => void;
  /** Find the pictures that look like this one (search by meaning). */
  onMoreLike?: () => void;
}

export function Detail({
  image,
  originalUrl,
  saveState,
  onSetProperty,
  onRemoveProperty,
  onDelete,
  onClose,
  onMoreLike,
}: Props) {
  const [newKey, setNewKey] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const added = new Date(image.uploadedAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const entries = Object.entries(image.properties);
  const own = entries.filter(([k]) => !isCaptured(k));
  const camera = entries.filter(([k]) => isCaptured(k));
  const shot = captured(image.properties);
  const row = (k: string, v: PropertyValue) => (
    <PropertyRow
      key={k}
      name={k}
      value={v}
      onSet={(value) => onSetProperty(k, value)}
      onRemove={() => onRemoveProperty(k)}
    />
  );

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
          {image.source && (
            <a
              className="board-image-facts"
              data-testid="detail-source"
              href={api.sourceUrl(image.id)}
              download
            >
              Download the {image.source.format} (
              {bytesLabel(image.source.bytes)})
            </a>
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

      {(shot.camera || shot.taken || shot.place) && (
        <dl className="board-captured" data-testid="detail-captured">
          {shot.taken && (
            <div>
              <dt>Taken</dt>
              <dd>{shot.taken}</dd>
            </div>
          )}
          {shot.camera && (
            <div>
              <dt>Camera</dt>
              <dd>{shot.camera}</dd>
            </div>
          )}
          {shot.place && (
            <div>
              <dt>Place</dt>
              <dd>
                <a
                  href={`https://www.openstreetmap.org/?mlat=${shot.place.latitude}&mlon=${shot.place.longitude}#map=16/${shot.place.latitude}/${shot.place.longitude}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shot.place.latitude.toFixed(5)},{' '}
                  {shot.place.longitude.toFixed(5)}
                </a>
              </dd>
            </div>
          )}
        </dl>
      )}

      {onMoreLike && !image.missing && (
        <div className="board-detail-actions">
          <button
            type="button"
            data-testid="detail-more-like"
            onClick={onMoreLike}
          >
            <Icon name="search" size={15} />
            More like this
          </button>
        </div>
      )}

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
      {own.map(([k, v]) => row(k, v))}
      {camera.length > 0 && (
        <details className="board-captured-fields">
          <summary>Camera fields ({camera.length})</summary>
          {camera.map(([k, v]) => row(k, v))}
        </details>
      )}
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

      <FileFacts imageId={image.id} />

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

/**
 * One property: its value in the control its type wants, and its type.
 * Text, numbers, dates and lists are drafts saved on Enter or on leaving
 * the field; yes/no saves on the click. A draft that is not its type says
 * why and saves nothing.
 */
function PropertyRow({
  name,
  value,
  onSet,
  onRemove,
}: {
  name: string;
  value: PropertyValue;
  onSet: (value: PropertyValue) => void;
  onRemove: () => void;
}) {
  const type = typeOfValue(value);
  const [draft, setDraft] = useState(draftOf(value));
  const [error, setError] = useState('');
  // A save, or another person's edit, replaces the draft.
  const shown = draftOf(value);
  const [was, setWas] = useState(shown);
  if (shown !== was) {
    setWas(shown);
    setDraft(shown);
    setError('');
  }

  function commit() {
    if (draft === shown) return;
    const parsed = parseDraft(draft, type);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError('');
    onSet(parsed.value);
  }
  function retype(to: PropertyType) {
    const converted = convert(value, to);
    if ('error' in converted) {
      setError(`Cannot be a ${to}: ${converted.error.toLowerCase()}`);
      return;
    }
    setError('');
    onSet(converted.value);
  }

  const id = `detail-property-${name}`;
  return (
    <div className="board-property-row" data-invalid={error !== ''}>
      <label className="board-property-name" htmlFor={id}>
        {name}
      </label>
      {type === 'boolean' ? (
        <input
          id={id}
          type="checkbox"
          data-testid={`detail-prop-${name}`}
          checked={value === true}
          onChange={(e) => onSet(e.target.checked)}
        />
      ) : (
        <input
          id={id}
          data-testid={`detail-prop-${name}`}
          type={type === 'date' ? 'date' : 'text'}
          inputMode={type === 'number' ? 'decimal' : undefined}
          placeholder={type === 'list' ? 'one, two, three' : undefined}
          aria-invalid={error !== ''}
          aria-describedby={error ? `${id}-error` : undefined}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError('');
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            // Esc first cancels an unsaved edit; on an unchanged field it
            // goes on to close the panel, as it does anywhere else.
            if (e.key === 'Escape' && draft !== shown) {
              e.stopPropagation();
              setDraft(shown);
              setError('');
            }
          }}
        />
      )}
      <select
        value={type}
        aria-label={`Type of ${name}`}
        data-testid={`detail-prop-type-${name}`}
        onChange={(e) => retype(e.target.value as PropertyType)}
      >
        {TYPE_LABELS.map(([t, label]) => (
          <option key={t} value={t}>
            {label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="board-property-remove"
        aria-label={`Remove ${name}`}
        title={`Remove ${name}`}
        data-testid={`detail-prop-remove-${name}`}
        onClick={onRemove}
      >
        <Icon name="close" size={14} />
      </button>
      {error && (
        <span
          id={`${id}-error`}
          className="board-property-error"
          role="alert"
          data-testid={`detail-prop-error-${name}`}
        >
          {error}
        </span>
      )}
    </div>
  );
}
