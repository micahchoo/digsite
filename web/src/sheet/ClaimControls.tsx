// The two choices an edge carries besides its relation, as radio groups so
// arrow keys move between them. Shared by the relation picker that opens
// when a connection is made and by the inspector, so both read the same.
import type { Confidence, Direction } from '@digsite/shared';
import { CONFIDENCES } from '@digsite/shared';
import { useId } from 'react';
import { Icon, type IconName } from '../components/Icon.tsx';

const DIRECTIONS: { value: Direction; icon: IconName; label: string }[] = [
  { value: 'forward', icon: 'arrowRight', label: 'From first to second' },
  { value: 'reverse', icon: 'arrowLeft', label: 'From second to first' },
  { value: 'both', icon: 'arrowBoth', label: 'Both ways' },
  { value: 'none', icon: 'minus', label: 'No direction' },
];

export function DirectionControl({
  value,
  onChange,
  testId,
}: {
  value: Direction;
  onChange: (direction: Direction) => void;
  testId?: string;
}) {
  const name = useId();
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label="Direction"
      data-testid={testId}
    >
      {DIRECTIONS.map((d) => (
        <label key={d.value} title={d.label}>
          <input
            type="radio"
            name={name}
            value={d.value}
            checked={value === d.value}
            aria-label={d.label}
            data-testid={testId ? `${testId}-${d.value}` : undefined}
            onChange={() => onChange(d.value)}
          />
          <Icon name={d.icon} size={16} />
        </label>
      ))}
    </div>
  );
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  confirmed: 'Confirmed',
  likely: 'Likely',
  unverified: 'Unverified',
};

/** Unset is a real state ("nobody said"), so choosing the current value
 * again clears it. */
export function ConfidenceControl({
  value,
  onChange,
  testId,
}: {
  value: Confidence | undefined;
  onChange: (confidence: Confidence | null) => void;
  testId?: string;
}) {
  const name = useId();
  return (
    <div
      className="segmented"
      role="radiogroup"
      aria-label="Confidence"
      data-testid={testId}
    >
      {CONFIDENCES.map((c) => (
        <label key={c} data-confidence={c}>
          <input
            type="radio"
            name={name}
            value={c}
            checked={value === c}
            data-testid={testId ? `${testId}-${c}` : undefined}
            onChange={() => onChange(c)}
            onClick={() => {
              if (value === c) onChange(null);
            }}
          />
          {CONFIDENCE_LABEL[c]}
        </label>
      ))}
    </div>
  );
}
