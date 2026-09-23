import type { Properties, PropertyValue } from '@digsite/shared';
import { isValidPropertyKey } from './property-index.ts';

const MAX_PROPERTY_KEYS = 256;
const MAX_LIST_ITEMS = 1_000;
const MAX_TEXT_LENGTH = 10_000;

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

function isPropertyValue(value: unknown): value is PropertyValue {
  if (isScalar(value))
    return typeof value !== 'string' || value.length <= MAX_TEXT_LENGTH;
  return (
    Array.isArray(value) &&
    value.length <= MAX_LIST_ITEMS &&
    value.every(
      (item) =>
        isScalar(item) &&
        (typeof item !== 'string' || item.length <= MAX_TEXT_LENGTH),
    )
  );
}

/** Validates the JSON property map before it reaches typed sorts and filters. */
export function isProperties(value: unknown): value is Properties {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_PROPERTY_KEYS &&
    entries.every(
      ([key, property]) =>
        key.length <= 100 &&
        isValidPropertyKey(key) &&
        isPropertyValue(property),
    )
  );
}
