// Modified in the isolated phase-1 workspace slice (Apache-2.0; see LICENSE). Not an upstream Rakazo release.
/**
 * Fallback when a server does not advertise a limit. Historical deployments and
 * clients that never received `maxUploadSizeBytes` use 10 MiB. An unset
 * `MAX_UPLOAD_SIZE_MB` on this slice uses {@link DEFAULT_UPLOAD_MAX_BYTES}.
 */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** Deployment default: 25 MiB, exactly 26,214,400 bytes. */
export const DEFAULT_UPLOAD_MAX_BYTES = 26_214_400;
/** Stable machine code when actual bytes exceed the configured per-file limit. */
export const UPLOAD_TOO_LARGE_CODE = "upload_too_large";
export const ATTACHMENT_MAX_COUNT = 4;
/** Hard ceiling for the configurable per-message limit. */
export const ATTACHMENT_COUNT_CEILING = 100;
/** Shared photo preparation policy for web and mobile composers. */
export const ATTACHMENT_IMAGE_MAX_EDGE = 1_600;
export const ATTACHMENT_IMAGE_QUALITY = 0.7;
export const ARTIFACT_NAME_MAX_LENGTH = 255;
export const ARTIFACT_DESCRIPTION_MAX_LENGTH = 280;
/** Base64 expands payload by 4/3; cap before decode to reject oversize uploads cheaply. */
export const ATTACHMENT_MAX_BASE64_LENGTH = Math.ceil(ATTACHMENT_MAX_BYTES / 3) * 4;

export const ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export const ATTACHMENT_AUDIO_MIME_TYPES = [
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "audio/mp4",
] as const;

export const ATTACHMENT_FILE_MIME_TYPES = [
  ...ATTACHMENT_AUDIO_MIME_TYPES,
  "video/mp4",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/html",
  "application/json",
  "application/zip",
] as const;

export const ATTACHMENT_ALLOWED_MIME_TYPES = [
  ...ATTACHMENT_IMAGE_MIME_TYPES,
  ...ATTACHMENT_FILE_MIME_TYPES,
] as const;

export type AttachmentMimeType = (typeof ATTACHMENT_ALLOWED_MIME_TYPES)[number];

export function isAttachmentImageMimeType(mimeType: string): boolean {
  return (ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export type ArtifactPreviewKind = "html" | "markdown" | "pdf" | "image" | "video" | "text" | "none";

const TEXT_APPLICATION_MIME_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-sh",
  "application/sql",
]);

/** How every client previews a saved file, so web and mobile show the same types. */
export function artifactPreviewKind(mimeType: string): ArtifactPreviewKind {
  const type = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/html") return "html";
  if (type === "text/markdown") return "markdown";
  if (type === "application/pdf") return "pdf";
  if (isAttachmentImageMimeType(type)) return "image";
  if (type === "video/mp4") return "video";
  if (type.startsWith("text/") || TEXT_APPLICATION_MIME_TYPES.has(type)) return "text";
  return "none";
}

export function isAttachmentAudioMimeType(mimeType: string): boolean {
  return (ATTACHMENT_AUDIO_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function isAllowedAttachmentMimeType(mimeType: string): mimeType is AttachmentMimeType {
  return (ATTACHMENT_ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateThreadsSendInput(input: {
  text?: string;
  artifactIds?: string[];
}): boolean {
  const text = input.text?.trim() ?? "";
  const artifactIds = input.artifactIds ?? [];
  return Boolean(text || artifactIds.length);
}

/** Effective per-file upload limit advertised in me/bootstrap. */
export function attachmentMaxBytes(config?: { maxUploadSizeBytes?: number } | null): number {
  return config?.maxUploadSizeBytes ?? ATTACHMENT_MAX_BYTES;
}

export function attachmentSizeLabel(maxBytes: number): string {
  return `${maxBytes / (1024 * 1024)} MiB`;
}

/** Effective per-message limit, including the fallback for older servers. */
export function attachmentMaxCount(config?: { maxAttachmentsPerMessage?: number } | null): number {
  return config?.maxAttachmentsPerMessage ?? ATTACHMENT_MAX_COUNT;
}
