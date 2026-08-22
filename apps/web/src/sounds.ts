/** Synthesized, original sound effects (no sampled assets). */
let ctx: AudioContext | undefined;
let muted = localStorage.getItem("bl.muted") === "1";
export const isMuted = () => muted;
export const setMuted = (m: boolean) => {
  muted = m;
  localStorage.setItem("bl.muted", m ? "1" : "0");
};

function ac() {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
function tone(freq: number, start: number, dur: number, type: OscillatorType = "square", gain = 0.08) {
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start);
  o.stop(c.currentTime + start + dur + 0.05);
}
function noise(start: number, dur: number, gain = 0.15) {
  const c = ac();
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  const s = c.createBufferSource();
  s.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  const f = c.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 900;
  s.connect(f).connect(g).connect(c.destination);
  s.start(c.currentTime + start);
}

export const sfx = {
  /** buddy signed on: a door creaking open (rising chirp + soft thud) */
  doorOpen() {
    if (muted) return;
    tone(180, 0, 0.18, "sawtooth", 0.04);
    tone(420, 0.05, 0.22, "triangle", 0.06);
    noise(0.2, 0.08, 0.08);
  },
  /** buddy signed off: door closing (falling chirp + thud) */
  doorClose() {
    if (muted) return;
    tone(380, 0, 0.15, "triangle", 0.06);
    tone(160, 0.08, 0.2, "sawtooth", 0.04);
    noise(0.22, 0.1, 0.12);
  },
  /** incoming IM: two-note chime */
  im() {
    if (muted) return;
    tone(880, 0, 0.12, "square", 0.05);
    tone(1175, 0.1, 0.18, "square", 0.05);
  },
  /** sent IM: short blip */
  sent() {
    if (muted) return;
    tone(660, 0, 0.06, "square", 0.03);
  },
  /** room ping / mention */
  ping() {
    if (muted) return;
    tone(1320, 0, 0.08, "sine", 0.06);
    tone(1320, 0.12, 0.08, "sine", 0.06);
  },
  /** warned / error */
  uhoh() {
    if (muted) return;
    tone(300, 0, 0.15, "sawtooth", 0.05);
    tone(220, 0.15, 0.25, "sawtooth", 0.05);
  },
};
