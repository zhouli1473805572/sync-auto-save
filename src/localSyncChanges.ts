import type { TAbstractFile, Vault } from "obsidian";

export type VaultChange = "create" | "modify" | "delete" | "rename";
type ExpectedChange = {
  kind: "file" | "folder" | "delete";
  oldPath?: string;
  hash?: Promise<string>;
  expiresAt: number;
};

const pathKey = (path: string) => path.replace(/\/$/, "");
const digest = async (content: ArrayBuffer) =>
  Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", content))
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// Track individual local operations, never all events during a sync. Delayed
// filesystem notifications still match; a user's different content does not.
export class LocalSyncChanges {
  private expected = new Map<string, ExpectedChange>();

  private remember(path: string, change: Omit<ExpectedChange, "expiresAt">) {
    this.prune();
    const key = pathKey(path);
    const entry = { ...change, expiresAt: Date.now() + 60000 };
    this.expected.set(key, entry);
    return () => {
      if (this.expected.get(key) === entry) this.expected.delete(key);
    };
  }

  expectWrite(path: string, content: ArrayBuffer, oldPath?: string) {
    const hash = digest(content);
    // A failed digest must fail open in shouldIgnore, without an unhandled
    // rejection when a hidden config file produces no vault notification.
    void hash.catch(() => {});
    return this.remember(path, { kind: "file", hash, oldPath });
  }

  expectFolder(path: string, oldPath?: string) {
    return this.remember(path, { kind: "folder", oldPath });
  }

  expectDelete(paths: string[]) {
    const cancel = paths.map((path) => this.remember(path, { kind: "delete" }));
    return () => cancel.forEach((fn) => fn());
  }

  hasExpected(path: string) {
    this.prune();
    return this.expected.has(pathKey(path));
  }

  async shouldIgnore(
    event: VaultChange,
    file: TAbstractFile,
    oldPath: string | undefined,
    vault: Vault
  ) {
    const key = pathKey(file.path);
    const entry = this.expected.get(key);
    if (!entry || entry.expiresAt < Date.now()) return false;
    let matches = false;
    try {
      if (entry.kind === "delete") {
        matches = event === "delete" && !(await vault.adapter.exists(key));
      } else if (
        event === "create" ||
        event === "modify" ||
        (event === "rename" && entry.oldPath === pathKey(oldPath ?? ""))
      ) {
        if (entry.kind === "file") {
          matches =
            (await digest(await vault.adapter.readBinary(key))) ===
            (await entry.hash);
        } else {
          matches = (await vault.adapter.stat(key))?.type === "folder";
        }
      }
    } catch {
      // Failed reads must not swallow a real deletion or user change.
    }
    if (!matches && this.expected.get(key) === entry) this.expected.delete(key);
    return matches;
  }

  clear() {
    this.expected.clear();
  }

  private prune() {
    for (const [key, entry] of this.expected) {
      if (entry.expiresAt < Date.now()) this.expected.delete(key);
    }
  }
}
