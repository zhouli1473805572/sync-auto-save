import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInNewContext } from "vm";
import { transformSync } from "esbuild";
import { AutoSyncScheduler, getAutoSyncTiming } from "../src/autoSyncScheduler";

class FakeClock {
  now = 0;
  private nextID = 1;
  tasks = new Map<number, { time: number; callback: () => void }>();
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextID++;
    this.tasks.set(id, { time: this.now + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>) => {
    this.tasks.delete(id as unknown as number);
  };
  async advance(ms: number) {
    this.now += ms;
    for (const [id, task] of Array.from(this.tasks)) {
      if (task.time <= this.now) {
        this.tasks.delete(id);
        task.callback();
      }
    }
    // Flush async sync completion/finally callbacks without real timers.
    for (let n = 0; n < 8; n++) await Promise.resolve();
  }
}

class FakeEvents {
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  on(name: string, callback: (...args: any[]) => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
    return { name, callback };
  }
  off(name: string, callback: (...args: any[]) => void) {
    this.listeners.get(name)?.delete(callback);
  }
  trigger(name: string, ...args: any[]) {
    this.listeners.get(name)?.forEach((callback) => callback(...args));
  }
}

// Exercise the real plugin's registration/toggle/unload methods with a small
// Obsidian host stub. Other imports are unused by these methods and are stubbed.
const loadPluginClass = () => {
  const js = transformSync(readFileSync(resolve("src/main.ts"), "utf8"), {
    loader: "ts",
    format: "cjs",
    target: "es2020",
  }).code;
  const module = { exports: {} as any };
  runInNewContext(js, {
    module,
    exports: module.exports,
    console,
    require: (name: string) => {
      if (name === "obsidian") return { Plugin: class {}, Events: FakeEvents };
      if (name === "./autoSyncScheduler")
        return { AutoSyncScheduler, getAutoSyncTiming };
      return {};
    },
  });
  return module.exports.default;
};

describe("Automatic sync on vault changes", () => {
  let clock: FakeClock;
  let oldSetTimeout: typeof globalThis.setTimeout;
  let oldClearTimeout: typeof globalThis.clearTimeout;
  let oldDateNow: typeof Date.now;
  let plugin: any;
  let vault: FakeEvents;
  let syncs: number;

  beforeEach(() => {
    clock = new FakeClock();
    oldSetTimeout = globalThis.setTimeout;
    oldClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = clock.setTimeout as typeof setTimeout;
    globalThis.clearTimeout = clock.clearTimeout as typeof clearTimeout;
    oldDateNow = Date.now;
    Date.now = () => clock.now;
    const PluginClass = loadPluginClass();
    plugin = new PluginClass();
    vault = new FakeEvents();
    syncs = 0;
    plugin.settings = { syncOnSaveAfterMilliseconds: 1000 };
    plugin.isSyncing = false;
    plugin.manifest = { id: "sync-auto-save" };
    plugin.syncEvent = new FakeEvents();
    plugin.registerEvent = () => {};
    plugin.app = {
      vault,
      workspace: {
        onLayoutReady: (callback: () => void) => callback(),
        getActiveFile: () => {
          throw Error("Must not depend on the active editor");
        },
      },
    };
    plugin.syncRun = async (source: string) => {
      assert.equal(source, "auto_sync_on_save");
      syncs++;
      plugin.syncEvent.trigger("SYNC_DONE");
    };
    plugin.toggleSyncOnSaveIfSet();
  });

  afterEach(async () => {
    await plugin.onunload();
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
    Date.now = oldDateNow;
  });

  for (const event of ["delete", "rename", "create", "modify"]) {
    it(`syncs on ${event} even without an active file`, async () => {
      vault.trigger(event, { path: "other-note.md", stat: { mtime: 1 } });
      await clock.advance(2999);
      assert.equal(syncs, 0);
      await clock.advance(1);
      assert.equal(syncs, 1);
      await clock.advance(10000);
      assert.equal(syncs, 1, "completion alone must not trigger another sync");
    });
  }

  it("coalesces folder/child deletions and waits after the latest event", async () => {
    vault.trigger("delete", { path: "folder/a.md" });
    await clock.advance(500);
    vault.trigger("delete", { path: "folder/b.md" });
    vault.trigger("delete", { path: "folder", children: [] });
    await clock.advance(2999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("groups changes until the minimum interval after the previous sync ends", async () => {
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(3000);
    assert.equal(syncs, 1);
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(3000);
    assert.equal(syncs, 1);
    vault.trigger("delete", { path: "other.md" });
    await clock.advance(6999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("uses the configured delay and interval", async () => {
    plugin.settings.syncOnSaveDelayMilliseconds = 5000;
    plugin.settings.syncOnSaveMinIntervalMilliseconds = 60000;
    plugin.updateSyncOnSaveTiming();
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(4999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
    vault.trigger("delete", { path: "other.md" });
    await clock.advance(59999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("retains pending deletion and cooldown when timing changes", async () => {
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(3000);
    vault.trigger("delete", { path: "other.md" });
    plugin.settings.syncOnSaveDelayMilliseconds = 5000;
    plugin.settings.syncOnSaveMinIntervalMilliseconds = 20000;
    plugin.updateSyncOnSaveTiming();
    await clock.advance(19999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("bounds waiting during continuous edits", async () => {
    vault.trigger("modify", { path: "note.md" });
    for (let n = 0; n < 14; n++) {
      await clock.advance(2000);
      vault.trigger("modify", { path: "note.md" });
      assert.equal(syncs, 0);
    }
    await clock.advance(1999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("queues deletion during a manual sync until completion", async () => {
    plugin.isSyncing = true;
    vault.trigger("delete", { path: "deleted.md" });
    await clock.advance(3000);
    assert.equal(syncs, 0);
    plugin.isSyncing = false;
    plugin.syncEvent.trigger("SYNC_DONE");
    await clock.advance(9999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("keeps changes that arrive during the automatic sync", async () => {
    let finish!: () => void;
    plugin.syncRun = async () => {
      syncs++;
      if (syncs === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    };
    vault.trigger("modify", { path: "edited.md" });
    await clock.advance(3000);
    vault.trigger("delete", { path: "deleted.md" });
    await clock.advance(1000);
    assert.equal(syncs, 1, "syncs must never overlap");
    finish();
    await clock.advance(0);
    await clock.advance(9999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
    await clock.advance(5000);
    assert.equal(syncs, 2);
  });

  it("cancels queued work when disabled and registers only once on re-enable", async () => {
    vault.trigger("delete", { path: "deleted.md" });
    plugin.settings.syncOnSaveAfterMilliseconds = -1;
    plugin.toggleSyncOnSaveIfSet();
    await clock.advance(3000);
    assert.equal(syncs, 0);
    plugin.settings.syncOnSaveAfterMilliseconds = 1000;
    plugin.toggleSyncOnSaveIfSet();
    plugin.toggleSyncOnSaveIfSet();
    assert.equal(vault.listeners.get("delete")!.size, 1);
    vault.trigger("delete", { path: "another.md" });
    await clock.advance(3000);
    assert.equal(syncs, 1);
  });

  it("does not attach stale listeners when disabled before layout is ready", () => {
    const callbacks: (() => void)[] = [];
    plugin.app.workspace.onLayoutReady = (callback: () => void) =>
      callbacks.push(callback);
    plugin.toggleSyncOnSaveIfSet();
    plugin.settings.syncOnSaveAfterMilliseconds = -1;
    plugin.toggleSyncOnSaveIfSet();
    callbacks.forEach((callback) => callback());
    assert.equal(vault.listeners.get("delete")!.size, 0);
  });

  it("cancels the timer when the plugin is unloaded", async () => {
    vault.trigger("delete", { path: "deleted.md" });
    await plugin.onunload();
    await clock.advance(3000);
    assert.equal(syncs, 0);
    assert.equal(clock.tasks.size, 0);
  });

  it("reports rejection and allows a later change to sync", async () => {
    const errors: unknown[] = [];
    const scheduler = new AutoSyncScheduler({
      delay: 1000,
      minInterval: 10000,
      isSyncing: () => false,
      sync: async () => {
        if (++syncs === 1) throw Error("network failure");
      },
      onError: (error) => errors.push(error),
    });
    scheduler.notifyChange();
    await clock.advance(1000);
    assert.equal(errors.length, 1);
    scheduler.notifyChange();
    await clock.advance(9999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
    scheduler.dispose();
  });
});
