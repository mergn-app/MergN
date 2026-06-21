import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { UIMessage } from "ai";
import type { AuthoredFunc, InputForm, TriggerConfig, Wire } from "./types";
import { getSpace, spaceHeaders } from "./space";
import { useAuth } from "./authContext";

export interface WorkflowMeta {
  id: string;
  name: string;
  funcCount: number;
  updatedAt: string;
}

export interface SavedWorkflow {
  id: string;
  name: string;
  funcs: AuthoredFunc[];
  wires: Wire[];
  positions: Record<string, { x: number; y: number }>;
  config: Record<string, Record<string, string>>;
  nodeConnections?: Record<string, Record<string, string>>;
  trigger?: TriggerConfig;
  inputForm?: InputForm;
  variables?: Record<string, unknown>;
  conversationId?: string;
  alertsEnabled?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveInput {
  id: string;
  name: string;
  funcs: AuthoredFunc[];
  wires: Wire[];
  positions: Record<string, { x: number; y: number }>;
  config: Record<string, Record<string, string>>;
  nodeConnections: Record<string, Record<string, string>>;
  trigger: TriggerConfig;
  inputForm: InputForm | null;
  variables?: Record<string, unknown>;
  conversationId?: string;
}

export function generateInputForm(
  goal: string,
  fields: string[],
  fieldHints?: Record<string, string>,
): Promise<InputForm> {
  return json<InputForm>("/api/input-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, fields, fieldHints }),
  });
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...spaceHeaders(), ...init?.headers },
  });
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

export type ActivationState = "active" | "paused" | "none";

export function getWorkflowStatus(id: string): Promise<{ state: ActivationState }> {
  return json(`/api/workflows/${id}/status`);
}

export function pauseWorkflow(id: string): Promise<{ ok: boolean }> {
  return json(`/api/workflows/${id}/pause`, { method: "POST" });
}

export function resumeWorkflow(id: string): Promise<{ ok: boolean }> {
  return json(`/api/workflows/${id}/resume`, { method: "POST" });
}

export type WebhookAuthType = "none" | "hmac" | "basic" | "bearer" | "jwt";

export function getWebhookAuth(
  workflowId: string,
): Promise<{ type: WebhookAuthType; header?: string }> {
  return json(`/api/workflows/${workflowId}/webhook-auth`);
}

export function setWebhookAuth(
  workflowId: string,
  body: { type: WebhookAuthType; header?: string; secret?: string },
): Promise<{ ok: boolean }> {
  return json(`/api/workflows/${workflowId}/webhook-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function testWebhookAuth(
  workflowId: string,
): Promise<{ ok: boolean }> {
  return json(`/api/workflows/${workflowId}/webhook-auth/test`, {
    method: "POST",
  });
}

export function useWorkflows() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["workflows", getSpace()],
    queryFn: () => json<WorkflowMeta[]>("/api/workflows"),
    enabled: !!user,
  });
}

export function useSaveWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveInput) =>
      json<SavedWorkflow>(`/api/workflows/${input.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflows"] });
      qc.invalidateQueries({ queryKey: ["conversations", getSpace()] });
    },
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json<{ ok: boolean }>(`/api/workflows/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
  });
}

export function fetchWorkflow(id: string): Promise<SavedWorkflow> {
  return json<SavedWorkflow>(`/api/workflows/${id}`);
}

export interface ProviderSource {
  clientSource: string;
  credentialFields: { name: string; label: string }[];
}

export function fetchProviderSource(id: string): Promise<ProviderSource> {
  return json<ProviderSource>(`/api/providers/${id}/source`);
}

export interface SpaceMeta {
  id: string;
  name: string;
}

export function useSpaces() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["spaces"],
    queryFn: () => json<SpaceMeta[]>("/api/spaces"),
    enabled: !!user,
  });
}

export function useCreateSpace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      json<SpaceMeta>("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

export interface ConnectionMeta {
  id: string;
  provider: string;
  account?: string;
  createdAt: string;
}

export interface AuthField {
  name: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  required?: boolean;
  help?: string;
  secret?: boolean;
}

export interface SetupStep {
  title: string;
  detail?: string;
  link?: { label: string; href: string };
  copyRedirectUrl?: boolean;
}

export interface SetupGuide {
  intro?: string;
  steps: SetupStep[];
}

export interface ProviderAuth {
  type: "none" | "apiKey" | "oauth2";
  name: string;
  fields?: AuthField[];
  scopes?: string[];
  setupGuide?: SetupGuide;
}

export function useProviderAuth(provider: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["provider-auth", provider],
    queryFn: () => json<ProviderAuth>(`/api/providers/${provider}/auth`),
    enabled: !!user,
  });
}

export interface OAuthStatus {
  configured: boolean;
  needsEndpoints: boolean;
}

export function useOAuthStatus(provider: string, enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["oauth-config", provider],
    queryFn: () => json<OAuthStatus>(`/api/providers/${provider}/oauth-config`),
    enabled: enabled && !!user,
  });
}

export function useSaveOAuthApp(provider: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      clientId: string;
      clientSecret: string;
      authUrl?: string;
      tokenUrl?: string;
      scopes?: string[];
    }) =>
      json<{ ok: boolean }>(`/api/providers/${provider}/oauth-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["oauth-config", provider] }),
  });
}

