export function isLikelyTailscaleHost(host?: string | null) {
  const value = host?.trim().toLowerCase() || '';
  if (!value) {
    return false;
  }

  if (value.endsWith('.ts.net') || value.includes('tailnet')) {
    return true;
  }

  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }

  const [a, b, c, d] = match.slice(1).map((part) => Number.parseInt(part, 10));
  if ([a, b, c, d].some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  return a === 100 && b >= 64 && b <= 127;
}

export function formatTargetBadge(host?: string | null) {
  return isLikelyTailscaleHost(host) ? 'Tailscale' : 'LAN';
}
