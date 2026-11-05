import { ERROR_CODES, fail } from '../public/typed-error.mjs';

export function assertPathSegment(name, owningModule) {
  if (name.includes('/')) {
    fail(ERROR_CODES.VALIDATION, `name must not contain "/": ${name}`, { owningModule });
  }
  return name;
}

export function computePath(parentPath, name) {
  return parentPath === null || parentPath === undefined ? `/${name}` : `${parentPath}/${name}`;
}
