export function sanitizeTmuxSessionName(input: string, fallback = 'zterm') {
  const candidate = (input || fallback).trim();
  const normalized = candidate
    .replace(/[^a-zA-Z0-9:_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || fallback;
}
