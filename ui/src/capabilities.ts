/** Which UI entry points this dashboard connection may show. Over Tunnel
 * access the server's allowlist refuses most writes and every local-machine
 * tool; the UI hides those entry points so nothing fails on click. This is
 * only presentation — the server enforces the boundary. Independent of the
 * Mobile layout: any combination of layout and access can occur. */

import type { RuntimeInfo } from "./api";

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
  /** The settings page: env vars, tokens, data dir, compute, profile. */
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
  archiveExperiment: boolean;
  /** Start, reconnect or stop Remote hosts. */
  remoteHosts: boolean;
  /** The Tunnel access settings section and its status badge. */
  tunnelSettings: boolean;
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
    archiveExperiment: local,
    remoteHosts: local,
    tunnelSettings: local,
  };
}
