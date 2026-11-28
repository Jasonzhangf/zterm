export function parseEndpointHost(endpoint?: string | null) {
  const value = endpoint?.trim() || '';
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value.includes('://') ? value : `ws://${value}`);
    return parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  } catch {
    return value.split(':')[0]?.toLowerCase() || '';
  }
}

export function isPrivateLanIpv4Host(host?: string | null) {
  const value = host?.trim().toLowerCase() || '';
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }

  const [a, b, c, d] = match.slice(1).map((part) => Number.parseInt(part, 10));
  if ([a, b, c, d].some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return false;
  }

  return (
    a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

export function isLoopbackHost(host?: string | null) {
  const raw = host?.trim().toLowerCase() || '';
  if (!raw) {
    return false;
  }
  if (raw === '::1' || raw === '[::1]' || raw === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const value = parseEndpointHost(raw);
  if (!value) {
    return false;
  }
  if (
    value === 'localhost'
    || value.endsWith('.localhost')
    || value === '::1'
    || value === '0:0:0:0:0:0:0:1'
  ) {
    return true;
  }
  const match = value.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  return match.slice(1).every((part) => {
    const num = Number.parseInt(part, 10);
    return !Number.isNaN(num) && num >= 0 && num <= 255;
  });
}
