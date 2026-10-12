import { strict as assert } from "assert";
import type { InternalDBs } from "../src/localdb";
import { migrateSyncHistoryForVault } from "../src/syncHistoryMigration";

const createDB = () =>
  Object.fromEntries(
    [
      "vaultRandomIDMappingTbl",
      "versionTbl",
      "prevSyncRecordsTbl",
      "fileContentHistoryTbl",
      "fileHistoryTbl",
      "syncMappingTbl",
    ].map((name) => {
      const values = new Map<string, any>();
      return [
        name,
        {
          getItem: async (key: string) => values.get(key) ?? null,
          setItem: async (key: string, value: any) => {
            values.set(key, value);
            return value;
          },
          keys: async () => Array.from(values.keys()),
        },
      ];
    })
  ) as unknown as InternalDBs;

describe("Fork sync history migration", () => {
  it("inherits the deletion baseline for this vault without modifying the source", async () => {
    const source = createDB();
    const target = createDB();
    const path = "D:/zlnote";
    const key = "vault1\ts3\tdeleted.md";
    const record = { key: "deleted.md", size: 42, mtimeCli: 1000 };
    await source.vaultRandomIDMappingTbl.setItem(`path2id\t${path}`, "vault1");
    await source.versionTbl.setItem("vault1\tversion", 20240220);
    await source.prevSyncRecordsTbl.setItem(key, record);
    await source.prevSyncRecordsTbl.setItem("otherVault\ts3\tother.md", record);
    await source.fileContentHistoryTbl.setItem(
      key,
      new Uint8Array([1, 2]).buffer
    );
    await migrateSyncHistoryForVault(source, target, path);
    assert.equal(
      await target.vaultRandomIDMappingTbl.getItem(`path2id\t${path}`),
      "vault1"
    );
    assert.deepEqual(await target.prevSyncRecordsTbl.getItem(key), record);
    assert.deepEqual(await target.prevSyncRecordsTbl.keys(), [key]);
    assert.deepEqual(
      await target.fileContentHistoryTbl.getItem(key),
      new Uint8Array([1, 2]).buffer
    );
    await target.prevSyncRecordsTbl.setItem(key, { key: "changed.md" });
    await migrateSyncHistoryForVault(source, target, path);
    assert.deepEqual(await target.prevSyncRecordsTbl.getItem(key), {
      key: "changed.md",
    });
    assert.deepEqual(await source.prevSyncRecordsTbl.getItem(key), record);
  });

  it("leaves a new vault without old history ready for normal initialization", async () => {
    const target = createDB();
    await migrateSyncHistoryForVault(createDB(), target, "new-vault");
    assert.deepEqual(await target.vaultRandomIDMappingTbl.keys(), []);
  });

  it("copies a legacy global schema version", async () => {
    const source = createDB();
    const target = createDB();
    await source.vaultRandomIDMappingTbl.setItem("path2id\tvault", "id");
    await source.versionTbl.setItem("version", 20220326);
    await migrateSyncHistoryForVault(source, target, "vault");
    assert.equal(await target.versionTbl.getItem("id\tversion"), 20220326);
  });

  it("does not mark migration complete when copying fails, allowing retry", async () => {
    const source = createDB();
    const target = createDB();
    await source.vaultRandomIDMappingTbl.setItem("path2id\tvault", "id");
    await source.prevSyncRecordsTbl.setItem("id\ts3\tnote.md", {
      key: "note.md",
    });
    const save = target.prevSyncRecordsTbl.setItem.bind(
      target.prevSyncRecordsTbl
    );
    target.prevSyncRecordsTbl.setItem = async () => {
      throw Error("storage failure");
    };
    await assert.rejects(
      migrateSyncHistoryForVault(source, target, "vault"),
      /storage failure/
    );
    assert.equal(
      await target.vaultRandomIDMappingTbl.getItem("path2id\tvault"),
      null
    );
    target.prevSyncRecordsTbl.setItem = save;
    await migrateSyncHistoryForVault(source, target, "vault");
    assert.equal(
      await target.vaultRandomIDMappingTbl.getItem("path2id\tvault"),
      "id"
    );
  });
});
