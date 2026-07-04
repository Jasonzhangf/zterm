export const MAC_BROWSER_DEV_WINDOW_ID = 'browser-dev-window';

export interface MacWindowLocationLike {
  search: string;
}

export function resolveMacRendererWindowId(locationLike: MacWindowLocationLike): string {
  const params = new URLSearchParams(locationLike.search);
  const windowId = params.get('windowId')?.trim();
  return windowId || MAC_BROWSER_DEV_WINDOW_ID;
}
