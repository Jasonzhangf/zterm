// Reliable-input ack dedupe cache: remembers accepted seqs per session so a
// client retry of an already-applied seq gets the same ack without a second
// tmux write. Bounded FIFO eviction keeps memory flat.
export interface ReliableInputAckCache {
  remember: (sessionId: string, seq: string, bytes: number) => void;
  read: (sessionId: string, seq: string) => { accepted: true; bytes: number } | null;
}

const RELIABLE_INPUT_ACKED_SEQ_MAX = 2048;

export function createReliableInputAckCache(): ReliableInputAckCache {
  const reliableInputAckedSeqs = new Map<string, { accepted: true; bytes: number }>();

  function reliableInputKey(sessionId: string, seq: string) {
    return `${sessionId}\u0000${seq}`;
  }

  return {
    remember(sessionId, seq, bytes) {
      reliableInputAckedSeqs.set(reliableInputKey(sessionId, seq), { accepted: true, bytes });
      while (reliableInputAckedSeqs.size > RELIABLE_INPUT_ACKED_SEQ_MAX) {
        const oldestKey = reliableInputAckedSeqs.keys().next().value;
        if (typeof oldestKey !== 'string') {
          break;
        }
        reliableInputAckedSeqs.delete(oldestKey);
      }
    },
    read(sessionId, seq) {
      return reliableInputAckedSeqs.get(reliableInputKey(sessionId, seq)) || null;
    },
  };
}
