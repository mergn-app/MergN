// Encryption layer for secrets, kept ORTHOGONAL to where they are stored.
// A Cipher turns a plaintext secret into ciphertext and back. It is optional:
// when no Cipher is configured the Vault stores values as-is (self-host default,
// no extra service). When SECRET_ENCRYPTION=vault, secrets are encrypted with
// HashiCorp Vault's Transit engine — the key never leaves Vault, only ciphertext
// is persisted (in mongo / S3 via the storage Vault driver).

export interface Cipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}

// HashiCorp Vault Transit engine over its HTTP API (no SDK needed). The Vault
// server holds the key material; we only ever send/receive base64 plaintext and
// `vault:vN:...` ciphertext. Mirrors flowbaker-api's transit/encrypt|decrypt use.
export class VaultTransitCipher implements Cipher {
  constructor(
    private address: string,
    private token: string,
    private keyName: string,
  ) {
    this.address = address.replace(/\/+$/, "");
  }

  private async call(
    op: "encrypt" | "decrypt",
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.address}/v1/transit/${op}/${this.keyName}`, {
      method: "POST",
      headers: {
        "X-Vault-Token": this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `vault transit ${op} failed: ${res.status} ${await res.text()}`,
      );
    const json = (await res.json()) as { data?: Record<string, unknown> };
    if (!json.data) throw new Error(`vault transit ${op}: missing data`);
    return json.data;
  }

  async encrypt(plaintext: string): Promise<string> {
    const data = await this.call("encrypt", {
      plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
    });
    const ct = data.ciphertext;
    if (typeof ct !== "string")
      throw new Error("vault transit encrypt: ciphertext not a string");
    return ct;
  }

  async decrypt(ciphertext: string): Promise<string> {
    const data = await this.call("decrypt", { ciphertext });
    const b64 = data.plaintext;
    if (typeof b64 !== "string")
      throw new Error("vault transit decrypt: plaintext not a string");
    return Buffer.from(b64, "base64").toString("utf8");
  }
}
