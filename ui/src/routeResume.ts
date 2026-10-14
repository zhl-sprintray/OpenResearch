import { queryClient } from "./queries/client";
import { getUiStateQuery, listProjectsQuery, getProjectUiStateQuery } from "./queries/projects";
import { listChatSessionsQuery } from "./queries/chat";
import { isDemoProjectId, type ChatSession } from "./api";
import { defaultTaskWorkspace } from "./workspaceTabs";
import { getTaskWorkspace, parseDestination, parsePane, safeLocation, taskLocation, type Pane } from "./workspaceState";
import { getRememberedGlobalWorkspace } from "./workspacePersistence";
import { getCachedProjectWorkspace } from "./useProjectWorkspace";
import { mobilePaneView } from "./mobileNav";

export interface ResumeOptions {
  /** The Mobile layout resumes into the chat: persisted desktop-only panes
   * and pages (settings, skills) are skipped, never rewritten in storage. */
  mobile?: boolean;
}

/** A persisted location as the Mobile layout should resume it: the same task
 * without a desktop-only pane, or null for a page with no mobile view. */
function mobileResume(location: string): string | null {
  const delimiter = location.indexOf("?");
  const destination = parseDestination(delimiter === -1 ? location : location.slice(0, delimiter));
  if (destination?.kind !== "task" || !destination.projectId) return null;
  const search = new URLSearchParams(delimiter === -1 ? "" : location.slice(delimiter + 1));
  let pane: Pane | undefined;
  try { pane = search.has("pane") ? parsePane(JSON.parse(search.get("pane") ?? "")) : undefined; } catch { pane = undefined; }
  return taskLocation(destination.projectId, destination.sessionId ?? null, pane && mobilePaneView(pane).kind !== "desktopOnly" ? pane : null);
}

function validSessionLocation(location: string, sessions: ChatSession[]): boolean {
  const destination = parseDestination(location.split("?")[0]);
  return Boolean(destination && (!destination.sessionId || sessions.some((session) =>
    session.id === destination.sessionId && session.projectId === destination.projectId)));
}

export async function globalResumeLocation(client = queryClient, options: ResumeOptions = {}): Promise<string> {
  const [state, projects] = await Promise.all([client.fetchQuery(getUiStateQuery()), client.fetchQuery(listProjectsQuery())]);
  const location = safeLocation((getRememberedGlobalWorkspace() ?? state.workspace)?.lastLocation);
  const fallback = () => projects[0] ? projectResumeLocation(projects[0].id, client, options) : Promise.resolve("/projects");
  if (!location) return fallback();
  const destination = parseDestination(location.split("?")[0]);
  if (!destination?.projectId) return fallback();
  if (!projects.some((project) => project.id === destination.projectId)) return fallback();
  if (destination.sessionId && !validSessionLocation(location, await client.fetchQuery(listChatSessionsQuery(destination.projectId))))
    return fallback();
  if (!options.mobile) return location;
  return mobileResume(location) ?? projectResumeLocation(destination.projectId, client, options);
}

export async function projectResumeLocation(projectId: string, client = queryClient, options: ResumeOptions = {}): Promise<string> {
  const [loaded, sessions] = await Promise.all([client.fetchQuery(getProjectUiStateQuery(projectId)), client.fetchQuery(listChatSessionsQuery(projectId))]);
  const state = getCachedProjectWorkspace(projectId) ?? loaded;
  const location = safeLocation(state?.lastLocation);
  if (location && parseDestination(location.split("?")[0])?.projectId === projectId
    && validSessionLocation(location, sessions)) {
    const resumed = options.mobile ? mobileResume(location) : location;
    if (resumed) return resumed;
  }
  const newest = sessions.find((session) => !session.archived && !session.sideParentSessionId);
  const defaults = isDemoProjectId(projectId) ? defaultTaskWorkspace(newest?.id, !(await client.fetchQuery(getUiStateQuery())).tourCompleted) : undefined;
  const task = getTaskWorkspace(state, newest?.id ?? "new");
  const rememberedPane = task ? task.active : defaults?.active;
  const pane = options.mobile && rememberedPane && mobilePaneView(rememberedPane).kind === "desktopOnly" ? null : rememberedPane;
  return taskLocation(projectId, newest?.id ?? null, pane);
}
