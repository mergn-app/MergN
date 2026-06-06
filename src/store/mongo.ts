import { MongoClient, type Db, type Collection } from "mongodb";
import { assertSpace, type DocStore } from "./docstore";

const SAFE = /^[A-Za-z0-9_-]+$/;

interface Row {
  spaceId: string;
  id: string;
  doc: Record<string, unknown>;
}

function safeColl(name: string): string {
  if (!SAFE.test(name)) throw new Error(`invalid collection: ${name}`);
  return name;
}

function safeId(id: string): string {
  if (!SAFE.test(id)) throw new Error("invalid id");
  return id;
}

export class MongoStore implements DocStore {
  private client: MongoClient;
  private db: Db;
  private ready: Promise<void> | null = null;
  private indexed = new Set<string>();

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url);
    this.db = this.client.db(dbName);
  }

  private async connect(): Promise<void> {
    if (!this.ready) this.ready = this.client.connect().then(() => undefined);
    return this.ready;
  }

  private async coll(collection: string): Promise<Collection<Row>> {
    await this.connect();
    const name = safeColl(collection);
    const c = this.db.collection<Row>(name);
    if (!this.indexed.has(name)) {
      await c.createIndex({ spaceId: 1, id: 1 }, { unique: true });
      this.indexed.add(name);
    }
    return c;
  }

  async spaces(): Promise<string[]> {
    await this.connect();
    const names = await this.db.listCollections({}, { nameOnly: true }).toArray();
    const ids = new Set<string>();
    for (const { name } of names) {
      if (name.startsWith("system.")) continue;
      const vals = await this.db.collection<Row>(name).distinct("spaceId");
      for (const v of vals) if (typeof v === "string" && SAFE.test(v)) ids.add(v);
    }
    return [...ids];
  }

  async list(
    spaceId: string,
    collection: string,
  ): Promise<Record<string, unknown>[]> {
    const c = await this.coll(collection);
    const rows = await c.find({ spaceId: assertSpace(spaceId) }).toArray();
    return rows.map((r) => r.doc);
  }

  async get(
    spaceId: string,
    collection: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const c = await this.coll(collection);
    const row = await c.findOne({ spaceId: assertSpace(spaceId), id: safeId(id) });
    return row ? row.doc : null;
  }

  async put(
    spaceId: string,
    collection: string,
    id: string,
    doc: Record<string, unknown>,
  ): Promise<void> {
    const c = await this.coll(collection);
    const filter = { spaceId: assertSpace(spaceId), id: safeId(id) };
    await c.replaceOne(filter, { ...filter, doc }, { upsert: true });
  }

  async remove(spaceId: string, collection: string, id: string): Promise<void> {
    const c = await this.coll(collection);
    await c.deleteOne({ spaceId: assertSpace(spaceId), id: safeId(id) });
  }
}
