/** Which UI entry points this dashboard connection may show. Over Tunnel
 * access the server's allowlist refuses most writes and every local-machine
 * tool; the UI hides those entry points so nothing fails on click. This is
 * only presentation — the server enforces the boundary. Independent of the
 * Mobile layout: any combination of layout and access can occur. */

import type { ChatPrompt, RuntimeInfo } from "./api";
import type { ComposerCommandName } from "./composerCommands";

export interface Capabilities {
  /** Browse, send messages (images included), steer, interrupt, answer prompts. */
  chat: boolean;
  newSession: boolean;
  cancelRun: boolean;
  /** Change a session's permission or Plan mode (the server keeps it same-or-stricter). */
  permissionMode: boolean;
  /** Pick a permission mode looser than the session's (or, for a new
   * session, than the locally chosen one); see `permissionPicker`. */
  permissionModeLoosening: boolean;
  /** Project terminal and SSH connect terminals. */
  terminal: boolean;
  /** `!` shell commands in the composer. */
  shell: boolean;
  /** Browse, edit and diff the project's code and working tree, open or reveal files. */
  codeFiles: boolean;
  /** Rename, duplicate and delete artifacts (browsing them stays). */
  editArtifacts: boolean;
  /** The settings pages (env vars, tokens, data dir, compute, harness setup,
   * profile) and Customize (user skills, LaTeX templates). */
  settings: boolean;
  projectCreate: boolean;
  projectDelete: boolean;
  /** Check, install and apply updates; install the CLI. */
  updates: boolean;
  harnessSetup: boolean;
  overleaf: boolean;
  /** Save global UI state (e.g. the preferred agent for new sessions). */
  saveUiState: boolean;
  /** Rename, archive, goal and autonomy changes to a session. */
  editSession: boolean;
  /** Cancel or retry queued messages. */
  editQueue: boolean;
  compact: boolean;
  fork: boolean;
  sideChat: boolean;
  /** `/resume`: list and adopt chats from the agents' own CLIs. */
  importChats: boolean;
  archiveExperiment: boolean;
  /** Start, reconnect or stop Remote hosts. */
  remoteHosts: boolean;
  /** The Tunnel access settings section and its status badge. */
  tunnelSettings: boolean;
  /** Pick the mode a Claude plan approval resumes under (auto, bypass). Over
   * Tunnel access the server picks, capped at what a new session may use. */
  planResumeModes: boolean;
  /** Approve a Claude permission card that resumes by message: Claude only
   * grants the blocked tool under bypassPermissions, which would loosen the
   * session, so over Tunnel access it is approved on the computer instead. */
  endTurnApprovals: boolean;
}

/** How much a permission mode lets the agent do unasked, strictest first:
 * plan, ask, accept edits, auto, bypass. Mirrors the server's
 * `PermissionMode::from_id`, which every harness's wire ids resolve through. */
function looseness(id: string): number | null {
  switch (id) {
    case "plan": return 0;
    case "ask": case "manual": case "default": return 1;
    case "accept-edits": case "acceptEdits": return 2;
    case "auto": case "approve-for-me": case "auto-approve": return 3;
    case "bypass": case "bypassPermissions": case "full-access": return 4;
    default: return null;
  }
}

/** The permission modes the composer offers, and the one it shows when none
 * is chosen. Over Tunnel access a mode may only stay the same or get
 * stricter than `ceiling`: the open session's mode, or for a new session
 * the mode chosen locally for this harness. Without one, the server caps at
 * the harness's strictest mode that still asks (never its own default). */
export function permissionPicker<T extends { id: string }>(
  caps: Capabilities,
  choices: T[],
  ceiling: string | null | undefined,
  harnessDefault: string | null | undefined,
): { choices: T[]; defaultId: string | null } {
  if (caps.permissionModeLoosening) return { choices, defaultId: harnessDefault ?? null };
  const asking = choices
    .filter((choice) => (looseness(choice.id) ?? 0) > 0)
    .reduce<T | null>((best, choice) => (best && looseness(best.id)! <= looseness(choice.id)! ? best : choice), null);
  const cap = choices.find((choice) => choice.id === ceiling) ?? asking;
  const limit = cap ? looseness(cap.id) : null;
  if (limit === null) return { choices: [], defaultId: null };
  return {
    choices: choices.filter((choice) => {
      const rank = looseness(choice.id);
      return rank !== null && rank <= limit;
    }),
    defaultId: cap?.id ?? null,
  };
}

/** Whether a file tab or chip can load here. Over Tunnel access only the
 * artifacts store answers; repo and absolute-path files are desktop-only. */
export function fileReadable(caps: Capabilities, file: { source?: string | null }): boolean {
  return caps.codeFiles || file.source === "artifacts";
}

/** The view an experiment's Code tab shows. Over Tunnel access its committed
 * diff is readable but the branch's file browser is not. */
export function codeTabView<V extends "files" | "changes">(caps: Capabilities, view: V): V | "changes" {
  return caps.codeFiles ? view : "changes";
}

/** Whether this permission card must be approved on the computer: an
 * end-turn Claude approval (no live bridge request to answer) in a session
 * not already bypassing permissions. Denying it stays possible. */
export function approveOnComputer(
  caps: Capabilities,
  harness: string | null | undefined,
  permissionMode: string | null | undefined,
  prompt: Pick<ChatPrompt, "kind" | "nativeId">,
): boolean {
  return (
    !caps.endTurnApprovals &&
    prompt.kind === "permission" &&
    !prompt.nativeId &&
    harness === "claude-code" &&
    permissionMode !== "bypassPermissions"
  );
}

/** The composer's built-in commands this connection can't run. */
export function hiddenComposerCommands(caps: Capabilities): ComposerCommandName[] {
  const hidden: ComposerCommandName[] = [];
  if (!caps.editSession) hidden.push("goal");
  if (!caps.compact) hidden.push("compact");
  if (!caps.sideChat) hidden.push("side");
  if (!caps.importChats) hidden.push("resume");
  return hidden;
}

export function capabilities(runtime: RuntimeInfo): Capabilities {
  const local = !(runtime.kind === "local" && runtime.tunnelAccess === true);
  return {
    chat: true,
    newSession: true,
    cancelRun: true,
    permissionMode: true,
    permissionModeLoosening: local,
    terminal: local,
    shell: local,
    codeFiles: local,
    editArtifacts: local,
    settings: local,
    projectCreate: local,
    projectDelete: local,
    updates: local,
    harnessSetup: local,
    overleaf: local,
    saveUiState: local,
    editSession: local,
    editQueue: local,
    compact: local,
    fork: local,
    sideChat: local,
    importChats: local,
    archiveExperiment: local,
    remoteHosts: local,
    tunnelSettings: local,
    planResumeModes: local,
    endTurnApprovals: local,
  };
}
