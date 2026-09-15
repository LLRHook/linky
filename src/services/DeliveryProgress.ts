import type { DeliveryProgress } from './DeliveryContext';

const labels: Record<DeliveryProgress['stage'], string> = {
  queue: 'Waiting for a media preparation slot…',
  resolve: 'Checking the album and its available media…',
  download: 'Downloading the selected media…',
  inspect: 'Checking the original media for Discord…',
  convert: 'Preparing a compatible video while preserving source detail…',
  store: 'Saving the prepared media…',
  publish: 'Sending the preview to Discord…',
  preview: 'Waiting for Discord to confirm the preview…',
  ownership: 'Finishing the preview controls…',
};

export function deliveryProgressText(event: DeliveryProgress): string {
  const item = Number.isInteger(event.itemIndex) && Number.isInteger(event.itemCount) &&
    event.itemIndex! >= 0 && event.itemIndex! < event.itemCount!
    ? `Item ${event.itemIndex! + 1} of ${event.itemCount}. ` : '';
  return item + (event.cache === 'hit' ? 'Reusing a validated preview…' : labels[event.stage]);
}

/** Coalesce noisy work events. stop() drains the one in-flight edit before a final response. */
export function createDeliveryProgress(edit: (content: string) => Promise<unknown>,
  { delayMs = 1500, intervalMs = 1500 } = {}) {
  let stopped = false, pending: string | undefined, last: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> = Promise.resolve();
  let writing = false, nextAt = performance.now() + delayMs;
  const schedule = () => {
    if (stopped || writing || timer || !pending || pending === last) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !pending) return;
      const text = pending;
      pending = undefined;
      writing = true;
      running = Promise.resolve().then(() => edit(text)).then(() => { last = text; }, () => {})
        .finally(() => {
          writing = false;
          nextAt = performance.now() + intervalMs;
          schedule();
        });
    }, Math.max(0, nextAt - performance.now()));
    timer.unref?.();
  };
  return {
    update(event: DeliveryProgress): void {
      if (stopped || event.state === 'done') return;
      pending = deliveryProgressText(event);
      schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      await running;
    },
  };
}
