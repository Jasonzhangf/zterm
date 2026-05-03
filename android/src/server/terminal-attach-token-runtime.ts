import crypto from 'crypto';

export interface TerminalAttachTokenRuntime {
  issueSessionTransportToken: (clientSessionId: string) => string;
  consumeSessionTransportToken: (token: string, clientSessionId: string) => boolean;
}

export function createTerminalAttachTokenRuntime(): TerminalAttachTokenRuntime {
  const sessionTransportAttachTokens = new Map<string, string>();

  function issueSessionTransportToken(clientSessionId: string) {
    const token = crypto.randomUUID();
    sessionTransportAttachTokens.set(token, clientSessionId);
    return token;
  }

  function consumeSessionTransportToken(token: string, clientSessionId: string) {
    const owner = sessionTransportAttachTokens.get(token);
    if (!owner || owner !== clientSessionId) {
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
