import { useMutation, useQuery } from "@tanstack/react-query";
import { generate } from "lean-qr";
import { ExternalLink, QrCode, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  mintTunnelPairingCode,
  renameTunnelDevice,
  revokeAllTunnelDevices,
  revokeTunnelDevice,
  setTunnelAccess,
  timeAgo,
  type TunnelDevice,
  type TunnelPairingCode,
  type TunnelProviderState,
} from "../api";
import { ltr } from "../i18n";
import { m } from "../paraglide/messages.js";
import { getTunnelAccessQuery, listTunnelDevicesQuery } from "../queries/settings";
import { pairingLink, tunnelAccessView, type TunnelAccessView } from "../tunnelAccess";
import { Badge, Button, Input, LoadingRow, Spinner, Switch, type BadgeVariant } from "./ui";

const CARD_CLASS_NAME = "bg-background border border-border rounded-lg py-4 px-4.5 mb-4";
const ROW_CLASS_NAME = "flex items-center justify-between gap-6 py-3.5 border-t border-t-border-variant first:pt-0 first:border-t-0";
const NOTE_CLASS_NAME = "mt-1 text-sm leading-relaxed text-subtext";
const ERROR_CLASS_NAME = "mt-2 text-base text-accent-red whitespace-pre-wrap";
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

const STATE_LABELS: Record<TunnelProviderState, () => string> = {
  "not-installed": m.tunnel_access_state_not_installed,
  "logged-out": m.tunnel_access_state_logged_out,
  unavailable: m.tunnel_access_state_unavailable,
  conflict: m.tunnel_access_state_conflict,
  ready: m.tunnel_access_state_ready,
  connected: m.tunnel_access_state_connected,
  disconnected: m.tunnel_access_state_disconnected,
};

const STATE_VARIANTS: Record<TunnelProviderState, BadgeVariant> = {
  "not-installed": "warning",
  "logged-out": "warning",
  unavailable: "warning",
  conflict: "error",
  ready: "default",
  connected: "success",
  disconnected: "warning",
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Settings → "Tunnel access": the toggle, provider status, public address,
 *  device pairing and the paired-device list. `remote`: an SSH workspace. */
export function TunnelAccessSettings({ remote }: { remote: boolean }) {
  const statusQuery = useQuery({ ...getTunnelAccessQuery(), enabled: !remote });
  const status = statusQuery.data ?? null;
  const view = tunnelAccessView(status, { remote });
  const toggle = useMutation({ mutationFn: setTunnelAccess });
  const error = toggle.error ? errorText(toggle.error) : statusQuery.error ? errorText(statusQuery.error) : null;

  return (
    <>
      <h2>{m.tunnel_access_title()}</h2>
      <p className={NOTE_CLASS_NAME}>{m.tunnel_access_description()}</p>
      <div className={`${CARD_CLASS_NAME} mt-3`}>
        <div className={ROW_CLASS_NAME}>
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-base font-medium">
              {m.tunnel_access_title()}
              {status && !view.disabledReason && (
                <Badge size="small" variant={STATE_VARIANTS[status.state]}>{STATE_LABELS[status.state]()}</Badge>
              )}
            </div>
            <StatusNote view={view} />
          </div>
          {!remote && !status && statusQuery.isPending ? (
            <Spinner />
          ) : (
            <Switch
              type="button"
              checked={view.enabled}
              aria-label={m.tunnel_access_title()}
              disabled={view.toggleDisabled || !status || toggle.isPending}
              onClick={() => { toggle.reset(); toggle.mutate(!view.enabled); }}
            />
          )}
        </div>
        {view.origin && (
          <div className={ROW_CLASS_NAME}>
            <div className="min-w-0">
              <div className="text-base font-medium">{m.tunnel_access_address()}</div>
              <a className="text-sm text-subtext break-all hover:text-text" href={view.origin} target="_blank" rel="noreferrer">{ltr(view.origin)}</a>
            </div>
          </div>
        )}
        {error && <div className={ERROR_CLASS_NAME}>{error}</div>}
      </div>
      {view.enabled && <AddDevice view={view} />}
      {!remote && status && <DeviceList />}
    </>
  );
}

function StatusNote({ view }: { view: TunnelAccessView }) {
  if (view.disabledReason === "remote") return <p className={NOTE_CLASS_NAME}>{m.tunnel_access_blocked_remote()}</p>;
  if (view.disabledReason === "dev-slot") return <p className={NOTE_CLASS_NAME}>{m.tunnel_access_blocked_dev_slot()}</p>;
  return (
    <>
      {view.guidance === "install" && (
        <p className={NOTE_CLASS_NAME}>
          {m.tunnel_access_install_guidance()}{" "}
          <a className="inline-flex items-center gap-1 text-text underline" href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
            {m.tunnel_access_install_link()} <ExternalLink size={12} />
          </a>
        </p>
      )}
      {view.guidance === "login" && <p className={NOTE_CLASS_NAME}>{m.tunnel_access_login_guidance()}</p>}
      {view.guidance === "conflict" && <p className={NOTE_CLASS_NAME}>{m.tunnel_access_conflict_guidance()}</p>}
      {/* The provider's own detail (English, from the server) when nothing above covers it. */}
      {view.message && view.guidance !== "install" && <p dir="auto" className={`${NOTE_CLASS_NAME} whitespace-pre-wrap`}>{view.message}</p>}
    </>
  );
}

function AddDevice({ view }: { view: TunnelAccessView }) {
  const mint = useMutation({ mutationFn: mintTunnelPairingCode });
  const [code, setCode] = useState<TunnelPairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [code]);
  const start = () => {
    mint.reset();
    void mint.mutateAsync().then((next) => { setNow(Date.now()); setCode(next); }).catch(() => {});
  };
  const expired = code !== null && now >= code.expiresAt;
  const link = code && view.origin ? pairingLink(view.origin, code.path) : null;

  return (
    <div className={CARD_CLASS_NAME}>
      <div className={ROW_CLASS_NAME}>
        <div className="min-w-0">
          <div className="text-base font-medium">{m.tunnel_access_add_device()}</div>
          <p className={NOTE_CLASS_NAME}>{view.canAddDevice ? m.tunnel_access_pairing_hint() : m.tunnel_access_pairing_unavailable()}</p>
        </div>
        {!code && (
          <Button disabled={!view.canAddDevice || mint.isPending} onClick={start}>
            <QrCode size={14} /> {m.tunnel_access_add_device()}
          </Button>
        )}
      </div>
      {code && link && (
        <div className="flex flex-col items-center gap-3 pt-3.5 border-t border-t-border-variant">
          {expired ? (
            <p className="text-sm text-subtext">{m.tunnel_access_pairing_expired()}</p>
          ) : (
            <>
              <PairingQr link={link} />
              <p className="text-sm text-subtext">{m.tunnel_access_pairing_expires({ seconds: Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) })}</p>
            </>
          )}
          <div className="flex gap-2.5">
            <Button size="small" disabled={mint.isPending} onClick={start}>{m.tunnel_access_new_code()}</Button>
            <Button size="small" variant="ghost" onClick={() => setCode(null)}>{m.tunnel_access_done()}</Button>
          </div>
        </div>
      )}
      {mint.error && <div className={ERROR_CLASS_NAME}>{errorText(mint.error)}</div>}
    </div>
  );
}

