import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import { ArrowUp, Copy, Network, Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShowcaseSpacePause } from "@/hooks/useShowcaseSpacePause";
import { FuncNode } from "./FuncNode";
import { TriggerNode } from "./TriggerNode";
import { GateEdge } from "./GateEdge";
import { Story } from "./Story";
import { Pipeline } from "./Pipeline";
import { layoutPositions } from "./layout";
import { outputsOf } from "./lineage";
import { CodeBlock } from "./CodeBlock";
import type { AuthoredFunc, TriggerConfig, Wire } from "./types";

const nodeTypes = { func: FuncNode, trigger: TriggerNode };
const edgeTypes = { gate: GateEdge };

// User turns reference an i18n key (localized); assistant turns stay in English
// because they represent the AI's own output.
type ChatMsg =
  | { role: "user"; key: string }
  | { role: "assistant"; text: string };

interface MockScenario {
  id: string;
  title: string;
  subtitle: string;
  mockElapsedMs: number;
  trigger: TriggerConfig;
  funcs: AuthoredFunc[];
  wires: Wire[];
  chat: ChatMsg[];
}

// Compact authoring helper so each scenario reads like a tiny workflow spec
// while still producing the exact AuthoredFunc shape the real views consume.
function mkFunc(o: {
  id: string;
  title: string;
  summary: string;
  pure?: boolean;
  provider?: string;
  inputs?: string[];
  outputs?: string[];
}): AuthoredFunc {
  const outputs = o.outputs ?? [];
  return {
    id: o.id,
    title: o.title,
    summary: o.summary,
    version: 1,
    kind: o.pure ? "adapter" : "library",
    pure: o.pure ?? false,
    inputs: (o.inputs ?? []).map((name) => ({
      name,
      role: "input",
      type: "string",
      required: true,
    })),
    outputSchema: {
      type: "object",
      properties: Object.fromEntries(outputs.map((k) => [k, { type: "string" }])),
      required: outputs,
    },
    bodySource: mockBodySource(o),
    requires: o.provider
      ? [{ name: o.provider, provider: o.provider, scopes: [] }]
      : [],
    dangerClass: null,
    idempotency: null,
  };
}

const w = (from: string, fromOutput: string, to: string, toInput: string): Wire => ({
  from,
  fromOutput,
  to,
  toInput,
});

