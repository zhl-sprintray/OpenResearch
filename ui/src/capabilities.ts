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
