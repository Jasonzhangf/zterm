export class TypedError extends Error {
  constructor({ code = 'DELIVERY_ERROR', category = 'delivery', message = '', retryable = false, details = {} } = {}) {
    super(message);
    this.name = 'TypedError';
    this.code = code;
    this.category = category;
    this.message = message;
    this.retryable = retryable;
    this.details = details;
  }
}

function isMissing(value) {
  return value === undefined || value === null || value === '';
}

function invalidArgument(message) {
  return new TypedError({
    code: 'DELIVERY_INVALID_ARGUMENT',
    category: 'invalid_argument',
    message,
    retryable: false,
  });
}

function assertRequiredString(values, name) {
  if (isMissing(values[name])) {
    throw invalidArgument(`${name} is required`);
  }
}

function assertRequiredNumber(values, name) {
  const value = values[name];
  if (!Number.isFinite(value) || value < 0) {
    throw invalidArgument(`${name} must be a finite non-negative number`);
  }
}

function normalizeTransportError(error, type) {
  if (error instanceof TypedError) {
    return error;
  }
  return new TypedError({
    code: 'DELIVERY_TRANSPORT_FAILURE',
    category: 'transport',
    message: `${type} transport failed`,
    retryable: true,
    details: {
      originalMessage: error?.message || String(error),
      originalName: error?.name || 'Error',
    },
  });
}

export function createDeliveryClient({ transport }) {
  if (!transport || typeof transport.send !== 'function') {
    throw new TypeError('delivery client requires a transport with send()');
  }
  const request = async (type, payload) => {
    try {
      return await transport.send({ type, payload });
    } catch (error) {
      throw normalizeTransportError(error, type);
    }
  };
  return {
    async submitMessage({ workspaceId, senderMemberId, recipientMemberId, body, clientMessageId, metadata } = {}) {
      assertRequiredString({ workspaceId }, 'workspaceId');
      assertRequiredString({ recipientMemberId }, 'recipientMemberId');
      assertRequiredString({ body }, 'body');
      return request('delivery.submitMessage', {
        workspaceId,
        senderMemberId,
        recipientMemberId,
        body,
        clientMessageId,
        metadata,
      });
    },
    async beginFile({ workspaceId, senderMemberId, recipientMemberId, fileName, totalBytes, mimeType, sha256 } = {}) {
      assertRequiredString({ workspaceId }, 'workspaceId');
      assertRequiredString({ senderMemberId }, 'senderMemberId');
      assertRequiredString({ recipientMemberId }, 'recipientMemberId');
      assertRequiredString({ fileName }, 'fileName');
      assertRequiredNumber({ totalBytes }, 'totalBytes');
      assertRequiredString({ mimeType }, 'mimeType');
      assertRequiredString({ sha256 }, 'sha256');
      return request('delivery.beginFile', {
        workspaceId,
        senderMemberId,
        recipientMemberId,
        fileName,
        totalBytes,
        mimeType,
        sha256,
      });
    },
    async writeChunk({ transferId, chunkIndex, byteOffset, data, isLastChunk } = {}) {
      assertRequiredString({ transferId }, 'transferId');
      assertRequiredNumber({ chunkIndex }, 'chunkIndex');
      assertRequiredNumber({ byteOffset }, 'byteOffset');
      if (isMissing(data)) {
        throw invalidArgument('data is required');
      }
      return request('delivery.writeChunk', {
        transferId,
        chunkIndex,
        byteOffset,
        data,
        isLastChunk,
      });
    },
    async commitFile({ transferId, totalChunks, totalBytes } = {}) {
      assertRequiredString({ transferId }, 'transferId');
      assertRequiredNumber({ totalChunks }, 'totalChunks');
      assertRequiredNumber({ totalBytes }, 'totalBytes');
      return request('delivery.commitFile', {
        transferId,
        totalChunks,
        totalBytes,
      });
    },
    async queryReceipt({ messageId } = {}) {
      assertRequiredString({ messageId }, 'messageId');
      return request('delivery.queryReceipt', { messageId });
    },
    async queryTransfer({ transferId } = {}) {
      assertRequiredString({ transferId }, 'transferId');
      return request('delivery.queryTransfer', { transferId });
    },
    subscribeInbox({ workspaceId, memberId } = {}, onEvent) {
      assertRequiredString({ workspaceId }, 'workspaceId');
      assertRequiredString({ memberId }, 'memberId');
      if (typeof onEvent !== 'function') {
        throw invalidArgument('onEvent must be a function');
      }
      if (!transport.subscribe || typeof transport.subscribe !== 'function') {
        throw new TypedError({
          code: 'DELIVERY_SUBSCRIBE_UNSUPPORTED',
          category: 'transport',
          message: 'transport does not support subscribe()',
          retryable: false,
        });
      }
      const unsubscribe = transport.subscribe('delivery.inbox', { workspaceId, memberId }, onEvent);
      return () => {
        if (typeof transport.unsubscribe === 'function') {
          transport.unsubscribe('delivery.inbox', { workspaceId, memberId }, onEvent);
        } else if (typeof unsubscribe === 'function') {
          unsubscribe();
        }
      };
    },
  };
}
