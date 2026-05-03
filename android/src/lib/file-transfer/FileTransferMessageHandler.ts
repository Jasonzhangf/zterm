import type { Transport } from '../transport/TransportManager';
import type { FileTransferCoordinator } from './FileTransferCoordinator';

export type FileTransferMessage = {
  type: string;
  payload?: any;
  chunk?: ArrayBuffer;
  chunkIndex?: number;
  totalChunks?: number;
  fileName?: string;
  error?: string;
};

export class FileTransferMessageHandler {
  private coordinator: FileTransferCoordinator;

  constructor(coordinator: FileTransferCoordinator) {
    this.coordinator = coordinator;
  }

  /**
   * 解析并处理来自 transport 的消息
   * @param sessionId 所属 session
   * @param msg 原始消息（可能是字符串或 ArrayBuffer）
   * @returns 是否已处理该消息（如果 true，上层应停止进一步处理）
   */
  handleMessage(sessionId: string, msg: string | ArrayBuffer): boolean {
    // 二进制数据：一定是文件传输的 chunk
    if (msg instanceof ArrayBuffer) {
      // 需要从上下文中获取 chunk 元数据，但通常 chunk 消息是纯二进制，没有索引。
      // 实际协议中，chunk 应该先有 JSON 消息告知开始，然后二进制流。
      // 简化：假设接收到的二进制属于当前活跃下载
      this.coordinator.handleChunk(sessionId, msg, 0, 0);
      return true;
    }

    // JSON 消息
    try {
      const data = JSON.parse(msg) as FileTransferMessage;
      switch (data.type) {
        case 'file-transfer-chunk':
          if (data.chunk) {
            this.coordinator.handleChunk(sessionId, data.chunk, data.chunkIndex || 0, data.totalChunks || 0);
          }
          return true;
        case 'file-transfer-complete':
          this.coordinator.handleComplete(sessionId, new Uint8Array(), data.fileName);
          return true;
        case 'file-transfer-error':
          this.coordinator.handleError(sessionId, data.error || 'Unknown error');
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }
}
