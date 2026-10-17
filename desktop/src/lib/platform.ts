// macOS draws its traffic lights over the window (title bar overlay); other
// systems keep a native title bar.
export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
