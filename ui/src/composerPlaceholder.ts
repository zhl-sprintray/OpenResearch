import { m } from "./paraglide/messages.js";

export interface ComposerPlaceholderInput {
  /** A pending question card owns typed text (see ChatPanel's send()). */
  answeringQuestion: boolean;
  /** While a steerable turn runs, Enter goes to that turn: name the gesture and its queue chord. */
  steer: { harness: string; shortcut: string } | null;
  /** The harness the composer sends to, or null before one is selected. */
  harness: string | null;
  harnessReady: boolean;
  /** Whether a leading `!` runs a shell command (not on mobile or over Tunnel access). */
  shell: boolean;
}

export function composerPlaceholder({ answeringQuestion, steer, harness, harnessReady, shell }: ComposerPlaceholderInput): string {
  if (answeringQuestion) return m.chat_type_custom_answer();
  if (steer) return m.chat_steer_placeholder(steer);
  if (harness === null) return shell ? m.chat_ask_agent_placeholder() : m.chat_ask_agent_placeholder_no_shell();
  if (!harnessReady) return m.chat_harness_unavailable({ harness });
  return shell ? m.chat_message_harness({ harness }) : m.chat_message_harness_no_shell({ harness });
}
