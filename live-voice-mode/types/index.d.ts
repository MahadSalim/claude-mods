export type VoiceStatus = 'off' | 'loading' | 'listening' | 'hearing' | 'thinking' | 'speaking'

declare module 'claude-code' {
  interface PluginState {
    'live-voice-mode': { status: VoiceStatus; muted: boolean }
  }
}