const MOCK_BODIES: Record<string, string> = {
  parse_event: `  const payload = input.payload;
  const obj = payload?.data?.object ?? payload?.object ?? payload;
  return {
    amount: obj.amount,
    currency: obj.currency,
    customer: obj.customer,
  };`,
  fetch_customer: `  const customer = input.customer;
  const profile = await ctx.connections.stripe.customers.retrieve(customer);
  return {
    name: profile.name ?? profile.email,
    email: profile.email,
  };`,
  format_alert: `  const { amount, currency, name } = input;
  const formatted = (amount / 100).toFixed(2);
  return {
    message: \`Payment received: \${formatted} \${currency.toUpperCase()} from \${name}\`,
  };`,
  post_discord: `  const { message } = input;
  const messageId = await ctx.connections.discord.send(message);
  return { messageId };`,
  list_overdue: `  const { timestamp } = input;
  const invoices = await ctx.connections.stripe.invoices.list({
    status: "open",
    due_date: { lt: Math.floor(Date.now() / 1000) },
  });
  return { invoices: invoices.data };`,
  build_reminders: `  const { invoices } = input;
  const reminders = invoices.map((inv) => ({
    to: inv.customer_email,
    body: \`Invoice \${inv.number} is \${inv.amount_due / 100} overdue\`,
  }));
  return { reminders };`,
  send_reminders: `  const { reminders } = input;
  let sent = 0;
  for (const r of reminders) {
    await ctx.connections.slack.postMessage(r.body);
    sent++;
  }
  return { sent };`,
  finance_summary: `  const { sent } = input;
  const messageId = await ctx.connections.slack.postMessage(
    \`Sent \${sent} invoice reminders today\`,
  );
  return { messageId };`,
  parse_order: `  const payload = input.payload;
  const obj = payload?.data?.object ?? payload;
  return {
    orderId: obj.id,
    items: obj.lines?.data ?? [],
    customer: obj.customer,
  };`,
  confirm_charge: `  const { orderId } = input;
  const charge = await ctx.connections.stripe.charges.retrieve(orderId);
  return { receipt: charge.receipt_url, total: charge.amount };`,
  alert_fulfillment: `  const { items, total } = input;
  await ctx.connections.slack.postMessage(
    \`Pack order: \${items.length} items, total \${total / 100}\`,
  );
  return { sent: true };`,
  ping_community: `  const { total, receipt } = input;
  const messageId = await ctx.connections.discord.send(
    \`New sale! \${total / 100} — \${receipt}\`,
  );
  return { messageId };`,
  normalize_alert: `  const payload = input.payload;
  return {
    alert: {
      title: payload.title ?? payload.message,
      service: payload.service ?? payload.host,
      severity: payload.severity ?? "unknown",
    },
  };`,
  classify_severity: `  const { alert } = input;
  const critical = alert.severity === "critical" || alert.severity === "P1";
  return { severity: alert.severity, critical };`,
  page_slack: `  const { alert, severity } = input;
  await ctx.connections.slack.postMessage(
    \`[\${severity}] \${alert.service}: \${alert.title}\`,
  );
  return { sent: true };`,
  alert_discord: `  const { alert, critical } = input;
  if (!critical) return { messageId: null };
  const messageId = await ctx.connections.discord.send(
    \`CRITICAL: \${alert.title}\`,
  );
  return { messageId };`,
  parse_refund: `  const payload = input.payload;
  const obj = payload?.data?.object ?? payload;
  return { chargeId: obj.charge, amount: obj.amount };`,
  lookup_charge: `  const { chargeId } = input;
  const charge = await ctx.connections.stripe.charges.retrieve(chargeId);
  return { customer: charge.customer, order: charge.metadata?.orderId };`,
  notify_support: `  const { customer, amount } = input;
  await ctx.connections.slack.postMessage(
    \`Refund issued: \${amount / 100} for customer \${customer}\`,
  );
  return { sent: true };`,
  log_discord: `  const { order, amount } = input;
  const messageId = await ctx.connections.discord.send(
    \`Refund logged — order \${order}, \${amount / 100}\`,
  );
  return { messageId };`,
};

function mockBodySource(o: {
  id: string;
  provider?: string;
  inputs?: string[];
  outputs?: string[];
}): string {
  if (MOCK_BODIES[o.id]) return MOCK_BODIES[o.id];
  const ins = o.inputs ?? [];
  const outs = o.outputs ?? [];
  const reads = ins.map((n) => `  const ${n} = input.${n};`).join("\n");
  if (o.provider) {
    const ret = outs.map((n) => `    ${n},`).join("\n");
    return `${reads || "  // read inputs"}\n  // call ${o.provider}\n  return {\n${ret}\n  };`;
  }
  const ret = outs.map((n) => `    ${n}: /* derived */`).join(",\n");
  return `${reads || "  // read inputs"}\n  return {\n${ret}\n  };`;
}

