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
  stepCount: number;
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

export async function saveLlmSettings(body: {
  provider: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<{ ok: boolean; modelRejected?: boolean; error?: string }> {
  const res = await fetch("/api/settings/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...spaceHeaders() },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    modelRejected?: boolean;
  };
  if (!res.ok) {
    throw new Error(data.error || `Save failed: ${res.status}`);
  }
  return data as { ok: boolean; modelRejected?: boolean; error?: string };
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
