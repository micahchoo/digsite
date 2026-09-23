// The shell's one data source (docs/ux/design.md §3): every group the
// viewer belongs to (the rail), the current group's boards and each
// board's sheets (the channel column, nested — docs/phases/6-product.md
// "Sheets are threads"), and enough of the current route to build a
// breadcrumb. No new endpoint: `api.listGroups`/`listBoards`/`listSheets`
// are the same calls Groups.tsx/Group.tsx/Board.tsx already make.
//
// The URL alone doesn't carry a group id on a board or sheet route
// (`/b/:id`, `/s/:id`) — `getBoard`/`getSheet` are what a board/sheet page
// already fetches for itself, so this hook fetches the same thing again to
// learn the group id for the rail/channel column. A page whose fetch 403s
// or 404s leaves the shell showing whatever group context it last had
// (rail with no group highlighted, an empty channel column) while the
// page's own `ErrorState` explains what happened — the shell frame never
// blocks that from rendering (design principle 3: "the shell never
// disappears").
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router';
import {
  type BoardSummaryWithStats,
  type SheetSummaryWithStats,
  api,
} from '../lib/api.ts';
import { onSheetsChanged } from '../lib/sheetEvents.ts';

export type RouteKind = 'other' | 'groups' | 'group' | 'board' | 'sheet';

export interface ShellRoute {
  kind: RouteKind;
  groupId: string | null;
  groupName: string | null;
  boardId: string | null;
  boardName: string | null;
  sheetId: string | null;
  sheetName: string | null;
}

export interface ShellData {
  route: ShellRoute;
  groups: Awaited<ReturnType<typeof api.listGroups>>;
  boards: BoardSummaryWithStats[];
  sheetsByBoard: Record<string, SheetSummaryWithStats[]>;
  /** Every group/board/sheet the quick switcher can jump to — the same
   * data the rail/channel column already hold, flattened. */
  refreshGroups: () => void;
}

function routeKindOf(pathname: string): RouteKind {
  if (pathname === '/groups') return 'groups';
  if (/^\/g\//.test(pathname)) return 'group';
  if (/^\/b\//.test(pathname)) return 'board';
  if (/^\/s\//.test(pathname)) return 'sheet';
  return 'other';
}

export function useShellData(): ShellData {
  const location = useLocation();
  const [groups, setGroups] = useState<
    Awaited<ReturnType<typeof api.listGroups>>
  >([]);
  const [groupsTick, setGroupsTick] = useState(0);
  const [resolved, setResolved] = useState<{
    groupId: string | null;
    boardId: string | null;
    boardName: string | null;
    sheetId: string | null;
    sheetName: string | null;
  }>({
    groupId: null,
    boardId: null,
    boardName: null,
    sheetId: null,
    sheetName: null,
  });
  const [boards, setBoards] = useState<BoardSummaryWithStats[]>([]);
  const [sheetsByBoard, setSheetsByBoard] = useState<
    Record<string, SheetSummaryWithStats[]>
  >({});

  const kind = routeKindOf(location.pathname);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch is triggered BY refreshGroups() bumping groupsTick, not by reading it
  useEffect(() => {
    void api
      .listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [groupsTick]);

  // -- resolve the route to a group id (and, on a board/sheet route, its
  // board/sheet name for the breadcrumb) ------------------------------------
  useEffect(() => {
    let cancelled = false;
    const gm = location.pathname.match(/^\/g\/([^/]+)/);
    const bm = location.pathname.match(/^\/b\/([^/]+)/);
    const sm = location.pathname.match(/^\/s\/([^/]+)/);

    async function run() {
      if (gm) {
        if (!cancelled) {
          setResolved({
            groupId: gm[1] ?? null,
            boardId: null,
            boardName: null,
            sheetId: null,
            sheetName: null,
          });
        }
        return;
      }
      if (bm) {
        const boardId = bm[1] ?? '';
        try {
          const b = await api.getBoard(boardId);
          if (cancelled) return;
          setResolved({
            groupId: b.groupId,
            boardId,
            boardName: b.name,
            sheetId: null,
            sheetName: null,
          });
        } catch {
          if (!cancelled) {
            setResolved((prev) => ({
              ...prev,
              boardId,
              boardName: null,
              sheetId: null,
              sheetName: null,
            }));
          }
        }
        return;
      }
      if (sm) {
        const sheetId = sm[1] ?? '';
        try {
          const s = await api.getSheet(sheetId);
          if (cancelled) return;
          setResolved((prev) => ({
            ...prev,
            boardId: s.boardId,
            sheetId,
            sheetName: s.name,
          }));
          const b = await api.getBoard(s.boardId);
          if (cancelled) return;
          setResolved((prev) => ({
            ...prev,
            groupId: b.groupId,
            boardName: b.name,
          }));
        } catch {
          if (!cancelled) {
            setResolved((prev) => ({
              ...prev,
              sheetId,
              sheetName: null,
            }));
          }
        }
        return;
      }
      if (!cancelled) {
        setResolved({
          groupId: null,
          boardId: null,
          boardName: null,
          sheetId: null,
          sheetName: null,
        });
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const groupId = resolved.groupId;
  // Slice 2 follow-up (a): a sheet created/renamed/deleted/grown elsewhere
  // on the page (the board tray, the sheet page's own rename) bumps this so
  // the effect below refetches — an event the pages emit, never a poll.
  const [sheetsTick, setSheetsTick] = useState(0);
  useEffect(() => onSheetsChanged(() => setSheetsTick((n) => n + 1)), []);

  // -- the current group's boards, each with its own sheets ----------------
  // Slice 2 follow-up (b): ONE `GET /groups/:id/sheets` call instead of a
  // `listSheets` per board — the sheet list already carries every board's
  // sheets in one response; group it client-side.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch is triggered BY sheetsTick bumping, not by reading it
  useEffect(() => {
    let cancelled = false;
    if (!groupId) {
      setBoards([]);
      setSheetsByBoard({});
      return;
    }
    async function run() {
      try {
        const list = groupId ? await api.listBoards(groupId) : [];
        if (cancelled) return;
        // docs/ux/audit.md #14: the board list mixed real content with
        // undifferentiated test boards, unsorted — most-recently-active
        // first is the shell's own fix, same rule the group homepage's
        // badge row will use in slice 5.
        const sorted = [...list].sort((a, b) =>
          (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
        );
        setBoards(sorted);
        const allSheets = groupId ? await api.listGroupSheets(groupId) : [];
        if (cancelled) return;
        const grouped: Record<string, SheetSummaryWithStats[]> = {};
        for (const b of sorted) grouped[b.id] = [];
        for (const s of allSheets) {
          grouped[s.boardId]?.push(s);
        }
        setSheetsByBoard(grouped);
      } catch {
        if (!cancelled) {
          setBoards([]);
          setSheetsByBoard({});
        }
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [groupId, sheetsTick]);

  const groupName = useMemo(
    () => groups.find((g) => g.id === groupId)?.name ?? null,
    [groups, groupId],
  );

  const route: ShellRoute = {
    kind,
    groupId,
    groupName,
    boardId: resolved.boardId,
    boardName: resolved.boardName,
    sheetId: resolved.sheetId,
    sheetName: resolved.sheetName,
  };

  return {
    route,
    groups,
    boards,
    sheetsByBoard,
    refreshGroups: () => setGroupsTick((n) => n + 1),
  };
}
