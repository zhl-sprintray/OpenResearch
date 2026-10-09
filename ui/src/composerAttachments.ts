/** Which files the composer attaches. The desktop composer takes images and
 * PDFs; the Mobile layout's composer takes images only, so its picker can
 * offer the camera and photo library. Pure logic, no React. */
export type AttachmentKinds = "imagesAndPdf" | "images";

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;

export function acceptsAttachment(mediaType: string, kinds: AttachmentKinds): boolean {
  return IMAGE_TYPE.test(mediaType) || (kinds === "imagesAndPdf" && mediaType === "application/pdf");
}

/** The file input's `accept` attribute. `image/*` lets phones offer the
 * camera and photo library; they hand back JPEG or PNG. */
export function attachmentAccept(kinds: AttachmentKinds): string {
  return kinds === "images" ? "image/*" : "application/pdf,image/png,image/jpeg,image/gif,image/webp";
}
