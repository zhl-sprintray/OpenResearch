import type { ChatSession, Project } from "./api";

export type SidebarRow =
  | { kind: "project"; project: Project; collapsed: boolean; busy: boolean }
  | { kind: "chat"; project: Project; session: ChatSession }
  | { kind: "more"; project: Project }
  | { kind: "status"; project: Project; pending: boolean; error: boolean; retry: () => void };

export const sidebarRowHeight = (row: SidebarRow) => row.kind === "project" ? 36 : 34;

export function fitSidebarRows(rows: SidebarRow[], height: number, activeId: string | null): SidebarRow[] {
  const selected = rows.find((row) => row.kind === "chat" && row.session.id === activeId);
  const header = selected && rows.find((row) => row.kind === "project" && row.project.id === selected.project.id);
  const fit = (candidates: SidebarRow[], available: number) => {
    const result: SidebarRow[] = [];
    let used = 0;
    for (const row of candidates) {
      if (used + sidebarRowHeight(row) > available) break;
      result.push(row);
      used += sidebarRowHeight(row);
    }
    const last = result.at(-1);
    if (last?.kind === "project" && !last.collapsed) result.pop();
    return result;
  };
  const visible = fit(rows, height);
  if (!selected || visible.includes(selected)) return visible;
  if (!header) return height < 34 ? visible : [...fit(rows.filter((row) => row !== selected), height - 34), selected];
  if (height < 70) return visible;
  return [
    ...fit(rows.filter((row) => row.project.id !== selected.project.id), height - 70),
    header,
    selected,
  ];
}

/* Rules shared by the desktop rail and the Mobile layout drawer. */

export type SessionFilter = "active" | "archived" | "all";

/** Pinned projects first, then most recent activity. */
export function sortSidebarProjects(projects: readonly Project[], pinned: readonly string[], lastActivity: ReadonlyMap<string, number>): Project[] {
  return [...projects].sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id))
    || Math.max(lastActivity.get(b.id) ?? 0, b.updatedAt) - Math.max(lastActivity.get(a.id) ?? 0, a.updatedAt));
}

/** A project's sessions as its sidebar group lists them, newest first: side
 * chats are hidden, and the current session always shows whatever the filter. */
export function sidebarProjectSessions(sessions: readonly ChatSession[], filter: SessionFilter, activeId: string | null): ChatSession[] {
  const matches = (archived: boolean) => filter === "all" ? true : filter === "archived" ? archived : !archived;
  return sessions
    .filter((session) => !session.sideParentSessionId && (matches(session.archived) || session.id === activeId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export type SidebarIdList = "sidebar-pinned-projects" | "sidebar-collapsed-projects";

/** Project ids remembered in this browser (pinned or collapsed groups). */
export function readSidebarIds(key: SidebarIdList): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function writeSidebarIds(key: SidebarIdList, ids: readonly string[]): void {
  try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* storage unavailable: keep it in memory */ }
}

/** Add `id` if absent, remove it if present. */
export const toggleId = (ids: readonly string[], id: string): string[] =>
  ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
