import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { resolve } from "path";
import { runInNewContext } from "vm";
import { transformSync } from "esbuild";
import { AutoSyncScheduler, getAutoSyncTiming } from "../src/autoSyncScheduler";
import { LocalSyncChanges } from "../src/localSyncChanges";
import { getFolderLevels, statFix } from "../src/misc";

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
  listeners = new Map<string, Set<(...args: any[]) => any>>();
  pending: Promise<any>[] = [];
  on(name: string, callback: (...args: any[]) => any) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(callback);
    return { name, callback };
  }
  off(name: string, callback: (...args: any[]) => void) {
    this.listeners.get(name)?.delete(callback);
  }
  offref(ref: { name: string; callback: (...args: any[]) => any }) {
    this.off(ref.name, ref.callback);
  }
  trigger(name: string, ...args: any[]) {
    this.listeners.get(name)?.forEach((callback) => {
      const result = callback(...args);
      if (result && typeof result.then === "function")
        this.pending.push(result);
    });
  }
  async settle() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}

const loadFsLocalClass = () => {
  const module = { exports: {} as any };
  runInNewContext(
    transformSync(readFileSync(resolve("src/fsLocal.ts"), "utf8"), {
      loader: "ts",
      format: "cjs",
      target: "es2020",
    }).code,
    {
      module,
      exports: module.exports,
      console,
      require: (name: string) => {
        if (name === "./fsAll") return { FakeFs: class {} };
        if (name === "./misc")
          return {
            getFolderLevels,
            statFix,
            unixTimeToStr: (time: number) => `${time}`,
          };
        return {};
      },
    }
  );
  return module.exports.FakeFsLocal;
};

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
      if (name === "./localSyncChanges") return { LocalSyncChanges };
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
  let local: any;
  let files: Map<
    string,
    {
      type: "file" | "folder";
      content?: ArrayBuffer;
      mtime: number;
      ctime: number;
      size: number;
    }
  >;

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
    files = new Map();
    const emit = (name: string, path: string, oldPath?: string) =>
      vault.trigger(name, { path }, oldPath);
    const adapter = {
      exists: async (path: string) => files.has(path.replace(/\/$/, "")),
      stat: async (path: string) => files.get(path.replace(/\/$/, "")) ?? null,
      readBinary: async (path: string) => {
        const content = files.get(path)?.content;
        if (!content) throw Error("File does not exist");
        return content.slice(0);
      },
      writeBinary: async (path: string, content: ArrayBuffer, options: any) => {
        const event = files.has(path) ? "modify" : "create";
        files.set(path, {
          type: "file",
          content: content.slice(0),
          ...options,
          size: content.byteLength,
        });
        emit(event, path);
      },
      mkdir: async (path: string) => {
        files.set(path, {
          type: "folder",
          mtime: clock.now,
          ctime: clock.now,
          size: 0,
        });
        emit("create", path);
      },
      trashLocal: async (path: string) => {
        path = path.replace(/\/$/, "");
        for (const key of [...files.keys()]) {
          if (key === path || key.startsWith(`${path}/`)) {
            files.delete(key);
            emit("delete", key);
          }
        }
      },
      rename: async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath)!);
        files.delete(oldPath);
        emit("rename", newPath, oldPath);
      },
    };
    Object.assign(vault, {
      adapter,
      getAllLoadedFiles: () => [...files.keys()].map((path) => ({ path })),
    });
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
    const FsLocal = loadFsLocalClass();
    local = new FsLocal(
      vault,
      false,
      false,
      ".obsidian",
      "sync-auto-save",
      undefined,
      "obsidian",
      plugin.localSyncChanges
    );
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
      await clock.advance(9999);
      assert.equal(syncs, 0);
      await clock.advance(1);
      assert.equal(syncs, 1);
      await clock.advance(10000);
      assert.equal(syncs, 1, "completion alone must not trigger another sync");
    });
  }

  it("coalesces folder/child deletions and waits after the last event", async () => {
    vault.trigger("delete", { path: "folder/a.md" });
    await clock.advance(500);
    vault.trigger("delete", { path: "folder/b.md" });
    vault.trigger("delete", { path: "folder", children: [] });
    await clock.advance(9999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("groups changes until the quiet interval after the latest change", async () => {
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(10000);
    assert.equal(syncs, 1);
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(3000);
    assert.equal(syncs, 1);
    vault.trigger("delete", { path: "other.md" });
    await clock.advance(9999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("uses the configured single throttle interval", async () => {
    plugin.settings.syncOnSaveMinIntervalMilliseconds = 60000;
    plugin.updateSyncOnSaveTiming();
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(59999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
    vault.trigger("delete", { path: "other.md" });
    await clock.advance(59999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("retains pending deletion when timing changes", async () => {
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(10000);
    vault.trigger("delete", { path: "other.md" });
    plugin.settings.syncOnSaveMinIntervalMilliseconds = 20000;
    plugin.updateSyncOnSaveTiming();
    await clock.advance(19999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
  });

  it("waits for a full quiet interval even after prolonged editing", async () => {
    vault.trigger("modify", { path: "note.md" });
    for (let n = 0; n < 30; n++) {
      await clock.advance(2000);
      vault.trigger("modify", { path: "note.md" });
      assert.equal(syncs, 0);
    }
    await clock.advance(9999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("resumes after a manual sync using the remaining quiet interval", async () => {
    plugin.isSyncing = true;
    vault.trigger("delete", { path: "deleted.md" });
    await clock.advance(3000);
    assert.equal(syncs, 0);
    plugin.isSyncing = false;
    plugin.syncEvent.trigger("SYNC_DONE");
    await clock.advance(6999);
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
    await clock.advance(10000);
    vault.trigger("delete", { path: "deleted.md" });
    await clock.advance(1000);
    assert.equal(syncs, 1, "syncs must never overlap");
    finish();
    await clock.advance(0);
    await clock.advance(8999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
    await clock.advance(5000);
    assert.equal(syncs, 2);
  });

  it("restarts the countdown when another file changes near the deadline", async () => {
    vault.trigger("modify", { path: "first.md" });
    await clock.advance(9000);
    vault.trigger("modify", { path: "second.md" });
    await clock.advance(1000);
    assert.equal(
      syncs,
      0,
      "the first modification's deadline must be cancelled"
    );
    await clock.advance(8999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("cancels queued work when disabled and registers only once on re-enable", async () => {
    vault.trigger("delete", { path: "deleted.md" });
    plugin.settings.syncOnSaveAfterMilliseconds = -1;
    plugin.toggleSyncOnSaveIfSet();
    await clock.advance(10000);
    assert.equal(syncs, 0);
    plugin.settings.syncOnSaveAfterMilliseconds = 1000;
    plugin.toggleSyncOnSaveIfSet();
    plugin.toggleSyncOnSaveIfSet();
    assert.equal(vault.listeners.get("delete")!.size, 1);
    vault.trigger("delete", { path: "another.md" });
    await clock.advance(10000);
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
    await clock.advance(10000);
    assert.equal(syncs, 0);
    assert.equal(clock.tasks.size, 0);
  });

  it("reports rejection and allows a later change to sync", async () => {
    const errors: unknown[] = [];
    const scheduler = new AutoSyncScheduler({
      interval: 1000,
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
    await clock.advance(999);
    assert.equal(syncs, 1);
    await clock.advance(1);
    assert.equal(syncs, 2);
    scheduler.dispose();
  });

  it("does not restart sync after its own download, even without baseline convergence", async () => {
    plugin.syncRun = async () => {
      syncs++;
      // Every run would download again if saving its baseline failed.
      await local.writeFile(
        "downloaded.md",
        new Uint8Array([1, 2, 3]).buffer,
        1,
        1
      );
      plugin.syncEvent.trigger("SYNC_DONE");
    };
    vault.trigger("modify", { path: "user-note.md" });
    for (let n = 0; n < 6; n++) {
      await clock.advance(10000);
      await vault.settle();
      await clock.advance(0);
    }
    assert.equal(syncs, 1);
  });

  it("ignores download notifications arriving after sync completion", async () => {
    await local.writeFile(
      "downloaded.md",
      new Uint8Array([1, 2, 3]).buffer,
      1,
      1
    );
    await vault.settle();
    await clock.advance(15000);
    vault.trigger("modify", { path: "downloaded.md" });
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 0);
  });

  it("keeps a user's different content in the downloaded file, even with the same size and mtime", async () => {
    await local.writeFile(
      "downloaded.md",
      new Uint8Array([1, 2, 3]).buffer,
      1,
      1
    );
    await vault.settle();
    plugin.isSyncing = true;
    files.get("downloaded.md")!.content = new Uint8Array([4, 5, 6]).buffer;
    vault.trigger("modify", { path: "downloaded.md" });
    await vault.settle();
    await clock.advance(3000);
    plugin.isSyncing = false;
    plugin.syncEvent.trigger("SYNC_DONE");
    await clock.advance(6999);
    assert.equal(syncs, 0);
    await clock.advance(1);
    assert.equal(syncs, 1);
  });

  it("ignores sync-created parent folders and recursive deletions, but keeps user deletions", async () => {
    await local.mkdir("remote/nested/");
    await local.writeFile(
      "remote/nested/note.md",
      new Uint8Array([1]).buffer,
      1,
      1
    );
    await vault.settle();
    await local.rm("remote/");
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 0);
    vault.trigger("delete", { path: "user-folder/note.md" });
    await clock.advance(10000);
    assert.equal(syncs, 1);
  });

  it("ignores a conflict rename but keeps a later user rename", async () => {
    await local.writeFile("note.md", new Uint8Array([1]).buffer, 1, 1);
    await vault.settle();
    await local.rename("note.md", "note.dup.md");
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 0);
    (vault as any).adapter.rename("note.dup.md", "user-renamed.md");
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 1);
  });

  it("keeps user deletion of a freshly downloaded file", async () => {
    await local.writeFile("downloaded.md", new Uint8Array([1]).buffer, 1, 1);
    await vault.settle();
    files.delete("downloaded.md");
    vault.trigger("delete", { path: "downloaded.md" });
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 1);
  });

  it("lets expired expectations and unreadable file events trigger sync", async () => {
    await local.writeFile("downloaded.md", new Uint8Array([1]).buffer, 1, 1);
    await vault.settle();
    await clock.advance(60001);
    vault.trigger("modify", { path: "downloaded.md" });
    await clock.advance(10000);
    assert.equal(syncs, 1);
    await local.writeFile("unreadable.md", new Uint8Array([1]).buffer, 1, 1);
    await vault.settle();
    (vault as any).adapter.readBinary = async () => {
      throw Error("read failed");
    };
    vault.trigger("modify", { path: "unreadable.md" });
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 2);
  });

  it("cancels suppression when a local write fails", async () => {
    const original = (vault as any).adapter.writeBinary;
    (vault as any).adapter.writeBinary = async () => {
      throw Error("disk full");
    };
    await assert.rejects(
      local.writeFile("note.md", new Uint8Array([1]).buffer, 1, 1)
    );
    (vault as any).adapter.writeBinary = original;
    await original("note.md", new Uint8Array([1]).buffer, {
      mtime: 1,
      ctime: 1,
    });
    await vault.settle();
    await clock.advance(10000);
    assert.equal(syncs, 1);
  });

  it("does not sync while idle, before or after one completed sync", async () => {
    for (let n = 0; n < 120; n++) await clock.advance(10000);
    assert.equal(syncs, 0);
    vault.trigger("modify", { path: "note.md" });
    await clock.advance(10000);
    for (let n = 0; n < 120; n++) await clock.advance(10000);
    assert.equal(syncs, 1);
  });
});
