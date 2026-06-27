import type { Extension } from "@codemirror/state";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { AuthoredFunc, Wire } from "./types";
import { lineage, orderFuncs, outputsOf, type Source } from "./lineage";

// CodeMirror autocomplete for the step body editor:
//   • `input.`            → the node's available inputs (what will actually have a
//                           value at runtime, i.e. node.inputs) annotated with their
//                           source (upstream step / trigger / config / run form),
//                           PLUS upstream outputs & trigger fields that aren't wired
//                           yet — picking one inserts the name AND creates the wire
//                           (+ input port) so the code can read it. Bidirectional.
//   • `ctx.connections.`  → the providers this workflow connects to.
//
// The available scope is computed live from the current funcs/wires/trigger/config,
// so newly added inputs show up and removed ones disappear automatically.

export interface FlowCompletionOpts {
  node: AuthoredFunc;
  funcs: AuthoredFunc[];
  wires: Wire[];
  config: Record<string, Record<string, string>>;
  triggerFields: string[];
  // When provided, picking an upstream output / trigger field auto-creates the wire
  // (and the target input port) so the value actually reaches the code at runtime.
  onWireInput?: (p: {
    funcId: string;
    inputName: string;
    from: string;
    fromOutput: string;
  }) => void;
}

function srcDetail(s: Source): string {
  switch (s.kind) {
    case "trigger":
      return "← trigger / run form";
    case "step":
      return `← ${s.title}.${s.output}`;
    case "config":
      return "← config";
    default:
      return "← unbound";
  }
}

const WORD = /^[A-Za-z0-9_$]*$/;

export function flowCompletion(opts: FlowCompletionOpts): Extension {
  const { node, funcs, wires, config, triggerFields, onWireInput } = opts;
  const { sourceOf } = lineage(funcs, wires, config);

  // Only upstream steps (those before this node topologically) can be wired in
  // without creating a cycle.
  const ordered = orderFuncs(funcs, wires);
  const nodeIdx = ordered.findIndex((f) => f.id === node.id);
  const upstream = nodeIdx < 0 ? [] : ordered.slice(0, nodeIdx);

  const source = (ctx: CompletionContext): CompletionResult | null => {
    const inp = ctx.matchBefore(/input\.[A-Za-z0-9_$]*/);
    if (inp) {
      const from = inp.from + "input.".length;
      const have = new Set(node.inputs.map((p) => p.name));
      const options: Completion[] = [];

      // Group 1 — already in scope (a value exists at runtime).
      for (const p of node.inputs) {
        options.push({
          label: p.name,
          type: "variable",
          detail: srcDetail(sourceOf(node.id, p.name)),
          boost: 2,
        });
      }

      // Group 2 — wireable upstream outputs / trigger fields not yet in scope.
      // Only offered when we can actually create the wire, otherwise inserting the
      // name would read undefined at runtime.
      if (onWireInput) {
        for (const f of upstream) {
          for (const out of outputsOf(f)) {
            if (have.has(out)) continue;
            options.push({
              label: out,
              type: "property",
              detail: `⊕ wire from ${f.title}`,
              apply: (view, _c, a, b) => {
                view.dispatch({ changes: { from: a, to: b, insert: out } });
                onWireInput({
                  funcId: node.id,
                  inputName: out,
                  from: f.id,
                  fromOutput: out,
                });
              },
              boost: -1,
            });
          }
        }
        for (const tf of triggerFields) {
          if (have.has(tf)) continue;
          options.push({
            label: tf,
            type: "property",
            detail: "⊕ from trigger",
            apply: (view, _c, a, b) => {
              view.dispatch({ changes: { from: a, to: b, insert: tf } });
              onWireInput({
                funcId: node.id,
                inputName: tf,
                from: "trigger",
                fromOutput: tf,
              });
            },
            boost: -1,
          });
        }
      }

      return { from, options, validFor: WORD };
    }

    const conn = ctx.matchBefore(/ctx\.connections\.[A-Za-z0-9_$]*/);
    if (conn) {
      const from = conn.from + "ctx.connections.".length;
      const mine = new Set(node.requires.map((r) => r.provider));
      const provs = [
        ...new Set(funcs.flatMap((f) => f.requires.map((r) => r.provider))),
      ];
      const options: Completion[] = provs.map((p) => ({
        label: p,
        type: "class",
        detail: mine.has(p) ? "connection (this step)" : "connection",
        boost: mine.has(p) ? 2 : 0,
      }));
      return { from, options, validFor: WORD };
    }

    return null;
  };

  return autocompletion({ override: [source] });
}
