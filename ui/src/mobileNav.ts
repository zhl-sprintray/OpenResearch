/** Navigation state for the Mobile layout (MobileShell): drawer, new-session
 * page and the stack of full-screen panels. The current session is not here;
 * it stays in the route. Pure logic, no React. */

import type { ChatMessage, ChatPart, ChatSession } from "./api";
import type { Pane } from "./workspaceState";

export type MobilePanel =
  | { kind: "experiments" }
  | { kind: "experiment"; experimentId: string; runId?: string }
  | { kind: "artifacts" }
  | { kind: "artifact"; path: string }
  | { kind: "plan"; promptId: string }
  | { kind: "subagent"; partId: string };

export interface MobileNavState {
  drawerOpen: boolean;
  newSession: { open: boolean; projectId: string } | null;
  /** Full-screen panel stack; back = pop. */
  panels: MobilePanel[];
}

export type MobileNavEvent =
  | { type: "openDrawer" }
  | { type: "closeDrawer" }
  /** A session became current (picked in the drawer, or created by sending
   * the first message on the new-session page). */
  | { type: "selectSession" }
  /** `sessionProjectId` is the current session's project, if one is open. */
  | { type: "openNewSession"; sessionProjectId: string | null; routeProjectId: string }
  | { type: "pickNewSessionProject"; projectId: string }
  | { type: "closeNewSession" }
  | { type: "pushPanel"; panel: MobilePanel }
  | { type: "popPanel" }
  /** The route's `pane` now shows `panel` (null: the chat), e.g. after a
   * refresh, a shared link or browser back/forward. */
  | { type: "routePanel"; panel: MobilePanel | null }
  /** The viewport crossed the 768px breakpoint; the current session (in the
   * route) is kept. */
  | { type: "viewportCrossed" };

export const initialMobileNav: MobileNavState = { drawerOpen: false, newSession: null, panels: [] };

export function mobileNavReducer(state: MobileNavState, event: MobileNavEvent): MobileNavState {
  switch (event.type) {
    case "openDrawer": return { ...state, drawerOpen: true };
    case "closeDrawer": return { ...state, drawerOpen: false };
    case "selectSession": return initialMobileNav;
    case "openNewSession":
      return { ...state, drawerOpen: false, newSession: { open: true, projectId: event.sessionProjectId ?? event.routeProjectId } };
    case "pickNewSessionProject":
      return state.newSession ? { ...state, newSession: { ...state.newSession, projectId: event.projectId } } : state;
    case "closeNewSession": return { ...state, newSession: null };
    case "pushPanel": return { ...state, drawerOpen: false, panels: [...state.panels, event.panel] };
    case "popPanel": return state.panels.length ? { ...state, panels: state.panels.slice(0, -1) } : state;
    case "routePanel": return { ...state, panels: restorePanelStack(state.panels, event.panel) };
    case "viewportCrossed": return { ...state, drawerOpen: false, panels: [] };
  }
}

/** The stack to render when the route shows `top` (null: the chat). A panel
 * already in the stack keeps its place (browser back drops what was above it;
 * a different run of the same experiment replaces it); otherwise the route was
 * opened directly and a detail panel gets its list underneath. */
export function restorePanelStack(stack: readonly MobilePanel[], top: MobilePanel | null): MobilePanel[] {
  if (!top) return [];
  const index = stack.findIndex((panel) => panelIdentity(panel) === panelIdentity(top));
  if (index !== -1) return [...stack.slice(0, index), top];
  const parent = parentPanel(top);
  return parent ? [parent, top] : [top];
}

function parentPanel(panel: MobilePanel): MobilePanel | null {
  switch (panel.kind) {
    case "experiment": return { kind: "experiments" };
    case "artifact": return { kind: "artifacts" };
    default: return null;
  }
}

/** Which thing a panel shows, ignoring view state such as the selected run. */
function panelIdentity(panel: MobilePanel): string {
  switch (panel.kind) {
    case "experiments": case "artifacts": return panel.kind;
    case "experiment": return `experiment:${panel.experimentId}`;
    case "artifact": return `artifact:${panel.path}`;
    case "plan": return `plan:${panel.promptId}`;
    case "subagent": return `subagent:${panel.partId}`;
  }
}

