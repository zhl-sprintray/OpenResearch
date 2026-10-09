import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, ChevronRight, FlaskConical, Menu, Monitor, Package, Plus, SquarePen } from "lucide-react";
import { useCallback, useReducer, useRef, useState } from "react";
import { DEFAULT_AUTONOMY, timeAgo, updateUiState, type AgentSelection, type Autonomy, type ChatSession, type Project, type RuntimeInfo, type UiState } from "./api";
import { capabilities } from "./capabilities";
import { ChatPanel } from "./components/ChatPanel";
import { OfflineBanner } from "./components/OfflineBanner";
import { StatusBadge } from "./components/StatusBadge";
import { Button, IconButton, Spinner } from "./components/ui";
import { cn } from "./components/ui/cn";
import { UpdateBanner, useUpdateStatus } from "./components/UpdateBanner";
import { MobilePanelBody } from "./components/MobilePanels";
import { MobileNewSession } from "./MobileNewSession";
import { initialMobileNav, mobileNavReducer, panelToPane, pendingPrompts, restorePanelStack, type MobilePaneView, type MobilePanel } from "./mobileNav";
import { m } from "./paraglide/messages.js";
import { queryClient, setScopedQueryData } from "./queries/client";
import { listChatSessionsQuery } from "./queries/chat";
import { getUiStateQuery, listProjectActivityQuery, listProjectsQuery } from "./queries/projects";
import { readSidebarIds, sidebarProjectSessions, sortSidebarProjects, toggleId, writeSidebarIds } from "./sidebarLayout";
import { useMobileSwipe } from "./useMobileSwipe";
import { useVisualViewportStyle } from "./useVisualViewport";
import { taskLocation, type Pane } from "./workspaceState";

/** Sessions per drawer group before "Show more", as in the desktop rail. */
const CHAT_LIMIT = 6;
const EMPTY_SESSIONS: ChatSession[] = [];

/** The Mobile layout's outer shell (viewports narrower than 768px): top bar,
 * session drawer, and the chat filling the screen, with full-screen panels
 * and the desktop-only placeholder over it. Inner content reuses the desktop
 * components; the current session and panel stay in the route. */
