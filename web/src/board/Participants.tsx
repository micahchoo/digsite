// Who has been in a sheet (SheetSummary.participants): their initials, most
// recent first, each named on hover and to a screen reader. The server sends
// five at most; a sheet nobody has marked yet shows nothing.
import type { Participant } from '@digsite/shared';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';

export function Participants({ people }: { people: readonly Participant[] }) {
  if (!people.length) return null;
  const names = people.map((p) => p.name).join(', ');
  return (
    <span
      className="participants"
      data-testid="sheet-participants"
      title={`Been here: ${names}`}
      aria-label={`Been here: ${names}`}
      role="img"
    >
      {people.map((p) => (
        <span key={p.id} className="participant" aria-hidden="true">
          {initials(p.name)}
        </span>
      ))}
    </span>
  );
}
