/** Running message and interaction handlers that shutdown lets finish before cancelling them. */
export class InFlightWork {
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly onFailure: () => void = () => {}) {}

  get size(): number { return this.running.size; }

  /** Returns `task` unchanged; a rejection is reported here instead of becoming an unhandled rejection. */
  track<T>(task: Promise<T>): Promise<T> {
    const settled = task.then(() => {}, () => {
      try { this.onFailure(); } catch { /* Reporting must not stop shutdown accounting. */ }
    });
    this.running.add(settled);
    void settled.then(() => this.running.delete(settled));
    return task;
  }

  /** Waits until every tracked task settles or `limitMs` passes. Returns whether all of them finished. */
  async settle(limitMs: number): Promise<boolean> {
    const deadline = Date.now() + limitMs;
    while (this.running.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = await Promise.race([
        Promise.all(this.running).then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(resolve, remaining, true); }),
      ]);
      clearTimeout(timer);
      if (expired) return false;
    }
    return true;
  }
}
