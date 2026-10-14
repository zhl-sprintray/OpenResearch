import { createFileRoute, notFound, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import App from "../App";
import { MobileShell } from "../MobileShell";
import { mobilePaneView, type MobilePaneView } from "../mobileNav";
import { useRuntime } from "../RemoteRuntime";
import { useMobileLayout } from "../useMobileLayout";
import { parseDestination, parsePane, type Pane } from "../workspaceState";

export const Route = createFileRoute("/projects/$projectId")({
  validateSearch: (search): { pane?: Pane } => ({ pane: parsePane(search.pane) }),
  beforeLoad: ({ location }) => { if (!parseDestination(location.pathname)) throw notFound(); },
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = Route.useParams();
  const { pane } = Route.useSearch();
  const router = useRouter();
  const location = useRouterState({ select: (state) => state.location });
  useEffect(() => {
    const search = normalizedPaneSearch(location.searchStr);
    if (search === null) return;
    void router.navigate({ href: `${location.pathname}${search}${location.hash ? `#${location.hash}` : ""}`, replace: true });
  }, [location, router]);
  const runtime = useRuntime();
  const mobile = useMobileLayout();
  if (!mobile) return <><Outlet /><App projectId={projectId} pane={pane} runtime={runtime} /></>;
  const destination = parseDestination(location.pathname);
  // Skills and settings have no Mobile layout entry; deep links get the placeholder.
  const view: MobilePaneView = destination?.kind === "skills" || destination?.kind === "settings" ? { kind: "desktopOnly" } : mobilePaneView(pane);
  return <><Outlet /><MobileShell projectId={projectId} sessionId={destination?.kind === "task" ? destination.sessionId ?? null : null} pane={pane} view={view} runtime={runtime} /></>;
}

export function normalizedPaneSearch(searchStr: string): string | null {
  const search = new URLSearchParams(searchStr);
  if (!search.has("pane")) return null;
  try {
    if (search.getAll("pane").length === 1 && parsePane(JSON.parse(search.get("pane") ?? ""))) return null;
  } catch { /* Invalid JSON is the same as an invalid pane descriptor. */ }
  search.delete("pane");
  const query = search.toString();
  return query ? `?${query}` : "";
}
