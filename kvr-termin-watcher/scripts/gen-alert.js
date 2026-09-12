// Generates alert.wav (16-bit mono PCM, 44.1 kHz): a loud, insistent three-tone pattern.
// Plain JavaScript on purpose so it runs before any build step.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2] || path.resolve(__dirname, '..', 'alert.wav');
if (fs.existsSync(out) && !process.argv.includes('--force')) {
  console.log(`alert.wav already exists at ${out} (use --force to regenerate)`);
  process.exit(0);
}

const rate = 44100;
const pattern = [
  [880, 0.18], [0, 0.05], [1175, 0.18], [0, 0.05], [1568, 0.28], [0, 0.18],
  [880, 0.18], [0, 0.05], [1175, 0.18], [0, 0.05], [1568, 0.28], [0, 0.35],
];
const samples = [];
for (const [freq, dur] of pattern) {
  const n = Math.round(rate * dur);
  for (let i = 0; i < n; i++) {
    if (freq === 0) { samples.push(0); continue; }
    const t = i / rate;
    const env = Math.min(1, i / 300, (n - i) / 300); // short fade in/out to avoid clicks
    // square-ish wave (fundamental + 3rd harmonic) is louder/more piercing than a pure sine
    const v = Math.sin(2 * Math.PI * freq * t) + 0.33 * Math.sin(2 * Math.PI * freq * 3 * t);
    samples.push(Math.round(0.9 * 32767 * env * (v / 1.33)));
  }
}

const dataBytes = samples.length * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);      // PCM chunk size
buf.writeUInt16LE(1, 20);       // PCM
buf.writeUInt16LE(1, 22);       // mono
buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28); // byte rate
buf.writeUInt16LE(2, 32);       // block align
buf.writeUInt16LE(16, 34);      // bits per sample
buf.write('data', 36);
buf.writeUInt32LE(dataBytes, 40);
samples.forEach((s, i) => buf.writeInt16LE(s, 44 + i * 2));
fs.writeFileSync(out, buf);
console.log(`wrote ${out} (${(buf.length / 1024).toFixed(0)} KB, ${(samples.length / rate).toFixed(1)} s)`);