/** The `pane` search param for a mobile panel, so refresh and shared links
 * reopen it. Plan and subagent panes are scoped to the current session. */
export function panelToPane(panel: MobilePanel, sessionId: string): Pane {
  switch (panel.kind) {
    case "experiments": return { kind: "home", view: "experiments" };
    case "experiment": return { kind: "experiment", experimentId: panel.experimentId, view: "overview", ...(panel.runId ? { runId: panel.runId } : {}) };
    case "artifacts": return { kind: "home", view: "artifacts" };
    case "artifact": return { kind: "file", path: panel.path, source: "artifacts" };
    case "plan": return { kind: "plan", sessionId, promptId: panel.promptId };
    case "subagent": return { kind: "subagent", sessionId, spawnPartId: panel.partId };
  }
}

/** What the Mobile layout shows for a `pane` search param: the chat, a mobile
 * panel, or the desktop-only placeholder (file browser, Git diff, terminal,
 * code edit; Overleaf opens `.tex` files through repo file panes). */
export type MobilePaneView =
  | { kind: "chat" }
  | { kind: "panel"; panel: MobilePanel }
  | { kind: "desktopOnly" };

export function mobilePaneView(pane: Pane | undefined): MobilePaneView {
  if (!pane) return { kind: "chat" };
  const panel = (value: MobilePanel): MobilePaneView => ({ kind: "panel", panel: value });
  switch (pane.kind) {
    case "home":
      if (pane.view === "experiments") return panel({ kind: "experiments" });
      if (pane.view === "artifacts") return panel({ kind: "artifacts" });
      return { kind: "desktopOnly" };
    case "experiment":
      if (pane.view === "terminal") return { kind: "desktopOnly" };
      return panel({ kind: "experiment", experimentId: pane.experimentId, ...(pane.runId ? { runId: pane.runId } : {}) });
    case "file":
      return pane.source === "artifacts" ? panel({ kind: "artifact", path: pane.path }) : { kind: "desktopOnly" };
    case "code": return { kind: "desktopOnly" };
    case "plan": return panel({ kind: "plan", promptId: pane.promptId });
    case "subagent": return panel({ kind: "subagent", partId: pane.spawnPartId });
    // Side chats are a desktop tab; on mobile the main chat stays in view.
    case "side": return { kind: "chat" };
  }
}

export interface PendingPrompts {
  /** Badge count on the menu button: sessions awaiting an answer, across
   * every listed project. */
  total: number;
  /** Unresolved prompts per awaiting session; drawer rows mark these. */
  bySession: Record<string, number>;
}

/** Derive the badge and drawer marks from the session summaries' server-
 * computed `pendingPromptIds` (kept live by `applyPromptMessage`). */
export function pendingPrompts(sessions: readonly Pick<ChatSession, "id" | "pendingPromptIds">[]): PendingPrompts {
  const bySession: Record<string, number> = {};
  for (const { id, pendingPromptIds } of sessions) {
    if (pendingPromptIds?.length) bySession[id] = pendingPromptIds.length;
  }
  return { total: Object.keys(bySession).length, bySession };
}

/** Fold a streamed `chat.message` into a session's unresolved prompt ids
 * (permission, plan, question — sub-agent transcripts included): new open
 * cards are added, answered ones removed. Returns `ids` itself when nothing
 * changed. */
export function applyPromptMessage(ids: readonly string[], message: ChatMessage): readonly string[] {
  const open = new Set(ids);
  const visit = (parts: readonly ChatPart[]) => {
    for (const part of parts) {
      if (part.prompt) {
        if (part.prompt.resolved) open.delete(part.id);
        else open.add(part.id);
      }
      if (part.children) visit(part.children);
    }
  };
  visit(message.parts);
  return open.size === ids.length && ids.every((id) => open.has(id)) ? ids : [...open];
}
