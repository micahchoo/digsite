import { beforeEach, describe, expect, test } from 'bun:test';
import { type Answer, RankedView } from '../src/board/ranked-view.ts';
import {
  noteOrderVersion,
  resetOrderVersionsForTest,
} from '../src/lib/order-version.ts';

beforeEach(resetOrderVersionsForTest);

/** A reply as the api client makes it: the store has noted its build, and
 * the side table says which build it came from. */
function server() {
  const builds = new WeakMap<object, string>();
  return {
    buildOf: (answer: object) => builds.get(answer),
    reply<T extends object>(value: T, build?: string): T {
      if (build) {
        noteOrderVersion('b', 's', build);
        builds.set(value, build);
      }
      return value;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the ranked view', () => {
  test('delivers an answer that names its build, and one that names none', async () => {
    const s = server();
    const view = new RankedView('b', 's', s);
    const got: (Answer<{ n: number }> | null)[] = [];
    view.answer(
      async () => s.reply({ n: 1 }, 'A'),
      (a) => got.push(a),
    );
    view.answer(
      async () => s.reply({ n: 2 }),
      (a) => got.push(a),
    );
    await settle();
    expect(got.map((a) => a?.value?.n)).toEqual([1, 2]);
    expect(view.build).toBe('A');
    view.dispose();
  });

  test('the first build of a visit is not a move', async () => {
    const s = server();
    const view = new RankedView('b', 's', s);
    let moves = 0;
    view.onMove(() => moves++);
    let asked = 0;
    view.answer(
      async () => {
        asked++;
        return s.reply({}, 'A');
      },
      () => {},
    );
    await settle();
    expect(moves).toBe(0);
    expect(asked).toBe(1);
    view.dispose();
  });

  test('a newer build clears every answer, asks each again and tells the caches', async () => {
    const s = server();
    noteOrderVersion('b', 's', 'A');
    const view = new RankedView('b', 's', s);
    let build = 'A';
    const sections: (Answer<{ from: string }> | null)[] = [];
    const find: (Answer<{ from: string }> | null)[] = [];
    let moves = 0;
    view.onMove(() => moves++);
    view.answer(
      async () => s.reply({ from: build }, build),
      (a) => sections.push(a),
    );
    view.answer(
      async () => s.reply({ from: build }, build),
      (a) => find.push(a),
    );
    await settle();
    build = 'B';
    noteOrderVersion('b', 's', 'B'); // a tile named it first
    await settle();
    expect(moves).toBe(1);
    expect(sections.map((a) => a?.value?.from ?? null)).toEqual([
      'A',
      null,
      'B',
    ]);
    expect(find.map((a) => a?.value?.from ?? null)).toEqual(['A', null, 'B']);
    view.dispose();
  });

  test('a slow reply from the build before a move is never delivered', async () => {
    const s = server();
    noteOrderVersion('b', 's', 'A');
    const view = new RankedView('b', 's', s);
    const slow = deferred<{ from: string }>();
    let first = true;
    const got: string[] = [];
    view.answer(
      () => {
        if (first) {
          first = false;
          return slow.promise;
        }
        return Promise.resolve(s.reply({ from: 'B' }, 'B'));
      },
      (a) => {
        if (a?.value) got.push(a.value.from);
      },
    );
    noteOrderVersion('b', 's', 'B');
    await settle();
    slow.resolve(s.reply({ from: 'A' }, 'A'));
    await settle();
    expect(got).toEqual(['B']);
    view.dispose();
  });

  test('a reply from an older build with no move since is asked for again', async () => {
    const s = server();
    noteOrderVersion('b', 's', 'A');
    noteOrderVersion('b', 's', 'B');
    const view = new RankedView('b', 's', s);
    let calls = 0;
    const got: string[] = [];
    view.answer(
      async () => {
        calls++;
        // A server cache lagging one answer behind.
        return calls === 1
          ? s.reply({ from: 'A' }, 'A')
          : s.reply({ from: 'B' }, 'B');
      },
      (a) => {
        if (a?.value) got.push(a.value.from);
      },
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toBe(2);
    expect(got).toEqual(['B']);
    view.dispose();
  });

  test('a stopped answer is never delivered or asked again', async () => {
    const s = server();
    noteOrderVersion('b', 's', 'A');
    const view = new RankedView('b', 's', s);
    let asked = 0;
    const got: unknown[] = [];
    const stop = view.answer(
      async () => {
        asked++;
        return s.reply({}, 'A');
      },
      (a) => got.push(a),
    );
    stop();
    await settle();
    noteOrderVersion('b', 's', 'B');
    await settle();
    expect(asked).toBe(1);
    expect(got).toEqual([]);
    view.dispose();
  });

  test('a delayed question asks once, after the delay', async () => {
    const s = server();
    const view = new RankedView('b', 's', s);
    let asked = 0;
    view.answer(
      async () => {
        asked++;
        return s.reply({});
      },
      () => {},
      50,
    );
    expect(asked).toBe(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(asked).toBe(1);
    view.dispose();
  });

  test('another sort on the same board is not this view', async () => {
    const s = server();
    noteOrderVersion('b', 's', 'A');
    const view = new RankedView('b', 's', s);
    let moves = 0;
    view.onMove(() => moves++);
    noteOrderVersion('b', 'other.asc', 'X');
    await settle();
    expect(moves).toBe(0);
    view.dispose();
  });
});
