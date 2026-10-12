import { DEFAULT_DEBUG_FOLDER, type Entity } from "./baseTypes";
import { FakeFs } from "./fsAll";

import { TFile, TFolder, type Vault } from "obsidian";
import { getFolderLevels, statFix, unixTimeToStr } from "./misc";
import type { LocalSyncChanges } from "./localSyncChanges";
import { listFilesInObsFolder } from "./obsFolderLister";
import type { Profiler } from "./profiler";

export class FakeFsLocal extends FakeFs {
  vault: Vault;
  syncConfigDir: boolean;
  syncBookmarks: boolean;
  configDir: string;
  pluginID: string;
  profiler: Profiler | undefined;
  deleteToWhere: "obsidian" | "system";
  kind: "local";
  constructor(
    vault: Vault,
    syncConfigDir: boolean,
    syncBookmarks: boolean,
    configDir: string,
    pluginID: string,
    profiler: Profiler | undefined,
    deleteToWhere: "obsidian" | "system",
    private readonly localChanges?: LocalSyncChanges
  ) {
    super();

    this.vault = vault;
    this.syncConfigDir = syncConfigDir;
    this.syncBookmarks = syncBookmarks;
    this.configDir = configDir;
    this.pluginID = pluginID;
    this.profiler = profiler;
    this.deleteToWhere = deleteToWhere;
    this.kind = "local";
  }

  async walk(): Promise<Entity[]> {
    this.profiler?.addIndent();
    this.profiler?.insert("enter walk for local");
    const local: Entity[] = [];

    const localTAbstractFiles = this.vault.getAllLoadedFiles();
    this.profiler?.insert("finish getting walk for local");
    for (const entry of localTAbstractFiles) {
      let r: Entity | undefined = undefined;
      let key = entry.path;
      if (key.startsWith("/")) {
        // why?
        // just remove leading slash /
        key = key.slice(1);
      }

      if (entry.path === "/" || entry.path === "") {
        // ignore
        continue;
      } else if (entry instanceof TFile) {
        let mtimeLocal: number | undefined = entry.stat.mtime;
        if (mtimeLocal <= 0) {
          mtimeLocal = entry.stat.ctime;
        }
        if (mtimeLocal === 0) {
          mtimeLocal = undefined;
        }
        if (mtimeLocal === undefined) {
          throw Error(
            `Your file has last modified time 0: ${key}, don't know how to deal with it`
          );
        }
        r = {
          key: key, // local always unencrypted
          keyRaw: key,
          mtimeCli: mtimeLocal,
          mtimeSvr: mtimeLocal,
          size: entry.stat.size, // local always unencrypted
          sizeRaw: entry.stat.size,
        };
      } else if (entry instanceof TFolder) {
        key = `${key}/`;
        r = {
          key: key,
          keyRaw: key,
          size: 0,
          sizeRaw: 0,
        };
      } else {
        throw Error(`unexpected ${entry}`);
      }

      if (r.keyRaw.startsWith(DEFAULT_DEBUG_FOLDER)) {
        // skip listing the debug folder,
        // which should always not involved in sync
        // continue;
      } else {
        local.push(r);
      }
    }

    this.profiler?.insert("finish transforming walk for local");

    if (this.syncConfigDir || this.syncBookmarks) {
      this.profiler?.insert("into syncConfigDir or syncBookmarks");
      const bookmarksOnly = !this.syncConfigDir;
      const syncFiles = await listFilesInObsFolder(
        this.configDir,
        this.vault,
        this.pluginID,
        bookmarksOnly
      );
      // console.debug(`syncFiles in obs: ${JSON.stringify(syncFiles, null, 2)}`);
      for (const f of syncFiles) {
        local.push(f);
      }
      this.profiler?.insert("finish syncConfigDir");
    }

    this.profiler?.insert("finish walk for local");
    this.profiler?.removeIndent();
    return local;
  }

  async walkPartial(): Promise<Entity[]> {
    return await this.walk();
  }

  async stat(key: string): Promise<Entity> {
    const statRes = await statFix(this.vault, key);
    if (statRes === undefined || statRes === null) {
      throw Error(`${key} does not exist! cannot stat for local`);
    }
    const isFolder = statRes.type === "folder";
    return {
      key: isFolder ? `${key}/` : key, // local always unencrypted
      keyRaw: isFolder ? `${key}/` : key,
      ctimeCli: statRes.ctime,
      mtimeCli: statRes.mtime,
      mtimeSvr: statRes.mtime,
      ctimeCliFmt: unixTimeToStr(statRes.ctime),
      mtimeCliFmt: unixTimeToStr(statRes.mtime),
      mtimeSvrFmt: unixTimeToStr(statRes.mtime),
      size: statRes.size, // local always unencrypted
      sizeRaw: statRes.size,
    };
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    // console.debug(`mkdir: ${key}`);
    for (const folder of getFolderLevels(key)) {
      if (await this.vault.adapter.exists(folder)) continue;
      const cancel = this.localChanges?.expectFolder(folder);
      try {
        await this.vault.adapter.mkdir(folder);
      } catch (error) {
        cancel?.();
        throw error;
      }
    }
    return await this.stat(key);
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    const cancel = this.localChanges?.expectWrite(key, content);
    try {
      await this.vault.adapter.writeBinary(key, content, {
        mtime: mtime,
        ctime: ctime,
      });
    } catch (error) {
      cancel?.();
      throw error;
    }
    return await this.stat(key);
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    return await this.vault.adapter.readBinary(key);
  }

  async rename(key1: string, key2: string): Promise<void> {
    const source = await this.vault.adapter.stat(key1);
    const cancelNew =
      source?.type === "folder"
        ? this.localChanges?.expectFolder(key2, key1.replace(/\/$/, ""))
        : this.localChanges?.expectWrite(
            key2,
            await this.readFile(key1),
            key1.replace(/\/$/, "")
          );
    const cancelOld = this.localChanges?.expectDelete([key1]);
    try {
      await this.vault.adapter.rename(key1, key2);
    } catch (error) {
      cancelNew?.();
      cancelOld?.();
      throw error;
    }
  }

  async rm(key: string): Promise<void> {
    const root = key.replace(/\/$/, "");
    const paths = this.vault
      .getAllLoadedFiles()
      .filter((file) => file.path.startsWith(`${root}/`))
      .map((file) => file.path);
    const cancel = this.localChanges?.expectDelete([root, ...paths]);
    try {
      if (this.deleteToWhere === "obsidian") {
        await this.vault.adapter.trashLocal(key);
      } else {
        // "system"
        if (!(await this.vault.adapter.trashSystem(key))) {
          await this.vault.adapter.trashLocal(key);
        }
      }
    } catch (error) {
      cancel?.();
      throw error;
    }
  }
  async checkConnect(callbackFunc?: any): Promise<boolean> {
    return true;
  }

  async getUserDisplayName(): Promise<string> {
    throw new Error("Method not implemented.");
  }

  async revokeAuth(): Promise<any> {
    throw new Error("Method not implemented.");
  }

  allowEmptyFile(): boolean {
    return true;
  }
}