export function useDeleteOAuthApp(provider: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      json<{ ok: boolean }>(`/api/providers/${provider}/oauth-config`, {
        method: "DELETE",
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["oauth-config", provider] }),
  });
}

export function useConnections() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["connections", getSpace()],
    queryFn: () => json<ConnectionMeta[]>("/api/connections"),
    enabled: !!user,
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      provider: string;
      cred: Record<string, string>;
      account?: string;
    }) =>
      json<ConnectionMeta>("/api/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      account?: string;
      cred?: Record<string, string>;
    }) =>
      json<ConnectionMeta>(`/api/connections/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: input.account, cred: input.cred }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json<{ ok: boolean }>(`/api/connections/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["connections"] }),
  });
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: string;
  workflowId?: string;
}

export function useConversations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["conversations", getSpace()],
    queryFn: () => json<ConversationMeta[]>("/api/chat/conversations"),
    enabled: !!user,
  });
}

export function useConversation(id: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["conversation", getSpace(), id],
    queryFn: () => json<UIMessage[]>(`/api/chat/conversations/${id}`),
    enabled: !!user && !!id,
  });
}

export function useDeleteConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json<{ ok: boolean }>(`/api/chat/conversations/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

export interface RunMeta {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt?: string; // present once the run completes — drives the latency graph
  errorType?: string; // classified failure (transient|auth|logic|unknown)
  stepCount: number;
}

// Mirrors the server's HealthState (web has no import bridge to src/server).
export interface HealthState {
  workflowId: string;
  status: "healthy" | "degraded" | "failing" | "nodata";
  lastRunAt?: string;
  lastError?: { type: string; message: string };
  livenessFail?: { kind: "schedule" | "webhook"; since: string };
  outcomeFail?: { kind: "expectation" | "drop"; nodeId?: string; detail: string; since: string };
  updatedAt: string;
}

export interface RunRecord {
  nodeId: string;
  status: string;
  output?: unknown;
  error?: string;
  resolvedInput?: unknown;
}

export interface RunDoc {
  id: string;
  workflowId: string;
  workflowName: string;
  trigger: string;
  status: string;
  input: Record<string, unknown>;
  records: RunRecord[];
  startedAt: string;
  finishedAt: string;
}

export function useRunStream(
  workflowId: string | null,
  enabled: boolean,
  onEvent?: (status: "done" | "failed") => void,
) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    if (!workflowId || !user || !enabled) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const res = await fetch(
          `/api/runs/stream?workflow=${encodeURIComponent(workflowId)}`,
          { headers: spaceHeaders(), signal: ctrl.signal },
        );
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          if (text.includes('"id"')) {
            qc.invalidateQueries({ queryKey: ["runs", workflowId] });
            cb.current?.(text.includes('"failed"') ? "failed" : "done");
          }
        }
      } catch {
        void 0;
      }
    })();
    return () => ctrl.abort();
  }, [workflowId, user, enabled, qc]);
}

export interface LlmSettings {
  provider: string;
  model: string;
  baseURL: string;
  hasApiKey: boolean;
  configured: boolean;
  locked: boolean;
  usingOwn?: boolean;
  lockReason?: "instance" | "plan" | null;
}

export function saveLlmSettings(body: {
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<{ ok: boolean }> {
  return json("/api/settings/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
  source: "user" | "workflow";
  createdAt: string;
}

export function useFiles() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["files", getSpace()],
    queryFn: () => json<FileMeta[]>("/api/files"),
    enabled: !!user,
  });
}

export async function uploadFile(file: File): Promise<FileMeta> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/files", {
    method: "POST",
    headers: spaceHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `upload failed: ${res.status}`);
  }
  return res.json();
}

export function deleteFile(id: string): Promise<{ ok: boolean }> {
  return json(`/api/files/${id}`, { method: "DELETE" });
}

export async function downloadFile(meta: FileMeta): Promise<void> {
  const res = await fetch(`/api/files/${meta.id}/content`, {
    headers: spaceHeaders(),
  });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = meta.name;
  a.click();
  URL.revokeObjectURL(url);
}

export interface LogEntry {
  id: string;
  ts: string;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  detail?: string;
  workflowId?: string;
}

export function useLogs(active: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["logs", getSpace()],
    queryFn: () => json<LogEntry[]>("/api/logs"),
    enabled: !!user,
    // live-ish feed: poll while the Logs tab is open
    refetchInterval: active ? 3000 : false,
  });
}

export function clearLogs(): Promise<{ ok: boolean }> {
  return json("/api/logs", { method: "DELETE" });
}

// Fire-and-forget client error reporter. Never throws — logging must not break
// the app. Tagged 'client' server-side.
export function reportLog(body: {
  level?: "error" | "warn" | "info";
  message: string;
  detail?: string;
  workflowId?: string;
}): void {
  void fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...spaceHeaders() },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export interface LlmProbe {
  provider: string;
  model: string;
  local: boolean;
  structured: boolean;
  accurate: boolean;
  latencyMs: number;
  error?: string;
  weak: boolean;
}

export function probeLlm(): Promise<LlmProbe> {
  return json<LlmProbe>("/api/settings/llm/probe", { method: "POST" });
}

export function useLlmSettings() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["llm-settings"],
    queryFn: () => json<LlmSettings>("/api/settings/llm"),
    enabled: !!user,
    // don't refetch when the window regains focus — you may have tabbed away to
    // copy a key, and a refetch mid-edit churns the picker.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function useRuns(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["runs", workflowId, getSpace()],
    queryFn: () =>
      json<RunMeta[]>(`/api/runs?workflow=${encodeURIComponent(workflowId!)}`),
    enabled: !!workflowId && !!user,
  });
}

// Per-flow health (recomputed from run history on read). Polls while open so the
// icon/page stay live without depending on the SSE wiring.
export function useHealth(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["health", getSpace(), workflowId],
    queryFn: () =>
      json<HealthState>(`/api/workflows/${encodeURIComponent(workflowId!)}/health`),
    enabled: !!workflowId && !!user,
    refetchInterval: 15000,
  });
}

// Per-flow "send external alerts" flag (default OFF). The gear toggle reads +
// flips it via PATCH so a flow doesn't spam notifications until opted in.
export function useAlertsEnabled(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["alerts-enabled", getSpace(), workflowId],
    queryFn: async () =>
      (await json<SavedWorkflow>(`/api/workflows/${encodeURIComponent(workflowId!)}`)).alertsEnabled === true,
    enabled: !!workflowId && !!user,
  });
}

export function useToggleAlerts(workflowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      json<{ ok: boolean }>(`/api/workflows/${encodeURIComponent(workflowId)}/alerts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["alerts-enabled", getSpace(), workflowId] }),
  });
}

