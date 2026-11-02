export const PREVIEW_SOFT_BYTES = 512 * 1024
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024
export const PREVIEW_DEBOUNCE_MS = 200
export const RECOVERY_DEBOUNCE_MS = 1_000
export const RECOVERY_MAX_DELAY_MS = 5_000
export const LAYOUT_DEBOUNCE_MS = 250

export function recoveryDelay(firstAt: number, now: number, delay: number) {
  return Math.min(delay, Math.max(0, RECOVERY_MAX_DELAY_MS - (now - firstAt)))
}

export function previewPolicy(byteLength: number) {
  const previewTooLarge = byteLength > PREVIEW_MAX_BYTES
  const previewNeedsManual = byteLength > PREVIEW_SOFT_BYTES && !previewTooLarge
  return { previewTooLarge, previewNeedsManual }
}