const SCENARIOS: MockScenario[] = [
  {
    id: "payment-alerts",
    title: "Payment Alerts",
    subtitle: "Turn successful Stripe payments into rich Discord alerts.",
    mockElapsedMs: 32000,
    trigger: { kind: "webhook", eventFields: ["payload"] },
    funcs: [
      mkFunc({
        id: "parse_event",
        title: "Parse Event",
        summary:
          "Parse the incoming Stripe webhook event and pull out the charge amount, the currency, and the customer id so the rest of the flow has clean fields to work with.",
        pure: true,
        inputs: ["payload"],
        outputs: ["amount", "currency", "customer"],
      }),
      mkFunc({
        id: "fetch_customer",
        title: "Fetch Customer",
        summary:
          "Call the Stripe API with the customer id to load the full customer profile, so the alert can show a real name and email instead of an opaque id.",
        provider: "stripe",
        inputs: ["customer"],
        outputs: ["name", "email"],
      }),
      mkFunc({
        id: "format_alert",
        title: "Format Alert",
        summary:
          "Compose a clean, human-readable payment summary from the amount, currency, and customer name that reads well in a chat message.",
        pure: true,
        inputs: ["amount", "currency", "name"],
        outputs: ["message"],
      }),
      mkFunc({
        id: "post_discord",
        title: "Post Discord",
        summary:
          "Send the formatted payment alert into the team's Discord channel through an incoming webhook so everyone sees new revenue in real time.",
        provider: "discord",
        inputs: ["message"],
        outputs: ["messageId"],
      }),
    ],
    wires: [
      w("parse_event", "customer", "fetch_customer", "customer"),
      w("parse_event", "amount", "format_alert", "amount"),
      w("parse_event", "currency", "format_alert", "currency"),
      w("fetch_customer", "name", "format_alert", "name"),
      w("format_alert", "message", "post_discord", "message"),
    ],
    chat: [
      { role: "user", key: "landing.chat.payment1" },
      {
        role: "assistant",
        text: "Done. I parse the Stripe webhook, enrich the customer through the Stripe API, format a clean summary, and post it to Discord.",
      },
      { role: "user", key: "landing.chat.payment2" },
    ],
  },
  {
    id: "invoice-reminders",
    title: "Invoice Reminders",
    subtitle: "Chase overdue Stripe invoices and report it in Slack daily.",
    mockElapsedMs: 56000,
    trigger: { kind: "schedule", eventFields: ["timestamp"] },
    funcs: [
      mkFunc({
        id: "list_overdue",
        title: "List Overdue",
        summary:
          "Query the Stripe API every morning for every invoice that is now past its due date, returning the customer, amount owed, and hosted invoice link.",
        provider: "stripe",
        inputs: ["timestamp"],
        outputs: ["invoices"],
      }),
      mkFunc({
        id: "build_reminders",
        title: "Build Reminders",
        summary:
          "Turn each overdue Stripe invoice into a friendly reminder that includes the amount due, the due date, and a one-click hosted payment link.",
        pure: true,
        inputs: ["invoices"],
        outputs: ["reminders"],
      }),
      mkFunc({
        id: "send_reminders",
        title: "Send Reminders",
        summary:
          "Send each customer their reminder and DM the account owner in Slack as a heads-up so the team knows who is being chased today.",
        provider: "slack",
        inputs: ["reminders"],
        outputs: ["sent"],
      }),
      mkFunc({
        id: "finance_summary",
        title: "Finance Summary",
        summary:
          "Post a single daily roll-up of how many reminders went out and the total outstanding into the finance Slack channel.",
        provider: "slack",
        inputs: ["sent"],
        outputs: ["messageId"],
      }),
    ],
    wires: [
      w("list_overdue", "invoices", "build_reminders", "invoices"),
      w("build_reminders", "reminders", "send_reminders", "reminders"),
      w("send_reminders", "sent", "finance_summary", "sent"),
    ],
    chat: [
      { role: "user", key: "landing.chat.invoice1" },
      {
        role: "assistant",
        text: "Set up a daily schedule that pulls overdue invoices from Stripe, builds reminders, sends them, and drops a summary in the finance Slack channel.",
      },
      { role: "user", key: "landing.chat.invoice2" },
    ],
  },
  {
    id: "order-notifications",
    title: "Order Notifications",
    subtitle: "Route new Stripe orders to Slack and Discord at once.",
    mockElapsedMs: 47000,
    trigger: { kind: "webhook", eventFields: ["payload"] },
    funcs: [
      mkFunc({
        id: "parse_order",
        title: "Parse Order",
        summary:
          "Decode the Stripe Checkout webhook and extract the order id, the purchased line items, and the customer so downstream steps stay simple.",
        pure: true,
        inputs: ["payload"],
        outputs: ["orderId", "items", "customer"],
      }),
      mkFunc({
        id: "confirm_charge",
        title: "Confirm Charge",
        summary:
          "Use the Stripe API to confirm the charge actually cleared and grab the hosted receipt URL plus the final order total for the notifications.",
        provider: "stripe",
        inputs: ["orderId"],
        outputs: ["receipt", "total"],
      }),
      mkFunc({
        id: "alert_fulfillment",
        title: "Alert Fulfillment",
        summary:
          "Notify the fulfillment team in Slack with the exact items to ship and the order total so packing can start immediately.",
        provider: "slack",
        inputs: ["items", "total"],
        outputs: ["sent"],
      }),
      mkFunc({
        id: "ping_community",
        title: "Ping Community",
        summary:
          "Drop a celebratory new-sale message with the order total and receipt link into the community Discord to keep the energy up.",
        provider: "discord",
        inputs: ["total", "receipt"],
        outputs: ["messageId"],
      }),
    ],
    wires: [
      w("parse_order", "orderId", "confirm_charge", "orderId"),
      w("parse_order", "items", "alert_fulfillment", "items"),
      w("confirm_charge", "total", "alert_fulfillment", "total"),
      w("confirm_charge", "total", "ping_community", "total"),
      w("confirm_charge", "receipt", "ping_community", "receipt"),
    ],
    chat: [
      { role: "user", key: "landing.chat.order1" },
      {
        role: "assistant",
        text: "Built it: parse the Stripe order, confirm the charge via the Stripe API, alert Slack with the items, and post a sale message to Discord.",
      },
      { role: "user", key: "landing.chat.order2" },
    ],
  },
  {
    id: "incident-escalation",
    title: "Incident Escalation",
    subtitle: "Triage monitoring alerts across Slack and Discord.",
    mockElapsedMs: 60000,
    trigger: { kind: "webhook", eventFields: ["payload"] },
    funcs: [
      mkFunc({
        id: "normalize_alert",
        title: "Normalize Alert",
        summary:
          "Standardize the raw monitoring webhook into a consistent alert object with a title, the affected service, and a normalized severity field.",
        pure: true,
        inputs: ["payload"],
        outputs: ["alert"],
      }),
      mkFunc({
        id: "classify_severity",
        title: "Classify Severity",
        summary:
          "Decide whether the incident is critical based on the affected service and the current error rate, returning both a severity label and a flag.",
        pure: true,
        inputs: ["alert"],
        outputs: ["severity", "critical"],
      }),
      mkFunc({
        id: "page_slack",
        title: "Page Slack",
        summary:
          "Post the incident to the on-call Slack channel and tag the responsible team so the right people are paged within seconds.",
        provider: "slack",
        inputs: ["alert", "severity"],
        outputs: ["sent"],
      }),
      mkFunc({
        id: "alert_discord",
        title: "Alert Discord",
        summary:
          "Mirror critical incidents into the engineering Discord channel so nobody on the team misses a page during a high-severity event.",
        provider: "discord",
        inputs: ["alert", "critical"],
        outputs: ["messageId"],
      }),
    ],
    wires: [
      w("normalize_alert", "alert", "classify_severity", "alert"),
      w("normalize_alert", "alert", "page_slack", "alert"),
      w("classify_severity", "severity", "page_slack", "severity"),
      w("normalize_alert", "alert", "alert_discord", "alert"),
      w("classify_severity", "critical", "alert_discord", "critical"),
    ],
    chat: [
      { role: "user", key: "landing.chat.incident1" },
      {
        role: "assistant",
        text: "Added normalization, severity classification, a Slack page to on-call, and a Discord mirror for critical incidents.",
      },
      { role: "user", key: "landing.chat.incident2" },
    ],
  },
  {
    id: "refund-handler",
    title: "Refund Handler",
    subtitle: "Track Stripe refunds across Slack and Discord.",
    mockElapsedMs: 42000,
    trigger: { kind: "webhook", eventFields: ["payload"] },
    funcs: [
      mkFunc({
        id: "parse_refund",
        title: "Parse Refund",
        summary:
          "Parse the Stripe refund webhook to read the original charge id and the exact amount that was refunded back to the customer.",
        pure: true,
        inputs: ["payload"],
        outputs: ["chargeId", "amount"],
      }),
      mkFunc({
        id: "lookup_charge",
        title: "Lookup Charge",
        summary:
          "Fetch the original charge from the Stripe API to recover the customer and the order metadata tied to this refund for full context.",
        provider: "stripe",
        inputs: ["chargeId"],
        outputs: ["customer", "order"],
      }),
      mkFunc({
        id: "notify_support",
        title: "Notify Support",
        summary:
          "Let the support team know in Slack which customer was refunded and how much, so they can proactively reach out if needed.",
        provider: "slack",
        inputs: ["customer", "amount"],
        outputs: ["sent"],
      }),
      mkFunc({
        id: "log_discord",
        title: "Log Discord",
        summary:
          "Log the processed refund with the order and amount in the support Discord channel so agents have a running, searchable history.",
        provider: "discord",
        inputs: ["order", "amount"],
        outputs: ["messageId"],
      }),
    ],
    wires: [
      w("parse_refund", "chargeId", "lookup_charge", "chargeId"),
      w("parse_refund", "amount", "notify_support", "amount"),
      w("lookup_charge", "customer", "notify_support", "customer"),
      w("parse_refund", "amount", "log_discord", "amount"),
      w("lookup_charge", "order", "log_discord", "order"),
    ],
    chat: [
      { role: "user", key: "landing.chat.refund1" },
      {
        role: "assistant",
        text: "Done: parse the Stripe refund, look up the original charge, notify support in Slack, and log it to the Discord channel.",
      },
      { role: "user", key: "landing.chat.refund2" },
    ],
  },
];

