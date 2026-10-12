import { strict as assert } from "assert";
import { syncer } from "../pro/src/sync";
import type { Entity, RemotelySavePluginSettings } from "../src/baseTypes";
import type { FakeFs } from "../src/fsAll";
import type { FakeFsEncrypt } from "../src/fsEncrypt";
import type { InternalDBs } from "../src/localdb";
import { migrateSyncHistoryForVault } from "../src/syncHistoryMigration";

const memoryDB = () =>
  Object.fromEntries(
    [
      "vaultRandomIDMappingTbl",
      "versionTbl",
      "prevSyncRecordsTbl",
      "fileContentHistoryTbl",
      "fileHistoryTbl",
      "syncMappingTbl",
      "syncPlansTbl",
    ].map((name) => {
      const data = new Map<string, any>();
      return [
        name,
        {
          getItem: async (key: string) => data.get(key) ?? null,
          setItem: async (key: string, value: any) => {
            data.set(key, value);
            return value;
          },
          removeItem: async (key: string) => {
            data.delete(key);
          },
          getItems: async () => Object.fromEntries(data),
          keys: async () => Array.from(data.keys()),
        },
      ];
    })
  ) as unknown as InternalDBs;

describe("Deletion sync with the inherited baseline", () => {
  let oldWindow: typeof globalThis.window;
  beforeEach(() => {
    oldWindow = globalThis.window;
    globalThis.window = {
      moment: (time: number) => ({
        format: () => new Date(time).toISOString(),
        toISOString: () => new Date(time).toISOString(),
      }),
    } as any;
  });
  afterEach(() => {
    globalThis.window = oldWindow;
  });

  for (const scenario of [
    {
      name: "syncs a new empty folder to S3 and preserves it across consecutive syncs",
      remoteDeletes: false,
    },
    {
      name: "propagates deletion of a real remote folder marker to the local folder",
      remoteDeletes: true,
    },
  ]) {
    it(scenario.name, async () => {
      const db = memoryDB();
      const files: Entity[] = ["kept-a.md", "kept-b.md"].map((key) => ({
        key,
        keyRaw: key,
        keyEnc: key,
        mtimeCli: 1000,
        mtimeSvr: 1000,
        size: 42,
        sizeRaw: 42,
        sizeEnc: 42,
      }));
      const folder: Entity = {
        key: "new-folder/",
        keyRaw: "new-folder/",
        size: 0,
        sizeRaw: 0,
      };
      let folderExists = true;
      const removed: string[] = [];
      const created: Entity[] = [];
      let remoteFolder: Entity | undefined;
      const errors: Error[] = [];
      const settings = {
        serviceType: "s3",
        s3: { generateFolderObject: true },
        password: "",
        conflictAction: "keep_newer",
        syncDirection: "bidirectional",
        protectModifyPercentage: 50,
        pro: { refreshToken: "", enabledProFeatures: [] },
      } as unknown as RemotelySavePluginSettings;
      const local = {
        walk: async () => (folderExists ? [...files, folder] : files),
        stat: async (key: string) =>
          key === folder.key ? folder : files.find((file) => file.key === key),
        rm: async (key: string) => {
          removed.push(key);
          folderExists = false;
        },
      } as unknown as FakeFs;
      for (let round = 0; round < 2; round++) {
        if (round === 1 && scenario.remoteDeletes) remoteFolder = undefined;
        // A fresh client sees the persisted S3 folder marker unless it was
        // explicitly deleted on the remote side between syncs.
        const remote = {} as FakeFs;
        const encrypted = {
          innerFs: remote,
          isPasswordOk: async () => ({ ok: true }),
          walk: async () => (remoteFolder ? [...files, remoteFolder] : files),
          encryptEntity: async (entity: Entity) => entity,
          mkdir: async () => {
            const entity = {
              ...folder,
              sizeEnc: 0,
              synthesizedFolder: !settings.s3.generateFolderObject,
            };
            created.push(entity);
            remoteFolder = entity;
            return entity;
          },
        } as unknown as FakeFsEncrypt;
        await syncer(
          local,
          remote,
          encrypted,
          undefined,
          db,
          "auto_sync_on_save",
          "s3-default-1",
          "vault",
          ".obsidian",
          settings,
          "0.1.0",
          async () => {},
          () => "bulk deletion protection",
          () => {},
          undefined,
          async (_source, error) => {
            errors.push(error);
          }
        );
      }
      assert.deepEqual(errors, []);
      assert.equal(folderExists, !scenario.remoteDeletes);
      assert.deepEqual(removed, scenario.remoteDeletes ? [folder.key] : []);
      assert.equal(created.length, 1);
      assert.equal(created[0].synthesizedFolder, false);
    });
  }
  for (const protectPercentage of [50, 25]) {
    it(
      protectPercentage === 50
        ? "deletes a previously synced remote note without restoring it locally"
        : "retains bulk deletion protection after importing history",
      async () => {
        const source = memoryDB();
        const target = memoryDB();
        const entities: Entity[] = ["deleted.md", "kept-a.md", "kept-b.md"].map(
          (key) => ({
            key,
            keyRaw: key,
            keyEnc: key,
            mtimeCli: 1000,
            mtimeSvr: 1000,
            size: 42,
            sizeRaw: 42,
            sizeEnc: 42,
          })
        );
        const vaultID = "test-vault";
        const profileID = "s3-default-1";
        await source.vaultRandomIDMappingTbl.setItem("path2id\tvault", vaultID);
        for (const entity of entities) {
          await source.prevSyncRecordsTbl.setItem(
            `${vaultID}\t${profileID}\t${entity.key}`,
            entity
          );
        }
        await migrateSyncHistoryForVault(source, target, "vault");

        const deleted: string[] = [];
        const errors: Error[] = [];
        const local = {
          walk: async () => entities.slice(1),
          writeFile: async () => {
            throw Error("Deleted note must not be restored");
          },
        } as unknown as FakeFs;
        const remote = {} as FakeFs;
        const encrypted = {
          innerFs: remote,
          isPasswordOk: async () => ({ ok: true }),
          walk: async () => entities,
          encryptEntity: async (entity: Entity) => entity,
          rm: async (key: string) => {
            deleted.push(key);
          },
        } as unknown as FakeFsEncrypt;
        const settings = {
          serviceType: "s3",
          password: "",
          conflictAction: "keep_newer",
          syncDirection: "bidirectional",
          protectModifyPercentage: protectPercentage,
          pro: { refreshToken: "", enabledProFeatures: [] },
        } as unknown as RemotelySavePluginSettings;
        let busy = false;
        await syncer(
          local,
          remote,
          encrypted,
          undefined,
          target,
          "auto_sync_on_save",
          profileID,
          vaultID,
          ".obsidian",
          settings,
          "0.1.0",
          async () => {},
          () => "bulk deletion protection",
          (value) => {
            busy = value;
          },
          undefined,
          async (_source, error) => {
            errors.push(error);
          }
        );
        assert.equal(busy, false);
        if (protectPercentage === 50) {
          assert.deepEqual(errors, []);
          assert.deepEqual(deleted, ["deleted.md"]);
          assert.equal(
            await target.prevSyncRecordsTbl.getItem(
              `${vaultID}\t${profileID}\tdeleted.md`
            ),
            null
          );
        } else {
          assert.deepEqual(deleted, []);
          assert.equal(errors.length, 1);
          assert.match(errors[0].message, /bulk deletion protection/);
        }
        assert.notEqual(
          await source.prevSyncRecordsTbl.getItem(
            `${vaultID}\t${profileID}\tdeleted.md`
          ),
          null
        );
      }
    );
  }
});