// Space-wide health summary — one entry per workflow (the monitoring page's
// left list + at-a-glance dots read this).
export function useHealthSummary() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["health-summary", getSpace()],
    queryFn: () => json<HealthState[]>("/api/health"),
    enabled: !!user,
    refetchInterval: 15000,
  });
}

export function fetchRun(id: string): Promise<RunDoc> {
  return json<RunDoc>(`/api/runs/${id}`);
}

export function useRepairProvider() {
  return useMutation({
    mutationFn: (input: { id: string; error: string }) =>
      json<{ id: string; apiDoc: string }>(
        `/api/providers/${input.id}/repair`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: input.error }),
        },
      ),
  });
}

// --- Remote MCP tokens (CLI / Claude Code) --------------------------------
export interface McpTokenMeta {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function useMcpTokens(enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["mcp-tokens", getSpace()],
    queryFn: () => json<McpTokenMeta[]>("/api/mcp/tokens"),
    enabled: !!user && enabled,
  });
}

export function useCreateMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    // 403 (plan gate) surfaces as a thrown error the dialog can show.
    mutationFn: (name: string) =>
      json<McpTokenMeta & { token: string }>("/api/mcp/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["mcp-tokens", getSpace()] }),
  });
}

export function useRevokeMcpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      json<{ ok: boolean }>(`/api/mcp/tokens/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["mcp-tokens", getSpace()] }),
  });
}

// --- workflow versioning ---------------------------------------------------
export interface WorkflowVersionMeta {
  id: string;
  workflowId: string;
  seq: number;
  source: "editor" | "chat" | "mcp" | "run-snapshot" | "healing" | "restore";
  label?: string;
  message?: string;
  restoredFrom?: string;
  parentVersionId?: string; // pre-fix HEAD — diff "from" + undo target
  healing?: { runId: string; diagnosis: string }; // plain-language fix title
  createdAt: string;
}

// ── self-healing: diff + fix events (M9 consumes the M8 contract) ─────────────
// mirror of the server WorkflowDiff (src/server/workflow-diff.ts) — kept in sync.
export interface WorkflowDiff {
  nodes: {
    added: string[];
    removed: string[];
    modified: Array<{
      id: string;
      changed: {
        code?: boolean;
        inputs?: { added: string[]; removed: string[]; retyped: string[] };
        outputs?: { added: string[]; removed: string[] };
        gate?: "added" | "removed" | "changed";
        provider?: boolean;
      };
    }>;
  };
  wires: { added: string[]; removed: string[] };
  trigger: { changed: boolean };
  config: { changedSteps: string[] };
}

export type FixMode = "notify" | "propose" | "auto";
export type FixStatus = "proposed" | "applied" | "rejected" | "reverted" | "failed";

export interface FixEvent {
  id: string;
  workflowId: string;
  runId: string;
  versionId?: string;
  mode: FixMode;
  status: FixStatus;
  errorType: string;
  confidence: "high" | "medium" | "low";
  diagnosis: string;
  downgradeReason?: string;
  proposal?: { kind: string; diff: WorkflowDiff; apply?: { funcs?: unknown[]; wires?: unknown[] } };
  at: string;
}

export function useHealEvents(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["heal-events", getSpace(), workflowId],
    queryFn: () => json<FixEvent[]>(`/api/workflows/${workflowId}/heal-events`),
    enabled: !!user && !!workflowId,
    refetchInterval: 15000,
  });
}

// before/after snapshots + diff — everything the change-review screen renders.
export interface WorkflowSnapshot {
  funcs?: unknown[];
  wires?: unknown[];
  trigger?: unknown;
  positions?: Record<string, { x: number; y: number }>;
}
export interface ReviewData {
  before: WorkflowSnapshot;
  after: WorkflowSnapshot;
  diff: WorkflowDiff;
}

export function useVersionReview(workflowId: string | null, versionId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["version-review", getSpace(), workflowId, versionId],
    queryFn: () => json<ReviewData>(`/api/workflows/${workflowId}/versions/${versionId}/review`),
    enabled: !!user && !!workflowId && !!versionId,
  });
}

export function useApproveFix(workflowId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      json<FixEvent>(`/api/workflows/${workflowId}/fix/${eventId}/approve`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["heal-events", getSpace(), workflowId] });
      qc.invalidateQueries({ queryKey: ["versions", getSpace(), workflowId] });
      qc.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
}

export function useRejectFix(workflowId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      json<FixEvent>(`/api/workflows/${workflowId}/fix/${eventId}/reject`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["heal-events", getSpace(), workflowId] }),
  });
}

export function useWorkflowVersions(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["versions", getSpace(), workflowId],
    queryFn: () =>
      json<WorkflowVersionMeta[]>(`/api/workflows/${workflowId}/versions`),
    enabled: !!user && !!workflowId,
  });
}

export function useCreateCheckpoint(workflowId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { label?: string; message?: string }) =>
      json<{ id: string; deduped: boolean }>(
        `/api/workflows/${workflowId}/versions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["versions", getSpace(), workflowId] }),
  });
}

