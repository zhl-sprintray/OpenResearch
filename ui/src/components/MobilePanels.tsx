import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, CircleStop, Folder, Package, FlaskConical } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  artifactUrl,
  cancelRun,
  respondChat,
  runDisplayStatus,
  timeAgo,
  type ArtifactEntry,
  type ChatPart,
  type Experiment,
  type PromptAnswer,
  type Run,
} from "../api";
import { ltr } from "../i18n";
import { capabilities } from "../capabilities";
import { appendLogTail, emptyLogTail, logTailLines } from "../logTail";
import type { MobilePanel } from "../mobileNav";
import { m } from "../paraglide/messages.js";
import { getChatMessagesQuery, listChatSessionsQuery } from "../queries/chat";
import { queryClient } from "../queries/client";
import { getArtifactsQuery } from "../queries/files";
import { listExperimentsQuery, listProjectsQuery, listRunsQuery } from "../queries/projects";
import { useRuntime } from "../RemoteRuntime";
import { followRunLog } from "../runLogStream";
import { useFileVersion } from "../useFileVersion";
import { ArtifactMarkdown, findArtifactEntry, previewKind, useTextBody } from "./ArtifactsTab";
import { BranchPill } from "./BranchPill";
import { findPartById } from "./ChatPanel";
import { CodeView } from "./CodeView";
import { FileTypeIcon } from "./FileTypeIcon";
import { MediaPreview } from "./MediaPreview";
import { Md } from "./Md";
import { HARNESS_LABELS } from "./ModelPicker";
import { PlanStrip } from "./PlanStrip";
import { StatusBadge } from "./StatusBadge";
import { SubagentTab } from "./SubagentTab";
import { Button, LoadingRow, Spinner } from "./ui";
import { cn } from "./ui/cn";
import { WorkspaceEmptyState } from "./WorkspaceEmptyState";

const SECTION_CLASS_NAME = "border-t border-border-variant px-4 py-4";
const HEADING_CLASS_NAME = "m-0 mb-2.5 text-sm font-semibold text-text";
const ROW_CLASS_NAME = "flex w-full items-center gap-3 border-b border-border-variant px-4 py-3 text-start active:bg-surface";

/** Body of one Mobile layout full-screen panel. The shell owns the frame (top
 * bar, Back); this renders the content, reusing the desktop's data queries
 * and viewers. Read-only apart from cancelling a run and answering a plan. */
export function MobilePanelBody({ projectId, sessionId, panel, onOpen, onReplace, onBack }: {
  projectId: string;
  /** The current chat session; plan and subagent panels read its transcript. */
  sessionId: string | null;
  panel: MobilePanel;
  /** Push a panel on top of this one. */
  onOpen: (panel: MobilePanel) => void;
  /** Swap this panel for another view of the same thing (e.g. another run). */
  onReplace: (panel: MobilePanel) => void;
  onBack: () => void;
}) {
  switch (panel.kind) {
    case "experiments":
      return <ExperimentList projectId={projectId} onOpen={(experimentId) => onOpen({ kind: "experiment", experimentId })} />;
    case "experiment":
      return (
        <ExperimentDetail
          key={panel.experimentId}
          projectId={projectId}
          experimentId={panel.experimentId}
          runId={panel.runId}
          onSelectRun={(runId) => onReplace({ kind: "experiment", experimentId: panel.experimentId, runId })}
        />
      );
    case "artifacts":
      return <ArtifactBrowser projectId={projectId} onOpen={(path) => onOpen({ kind: "artifact", path })} />;
    case "artifact":
      return <ArtifactViewer key={panel.path} projectId={projectId} path={panel.path} />;
    case "plan":
      return sessionId
        ? <PlanPanel projectId={projectId} sessionId={sessionId} promptId={panel.promptId} onAnswered={onBack} />
        : <Unavailable />;
    case "subagent":
      return sessionId
        ? <SubagentTab key={panel.partId} projectId={projectId} sessionId={sessionId} spawnPartId={panel.partId} />
        : <Unavailable />;
  }
}

