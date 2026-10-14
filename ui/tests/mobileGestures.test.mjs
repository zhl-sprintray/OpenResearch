import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySwipe } from "../src/mobileGestures.ts";

const WIDTH = 390;
const chat = { drawerOpen: false, panelOpen: false, rtl: false, width: WIDTH };
const swipe = (startX, endX, { startY = 300, endY = startY, ...context } = {}) =>
  classifySwipe({ startX, startY, endX, endY }, { ...chat, ...context });

test("a right swipe starting just inside the left edge opens the drawer", () => {
  assert.equal(swipe(30, 140), "openDrawer");
});

test("a swipe from the very edge is left to the browser's back gesture", () => {
  assert.equal(swipe(4, 140), null);
});

test("a right swipe starting mid-screen does nothing on the chat", () => {
  assert.equal(swipe(150, 300), null);
});

test("short or mostly vertical moves are not swipes", () => {
  assert.equal(swipe(30, 60), null);
  assert.equal(swipe(30, 140, { startY: 100, endY: 300 }), null);
});

test("a left swipe anywhere closes an open drawer", () => {
  assert.equal(swipe(250, 100, { drawerOpen: true }), "closeDrawer");
  assert.equal(swipe(30, 140, { drawerOpen: true }), null);
});

test("an edge right swipe in a full-screen panel pops it instead of opening the drawer", () => {
  assert.equal(swipe(30, 140, { panelOpen: true }), "popPanel");
  assert.equal(swipe(150, 300, { panelOpen: true }), null);
  assert.equal(swipe(250, 100, { panelOpen: true }), null);
});

test("right-to-left layouts mirror the edge and direction", () => {
  assert.equal(swipe(WIDTH - 30, WIDTH - 140, { rtl: true }), "openDrawer");
  assert.equal(swipe(WIDTH - 4, WIDTH - 140, { rtl: true }), null);
  assert.equal(swipe(100, 250, { rtl: true, drawerOpen: true }), "closeDrawer");
  assert.equal(swipe(30, 140, { rtl: true }), null);
});
