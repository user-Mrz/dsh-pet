![Voice-controlled pet](preview.svg)

# Voice-controlled pet

Hold the microphone button at the right of the composer, say one sentence, and the dsh-pet companion does it.

## Usage

1. Make sure **dsh-pet** is installed and enabled (the pet must actually be on your desktop).
2. Open any session in DSH; a microphone button appears at the right of the composer toolbar.
3. **Hold** the button, speak, then **release**.
4. The transcript shows in the button's tooltip while the pet performs the action and pops a speech bubble.

A tap shorter than 0.3 s is treated as a misclick. A silent recording reports a microphone problem instead of spending a recognition request.

## What it understands

| You say | The pet does |
| --- | --- |
| dance / maid dance / cute dance | plays that dance |
| go to sleep / good night | lies down to sleep |
| wake up | wakes up |
| go left / go right / come back | walks to that position |
| throw it / fling it | gets flung |
| eat rice / eat watermelon / hotpot / snacks | plays that eating animation |
| rubik's cube / pet the cat / fireworks / snowman / red envelope | plays that animation |

You can also say an **exact action name** ("solve a Rubik's cube in place", "hotpot"): the plugin matches keywords first, then falls back to a substring match against the configured animation names, so loose phrasing still lands.

When nothing matches, the pet pops "didn't catch that" together with your words, so you can rephrase.

## Which recognition path is used

Recognition uses DeepSeek's official ASR endpoint `POST https://api.deepseek.com/v1/tools/asr`, issued by the implementation **built into dsh-pet**:

- Audio: 16 kHz, mono, 16-bit PCM WAV, sent as one complete request and returned as one complete transcript;
- Authentication: the `DEEPSEEK_API_KEY` in DSH credentials, resolved by dsh-pet;
- This plugin only POSTs audio to the local dsh-pet route `/dsh-pet-7340/voice/hear` (`provider=deepseek`) and receives text back.

**This plugin never reads, stores, or forwards any API key.**

## Limitations

- Requires **dsh-pet 0.4.9 or newer**: it provides `/voice/hear` and the `deepseek` recognizer. Older versions lack the route and the button reports a recognition failure.
- Requires a configured `DEEPSEEK_API_KEY`; without it recognition returns `unsupported` and the button says speech recognition is unavailable.
- Recording needs a secure context: `https` or `localhost`. An http LAN address gets no microphone.
- One utterance is capped at 100 seconds (the official ASR limit is 120 seconds per request, with headroom left).
- Recognition is billed by audio duration on your DeepSeek account.
- It is hold-to-talk, not a wake word: nothing is listened to while you are not holding the button.
