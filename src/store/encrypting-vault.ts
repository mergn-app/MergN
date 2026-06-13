import type { Vault } from "./vault";
import type { Cipher } from "./cipher";

// Wraps any storage Vault (doc / s3) so the VALUE is encrypted before it is
// stored and decrypted on read — without the storage drivers or the callers
// (connections/oauth) knowing. Ref ids are unchanged.
//
// Stored form: `MARKER + cipherText`. The marker lets a read tell an encrypted
// value apart from a legacy plaintext one (written before encryption was turned
// on), so both coexist and reads never crash mid-migration. New writes are
// always encrypted.
const MARKER = "enc:1:";

export class EncryptingVault implements Vault {
  constructor(
    private inner: Vault,
    private cipher: Cipher,
  ) {}

  async put(spaceId: string, value: string): Promise<string> {
    const ciphertext = await this.cipher.encrypt(value);
    return this.inner.put(spaceId, MARKER + ciphertext);
  }

  async get(spaceId: string, ref: string): Promise<string | null> {
    const stored = await this.inner.get(spaceId, ref);
    if (stored == null) return null;
    if (!stored.startsWith(MARKER)) return stored; // legacy plaintext — pass through
    return this.cipher.decrypt(stored.slice(MARKER.length));
  }

  async remove(spaceId: string, ref: string): Promise<void> {
    return this.inner.remove(spaceId, ref);
  }
}
