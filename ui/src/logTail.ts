/** The last lines of a run's `run.log`, for the Mobile layout's live log
 * tail. Fed decoded text chunks in order; keeps only the newest lines so a
 * long-running log never grows the buffer. Pure logic, no React. */

export const LOG_TAIL_LINES = 50;

export interface LogTail {
  /** Complete lines, oldest first, at most the line limit. */
  lines: readonly string[];
  /** Text after the last newline: the line still being written. */
  partial: string;
}

export const emptyLogTail: LogTail = { lines: [], partial: "" };

export function appendLogTail(tail: LogTail, text: string, maxLines = LOG_TAIL_LINES): LogTail {
  if (!text) return tail;
  const pieces = (tail.partial + text).split("\n");
  const partial = overwritten(pieces.pop() ?? "");
  const lines = pieces.length ? [...tail.lines, ...pieces.slice(-maxLines).map(visible)].slice(-maxLines) : tail.lines;
  return { lines, partial };
}

/** The lines to show: complete lines plus the one in progress. */
export function logTailLines(tail: LogTail, maxLines = LOG_TAIL_LINES): string[] {
  const partial = visible(tail.partial);
  const lines = partial ? [...tail.lines, partial] : [...tail.lines];
  return lines.slice(-maxLines);
}

/** Drop what a carriage return overwrote (progress bars), keeping a trailing
 * `\r` so the next chunk still overwrites the line. */
function overwritten(line: string): string {
  return line.slice(line.lastIndexOf("\r", line.length - 2) + 1);
}

/** What a terminal would show for a line: its last carriage-return segment,
 * a CRLF ending ignored, colour and cursor escape sequences removed. */
function visible(line: string): string {
  return overwritten(line).replace(/\r$/, "").replace(ANSI_ESCAPE, "");
}

// CSI sequences (colours, cursor moves) and OSC sequences (titles, links).
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
