import type { FuncDefinition, FuncContext } from "../atoms/index";
import type { Runtime } from "../engine/index";

export type FileResolver = (
  fileId: string,
) => Promise<{ name: string; mime: string; size: number; body: Buffer } | null>;

// A stored file's id is a v4 UUID (see createFileService). Used to spot inputs
// that are file references even when the step never declared/read them as files.
const FILE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Decorates a Runtime so that any step input typed `file` whose value is a file
// id is replaced — HOST-SIDE, before the code runs — with the file's bytes:
//   { name, mime, size, base64 }
// This keeps the egress-locked sandbox fully isolated (no network callback to
// fetch files): the bytes ride in over the normal stdin payload. Works the same
// for the local, docker and remote-sandbox runtimes.
export class FileInjectingRuntime implements Runtime {
  constructor(
    private inner: Runtime,
    private resolve: FileResolver,
  ) {}

  async run(
    def: FuncDefinition,
    ctx: FuncContext,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    // Which inputs are files: those typed `file`, OR those the body reads as a
    // file (input.x.base64 / .mime). The latter makes injection robust even when
    // the schema wasn't marked — if the code expects bytes and the value is a
    // file id, we resolve it.
    const names = new Set<string>();
    const typedFile = new Set<string>();
    for (const p of def.inputs)
      if (p.schema.type === "file") {
        names.add(p.name);
        typedFile.add(p.name);
      }
    for (const m of (def.body?.source ?? "").matchAll(
      /\binput\.([A-Za-z_$][\w$]*)\.(?:base64|mime|content_type|contentType)\b/g,
    ))
      names.add(m[1]);

    let next = input;
    for (const name of names) {
      const v = input[name];
      if (typeof v !== "string" || !v) continue;
      const f = await this.resolve(v);
      if (!f) {
        // A field explicitly typed `file` whose id can't be resolved means the
        // file's bytes are gone (e.g. re-uploaded needed, or the value isn't a
        // real file). Fail loudly instead of letting the step run with a raw id
        // and blow up later on `input.x.base64` being undefined.
        if (typedFile.has(name))
          throw new Error(
            `file input "${name}" could not be loaded (id ${v}). The file's content is missing — re-upload it and pick it again.`,
          );
        continue;
      }
      if (next === input) next = { ...input };
      next[name] = {
        name: f.name,
        mime: f.mime,
        size: f.size,
        base64: f.body.toString("base64"),
      };
    }

    // Catch-all hydration: ANY other input whose value is a stored-file id gets
    // resolved too, regardless of its declared type. This fixes steps that simply
    // forward the picked file to a provider — e.g. dropbox.uploadFile(path,
    // input.file) — without ever reading input.file.base64: they now receive the
    // real { name, mime, size, base64 } object instead of the raw blob id. The
    // UUID pre-check avoids a store lookup for ordinary string inputs.
    for (const [name, v] of Object.entries(input)) {
      if (names.has(name)) continue;
      if (typeof v !== "string" || !FILE_ID_RE.test(v)) continue;
      const f = await this.resolve(v);
      if (!f) continue; // a UUID that isn't a stored file — leave it untouched
      if (next === input) next = { ...input };
      next[name] = {
        name: f.name,
        mime: f.mime,
        size: f.size,
        base64: f.body.toString("base64"),
      };
    }

    return this.inner.run(def, ctx, next);
  }
}
