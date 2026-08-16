import crypto from 'crypto';

export interface TerminalAttachTokenRuntime {
  issueSessionTransportToken: () => string;
  consumeSessionTransportToken: (token: string) => boolean;
}

export function createTerminalAttachTokenRuntime(): TerminalAttachTokenRuntime {
  const sessionTransportAttachTokens = new Set<string>();

  function issueSessionTransportToken() {
    const token = crypto.randomUUID();
    sessionTransportAttachTokens.add(token);
    return token;
  }

  function consumeSessionTransportToken(token: string) {
    if (!sessionTransportAttachTokens.has(token)) {
      return false;
    }
    sessionTransportAttachTokens.delete(token);
    return true;
  }

  return {
    issueSessionTransportToken,
    consumeSessionTransportToken,
  };
}
