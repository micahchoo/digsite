// A report waits for the save that holds what the tab shows (report/saved.ts).
import { describe, expect, test } from 'bun:test';
import { isBehind, whenSaved } from '../src/report/saved.ts';

const el = (id: string, version: number, isDeleted = false) => ({
  id,
  version,
  isDeleted,
});

describe('isBehind', () => {
  test('an element missing or older in the save is behind', () => {
    expect(isBehind([el('a', 2)], [el('a', 2)])).toBe(false);
    expect(isBehind([el('a', 3)], [el('a', 2)])).toBe(true);
    expect(isBehind([el('b', 1)], [el('a', 2)])).toBe(true);
    // Someone else saved a newer version: not behind.
    expect(isBehind([el('a', 2)], [el('a', 5)])).toBe(false);
  });

  test('a local delete is saved once the element is gone', () => {
    expect(isBehind([el('a', 4, true)], [el('a', 3)])).toBe(true);
    expect(isBehind([el('a', 4, true)], [])).toBe(false);
  });
});

describe('whenSaved', () => {
  test('asks again until the save catches up', async () => {
    const saves = [[el('a', 1)], [el('a', 1)], [el('a', 2)]];
    let asked = 0;
    let waited = 0;
    const result = await whenSaved(
      async () => ({ scene: { elements: saves[asked++] ?? [] } }),
      [el('a', 2)],
      async () => {
        waited++;
      },
    );
    expect(result.complete).toBe(true);
    expect(asked).toBe(3);
    expect(waited).toBe(2);
  });

  test('gives up after its tries and says the report is incomplete', async () => {
    let asked = 0;
    const result = await whenSaved(
      async () => {
        asked++;
        return { scene: { elements: [el('a', 1)] } };
      },
      [el('a', 2)],
      async () => {},
      4,
    );
    expect(result.complete).toBe(false);
    expect(asked).toBe(4);
  });
});
