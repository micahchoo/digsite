// The board's detail panel: clicking an already-selected image in the side
// panel (Board.tsx's selection list) opens this — the original at fit size,
// its metadata, and its properties, editable through PATCH /images/:id
// (docs/phases/1-map.md section 3). Distinct from sheet/Inspector.tsx, which
// edits an Excalidraw element's customData; this edits an image row
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
  onClose: () => void;
}

export function Detail({
  image,
  originalUrl,
  saveState,
  onSetProperty,
  onRemoveProperty,
  onClose,
}: Props) {
  const [newKey, setNewKey] = useState('');

  return (
    <div className="card" data-testid="detail-panel" style={{ marginTop: 10 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {image.name}
        </b>
        <button type="button" data-testid="detail-close" onClick={onClose}>
          close
        </button>
      </div>
      <img
        src={originalUrl}
        alt={image.name}
        style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }}
      />
      <div className="muted">
        {image.width}×{image.height} · uploaded{' '}
        {new Date(image.uploadedAt).toLocaleString()}
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <b>properties</b>
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
          <div
            key={k}
            style={{
              display: 'flex',
              gap: 4,
              alignItems: 'center',
              marginTop: 4,
            }}
          >
            <span
              style={{
                width: 70,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {k}
            </span>
            <select
              value={typeOf(v)}
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
              data-testid={`detail-prop-${k}`}
              style={{ width: 90 }}
              value={String(v)}
              onChange={(e) =>
                onSetProperty(k, coerce(e.target.value, typeOf(v)))
              }
            />
            <button
              type="button"
              data-testid={`detail-prop-remove-${k}`}
              onClick={() => onRemoveProperty(k)}
            >
              x
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <input
            data-testid="detail-new-key"
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
            add
          </button>
        </div>
      </div>
    </div>
  );
}