export function MobileShell({ projectId, sessionId, pane, view, runtime }: {
  projectId: string;
  sessionId: string | null;
  pane: Pane | undefined;
  view: MobilePaneView;
  runtime: RuntimeInfo;
}) {
  const router = useRouter();
  const [nav, dispatch] = useReducer(mobileNavReducer, initialMobileNav);
  const viewportStyle = useVisualViewportStyle();
  const caps = capabilities(runtime);
  const { status: updateStatus } = useUpdateStatus(runtime.kind === "local" && caps.updates);
  const projectsQuery = useQuery(listProjectsQuery());
  const { data: activity = [] } = useQuery(listProjectActivityQuery());
  const uiStateOptions = getUiStateQuery();
  const { data: uiState } = useQuery(uiStateOptions);
  const projects = projectsQuery.data ?? [];
  const [pinned] = useState(() => readSidebarIds("sidebar-pinned-projects"));
  const sortedProjects = sortSidebarProjects(projects, pinned, new Map(activity.map((item) => [item.projectId, item.lastActivityAt])));
  const sessionQueries = useQueries({
    // Every project's list feeds the pending badge, not just the open drawer.
    queries: sortedProjects.map((project) => listChatSessionsQuery(project.id)),
  });
  const sessionsByProject = new Map(sortedProjects.map((project, index) => [project.id, sessionQueries[index]]));
  const currentSessions = sessionsByProject.get(projectId)?.data;
  const project = projects.find((item) => item.id === projectId);
  const session = sessionId ? currentSessions?.find((item) => item.id === sessionId) : undefined;
  const allSessions = sessionQueries.flatMap((query) => query.data ?? EMPTY_SESSIONS);
  const pending = pendingPrompts(allSessions);

  const go = useCallback((href: string, replace = false) => void router.navigate({ href, replace }), [router]);
  const openSession = useCallback((target: string | null, options?: { replace?: boolean; projectId?: string }) => {
    dispatch({ type: "selectSession" });
    go(taskLocation(options?.projectId ?? projectId, target), options?.replace);
  }, [go, projectId]);
  const openNewSession = () => dispatch({ type: "openNewSession", sessionProjectId: sessionId ? projectId : null, routeProjectId: projectId });
  const routedPanel = view.kind === "panel" ? view.panel : null;
  const panels = restorePanelStack(nav.panels, routedPanel);
  const showPanel = (panel: MobilePanel | undefined, replace = false) =>
    go(taskLocation(projectId, sessionId, panel && panelToPane(panel, sessionId ?? "")), replace);
  // Each panel action first syncs the stack to what the route shows (refresh,
  // shared link, browser back), then pushes or pops.
  const openPanel = (panel: MobilePanel) => {
    dispatch({ type: "routePanel", panel: routedPanel });
    dispatch({ type: "pushPanel", panel });
    showPanel(panel);
  };
  const replacePanel = (panel: MobilePanel) => {
    dispatch({ type: "routePanel", panel: routedPanel });
    dispatch({ type: "popPanel" });
    dispatch({ type: "pushPanel", panel });
    showPanel(panel, true);
  };
  const back = () => {
    dispatch({ type: "routePanel", panel: routedPanel });
    dispatch({ type: "popPanel" });
    showPanel(panels.at(-2));
  };

  const shellRef = useRef<HTMLDivElement>(null);
  useMobileSwipe(shellRef, { drawerOpen: nav.drawerOpen, panelOpen: view.kind !== "chat" }, (action) => {
    if (action === "popPanel") back();
    else dispatch({ type: action });
  });

  const saveUiState = useMutation({
    mutationFn: updateUiState,
    onMutate: (body) => setScopedQueryData(uiStateOptions.queryKey, (current: UiState | undefined) => current && { ...current, ...body }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: uiStateOptions.queryKey }),
  });
  // Without UI-state writes (Tunnel access) a choice lasts for this page only:
  // update the cached UI state and skip the save.
  const keepUiState = useCallback((body: Partial<UiState>) => setScopedQueryData(uiStateOptions.queryKey, (current: UiState | undefined) => current && { ...current, ...body }), [uiStateOptions.queryKey]);
  const persistPreferredAgent = useCallback(async (selection: AgentSelection) => {
    if (caps.saveUiState) await saveUiState.mutateAsync({ preferredAgent: selection });
    else keepUiState({ preferredAgent: selection });
  }, [saveUiState, keepUiState, caps.saveUiState]);
  const persistPreferredAutonomy = useCallback((autonomy: Autonomy) => {
    if (caps.saveUiState) saveUiState.mutate({ preferredAutonomy: autonomy });
    else keepUiState({ preferredAutonomy: autonomy });
  }, [saveUiState, keepUiState, caps.saveUiState]);

  const sessionsError = sessionsByProject.get(projectId)?.error;
  const contentError = !currentSessions && sessionsError ? sessionsError.message
    : sessionId && currentSessions && !session ? m.model_picker_unavailable() : null;

  return (
    <div ref={shellRef} className="mobile-shell relative flex h-full w-full flex-col overflow-hidden bg-background text-text" style={viewportStyle}>
      {runtime.kind === "local" && <OfflineBanner compact />}
      {runtime.kind === "local" && caps.updates && <UpdateBanner status={updateStatus} compact />}
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton className="relative" aria-label={m.mobile_menu()} onClick={() => dispatch({ type: "openDrawer" })}>
          <Menu size={18} />
          {pending.total > 0 && (
            <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-amber px-1 text-xs font-semibold text-background">{pending.total}</span>
          )}
        </IconButton>
        <div className="min-w-0 flex-1 px-1">
          <div className="truncate text-sm font-medium">{session?.title?.trim() || m.chat_new_session()}</div>
          <div className="truncate text-xs text-subtext">{project?.name ?? ""}</div>
        </div>
        <IconButton aria-label={m.chat_panel_new_chat()} onClick={openNewSession}><Plus size={18} /></IconButton>
        <IconButton aria-label={m.app_experiments()} onClick={() => openPanel({ kind: "experiments" })}><FlaskConical size={18} /></IconButton>
        <IconButton aria-label={m.app_artifacts()} onClick={() => openPanel({ kind: "artifacts" })}><Package size={18} /></IconButton>
      </header>
      <main className="relative flex min-h-0 flex-1 flex-col">
        {!uiState || !project ? (
          <div className="flex flex-1 items-center justify-center" role="status"><Spinner /></div>
        ) : (
          <ChatPanel
            bare
            railOpen={false}
            onShowRail={() => dispatch({ type: "openDrawer" })}
            projectId={projectId}
            projectName={project.name}
            contentLoading={!currentSessions && !sessionsError}
            contentError={contentError}
            onRetryContent={() => void sessionsByProject.get(projectId)?.refetch()}
            mainView="chat"
            onSelectMainView={() => {}}
            onOpenExperiment={(experimentId) => openPanel({ kind: "experiment", experimentId })}
            onOpenPlan={(_plan, _sessionId, promptId) => openPanel({ kind: "plan", promptId })}
            onOpenSubagent={(_sessionId, partId) => openPanel({ kind: "subagent", partId })}
            runtime={runtime}
            activeSessionId={sessionId}
            onActiveSessionChange={openSession}
            preferredAgent={uiState.preferredAgent}
            onPreferredAgentChange={persistPreferredAgent}
            preferredAutonomy={uiState.preferredAutonomy ?? DEFAULT_AUTONOMY}
            onPreferredAutonomyChange={persistPreferredAutonomy}
          />
        )}
        {view.kind === "panel" && (
          <section className="absolute inset-0 z-30 flex flex-col bg-background" data-pane={pane?.kind}>
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
              <IconButton aria-label={m.mobile_back()} onClick={back}><ArrowLeft size={18} className="rtl:rotate-180" /></IconButton>
              <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{panelTitle(view.panel)}</div>
            </div>
            <MobilePanelBody projectId={projectId} sessionId={sessionId} panel={view.panel} onOpen={openPanel} onReplace={replacePanel} onBack={back} />
          </section>
        )}
        {view.kind === "desktopOnly" && (
          <section className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background p-8 text-center">
            <Monitor size={28} className="text-subtext" />
            <h2 className="m-0 text-lg font-medium">{m.mobile_desktop_only_title()}</h2>
            <p className="m-0 text-sm text-subtext">{m.mobile_desktop_only_body()}</p>
            <Button onClick={back}><ArrowLeft size={14} className="rtl:rotate-180" />{m.mobile_back()}</Button>
          </section>
        )}
      </main>
      {nav.newSession?.open && uiState && (
        <MobileNewSession
          projects={sortedProjects}
          projectId={nav.newSession.projectId}
          onProject={(id) => dispatch({ type: "pickNewSessionProject", projectId: id })}
          onClose={() => dispatch({ type: "closeNewSession" })}
          onCreated={(id, target) => openSession(id, { projectId: target })}
          runtime={runtime}
          preferredAgent={uiState.preferredAgent}
          onPreferredAgentChange={persistPreferredAgent}
          preferredAutonomy={uiState.preferredAutonomy ?? DEFAULT_AUTONOMY}
          onPreferredAutonomyChange={persistPreferredAutonomy}
        />
      )}
      {nav.drawerOpen && (
        <div className="absolute inset-0 z-40 flex">
          <SessionDrawer
            projects={sortedProjects}
            sessionsFor={(id) => sessionsByProject.get(id)?.data}
            activeId={sessionId}
            pending={pending.bySession}
            onNew={openNewSession}
            onOpen={(target) => openSession(target.id, { projectId: target.projectId })}
          />
          <button type="button" aria-label={m.mobile_close_menu()} className="min-w-0 flex-1 bg-modal-backdrop" onClick={() => dispatch({ type: "closeDrawer" })} />
        </div>
      )}
    </div>
  );
}

