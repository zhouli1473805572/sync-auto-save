import type { RemotelySavePluginSettings } from "./baseTypes";

export const getAutoSyncTiming = (settings: RemotelySavePluginSettings) => {
  const valid = (value: number | undefined, fallback: number) =>
    value !== undefined &&
    Number.isInteger(value / 1000) &&
    value >= 1000 &&
    value <= 3600000
      ? value
      : fallback;
  return {
    interval: valid(settings.syncOnSaveMinIntervalMilliseconds, 10000),
  };
};

interface AutoSyncOptions {
  interval: number;
  isSyncing: () => boolean;
  sync: () => Promise<void>;
  onError: (error: unknown) => void;
}

// Vault events, including deletions, are the source of truth. An active editor
// and a file's mtime cannot tell us whether another file was deleted or renamed.
export class AutoSyncScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private pending = false;
  private running = false;
  private disposed = false;
  private lastChangeAt = 0;

  constructor(private readonly options: AutoSyncOptions) {}

  updateTiming(timing: Pick<AutoSyncOptions, "interval">) {
    Object.assign(this.options, timing);
    if (this.pending) this.schedule();
  }

  notifyChange() {
    if (this.disposed) return;
    this.lastChangeAt = Date.now();
    this.pending = true;
    this.schedule();
  }

  notifySyncDone() {
    if (this.pending && !this.running && !this.disposed) this.schedule();
  }

  dispose() {
    this.disposed = true;
    this.pending = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    // SYNC_DONE/finally will schedule queued changes when the current run ends.
    if (
      this.disposed ||
      !this.pending ||
      this.running ||
      this.options.isSyncing()
    )
      return;
    // Debounce: every vault change restarts the quiet period. Continuous
    // editing must never trigger a run just because an earlier timer expired.
    const dueAt = this.lastChangeAt + this.options.interval;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flush();
      },
      Math.max(0, dueAt - Date.now())
    );
  }

  private async flush() {
    if (this.disposed || !this.pending) return;
    // Keep the change queued until the current manual/automatic sync finishes.
    if (this.running || this.options.isSyncing()) return;
    this.pending = false;
    this.running = true;
    try {
      await this.options.sync();
    } catch (error) {
      this.options.onError(error);
    } finally {
      this.running = false;
      if (this.pending && !this.disposed && !this.options.isSyncing()) {
        this.schedule();
      }
    }
  }
}