const NO_RUN_STATUS: Record<string, string> = {};
const NO_CONFIG: Record<string, Record<string, string>> = {};
const AUTO_ROTATE_MS = 4200;
const AUTO_RING_R = 11;
const AUTO_RING_C = 2 * Math.PI * AUTO_RING_R;
const SHOWCASE_SCENARIO_ORDER = [
  "payment-alerts",
  "refund-handler",
  "order-notifications",
  "incident-escalation",
  "invoice-reminders",
] as const;
const SHOWCASE_SCENARIOS: MockScenario[] = SHOWCASE_SCENARIO_ORDER.map((id) =>
  SCENARIOS.find((s) => s.id === id),
).filter((s): s is MockScenario => Boolean(s));

// Replica of App.buildNode — keeps graph nodes visually identical to the real
// builder (FuncNode/TriggerNode shapes, port binding tones).
function buildGraph(
  scenario: MockScenario,
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const { funcs, wires, trigger } = scenario;
  const eventFields = trigger.eventFields ?? [];
  const positions = layoutPositions(funcs, wires, trigger);
  const ids = new Set(funcs.map((f) => f.id));
  const showTrigger = trigger.kind !== "manual";

  const funcNodes: Node[] = funcs.map((f, i) => {
    const inputs = f.inputs.map((p) => {
      const wired =
        wires.some((x) => x.to === f.id && x.toInput === p.name) ||
        eventFields.includes(p.name);
      return { name: p.name, bound: wired, variable: !wired };
    });
    return {
      id: f.id,
      type: "func",
      position: positions[f.id] ?? { x: 360 + i * 340, y: 160 },
      selected: selectedId === f.id,
      data: {
        title: f.title,
        summary: f.summary,
        pure: f.pure,
        needsConnection: false,
        needsValue: false,
        gated: !!f.gate,
        inputs,
        outputs: outputsOf(f),
      },
    };
  });

  const nodes: Node[] = showTrigger
    ? [
        {
          id: "trigger",
          type: "trigger",
          position: positions["trigger"] ?? { x: 40, y: 160 },
          data: { fields: eventFields, kind: trigger.kind },
        },
        ...funcNodes,
      ]
    : funcNodes;

  const wireEdges: Edge[] = wires
    .filter((x) => (x.from === "trigger" || ids.has(x.from)) && ids.has(x.to))
    .map((x) => ({
      id: `${x.from}.${x.fromOutput}->${x.to}.${x.toInput}`,
      source: x.from,
      target: x.to,
      sourceHandle: x.fromOutput || undefined,
      targetHandle: x.toInput || undefined,
      animated: true,
      style: { stroke: "#6ea8ff" },
    }));

  const triggerEdges: Edge[] = [];
  if (showTrigger) {
    for (const f of funcs) {
      for (const p of f.inputs) {
        if (!eventFields.includes(p.name)) continue;
        if (wires.some((x) => x.to === f.id && x.toInput === p.name)) continue;
        triggerEdges.push({
          id: `trigger.${p.name}->${f.id}.${p.name}`,
          source: "trigger",
          target: f.id,
          sourceHandle: p.name,
          targetHandle: p.name,
          animated: true,
          style: { stroke: "#6ea8ff" },
        });
      }
    }
  }

  return { nodes, edges: [...wireEdges, ...triggerEdges] };
}

