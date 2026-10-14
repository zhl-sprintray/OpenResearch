import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptsAttachment, attachmentAccept } from "../src/composerAttachments.ts";

test("the desktop composer takes images and PDFs", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]) {
    assert.equal(acceptsAttachment(type, "imagesAndPdf"), true, type);
  }
  assert.equal(acceptsAttachment("text/plain", "imagesAndPdf"), false);
});

test("the mobile composer takes images only", () => {
  assert.equal(acceptsAttachment("image/jpeg", "images"), true);
  assert.equal(acceptsAttachment("image/png", "images"), true);
  assert.equal(acceptsAttachment("application/pdf", "images"), false);
  assert.equal(acceptsAttachment("text/plain", "images"), false);
});

test("the mobile file picker offers the camera and photo library", () => {
  assert.equal(attachmentAccept("images"), "image/*");
  assert.equal(attachmentAccept("imagesAndPdf"), "application/pdf,image/png,image/jpeg,image/gif,image/webp");
});
