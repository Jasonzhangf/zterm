import type { DagpipeResult } from './dagpipe-types';

/**
 * Extract the ordered chunk payloads from an input-dispatch result.
 *
 * The Rust graph plans and emits a reliable-input batch, but zterm's real
 * runtime owns the durable per-session queue/ACK lifecycle. The bridge only
 * consumes the normalized chunk text so existing queue rules still decide
 * sequencing, retry, and backpressure.
 */
export function readDagpipeInputChunks(result: DagpipeResult): string[] {
  if (!result.ok) {
    throw new Error(result.error);
  }
  const sends = (result.outputs['arc.mux_channel_send'] as {
    sends?: Array<{ payload: { data?: string } }>;
  } | undefined)?.sends;
  if (!sends) {
    throw new Error('dagpipe input dispatch did not return arc.mux_channel_send.sends');
  }
  return sends.flatMap((send) => {
    const data = send.payload?.data;
    return data ? [data] : [];
  });
}
