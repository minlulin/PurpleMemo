// Error text helper — single shared copy.
//
// Every feature page turns a caught value into a display string with the
// same one-liner (`e instanceof Error ? e.message : String(e)`); it was
// declared 14 times and inlined 13 more. Rejections that are strings (Tauri
// command errors arrive as strings) must still render, never as "[object
// Object]".

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
