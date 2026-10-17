export type VoiceStatus = 'off' | 'loading' | 'listening' | 'hearing' | 'thinking' | 'speaking'
export type VoiceMode = 'handsFree' | 'tapToTalk'
/** What voice mode speaks during a turn: only the answer, or progress lines too. */
export type VoiceVerbosity = 'answer' | 'progress'
/** What the voice panel shows: a status other than thinking, or `ready` (tap to talk, not recording), `rec` (tap to talk, recording), `muted`. */
export type VoiceLook = Exclude<VoiceStatus, 'off' | 'thinking'> | 'ready' | 'rec' | 'muted'
/** The last microphone and playback RMS the sidecar sent. */
export type VoiceLevels = { mic: number; out: number }

declare module 'claude-code' {
  interface PluginState {
    'live-voice-mode': { status: VoiceStatus; mode: VoiceMode; muted: boolean; words: string; levels: VoiceLevels; verbosity: VoiceVerbosity }
  }
}
