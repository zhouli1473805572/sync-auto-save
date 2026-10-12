import type { RemotelySavePluginSettings } from "./baseTypes";

export const getAutoSyncTiming = (settings: RemotelySavePluginSettings) => {
  const valid = (value: number | undefined, fallback: number) =>
    value !== undefined &&
    Number.isInteger(value / 1000) &&
    value >= 1000 &&
    value <= 3600000
      ? value
      : fallback;
  const delay = valid(settings.syncOnSaveDelayMilliseconds, 3000);
  return {
    delay,
    minInterval: valid(settings.syncOnSaveMinIntervalMilliseconds, 10000),
    maxWait: Math.max(30000, delay),
  };
};

interface AutoSyncOptions {
  delay: number;
  minInterval?: number;
  maxWait?: number;
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
  private firstChangeAt = 0;
  private lastChangeAt = 0;
  private lastSyncCompletedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: AutoSyncOptions) {}

  updateTiming(
    timing: Pick<AutoSyncOptions, "delay" | "minInterval" | "maxWait">
  ) {
    Object.assign(this.options, timing);
    if (this.pending) this.schedule();
  }

  notifyChange() {
    if (this.disposed) return;
    const now = Date.now();
    if (!this.pending) this.firstChangeAt = now;
    this.lastChangeAt = now;
    this.pending = true;
    this.schedule();
  }

  notifySyncDone() {
    this.lastSyncCompletedAt = Date.now();
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
    const changeDueAt = Math.min(
      this.lastChangeAt + this.options.delay,
      this.firstChangeAt + (this.options.maxWait ?? Number.POSITIVE_INFINITY)
    );
    const dueAt = Math.max(
      changeDueAt,
      this.lastSyncCompletedAt + (this.options.minInterval ?? 0)
    );
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
      // Cool down after completion, including failure; a long sync should not
      // immediately be followed by another automatic run.
      this.lastSyncCompletedAt = Date.now();
      if (this.pending && !this.disposed && !this.options.isSyncing()) {
        this.schedule();
      }
    }
  }
}