interface GraphViewProps {
  scenario: MockScenario;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClearSelect: () => void;
  theme: "dark" | "light";
}

function GraphCanvas({
  scenario,
  selectedId,
  onSelect,
  onClearSelect,
  theme,
}: GraphViewProps) {
  const { t } = useTranslation();
  const { nodes, edges } = useMemo(
    () => buildGraph(scenario, selectedId),
    [scenario, selectedId],
  );
  const { fitView } = useReactFlow();

  // Re-center whenever the open flow changes so each scenario is framed nicely.
  useEffect(() => {
    const id = setTimeout(
      () => fitView({ duration: 300, padding: 0.2, minZoom: 0.15 }),
      0,
    );
    return () => clearTimeout(id);
  }, [scenario.id, fitView]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, minZoom: 0.15 }}
      minZoom={0.15}
      colorMode={theme}
      proOptions={{ hideAttribution: true }}
      nodesConnectable={false}
      onNodeClick={(_, node) => node.type === "func" && onSelect(node.id)}
      onPaneClick={onClearSelect}
    >
      <Background />
      <Controls showInteractive={false} />
      <Panel position="top-right">
        <div className="flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          <Network className="h-3.5 w-3.5" />
          {t("view.graph")}
        </div>
      </Panel>
    </ReactFlow>
  );
}

