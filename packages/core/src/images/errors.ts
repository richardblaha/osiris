export class ImageError extends Error {
  constructor(readonly code: string, readonly recoverable = false, readonly retryAfterMs?: number) { super(code); }
}
export function imageError(error: unknown): ImageError {
  if (error instanceof ImageError) return error;
  const e = error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string };
  const status = e?.status ?? e?.statusCode;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return new ImageError("TIMEOUT", true);
  if (status === 401 || status === 403) return new ImageError("AUTHENTICATION_REQUIRED");
  if (status === 400 || status === 422) return new ImageError("INVALID_PROVIDER_REQUEST");
  if (status === 402) return new ImageError("INSUFFICIENT_CREDITS");
  if (status === 429) return new ImageError("RATE_LIMIT_OR_SUBSCRIPTION", true);
  if (e?.code === "not_found") return new ImageError("SOURCE_FILE_EXPIRED_OR_MISSING");
  const fileCodes: Record<string, string> = { quota: "STORAGE_QUOTA_EXCEEDED", too_large: "FILE_SIZE_LIMIT", type: "INVALID_IMAGE_TYPE", invalid: "INVALID_FILE_PATH" };
  if (e?.code && fileCodes[e.code]) return new ImageError(fileCodes[e.code]!);
  const processingCodes = new Set(["INVALID_IMAGE", "TRANSPARENCY_MISSING", "INVALID_LAYOUT", "LAYOUT_TOO_LARGE", "MASK_DIMENSIONS_MISMATCH", "EDIT_DIMENSIONS_MISMATCH", "COMPARE_DIMENSIONS_MISMATCH", "TEXT_REGION_REQUIRED", "TEXT_REGION_OUT_OF_BOUNDS", "CROP_OUT_OF_BOUNDS", "PADDING_REQUIRED", "OVERLAY_REQUIRED", "OVERLAY_OUT_OF_BOUNDS", "RESIZE_DIMENSIONS_REQUIRED", "OUTPAINT_DIMENSIONS_MISMATCH", "INVALID_BORDER_SLICES", "MASK_REGION_OUT_OF_BOUNDS", "SPRITE_INPUT_TOO_LARGE", "CONTACT_SHEET_INPUT_TOO_LARGE"]);
  if (e?.message && processingCodes.has(e.message)) return new ImageError(e.message);
  return new ImageError("PROVIDER_OR_IMAGE_FAILURE", true);
}
