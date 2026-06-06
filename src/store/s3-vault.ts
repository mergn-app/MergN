import { randomUUID } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { assertSpace } from "./docstore";
import type { Vault } from "./vault";

const SAFE = /^[A-Za-z0-9_-]+$/;

export interface S3VaultConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export class S3Vault implements Vault {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3VaultConfig) {
    this.bucket = config.bucket;
    const opts: S3ClientConfig = {};
    if (config.region) opts.region = config.region;
    if (config.endpoint) opts.endpoint = config.endpoint;
    if (config.forcePathStyle) opts.forcePathStyle = true;
    this.client = new S3Client(opts);
  }

  private key(spaceId: string, ref: string): string {
    if (!SAFE.test(ref)) throw new Error("invalid ref");
    return `${assertSpace(spaceId)}/${ref}`;
  }

  async put(spaceId: string, value: string): Promise<string> {
    const ref = randomUUID();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(spaceId, ref),
        Body: value,
      }),
    );
    return ref;
  }

  async get(spaceId: string, ref: string): Promise<string | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.key(spaceId, ref),
        }),
      );
      return (await res.Body?.transformToString()) ?? null;
    } catch (err) {
      if ((err as { name?: string }).name === "NoSuchKey") return null;
      throw err;
    }
  }

  async remove(spaceId: string, ref: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key(spaceId, ref),
      }),
    );
  }
}
