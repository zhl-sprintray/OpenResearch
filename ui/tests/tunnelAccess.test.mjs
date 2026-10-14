import assert from "node:assert/strict";
import { test } from "node:test";
import { pairingLink, tunnelAccessView } from "../src/tunnelAccess.ts";

const status = (fields) => ({ enabled: false, provider: "tailscale", state: "ready", origin: null, message: null, blocked: null, ...fields });

test("a connected tunnel shows its address, the badge and the Add device action", () => {
  const view = tunnelAccessView(status({ enabled: true, state: "connected", origin: "https://laptop.example.ts.net" }));
  assert.equal(view.enabled, true);
  assert.equal(view.toggleDisabled, false);
  assert.equal(view.origin, "https://laptop.example.ts.net");
  assert.equal(view.canAddDevice, true);
  assert.equal(view.badge, "connected");
});

test("while off there is no badge, no live address and no pairing", () => {
  const view = tunnelAccessView(status({ state: "ready", origin: "https://laptop.example.ts.net" }));
  assert.equal(view.enabled, false);
  assert.equal(view.toggleDisabled, false);
  assert.equal(view.origin, null);
  assert.equal(view.canAddDevice, false);
  assert.equal(view.badge, null);
});

test("a dropped tunnel stays on, flags the badge and explains, but cannot pair until it reconnects", () => {
  const view = tunnelAccessView(status({ enabled: true, state: "disconnected", origin: "https://laptop.example.ts.net", message: "tailscale serve exited" }));
  assert.equal(view.enabled, true);
  assert.equal(view.badge, "disconnected");
  assert.equal(view.canAddDevice, false);
  assert.equal(view.message, "tailscale serve exited");
});

test("a Remote or dev-slot dashboard greys the toggle out and says why", () => {
  const remote = tunnelAccessView(status({ state: "unavailable", blocked: "remote", message: "unavailable over SSH" }));
  assert.equal(remote.toggleDisabled, true);
  assert.equal(remote.disabledReason, "remote");
  const devSlot = tunnelAccessView(status({ state: "unavailable", blocked: "dev-slot" }));
  assert.equal(devSlot.toggleDisabled, true);
  assert.equal(devSlot.disabledReason, "dev-slot");
});

test("the Remote workspace runtime disables Tunnel access even before the status loads", () => {
  const view = tunnelAccessView(null, { remote: true });
  assert.equal(view.toggleDisabled, true);
  assert.equal(view.disabledReason, "remote");
  assert.equal(view.badge, null);
});

test("a provider that is not set up yet gets actionable guidance", () => {
  assert.equal(tunnelAccessView(status({ state: "not-installed" })).guidance, "install");
  assert.equal(tunnelAccessView(status({ state: "logged-out" })).guidance, "login");
  assert.equal(tunnelAccessView(status({ state: "conflict" })).guidance, "conflict");
  assert.equal(tunnelAccessView(status({ state: "ready" })).guidance, null);
  assert.equal(tunnelAccessView(status({ enabled: true, state: "connected" })).guidance, null);
});

test("the QR pairing link puts the code in the fragment of the tunnel address", () => {
  assert.equal(pairingLink("https://laptop.example.ts.net", "/pair#K7Q2"), "https://laptop.example.ts.net/pair#K7Q2");
  assert.equal(pairingLink("https://laptop.example.ts.net/", "/pair#K7Q2"), "https://laptop.example.ts.net/pair#K7Q2");
});

test("a tunnel still starting is on, badged as starting, and cannot pair yet", () => {
  const view = tunnelAccessView(status({ enabled: true, state: "starting" }));
  assert.equal(view.enabled, true);
  assert.equal(view.badge, "starting");
  assert.equal(view.origin, null);
  assert.equal(view.canAddDevice, false);
});
