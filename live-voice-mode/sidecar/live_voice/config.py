"""Sidecar settings: model folders, the speaking voice, the engine's files, and audio tuning."""

WHISPER = "C:/Users/Mahad/models/whisper-large-v3-turbo"
KOKORO = "C:/Users/Mahad/models/kokoro"
VOICE = "af_heart"

# Words Whisper is biased towards hearing.
HOTWORDS = "Claude, Claude Code"

# The engine's lock, state (port and pid) and log files.
ENGINE_LOCK = "C:/Users/Mahad/.cache/live-voice-mode/engine.lock"
ENGINE_STATE = "C:/Users/Mahad/.cache/live-voice-mode/engine.json"
ENGINE_LOG = "C:/Users/Mahad/.cache/live-voice-mode/engine.log"

# Seconds an engine waits for the lock, and a relay for an engine to answer.
LOCK_SECONDS = 10.0
START_SECONDS = 30.0

# Sample rates in Hz; FRAME is one VAD frame at RATE and CHUNK one duplex block at PLAY_RATE, in samples.
RATE = 16000
PLAY_RATE = 48000
FRAME = 512
CHUNK = 480

# Seconds without a block from the duplex stream before it is reopened.
STALL_SECONDS = 2.0

# Utterance segmentation, counted in FRAMEs, with VAD speech probabilities.
PREROLL_FRAMES = 10
START_FRAMES = 3
END_FRAMES = 78
# Silence that ends a hands-free utterance once its live words read as finished; END_FRAMES or more turns it off.
QUICK_END_FRAMES = 31
# Last words that leave a sentence unfinished however Whisper punctuates it, as a regex alternation.
UNFINISHED = "and|but|or|because|the|a|an|to|of|with|for|um|uh|if"
MIN_FRAMES = 12
# Frames of speech a hands-free utterance needs after its start to be transcribed; fewer is noise, heard as no text.
SPEECH_FRAMES = 5
MAX_FRAMES = 940
MANUAL_MAX_FRAMES = 3750
# The live words read only the last PARTIAL_FRAMES of an utterance, within one 30 s Whisper window.
PARTIAL_FRAMES = 875
START_PROB = 0.5
END_PROB = 0.35

# Level events: one check per LEVEL_EVERY FRAMEs; an RMS at or under LEVEL_FLOOR is sent as 0.
LEVEL_EVERY = 2
LEVEL_FLOOR = 0.002

# Barge-in while the speaker is playing or just finished, within ECHO_SECONDS.
BARGE_PROB = 0.6
BARGE_FRAMES = 6
BARGE_WINDOW = 10
ECHO_SECONDS = 0.4

# A progress line still waiting NARRATE_SECONDS after it was queued is dropped.
NARRATE_SECONDS = 4.0
