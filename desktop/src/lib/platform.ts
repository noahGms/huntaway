// macOS draws its traffic lights over the window (title bar overlay); other
// systems keep a native title bar.
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

/** The shortcut modifier is held (⌘ on macOS, Ctrl elsewhere). */
export function modPressed(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/** A dialog or menu is open: global keys belong to it. */
export function overlayOpen(): boolean {
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]');
}
