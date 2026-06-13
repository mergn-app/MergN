import { join } from "node:path";
import { FileStore, type DocStore } from "./docstore";
import { DocVault, type Vault } from "./vault";
import { MongoStore } from "./mongo";
import { S3Vault } from "./s3-vault";
import { EncryptingVault } from "./encrypting-vault";
import { VaultTransitCipher, type Cipher } from "./cipher";

export function createStore(): DocStore {
  if (process.env.STORE_DRIVER === "mongo") {
    return new MongoStore(
      process.env.MONGO_URL ?? "mongodb://localhost:27017",
      process.env.MONGO_DB ?? "workflow",
    );
  }
  return new FileStore(join(process.cwd(), "data", "spaces"));
}

// WHERE secrets are stored (orthogonal to whether they're encrypted).
function createSecretStorage(store: DocStore): Vault {
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

// HOW secrets are encrypted at rest. Default: none (self-host stays simple — no
// extra service). SECRET_ENCRYPTION=vault encrypts with HashiCorp Vault Transit
// (intended for the managed/prod deployment, where a Vault service is running).
function createCipher(): Cipher | null {
  if (process.env.SECRET_ENCRYPTION === "vault") {
    const address = process.env.VAULT_ADDRESS;
    const token = process.env.VAULT_TOKEN;
    if (!address || !token)
      throw new Error(
        "SECRET_ENCRYPTION=vault requires VAULT_ADDRESS and VAULT_TOKEN",
      );
    return new VaultTransitCipher(
      address,
      token,
      process.env.VAULT_KEY_NAME || "mergn",
    );
  }
  return null;
}

export function createVault(store: DocStore): Vault {
  const storage = createSecretStorage(store);
  const cipher = createCipher();
  return cipher ? new EncryptingVault(storage, cipher) : storage;
}

export function createStorage(): { store: DocStore; vault: Vault } {
  const store = createStore();
  return { store, vault: createVault(store) };
}