export function useRestoreVersion(workflowId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) =>
      json<{ ok: boolean; newVersionId: string }>(
        `/api/workflows/${workflowId}/versions/${versionId}/restore`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["versions", getSpace(), workflowId] });
      qc.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
}

// ── Per-flow heal settings, eligibility, governance, audit ──
export interface FlowSettings {
  enabled: boolean;
  fixMode: FixMode;
  autoReplay: boolean;
}
export interface Eligibility {
  canHeal: boolean;
  reason?: "kill-switch" | "disabled" | "plan";
}
export interface AuditEntry {
  id: string;
  ts: string;
  kind: "settings.changed" | "killswitch.toggled" | "heal.applied" | "heal.rejected";
  message: string;
  workflowId?: string;
  actor?: string;
}

export function useFlowSettings(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["flow-settings", getSpace(), workflowId],
    queryFn: () => json<FlowSettings>(`/api/workflows/${workflowId}/settings`),
    enabled: !!workflowId && !!user,
  });
}

export function useUpdateFlowSettings(workflowId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<FlowSettings>) =>
      json<FlowSettings>(`/api/workflows/${workflowId}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-settings", getSpace(), workflowId] });
      qc.invalidateQueries({ queryKey: ["audit", getSpace()] });
    },
  });
}

export function useEligibility(workflowId: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["eligibility", getSpace(), workflowId],
    queryFn: () => json<Eligibility>(`/api/workflows/${workflowId}/eligibility`),
    enabled: !!workflowId && !!user,
  });
}

export function useKillSwitch() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["kill-switch", getSpace()],
    queryFn: () => json<{ on: boolean }>(`/api/governance/kill-switch`),
    enabled: !!user,
  });
}

export function useToggleKillSwitch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (on: boolean) =>
      json<{ ok: boolean; on: boolean }>(`/api/governance/kill-switch`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kill-switch", getSpace()] });
      qc.invalidateQueries({ queryKey: ["eligibility", getSpace()] });
      qc.invalidateQueries({ queryKey: ["audit", getSpace()] });
    },
  });
}

export function useAuditLog(workflowId?: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["audit", getSpace(), workflowId ?? "all"],
    queryFn: () =>
      json<AuditEntry[]>(`/api/audit${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`),
    enabled: !!user,
    refetchInterval: 15000,
  });
}

// ── Alert channels + handler flows ──
export type ChannelKind = "telegram" | "slack" | "discord" | "email" | "webhook";
export interface AlertChannel {
  id: string;
  kind: ChannelKind;
  label?: string;
  minSeverity?: "info" | "warn" | "critical";
  categories?: string[];
  enabled: boolean;
  createdAt: string;
}

export function useAlertChannels() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["alert-channels", getSpace()],
    queryFn: () => json<AlertChannel[]>(`/api/alert-channels`),
    enabled: !!user,
  });
}

export function useAddAlertChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: ChannelKind; label?: string; minSeverity?: string; secret: Record<string, string> }) =>
      json<AlertChannel>(`/api/alert-channels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-channels", getSpace()] }),
  });
}