function Unavailable() {
  return <div className="p-6 text-sm text-subtext">{m.model_picker_unavailable()}</div>;
}

function Loading() {
  return <div className="flex flex-1 items-center justify-center" role="status"><Spinner /></div>;
}

function Scroll({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]", className)}>{children}</div>;
}

/** Runs per experiment, newest first. */
function runsByExperiment(runs: readonly Run[]): Map<string, Run[]> {
  const byExperiment = new Map<string, Run[]>();
  for (const run of runs) {
    const list = byExperiment.get(run.experimentId);
    if (list) list.push(run);
    else byExperiment.set(run.experimentId, [run]);
  }
  for (const list of byExperiment.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  return byExperiment;
}

const isLive = (run: Run | undefined) => run?.status === "running" || run?.status === "starting";

function ExperimentList({ projectId, onOpen }: { projectId: string; onOpen: (experimentId: string) => void }) {
  const experimentsQuery = useQuery(listExperimentsQuery(projectId));
  const runsQuery = useQuery(listRunsQuery(projectId));
  const byExperiment = useMemo(() => runsByExperiment(runsQuery.data ?? []), [runsQuery.data]);
  if (experimentsQuery.error) return <div className="p-6 text-sm text-accent-red">{experimentsQuery.error.message}</div>;
  if (!experimentsQuery.data) return <Loading />;
  const latest = (experiment: Experiment) => byExperiment.get(experiment.id)?.[0];
  const experiments = experimentsQuery.data
    .filter((experiment) => !experiment.archived)
    .sort((a, b) => (latest(b)?.createdAt ?? b.createdAt) - (latest(a)?.createdAt ?? a.createdAt));
  if (!experiments.length) {
    return <WorkspaceEmptyState icon={FlaskConical} title={m.experiments_none_yet()} description={m.experiments_empty_description()} />;
  }
  return (
    <Scroll>
      {experiments.map((experiment) => {
        const run = latest(experiment);
        return (
          <button type="button" key={experiment.id} className={ROW_CLASS_NAME} onClick={() => onOpen(experiment.id)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text">{experiment.title || experiment.slug}</span>
              <span className="block truncate text-xs text-muted">{timeAgo(run?.createdAt ?? experiment.createdAt)}</span>
            </span>
            {run ? <StatusBadge status={runDisplayStatus(run)} /> : <span className="shrink-0 text-xs text-muted">{m.experiments_not_run_yet()}</span>}
          </button>
        );
      })}
    </Scroll>
  );
}

function ExperimentDetail({ projectId, experimentId, runId, onSelectRun }: {
  projectId: string;
  experimentId: string;
  runId: string | undefined;
  onSelectRun: (runId: string) => void;
}) {
  const experimentsQuery = useQuery(listExperimentsQuery(projectId));
  const runsQuery = useQuery(listRunsQuery(projectId));
  const { data: projects } = useQuery(listProjectsQuery());
  const project = projects?.find((item) => item.id === projectId);
  const runs = useMemo(() => runsByExperiment(runsQuery.data ?? []).get(experimentId) ?? [], [runsQuery.data, experimentId]);
  const [stopping, setStopping] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  if (!experimentsQuery.data || !runsQuery.data) return experimentsQuery.error ?? runsQuery.error ? <Unavailable /> : <Loading />;
  const experiment = experimentsQuery.data.find((item) => item.id === experimentId);
  const run = runId ? runs.find((item) => item.id === runId) : runs[0];
  if (!experiment || (runId && !run)) return <Unavailable />;
  const live = isLive(run);
  const cancelling = !!run && live && (run.cancelRequested || stopping === run.id);
  const stop = async (target: Run) => {
    setStopError(null);
    setStopping(target.id);
    try {
      await cancelRun(target.id);
    } catch (error) {
      setStopping(null);
      setStopError(error instanceof Error ? error.message : String(error));
    }
  };
  const runNumber = (id: string) => runs.length - runs.findIndex((item) => item.id === id);
  const command = run?.command || experiment.runCommand;

  return (
    <Scroll>
      <header className="flex items-start gap-3 px-4 pb-4 pt-4">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-lg font-semibold leading-tight text-text wrap-anywhere">{experiment.title || experiment.slug}</h2>
          <div className="mt-1 truncate text-xs text-muted">{run ? `${m.experiment_overview_run()} ${runNumber(run.id)} · ${timeAgo(run.createdAt)}` : m.experiments_not_run_yet()}</div>
        </div>
        <StatusBadge status={run ? (cancelling ? "cancelling" : runDisplayStatus(run)) : "idle"} />
      </header>
      {run && live && (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
          <Button disabled={cancelling} onClick={() => void stop(run)}>
            <CircleStop size={14} />
            {cancelling ? m.common_cancelling() : m.experiments_stop_run()}
          </Button>
          {stopError && <span className="text-sm text-accent-red wrap-anywhere" role="alert">{m.experiments_table_stop_failed()} {stopError}</span>}
        </div>
      )}
      <section className={SECTION_CLASS_NAME}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <BranchPill owner={project?.githubEnabled ? project.githubOwner : ""} repo={project?.githubEnabled ? project.githubRepo : ""} branch={experiment.branchName} />
        </div>
        {command && <code className="mt-3 block text-sm text-text wrap-anywhere">$ {command}</code>}
      </section>
      {experiment.description && (
        <section className={SECTION_CLASS_NAME}>
          <h3 className={HEADING_CLASS_NAME}>{m.experiment_overview_description()}</h3>
          <Md text={experiment.description} />
        </section>
      )}
      {run && live && (
        <section className={SECTION_CLASS_NAME}>
          <h3 className={HEADING_CLASS_NAME}>{m.mobile_log_tail()}</h3>
          <LogTail key={run.id} runId={run.id} />
        </section>
      )}
      {run?.resultMarkdown && (
        <section className={SECTION_CLASS_NAME}>
          <h3 className={HEADING_CLASS_NAME}>{m.mobile_result()}</h3>
          <div className={run.status === "failed" ? "text-accent-red" : undefined}><Md text={run.resultMarkdown} /></div>
        </section>
      )}
      {runs.length > 0 && (
        <section className={cn(SECTION_CLASS_NAME, "px-0 pb-0")}>
          <h3 className={cn(HEADING_CLASS_NAME, "px-4")}>{m.experiment_overview_run_history()}</h3>
          {runs.map((item) => (
            <button type="button" key={item.id} aria-current={item.id === run?.id || undefined}
              className={cn(ROW_CLASS_NAME, item.id === run?.id && "bg-surface")}
              onClick={() => onSelectRun(item.id)}
            >
              <span className="w-14 shrink-0 text-xs font-medium text-text">{m.experiment_overview_run()} {runNumber(item.id)}</span>
              <StatusBadge status={runDisplayStatus(item)} />
              <span className="ms-auto shrink-0 text-xs text-muted">{timeAgo(item.createdAt)}</span>
            </button>
          ))}
        </section>
      )}
    </Scroll>
  );
}

/** The newest lines of a run's log, following the live `run.log` stream. */
function LogTail({ runId }: { runId: string }) {
  const [tail, setTail] = useState(emptyLogTail);
  const scrollRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const decoder = new TextDecoder();
    return followRunLog(runId, (bytes) => {
      const text = decoder.decode(bytes, { stream: true });
      setTail((current) => appendLogTail(current, text));
    });
  }, [runId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);
  const lines = logTailLines(tail);
  return (
    <pre ref={scrollRef} dir="ltr" className="m-0 max-h-96 overflow-auto rounded-md bg-surface p-3 font-mono text-xs leading-normal text-text">
      {lines.length ? lines.join("\n") : <span className="text-muted">{m.mobile_log_waiting()}</span>}
    </pre>
  );
}

function ArtifactBrowser({ projectId, onOpen }: { projectId: string; onOpen: (path: string) => void }) {
  const query = useQuery(getArtifactsQuery(projectId));
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (query.error) return <div className="p-6 text-sm text-accent-red">{m.artifacts_tab_failed_to_load()} {ltr(query.error.message)}</div>;
  if (!query.data) return <Loading />;
  if (!query.data.entries.length) {
    return <WorkspaceEmptyState icon={Package} title={m.artifacts_tab_no_artifacts_yet()} description={m.artifacts_tab_this_is_the_project_s_durable_output_space()} />;
  }
  const toggle = (path: string) => setCollapsed((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const rows = (entries: ArtifactEntry[]): ReactNode => entries.map((entry) => {
    if (!entry.isDir) {
      return (
        <button type="button" key={entry.path} className="flex w-full items-center gap-2 py-2.5 pe-4 text-start text-sm text-text active:bg-surface" onClick={() => onOpen(entry.path)}>
          <FileTypeIcon name={entry.name} />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          <span className="shrink-0 text-xs text-muted">{timeAgo(entry.modifiedAt)}</span>
        </button>
      );
    }
    const open = !collapsed.has(entry.path);
    return (
      <div key={entry.path}>
        <button type="button" aria-expanded={open} className="flex w-full items-center gap-2 py-2.5 pe-4 text-start text-sm font-medium text-text active:bg-surface" onClick={() => toggle(entry.path)}>
          {open ? <ChevronDown size={14} className="shrink-0 text-muted" /> : <ChevronRight size={14} className="shrink-0 text-muted rtl:rotate-180" />}
          <Folder size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        {open && <div className="ps-5">{rows(entry.children ?? [])}</div>}
      </div>
    );
  });
  return (
    <Scroll className="ps-4">
      {rows(query.data.entries)}
      {query.data.truncated && <div className="py-2.5 pe-4 text-sm text-muted">{m.artifacts_tab_listing_truncated_the_folder_has_more_artifacts()}</div>}
    </Scroll>
  );
}

function ArtifactViewer({ projectId, path }: { projectId: string; path: string }) {
  const query = useQuery(getArtifactsQuery(projectId));
  if (query.error) return <div className="p-6 text-sm text-accent-red">{m.artifacts_tab_failed_to_load()} {ltr(query.error.message)}</div>;
  if (!query.data) return <Loading />;
  const entry = findArtifactEntry(query.data.entries, path);
  if (!entry || entry.isDir) return <div className="p-6 text-sm text-subtext">{m.artifacts_not_found()}</div>;
  return <ArtifactPreview projectId={projectId} entry={entry} entries={query.data.entries} />;
}

/** Read-only artifact preview: Markdown as a document, images and PDFs
 * inline, other text as code. No delete, rename or upload. */
function ArtifactPreview({ projectId, entry, entries }: { projectId: string; entry: ArtifactEntry; entries: ArtifactEntry[] }) {
  const kind = previewKind(entry);
  const version = useFileVersion(artifactUrl(projectId, entry.path));
  const { text, binary, truncated, error, wantsText } = useTextBody(projectId, entry, kind, version);
  const rawUrl = `${artifactUrl(projectId, entry.path)}&v=${encodeURIComponent(version ?? `${entry.modifiedAt}:${entry.size}`)}`;
  const note = "px-4 py-2.5 text-sm text-muted";

  let body: ReactNode;
  if (kind === "image" || kind === "audio" || kind === "video" || kind === "pdf") {
    body = <MediaPreview kind={kind} url={rawUrl} name={entry.name} />;
  } else if (kind === "download" || !wantsText || binary) {
    body = (
      <div className={note}>
        {kind === "download" || binary ? m.artifacts_binary_no_preview() : m.artifacts_too_large_to_preview()}{" "}
        <a href={rawUrl} {...(kind === "download" || binary ? { download: entry.name } : { target: "_blank", rel: "noopener noreferrer" })}>
          {kind === "download" || binary ? m.file_viewer_download() : m.artifacts_open_raw()}
        </a>
      </div>
    );
  } else if (error) {
    body = <div className={note}>{m.artifacts_tab_failed_to_load()} {ltr(error)}</div>;
  } else if (text === null) {
    body = <LoadingRow><Spinner /> {m.artifacts_tab_loading()}</LoadingRow>;
  } else if (kind === "markdown") {
    body = (
      <div className="px-4 pb-10 pt-4">
        <ArtifactMarkdown projectId={projectId} folder={entry.path.split("/").slice(0, -1).join("/")} markdown={text} entries={entries} />
      </div>
    );
  } else {
    body = <CodeView text={text} path={entry.path} />;
  }

  return (
    // `file-view` scopes the shared syntax-token colors onto the code view.
    <div className="file-view flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-variant px-4 py-2 text-sm text-subtext">
        <FileTypeIcon name={entry.name} />
        <span className="min-w-0 flex-1 truncate">{ltr(entry.path)}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto pb-[env(safe-area-inset-bottom)]">
        {body}
        {truncated && <div className={note}>{m.artifacts_tab_file_truncated_showing_the_first_512_kb()}</div>}
      </div>
    </div>
  );
}

/** The full plan from a chat plan card, with the approval actions while it is
 * unanswered. Answering returns to the chat, where the resumed turn streams. */
function PlanPanel({ projectId, sessionId, promptId, onAnswered }: {
  projectId: string;
  sessionId: string;
  promptId: string;
  onAnswered: () => void;
}) {
  const messagesQuery = useQuery(getChatMessagesQuery(sessionId));
  const { data: sessions } = useQuery(listChatSessionsQuery(projectId));
  const caps = capabilities(useRuntime());
  const [error, setError] = useState<string | null>(null);
  if (!messagesQuery.data) return messagesQuery.error ? <Unavailable /> : <Loading />;
  let part: ChatPart | null = null;
  for (const message of messagesQuery.data.messages) {
    part = findPartById(message.parts, promptId);
    if (part) break;
  }
  const prompt = part?.prompt;
  if (prompt?.kind !== "plan") return <Unavailable />;
  const harness = sessions?.find((item) => item.id === sessionId)?.harness;
  const respond = (answer: Omit<PromptAnswer, "promptId">) => {
    setError(null);
    void respondChat(sessionId, { promptId, ...answer })
      .then(onAnswered, (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => {
        void queryClient.fetchQuery({ ...getChatMessagesQuery(sessionId), staleTime: 0 }).catch(() => {});
        void queryClient.fetchQuery({ ...listChatSessionsQuery(projectId), staleTime: 0 }).catch(() => {});
      });
  };
  return (
    <>
      <Scroll className="px-4 py-4">
        <Md text={prompt.plan ?? ""} />
      </Scroll>
      {!prompt.resolved && (
        <div className="shrink-0 border-t border-border px-3 pb-[env(safe-area-inset-bottom)] pt-2.5">
          {error && <div className="pb-2 text-sm text-accent-red wrap-anywhere" role="alert">{m.chat_panel_failed()} {error}</div>}
          <PlanStrip
            synthesized={!!prompt.synthesized}
            agentLabel={harness ? HARNESS_LABELS[harness] : m.chat_the_agent()}
            showResumeModes={harness === "claude-code" && caps.planResumeModes}
            onApprove={(resumeMode) => respond({ approve: true, ...(resumeMode ? { resumeMode } : {}) })}
            onReject={() => respond({ approve: false })}
            onRevise={(note) => respond({ approve: false, note })}
          />
        </div>
      )}
    </>
  );
}
