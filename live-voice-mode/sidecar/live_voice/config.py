"""Sidecar settings: model folders, the speaking voice, and audio tuning."""

WHISPER = "C:/Users/Mahad/models/whisper-large-v3-turbo"
KOKORO = "C:/Users/Mahad/models/kokoro"
VOICE = "af_heart"

# Sample rates in Hz; FRAME is one VAD frame at RATE and CHUNK one duplex block at PLAY_RATE, in samples.
RATE = 16000
PLAY_RATE = 48000
FRAME = 512
CHUNK = 480

# Utterance segmentation, counted in FRAMEs, with VAD speech probabilities.
PREROLL_FRAMES = 10
START_FRAMES = 3
END_FRAMES = 47
MIN_FRAMES = 12
MAX_FRAMES = 940
START_PROB = 0.5
END_PROB = 0.35

# Barge-in while the speaker is playing or just finished, within ECHO_SECONDS.
BARGE_PROB = 0.6
BARGE_FRAMES = 6
BARGE_WINDOW = 10
ECHO_SECONDS = 0.4
