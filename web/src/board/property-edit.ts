// A property's value as a person edits it. Five types, in the shapes the
// server reads them (routes.ts#sortableKeysFor): text; a number; yes/no; a
// date, which is a `YYYY-MM-DD` string; a list, which is an array.
//
// Editing works on a draft string and saves on commit, never per keystroke:
// before, "-3" could not be typed, because "-" became 0 at once, and a list
// became text on its first edit.
import type { PropertyScalar, PropertyValue } from '@digsite/shared';

export type PropertyType = 'text' | 'number' | 'boolean' | 'date' | 'list';

export const TYPE_LABELS: [PropertyType, string][] = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['boolean', 'Yes/no'],
  ['date', 'Date'],
  ['list', 'List'],
];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day, written as the server sorts it. */
export function isDate(raw: string): boolean {
  if (!DATE.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === raw;
}

export function typeOfValue(v: PropertyValue): PropertyType {
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return isDate(v) ? 'date' : 'text';
}

/** The value as the field shows it. A list is its items, comma separated. */
export function draftOf(v: PropertyValue): string {
  return Array.isArray(v) ? v.map(String).join(', ') : String(v);
}

export type Parsed = { value: PropertyValue } | { error: string };

/** A draft read as `type`, or why it is not one. */
export function parseDraft(raw: string, type: PropertyType): Parsed {
  const text = raw.trim();
  switch (type) {
    case 'number': {
      const n = Number(text);
      return text !== '' && Number.isFinite(n)
        ? { value: n }
        : { error: 'Not a number' };
    }
    case 'boolean':
      if (/^(true|yes|y|1)$/i.test(text)) return { value: true };
      if (/^(false|no|n|0|)$/i.test(text)) return { value: false };
      return { error: 'Yes or no' };
    case 'date':
      return isDate(text)
        ? { value: text }
        : { error: 'A date, as 2026-09-23' };
    case 'list':
      return {
        value: text
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      };
    case 'text':
      return { value: raw };
  }
}

/** The same value as another type, or why it cannot be one. A list turned
 * into anything else is its items joined; anything turned into a list is a
 * list of one. */
export function convert(v: PropertyValue, to: PropertyType): Parsed {
  if (to === 'list')
    return {
      value: Array.isArray(v)
        ? v
        : draftOf(v) === ''
          ? []
          : [v as PropertyScalar],
    };
  return parseDraft(draftOf(v), to);
}
