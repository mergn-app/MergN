import type { Schema, UiHint } from './schema'

export type PortRole = 'input'

export type Binding =
  | { mode: 'literal'; value: unknown }
  | { mode: 'ref'; path: string }

export interface PortDef {
  name: string
  role: PortRole
  schema: Schema
  required: boolean
  default?: unknown
  secret?: boolean
  ui?: UiHint
}