function GraphView(props: GraphViewProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

// Faithful, static replica of Chat.DesignProgress in its "all done" state.
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function MockBuildCard({
  funcs,
  mockElapsedMs,
}: {
  funcs: AuthoredFunc[];
  mockElapsedMs: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="my-1.5 w-full overflow-hidden rounded-3xl border border-dashed border-border/40 bg-background p-4">
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-tight text-foreground">
            {t("chat.workflowReady")}
          </div>
          <div className="text-xs leading-tight text-muted-foreground">
            {t("chat.stepsProgress", {
              done: funcs.length,
              total: funcs.length,
            })}
          </div>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/70">
          {fmtElapsed(mockElapsedMs)}
        </span>
      </div>
      <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-muted/60">
        <div className="h-full rounded-full bg-emerald-500" style={{ width: "100%" }} />
      </div>
      <div className="mt-2.5 space-y-1">
        {funcs.map((f) => (
          <div
            key={f.id}
            className="flex items-center gap-2.5 rounded-xl border border-border/40 bg-background/50 px-2.5 py-1.5 text-[13px]"
          >
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              <span className="size-2 rounded-full bg-emerald-500" />
            </span>
            <span className="truncate text-foreground/80">{f.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Faithful replica of Chat.MessageItem: user gets a right-aligned secondary
// bubble; the assistant is left-aligned, full-width plain text (no bubble).
function MockMessage({
  role,
  text,
}: {
  role: "user" | "assistant";
  text: string;
}) {
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "flex min-w-0 max-w-full flex-col gap-1.5",
        isUser ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          isUser
            ? "max-w-[85%] rounded-2xl rounded-br-md border border-border/60 bg-secondary px-3.5 py-2 text-[14px] leading-relaxed text-secondary-foreground"
            : "w-full min-w-0 overflow-hidden text-[14px] leading-relaxed text-foreground/90",
        )}
      >
        {text}
      </div>
      {!isUser && (
        <div className="font-mono text-[10px] text-muted-foreground/60">
          ↑1.9k ↓0.4k
        </div>
      )}
    </div>
  );
}

// Faithful replica of ChatComposer's frame (visual only).
function MockComposer() {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setValue("");
      }}
      className="p-2"
    >
      <div className="flex items-end gap-2 rounded-2xl border border-border/40 bg-background-subtle p-2 transition-colors focus-within:border-foreground/20">
        <textarea
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("landing.describeChange")}
          className="max-h-52 min-h-[44px] flex-1 resize-none self-stretch border-none bg-transparent px-1 py-1 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
        />
        <button
          type="submit"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"
        >
          <ArrowUp className="size-4" />
        </button>
      </div>
    </form>
  );
}

const MOCK_PANEL_HEIGHT = 220;

