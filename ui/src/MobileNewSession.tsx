import { X } from "lucide-react";
import type { AgentSelection, Autonomy, Project, RuntimeInfo } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { MobileProjectChip } from "./components/MobileComposer";
import { IconButton } from "./components/ui";
import { m } from "./paraglide/messages.js";

/** The Mobile layout's full-screen new-session page: the composer, with
 * chips below the input for project, harness and model. Sending the first
 * message creates the session through the chat panel's usual create path;
 * `onCreated` then opens it. */
export function MobileNewSession({ projects, projectId, onProject, onClose, onCreated, runtime, preferredAgent, onPreferredAgentChange, preferredAutonomy, onPreferredAutonomyChange }: {
  projects: Project[];
  projectId: string;
  onProject: (projectId: string) => void;
  onClose: () => void;
  onCreated: (sessionId: string, projectId: string) => void;
  runtime: RuntimeInfo;
  preferredAgent: AgentSelection | null;
  onPreferredAgentChange: (selection: AgentSelection) => Promise<void>;
  preferredAutonomy: Autonomy;
  onPreferredAutonomyChange: (autonomy: Autonomy) => void;
}) {
  const project = projects.find((item) => item.id === projectId);
  return (
    <section className="absolute inset-0 z-30 flex flex-col bg-background" aria-label={m.chat_panel_new_chat()}>
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border px-2">
        <IconButton aria-label={m.mobile_close()} onClick={onClose}><X size={18} /></IconButton>
        <h1 className="m-0 min-w-0 flex-1 truncate px-1 text-sm font-medium">{m.chat_panel_new_chat()}</h1>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ChatPanel
          bare
          railOpen={false}
          onShowRail={() => {}}
          projectId={projectId}
          projectName={project?.name ?? ""}
          mainView="chat"
          onSelectMainView={() => {}}
          runtime={runtime}
          activeSessionId={null}
          // The first send creates the session and reports it here; other
          // changes (a `/new` with nothing sent) keep the page open.
          onActiveSessionChange={(sessionId, options) => { if (sessionId) onCreated(sessionId, options?.projectId ?? projectId); }}
          preferredAgent={preferredAgent}
          onPreferredAgentChange={onPreferredAgentChange}
          preferredAutonomy={preferredAutonomy}
          onPreferredAutonomyChange={onPreferredAutonomyChange}
          composerChips={<MobileProjectChip projects={projects} projectId={projectId} onSelect={onProject} />}
        />
      </div>
    </section>
  );
}
