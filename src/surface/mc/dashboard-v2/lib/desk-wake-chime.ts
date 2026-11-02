export function playWakeChime(audio: BaseAudioContext): void {
  const tone = audio.createOscillator();
  const volume = audio.createGain();
  const start = audio.currentTime;
  tone.type = "sine";
  tone.frequency.setValueAtTime(660, start);
  tone.frequency.setValueAtTime(880, start + 0.065);
  volume.gain.setValueAtTime(0, start);
  volume.gain.linearRampToValueAtTime(0.055, start + 0.008);
  volume.gain.setValueAtTime(0.055, start + 0.075);
  volume.gain.linearRampToValueAtTime(0, start + 0.14);
  tone.connect(volume).connect(audio.destination);
  tone.onended = () => { tone.disconnect(); volume.disconnect(); };
  tone.start(start);
  tone.stop(start + 0.14);
}