function MockRunPanel({
  selected,
  theme,
}: {
  selected: AuthoredFunc | null;
  theme: "dark" | "light";
}) {
  const { t } = useTranslation();

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-2">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("run.selectStepCode")}
          </div>
        ) : (
          <>
            <div className="mb-2 flex shrink-0 items-center gap-2 border-b border-border/40 pb-2">
              <span className="text-xs font-medium">
                {selected.title || selected.id}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/60">
                {selected.id} · v{selected.version}
              </span>
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 rounded-md border border-border/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                <Copy className="h-3 w-3" />
                {t("run.copy")}
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <CodeBlock
                source={selected.bodySource}
                name={selected.id}
                theme={theme}
                wrap={false}
                fill
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function BuilderMockShowcase() {
  const { t } = useTranslation();
  const [view, setView] = useState<"story" | "pipeline" | "graph">("graph");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState(SHOWCASE_SCENARIOS[0].id);
  const [autoRotate, setAutoRotate] = useState(true);
  const scenario = useMemo(
    () => SHOWCASE_SCENARIOS.find((s) => s.id === selected) ?? SHOWCASE_SCENARIOS[0],
    [selected],
  );
  const theme =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";

  const triggerFields = scenario.trigger.eventFields ?? [];
  const connectedProviders = useMemo(() => {
    const set = new Set<string>();
    for (const f of scenario.funcs)
      for (const r of f.requires) set.add(r.provider);
    return set;
  }, [scenario]);

  const firstAssistantIdx = scenario.chat.findIndex(
    (m) => m.role === "assistant",
  );
  const tokenCount = (scenario.funcs.length * 3.7 + 4).toFixed(1) + "k";

  const onSelectScenario = (id: string, manual = true) => {
    if (manual) setAutoRotate(false);
    setSelected(id);
    setSelectedId(null);
  };

  const onSelectNode = (id: string) => {
    setAutoRotate(false);
    setSelectedId(id);
  };

  const selectedFunc =
    scenario.funcs.find((f) => f.id === selectedId) ?? null;
  const panelOpen = selectedId != null;

  // Advance the showcase once per cycle only — one cheap re-render every
  // AUTO_ROTATE_MS. The ring fill is pure CSS (see index.css), so progress
  // never re-renders React (which would also re-render the ReactFlow graph).
  useEffect(() => {
    if (!autoRotate) return;
    const timer = setInterval(() => {
      setSelected((current) => {
        const idx = SHOWCASE_SCENARIOS.findIndex((s) => s.id === current);
        return SHOWCASE_SCENARIOS[(idx + 1) % SHOWCASE_SCENARIOS.length].id;
      });
      setSelectedId(null);
    }, AUTO_ROTATE_MS);
    return () => clearInterval(timer);
  }, [autoRotate]);

  const { rootRef, onPointerDown } = useShowcaseSpacePause(setAutoRotate);

  return (
    <div
      ref={rootRef}
      tabIndex={0}
      onPointerDown={onPointerDown}
      className="grid h-full min-h-0 w-full grid-cols-1 overflow-hidden rounded-2xl border border-border/50 bg-card shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/30 lg:grid-cols-[2fr_1fr]"
    >
      <div className="flex flex-col border-b border-border/40 lg:min-h-0 lg:flex-1 lg:border-b-0 lg:border-r">
        <div className="flex shrink-0 flex-col gap-2 border-b border-border/40 bg-muted/30 p-3 sm:flex-row sm:items-center">
          <span className="text-[11px] font-medium text-muted-foreground sm:mr-1 sm:shrink-0">
            {t("landing.tryIdea")}
          </span>
          <div className="flex flex-col gap-1.5 sm:min-w-0 sm:flex-1 sm:flex-row sm:items-center sm:gap-2 sm:overflow-x-auto scrollbar-none">
            {SHOWCASE_SCENARIOS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectScenario(item.id, true)}
                className={cn(
                  "w-full rounded-lg border px-2.5 py-1.5 text-left text-[11px] transition-colors sm:w-auto sm:shrink-0 sm:py-1",
                  selected === item.id
                    ? "border-tone-amber/50 bg-tone-amber-surface text-tone-amber-fg"
                    : "border-border/60 bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {t(`landing.ideas.${item.id}`, { defaultValue: item.title })}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAutoRotate((v) => !v)}
            className="relative inline-flex h-7 w-7 shrink-0 self-end items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground transition-colors hover:text-foreground sm:self-auto"
            title={
              autoRotate
                ? t("landing.autoRotate.pause", { defaultValue: "Pause rotation" })
                : t("landing.autoRotate.resume", { defaultValue: "Resume rotation" })
            }
          >
            {autoRotate && (
              <svg
                viewBox="0 0 28 28"
                className="pointer-events-none absolute inset-0 h-full w-full -rotate-90"
                aria-hidden="true"
              >
                <circle
                  cx="14"
                  cy="14"
                  r={AUTO_RING_R}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-border/60"
                />
                <circle
                  key={selected}
                  cx="14"
                  cy="14"
                  r={AUTO_RING_R}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={AUTO_RING_C}
                  className="landing-rotate-ring text-primary"
                  style={
                    {
                      "--ring-c": AUTO_RING_C,
                      "--ring-duration": `${AUTO_ROTATE_MS}ms`,
                    } as React.CSSProperties
                  }
                />
              </svg>
            )}
            {autoRotate ? (
              <Pause className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </button>
        </div>

        <div className="relative flex flex-col lg:min-h-0 lg:flex-1">
          <div className="relative h-[360px] shrink-0 lg:h-auto lg:min-h-0 lg:flex-1">
            <div className="absolute left-3 top-3 z-10 flex rounded-lg border border-border/50 bg-muted p-0.5 text-xs">
              {(["story", "pipeline", "graph"] as const).map((item) => (
                <button
                  key={item}
                  onClick={() => setView(item)}
                  className={cn(
                    "rounded-md px-2.5 py-1 capitalize transition-colors",
                    view === item
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`view.${item}`)}
                </button>
              ))}
            </div>

            {view === "graph" ? (
              <GraphView
                scenario={scenario}
                selectedId={selectedId}
                onSelect={onSelectNode}
                onClearSelect={() => setSelectedId(null)}
                theme={theme}
              />
            ) : view === "story" ? (
              <Story
                funcs={scenario.funcs}
                wires={scenario.wires}
                triggerFields={triggerFields}
                runStatus={NO_RUN_STATUS}
                connectedProviders={connectedProviders}
                configValues={NO_CONFIG}
                selectedId={selectedId}
                onSelect={onSelectNode}
              />
            ) : (
              <Pipeline
                funcs={scenario.funcs}
                wires={scenario.wires}
                triggerFields={triggerFields}
                runStatus={NO_RUN_STATUS}
                connectedProviders={connectedProviders}
                configValues={NO_CONFIG}
                selectedId={selectedId}
                onSelect={onSelectNode}
              />
            )}

            <div
              className={cn(
                "pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center transition-opacity duration-300",
                panelOpen ? "opacity-0" : "opacity-100",
              )}
            >
              <div className="mb-3 rounded-full border border-border/50 bg-muted/90 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
                {t("landing.showcase.clickStep")}
              </div>
            </div>
          </div>

        <div className="group flex h-2 shrink-0 cursor-default items-center justify-center border-t border-border/40">
          <div className="h-0.5 w-8 rounded-full bg-border transition-colors group-hover:bg-foreground/40" />
        </div>
        <div
          className="shrink-0 overflow-hidden transition-[height] duration-300 ease-out"
          style={{ height: panelOpen ? MOCK_PANEL_HEIGHT : 0 }}
        >
          <div style={{ height: MOCK_PANEL_HEIGHT }}>
            <MockRunPanel selected={selectedFunc} theme={theme} />
          </div>
        </div>
        </div>
      </div>

      <div className="flex min-h-[300px] flex-col">
        <div className="flex items-center gap-2 border-b border-border/40 px-3 py-4">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {t(`landing.ideas.${scenario.id}`, { defaultValue: scenario.title })}
          </span>
          <span className="ml-auto rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/80">
            {t("chat.tokens", { n: tokenCount })}
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 p-3">
            {scenario.chat.map((message, idx) => (
              <div key={`${scenario.id}-${idx}`} className="flex flex-col gap-3">
                {idx === firstAssistantIdx && (
                  <MockBuildCard
                    funcs={scenario.funcs}
                    mockElapsedMs={scenario.mockElapsedMs}
                  />
                )}
                <MockMessage
                  role={message.role}
                  text={
                    message.role === "user" ? t(message.key) : message.text
                  }
                />
              </div>
            ))}
          </div>
        </div>

        <MockComposer />
      </div>
    </div>
  );
}
