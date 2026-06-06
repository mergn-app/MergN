import { join } from "node:path";
import { FileStore, type DocStore } from "./docstore";
import { DocVault, type Vault } from "./vault";
import { MongoStore } from "./mongo";
import { S3Vault } from "./s3-vault";

export function createStore(): DocStore {
  if (process.env.STORE_DRIVER === "mongo") {
    return new MongoStore(
      process.env.MONGO_URL ?? "mongodb://localhost:27017",
      process.env.MONGO_DB ?? "workflow",
    );
  }
  return new FileStore(join(process.cwd(), "data", "spaces"));
}

export function createVault(store: DocStore): Vault {
  if (process.env.VAULT_DRIVER === "s3") {
    return new S3Vault({
      bucket: process.env.S3_BUCKET ?? "",
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    });
  }
  return new DocVault(store);
}

export function createStorage(): { store: DocStore; vault: Vault } {
  const store = createStore();
  return { store, vault: createVault(store) };
}
