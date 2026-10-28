export type RailEnvironment = {
  host: string
  path: string
  display: string
  branch: string | null
  model: string
}

export type RailCategory = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type RailMcpServer = { server: string; count: number; tokens: number }

export type RailMemoryFile = { path: string; type: string; tokens: number }

export type RailAgent = { agentType: string; source: string; tokens: number }

export type RailContext = {
  percentage: number
  totalTokens: number
  maxTokens: number
  autoCompactThreshold: number | null
  categories: RailCategory[]
  mcp: RailMcpServer[]
  memory: RailMemoryFile[]
  agents: RailAgent[]
}

export type RailConnector = { server: string; tools: number }

export type RailServer = {
  name: string
  port: number | null
  status: 'up' | 'down' | 'unknown'
}

declare module 'claude-code' {
  interface PluginState {
    'session-rail': {
      expanded: Record<string, boolean>
      environment: RailEnvironment | null
      context: Shaped<RailContext | null>
      outputs: string[]
      connectors: RailConnector[]
      servers: RailServer[]
      busy: string | null
    }
  }
}
