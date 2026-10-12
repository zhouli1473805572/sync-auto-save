import type { InternalDBs } from "./localdb";

type HistoryDB = Pick<
  InternalDBs,
  | "vaultRandomIDMappingTbl"
  | "versionTbl"
  | "prevSyncRecordsTbl"
  | "fileContentHistoryTbl"
  | "fileHistoryTbl"
  | "syncMappingTbl"
>;

// Copy the old baseline once so a local deletion is recognized as a deletion,
// rather than as a remote-only file to download on the fork's first sync.
// The source stores are read only; the two plugins then maintain separate DBs.
export const migrateSyncHistoryForVault = async (
  source: HistoryDB,
  target: HistoryDB,
  vaultBasePath: string
) => {
  const pathKey = `path2id\t${vaultBasePath}`;
  if ((await target.vaultRandomIDMappingTbl.getItem(pathKey)) !== null) return;
  const vaultID = await source.vaultRandomIDMappingTbl.getItem<string>(pathKey);
  if (!vaultID) return;

  const tableNames = [
    "versionTbl",
    "prevSyncRecordsTbl",
    "fileContentHistoryTbl",
    "fileHistoryTbl",
    "syncMappingTbl",
  ] as const;
  for (const name of tableNames) {
    for (const key of await source[name].keys()) {
      if (key.startsWith(`${vaultID}\t`)) {
        const value = await source[name].getItem(key);
        if (value !== null) await target[name].setItem(key, value);
      }
    }
  }
  // Older databases used one schema version for all vaults.
  const versionKey = `${vaultID}\tversion`;
  if ((await target.versionTbl.getItem(versionKey)) === null) {
    const version = await source.versionTbl.getItem("version");
    if (version !== null) await target.versionTbl.setItem(versionKey, version);
  }
  await target.vaultRandomIDMappingTbl.setItem(
    `id2path\t${vaultID}`,
    vaultBasePath
  );
  // Write this last, so a failed migration can be retried before syncing starts.
  await target.vaultRandomIDMappingTbl.setItem(pathKey, vaultID);
};