export function usePatchAlertChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) =>
      json(`/api/alert-channels/${v.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-channels", getSpace()] }),
  });
}

export function useRemoveAlertChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => json(`/api/alert-channels/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-channels", getSpace()] }),
  });
}

export function useTestAlert() {
  return useMutation({ mutationFn: () => json<{ ok?: boolean }>(`/api/alert-channels/test`, { method: "POST" }) });
}


// ── Alert handler flows (registry — user-chosen flows that run on alerts) ──
export interface AlertHandlerRow { workflowId: string; name: string; enabled: boolean }

export function useAlertHandlers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["alert-handlers", getSpace()],
    queryFn: () => json<AlertHandlerRow[]>(`/api/alert-handlers`),
    enabled: !!user,
  });
}
export function useAddAlertHandler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) =>
      json(`/api/alert-handlers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflowId }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-handlers", getSpace()] }),
  });
}
export function usePatchAlertHandler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workflowId: string; enabled: boolean }) =>
      json(`/api/alert-handlers/${v.workflowId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: v.enabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-handlers", getSpace()] }),
  });
}
export function useRemoveAlertHandler() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workflowId: string) => json(`/api/alert-handlers/${workflowId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-handlers", getSpace()] }),
  });
}

// Flows eligible to be alert handlers = those with a "monitor" trigger.
export function useMonitorHandlers() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["monitor-handlers", getSpace()],
    queryFn: () => json<{ id: string; name: string }[]>(`/api/monitor-handlers`),
    enabled: !!user,
  });
}
