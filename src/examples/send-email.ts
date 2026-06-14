import type {
  EffectfulFunc,
  PureFunc,
  FuncNode,
  StepRecord,
  Connection,
} from '../atoms/index'

export const fullNameAdapter: PureFunc = {
  id: 'fn_full_name',
  version: 1,
  kind: 'adapter',
  pure: true,
  inputs: [
    { name: 'firstName', role: 'input', schema: { type: 'string' }, required: true },
    { name: 'lastName', role: 'input', schema: { type: 'string' }, required: true },
  ],
  outputSchema: {
    type: 'object',
    properties: { fullName: { type: 'string' } },
    required: ['fullName'],
  },
  body: {
    language: 'javascript',
    source: "return { fullName: input.firstName + ' ' + input.lastName }",
    generatedBy: { agent: 'func-writer', prompt: 'tam ismi birleştir' },
  },
}

export const sendEmailFunc: EffectfulFunc = {
  id: 'fn_send_email',
  version: 1,
  kind: 'library',
  pure: false,
  inputs: [
    { name: 'to', role: 'input', schema: { type: 'string' }, required: true },
    {
      name: 'subject',
      role: 'input',
      schema: { type: 'string' },
      required: true,
      ui: { widget: 'text', label: 'Konu' },
    },
    {
      name: 'body',
      role: 'input',
      schema: { type: 'string' },
      required: true,
      ui: { widget: 'textarea', label: 'İçerik' },
    },
  ],
  outputSchema: {
    type: 'object',
    properties: { messageId: { type: 'string' } },
    required: ['messageId'],
  },
  requires: [{ name: 'smtp', provider: 'smtp', scopes: ['send'] }],
  effect: {
    retryable: true,
    dangerClass: 'costly',
    idempotency: { key: 'runId+funcId', mechanism: 'provider-key' },
  },
  body: {
    language: 'javascript',
    source:
      'return { messageId: await ctx.connections.smtp.send(input.to, input.subject, input.body) }',
    generatedBy: { agent: 'func-writer', prompt: 'kullanıcıya hoş geldin maili at' },
  },
}

export const slackPostFunc: EffectfulFunc = {
  id: 'fn_slack_post',
  version: 1,
  kind: 'library',
  pure: false,
  inputs: [
    {
      name: 'channel',
      role: 'input',
      schema: { type: 'string' },
      required: true,
      ui: { widget: 'select', label: 'Kanal' },
    },
    { name: 'text', role: 'input', schema: { type: 'string' }, required: true },
  ],
  outputSchema: {
    type: 'object',
    properties: { ts: { type: 'string' } },
    required: ['ts'],
  },
  requires: [{ name: 'slack', provider: 'slack', scopes: ['chat:write'] }],
  effect: {
    retryable: true,
    dangerClass: 'benign',
    idempotency: { key: 'runId+funcId', mechanism: 'provider-key' },
  },
  body: {
    language: 'javascript',
    source:
      'return { ts: await ctx.connections.slack.postMessage(input.channel, input.text) }',
    generatedBy: { agent: 'func-writer', prompt: 'yeni kayıt olunca slack kanalına haber ver' },
  },
}

export const slackConnection: Connection = {
  id: 'conn_slack_acme',
  provider: 'slack',
  kind: 'oauth2',
  account: 'acme-workspace',
  scopes: ['chat:write', 'channels:read'],
  vaultRef: 'vault://connections/conn_slack_acme',
  expiresAt: '2026-07-01T00:00:00Z',
}

export const slackPostNode: FuncNode = {
  nodeId: 'node_notify_slack',
  funcId: 'fn_slack_post',
  funcVersion: 1,
  bindings: {
    channel: { mode: 'literal', value: '#signups' },
    text: { mode: 'ref', path: 'node_full_name.output.fullName' },
  },
  connections: { slack: 'conn_slack_acme' },
  dependsOn: ['node_charge_payment'],
}

export const exampleStepRecord: StepRecord = {
  runId: 'run_abc123',
  nodeId: 'node_notify_slack',
  funcId: 'fn_slack_post',
  funcVersion: 1,
  attempt: 1,
  status: 'done',
  idempotencyKey: 'run_abc123:fn_slack_post',
  resolvedInput: { channel: '#signups', text: 'Ada Lovelace' },
  output: { ts: '1717400000.000100' },
}
