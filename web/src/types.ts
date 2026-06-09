export interface Wire {
  from: string;
  fromOutput: string;
  to: string;
  toInput: string;
}

export type TriggerKind = "manual" | "webhook" | "schedule" | "poll" | "event";

export type IntervalUnit = "second" | "minute" | "hour" | "day";

export interface ScheduleTriggerConfig {
  mode: "cron" | "interval";
  cron?: string;
  intervalValue?: number;
  intervalUnit?: IntervalUnit;
  timezone?: string;
}

export interface PollTriggerConfig {
  provider: string;
  source?: string;
  dependencies?: string[];
  paramNames?: string[];
  intervalValue: number;
  intervalUnit: IntervalUnit;
  connection?: string;
  params?: Record<string, unknown>;
}

export interface TriggerConfig {
  kind: TriggerKind;
  enabled?: boolean;
  schedule?: ScheduleTriggerConfig;
  poll?: PollTriggerConfig;
}

export type FormControl =
  | "text"
  | "textarea"
  | "number"
  | "toggle"
  | "select"
  | "date";

export interface FormField {
  name: string;
  label: string;
  control: FormControl;
  placeholder?: string;
  help?: string;
  required?: boolean;
  options?: { label: string; value: string }[];
  defaultValue?: string;
}

export interface InputForm {
  title?: string;
  fields: FormField[];
}

export type WorkflowOp =
  | { key: string; kind: "funcs"; funcs: AuthoredFunc[] }
  | { key: string; kind: "wires"; wires: Wire[] }
  | { key: string; kind: "deleteFunc"; id: string }
  | { key: string; kind: "unwire"; to: string; toInput?: string }
  | { key: string; kind: "trigger"; trigger: TriggerConfig }
  | { key: string; kind: "inputForm"; inputForm: InputForm }
  | { key: string; kind: "name"; name: string };

export interface RunStepData {
  status: string;
  resolvedInput?: unknown;
  output?: unknown;
  error?: string;
}

export interface AuthoredFunc {
  id: string;
  title: string;
  summary: string;
  version: number;
  kind: string;
  pure: boolean;
  inputs: { name: string; role: string; type: string; required: boolean }[];
  outputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  bodySource: string;
  requires: { name: string; provider: string; scopes: string[] }[];
  dangerClass: string | null;
  idempotency: { key: string; mechanism: string } | null;
}
