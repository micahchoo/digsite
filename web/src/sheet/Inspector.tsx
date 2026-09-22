// For an own element: kind, label/relation, direction, properties as
// editable rows. For a foreign selection: the sheet name, a jump link and
// "Copy to this sheet" (docs/design.md "web/"). Never edits a foreign
// element — there isn't one; see ../../.claude/rules/foreign-never-in-scene.md.
import { type PropertyValue, dataOf } from '@digsite/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Selected } from './tools.ts';

interface Props {
  selected: Selected | null;
  onSetProperty: (id: string, key: string, value: PropertyValue) => void;
  onRemoveProperty: (id: string, key: string) => void;
  onCopyForeign: (id: string) => void;
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
}: Props) {
  const [newKey, setNewKey] = useState('');

  if (!selected) {
    return (
      <div data-testid="inspector" className="muted">
        nothing selected
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
        <div
          style={{
            marginTop: 10,
            padding: 6,
            background: '#fafafa',
            border: '1px dashed #bbb',
          }}
        >
          <div>foreign from: {shape.sheetName}</div>
          <Link to={`/s/${shape.row.sheetId}`}>Jump to sheet</Link>
          <div style={{ marginTop: 6 }}>
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

  return (
    <div data-testid="inspector">
      <div>
        <b>kind:</b> {data.kind}
      </div>

      {(data.kind === 'region' || data.kind === 'edge') && (
        <div style={{ marginTop: 6 }}>
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
        <div style={{ marginTop: 6 }}>
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
        <div style={{ marginTop: 10 }}>
          <div>
            <b>properties</b>
          </div>
          {Object.entries(data.properties).map(([k, v]) => (
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
                style={{ width: 70 }}
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
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
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