function panelTitle(panel: MobilePanel): string {
  switch (panel.kind) {
    case "experiments": case "experiment": return m.app_experiments();
    case "artifacts": case "artifact": return m.app_artifacts();
    case "plan": return m.chat_plan();
    case "subagent": return m.app_subagent();
  }
}

/** Left drawer: "New chat", then sessions grouped by project and collapsible,
 * ordered and filtered by the desktop rail's rules. */
function SessionDrawer({ projects, sessionsFor, activeId, pending, onNew, onOpen }: {
  projects: Project[];
  sessionsFor: (projectId: string) => ChatSession[] | undefined;
  activeId: string | null;
  pending: Record<string, number>;
  onNew: () => void;
  onOpen: (session: ChatSession) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => readSidebarIds("sidebar-collapsed-projects"));
  const [limits, setLimits] = useState<Record<string, number>>({});
  const toggle = (id: string) => {
    const next = toggleId(collapsed, id);
    setCollapsed(next);
    writeSidebarIds("sidebar-collapsed-projects", next);
  };
  return (
    <aside className="flex w-5/6 max-w-80 flex-col overflow-y-auto overscroll-contain border-e border-border bg-panel pb-[env(safe-area-inset-bottom)]">
      <button type="button" className="mx-3 mb-2 mt-3 flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm font-medium active:bg-surface" onClick={onNew}>
        <SquarePen size={16} />{m.chat_panel_new_chat()}
      </button>
      {projects.map((project) => {
        const open = !collapsed.includes(project.id);
        const sessions = sessionsFor(project.id);
        const matching = sidebarProjectSessions(sessions ?? EMPTY_SESSIONS, "active", activeId);
        const limit = limits[project.id] ?? CHAT_LIMIT;
        let visible = matching.slice(0, limit);
        const selected = matching.find((item) => item.id === activeId);
        if (selected && !visible.includes(selected)) visible = [...visible.slice(0, limit - 1), selected];
        return (
          <div key={project.id} className="border-t border-border">
            <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-2.5 text-start text-sm font-medium" onClick={() => toggle(project.id)}>
              {open ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted rtl:rotate-180" />}
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
            </button>
            {open && !sessions && <div className="px-4 py-2"><Spinner /></div>}
            {open && sessions && !matching.length && <div className="px-4 pb-2.5 text-sm text-subtext">{m.chat_no_sessions_yet()}</div>}
            {open && visible.map((item) => (
              <button type="button" key={item.id} aria-current={item.id === activeId || undefined}
                className={cn("flex w-full items-center gap-2 py-2.5 pe-4 ps-9 text-start active:bg-surface", item.id === activeId && "bg-surface font-medium")}
                onClick={() => onOpen(item)}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{item.title?.trim() || m.chat_new_session()}</span>
                <SessionMark session={item} pending={(pending[item.id] ?? 0) > 0} />
              </button>
            ))}
            {open && matching.length > visible.length && (
              <Button variant="ghost" size="small" className="ms-7 mb-1 font-normal text-subtext" onClick={() => setLimits((current) => ({ ...current, [project.id]: limit + CHAT_LIMIT }))}>
                {m.common_show_more()}
              </Button>
            )}
          </div>
        );
      })}
    </aside>
  );
}

function SessionMark({ session, pending }: { session: ChatSession; pending: boolean }) {
  if (pending) return <span className="shrink-0 rounded-full bg-accent-amber-subtle px-2 py-0.5 text-xs font-medium text-accent-amber">{m.mobile_pending()}</span>;
  if (session.busy) return <StatusBadge status="running" />;
  return <span className="shrink-0 text-xs text-muted">{timeAgo(session.updatedAt)}</span>;
}
