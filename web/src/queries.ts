import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
}

export function generateInputForm(
  goal: string,
  fields: string[],
): Promise<InputForm> {
  return json<InputForm>("/api/input-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal, fields }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflows"] }),
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
    mutationFn: (input: { id: string; account?: string }) =>
      json<ConnectionMeta>(`/api/connections/${input.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: input.account }),
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
