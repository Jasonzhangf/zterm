export class DesktopGatewayError extends Error {
  constructor(
    readonly code: 'INVALID_PARAMS' | 'PLATFORM_CAPABILITY_UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'DesktopGatewayError';
  }
}
