import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { useEffect, useRef } from "react";
import { onTunnelDevicePaired } from "../events";
import { ltr } from "../i18n";
import { m } from "../paraglide/messages.js";
import { queryClient, workspaceKey } from "../queries/client";
import { getTunnelAccessQuery } from "../queries/settings";
import { tunnelAccessView } from "../tunnelAccess";
import { showAlert } from "./ui";

/** Shown in the desktop dashboard for as long as Tunnel access is on, so it is
 *  never on unnoticed; `onOpen` jumps to the Settings section. Also toasts each
 *  newly paired device, so a pairing nobody here started stands out.
 *
 *  Status comes from an original-port-only endpoint: on the Tunnel port (or
 *  in Remote) the query fails and nothing renders. */
export function TunnelAccessBadge({ onOpen }: { onOpen?: () => void }) {
  const statusQuery = useQuery(getTunnelAccessQuery());
  const view = statusQuery.data ? tunnelAccessView(statusQuery.data) : null;
  const reachable = statusQuery.data !== undefined;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (!reachable) return;
    return onTunnelDevicePaired((device) => {
      void queryClient.invalidateQueries({ queryKey: workspaceKey("listTunnelDevices") });
      const open = openRef.current;
      showAlert(m.tunnel_access_device_paired_toast({ name: device.name }), "info", {
        duration: 15_000,
        action: open ? { label: m.tunnel_access_badge_manage(), onClick: open } : undefined,
      });
    });
  }, [reachable]);

  if (!view?.badge) return null;
  const connected = view.badge === "connected";
  const label = connected ? m.tunnel_access_badge_on() : m.tunnel_access_badge_disconnected();
  return (
    <div
      className={`tunnel-access-badge flex items-center gap-2 shrink-0 py-1.5 px-3.5 mac-titlebar:ps-20 win-titlebar:pe-36 text-sm text-text border-b ${connected ? "bg-accent-green-subtle border-b-accent-green" : "bg-accent-amber-subtle border-b-accent-amber"}`}
      role="status"
    >
      <Radio size={13} className={`shrink-0 ${connected ? "text-accent-green" : "text-accent-amber"}`} />
      <span className="font-medium">{label}</span>
      {view.origin && <span className="min-w-0 truncate text-subtext">{ltr(view.origin)}</span>}
      {onOpen && (
        <button type="button" className="ms-auto shrink-0 font-medium text-text underline underline-offset-2 hover:text-subtext" onClick={onOpen}>
          {m.tunnel_access_badge_manage()}
        </button>
      )}
    </div>
  );
}
