/** What the desktop "Tunnel access" settings section and status badge show
 * for a Tunnel access status. Pure logic, no React. */

import type { TunnelProviderState, TunnelStatus } from "./api";

export interface TunnelAccessView {
  enabled: boolean;
  toggleDisabled: boolean;
  /** Why the toggle is greyed out for good on this dashboard. */
  disabledReason: "remote" | "dev-slot" | null;
  /** The live public address; only while Tunnel access is on. */
  origin: string | null;
  canAddDevice: boolean;
  /** The main-UI status badge while Tunnel access is on. */
  badge: "connected" | "disconnected" | null;
  /** The provider's own explanation, shown verbatim. */
  message: string | null;
  /** What the user can do to make the provider usable. */
  guidance: "install" | "login" | "conflict" | null;
}

const GUIDANCE: Partial<Record<TunnelProviderState, TunnelAccessView["guidance"]>> = {
  "not-installed": "install",
  "logged-out": "login",
  conflict: "conflict",
};

/** The QR link a phone opens to pair: `https://<tunnel>/pair#<code>`. The code
 * rides in the fragment so it never reaches request lines, logs or Referer. */
export function pairingLink(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}${path}`;
}

/** `remote`: the dashboard is connected to an SSH workspace (Remote). */
export function tunnelAccessView(status: TunnelStatus | null, { remote = false } = {}): TunnelAccessView {
  const disabledReason = remote ? "remote" : status?.blocked ?? null;
  const live = !disabledReason && status?.enabled ? status : null;
  const connected = live?.state === "connected";
  return {
    enabled: live !== null,
    toggleDisabled: disabledReason !== null,
    disabledReason,
    origin: live?.origin ?? null,
    canAddDevice: connected && live?.origin != null,
    badge: live ? (connected ? "connected" : "disconnected") : null,
    message: status?.message ?? null,
    guidance: disabledReason || !status ? null : GUIDANCE[status.state] ?? null,
  };
}
