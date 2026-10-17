/**
 * When the runtime was last used and whether a run is in progress, for the operator's sleep decision. Once
 * `sleeping` is set (the operator snapshotted the runtime and is about to scale it down), new requests are turned
 * away with 503 so the gateway wakes a fresh runtime instead.
 */
export class Activity {
  lastActivity = Date.now();
  activeRuns = 0;
  sleeping = false;

  touch() {
    this.lastActivity = Date.now();
  }

  /** Counts a run from start to finish (streamed web runs, scheduled runs, WhatsApp messages). */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.activeRuns++;
    this.touch();
    try {
      return await work();
    } finally {
      this.activeRuns--;
      this.touch();
    }
  }
}
