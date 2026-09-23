// What travels when another sheet's claim is copied here (copy-foreign.ts):
// the shape always, then the label, each property, and for a connection how
// sure it was and why, and its region ends. Everything starts chosen, which
// is what a copy did before there was a choice.
import { useState } from 'react';
import { type CopyChoice, fullChoice } from './copy-foreign.ts';
import type { ForeignShape } from './overlay/screen.ts';

export function CopyChooser({
  shape,
  onCopy,
  onCancel,
}: {
  shape: ForeignShape;
  /** Copies with the choice; the reason when it could not. */
  onCopy: (choice: CopyChoice) => string | null;
  onCancel: () => void;
}) {
  const [choice, setChoice] = useState(() => fullChoice(shape));
  const [refused, setRefused] = useState<string | null>(null);
  const keys = Object.keys(shape.row.properties);
  const edge = shape.kind === 'edge' ? shape.row : null;
  const hasReasons = !!edge && (!!edge.confidence || !!edge.note);
  const hasRegionEnds =
    !!edge && (!!edge.source.regionSourceId || !!edge.target.regionSourceId);
  const labelText =
    shape.kind === 'edge'
      ? `Relation: ${shape.row.relation || 'unnamed'}`
      : `Label: ${shape.row.label || 'none'}`;
  const toggle = (key: string, on: boolean) =>
    setChoice((c) => ({
      ...c,
      properties: on
        ? [...c.properties, key]
        : c.properties.filter((k) => k !== key),
    }));

  return (
    <form
      className="copy-chooser"
      data-testid="copy-chooser"
      onSubmit={(e) => {
        e.preventDefault();
        setRefused(onCopy(choice));
      }}
    >
      <p className="copy-chooser-lead">
        The {shape.kind === 'edge' ? 'connection' : 'region'} is copied as an
        ordinary claim of this sheet. Choose what comes with it.
      </p>
      <label>
        <input
          type="checkbox"
          data-testid="copy-choice-label"
          checked={choice.label}
          onChange={(e) => setChoice({ ...choice, label: e.target.checked })}
        />
        {labelText}
      </label>
      {keys.map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            data-testid={`copy-choice-property-${key}`}
            checked={choice.properties.includes(key)}
            onChange={(e) => toggle(key, e.target.checked)}
          />
          {key}: {String(shape.row.properties[key])}
        </label>
      ))}
      {hasReasons && (
        <label>
          <input
            type="checkbox"
            data-testid="copy-choice-reasons"
            checked={choice.reasons}
            onChange={(e) =>
              setChoice({ ...choice, reasons: e.target.checked })
            }
          />
          How sure, and why
        </label>
      )}
      {hasRegionEnds && (
        <label>
          <input
            type="checkbox"
            data-testid="copy-choice-ends"
            checked={choice.ends}
            onChange={(e) => setChoice({ ...choice, ends: e.target.checked })}
          />
          The regions it joins
        </label>
      )}
      {refused && (
        <p className="copy-chooser-refused" role="alert">
          {refused}
        </p>
      )}
      <div className="copy-chooser-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" data-testid="copy-foreign-confirm">
          Copy
        </button>
      </div>
    </form>
  );
}
