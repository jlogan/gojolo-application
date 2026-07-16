/** Open the native date picker when supported (Chrome, Safari 16+, etc.). */
export function tryOpenNativeDatePicker(input: HTMLInputElement) {
  if (typeof input.showPicker !== 'function') return
  try {
    input.showPicker()
  } catch {
    // showPicker may throw if not triggered by a user gesture or is unsupported.
  }
}

let lastPickerAt = 0

/** Debounced picker open to avoid double-invoke from focus + click on the same interaction. */
export function openNativeDatePicker(input: HTMLInputElement) {
  const now = Date.now()
  if (now - lastPickerAt < 400) return
  lastPickerAt = now
  tryOpenNativeDatePicker(input)
}