/** Dark modules on a white quiet zone whatever the theme: phone cameras read
 *  that most reliably. The link is never shown as text. */
function PairingQr({ link }: { link: string }) {
  const { size, path } = useMemo(() => {
    const qr = generate(link);
    let d = "";
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) if (qr.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    }
    return { size: qr.size, path: d };
  }, [link]);
  return (
    <svg
      role="img"
      aria-label={m.tunnel_access_qr_label()}
      viewBox={`-4 -4 ${size + 8} ${size + 8}`}
      className="w-52 h-52 rounded-md bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} className="fill-black" />
    </svg>
  );
}

function DeviceList() {
  const devicesQuery = useQuery(listTunnelDevicesQuery());
  const devices = devicesQuery.data ?? null;
  const revokeAll = useMutation({ mutationFn: revokeAllTunnelDevices });

  return (
    <div className={CARD_CLASS_NAME}>
      <div className="flex items-center justify-between gap-6 mb-1">
        <h3 className="m-0 text-base font-semibold text-text">{m.tunnel_access_devices()}</h3>
        {devices && devices.length > 0 && (
          <Button
            size="small"
            variant="danger"
            disabled={revokeAll.isPending}
            onClick={() => { if (window.confirm(m.tunnel_access_revoke_all_confirm())) revokeAll.mutate(); }}
          >
            {m.tunnel_access_revoke_all()}
          </Button>
        )}
      </div>
      {!devices ? (
        devicesQuery.error ? <div className={ERROR_CLASS_NAME}>{errorText(devicesQuery.error)}</div> : <LoadingRow><Spinner /> {m.common_loading()}</LoadingRow>
      ) : devices.length === 0 ? (
        <p className={NOTE_CLASS_NAME}>{m.tunnel_access_no_devices()}</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {devices.map((device) => <DeviceRow key={device.id} device={device} />)}
        </ul>
      )}
      {revokeAll.error && <div className={ERROR_CLASS_NAME}>{errorText(revokeAll.error)}</div>}
    </div>
  );
}

function DeviceRow({ device }: { device: TunnelDevice }) {
  const [draft, setDraft] = useState<string | null>(null);
  const rename = useMutation({ mutationFn: (name: string) => renameTunnelDevice(device.id, name), onSuccess: () => setDraft(null) });
  const revoke = useMutation({ mutationFn: () => revokeTunnelDevice(device.id) });
  const error = rename.error ?? revoke.error;

  return (
    <li className="py-3 border-t border-t-border-variant first:border-t-0">
      {draft === null ? (
        <div className="flex items-center gap-3">
          <Smartphone size={16} className="shrink-0 text-subtext" />
          <div className="min-w-0 flex-1">
            <div dir="auto" className="truncate text-base text-text">{device.name}</div>
            <div className="text-sm text-subtext">
              {m.tunnel_access_device_times({ paired: timeAgo(device.pairedAt), seen: timeAgo(device.lastSeenAt) })}
            </div>
          </div>
          <Button size="small" variant="ghost" onClick={() => { rename.reset(); setDraft(device.name); }}>{m.tunnel_access_rename()}</Button>
          <Button
            size="small"
            variant="danger"
            disabled={revoke.isPending}
            onClick={() => { if (window.confirm(m.tunnel_access_revoke_confirm({ name: device.name }))) revoke.mutate(); }}
          >
            {m.tunnel_access_revoke()}
          </Button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => { event.preventDefault(); if (draft.trim()) rename.mutate(draft.trim()); }}
        >
          <Input
            autoFocus
            dir="auto"
            value={draft}
            maxLength={80}
            aria-label={m.tunnel_access_rename()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }}
          />
          <Button size="small" type="submit" variant="primary" disabled={!draft.trim() || rename.isPending}>{m.common_save()}</Button>
          <Button size="small" type="button" variant="ghost" onClick={() => setDraft(null)}>{m.tunnel_access_cancel()}</Button>
        </form>
      )}
      {error && <div className={ERROR_CLASS_NAME}>{errorText(error)}</div>}
    </li>
  );
}
