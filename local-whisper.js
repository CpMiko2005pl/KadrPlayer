const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { createInterface } = require('node:readline');
const { execFile } = require('node:child_process');
const run = require('node:util').promisify(execFile);

const model = 'ggml-base.bin';
const bytes = 147951465;
const digest = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const address = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/' + model;

async function modelReady(directory) {
  try { return (await fs.stat(path.join(directory, model))).size === bytes; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

async function prepare(directory, signal, progress) {
  if (await modelReady(directory)) return;
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, randomUUID() + '.part');
  try {
    const response = await fetch(address, { signal: AbortSignal.any([signal, AbortSignal.timeout(900000)]) });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const hash = createHash('sha256');
    let received = 0, lastPercent = -1;
    await pipeline(response.body, async function* (source) {
      for await (const chunk of source) {
        received += chunk.length;
        if (received > bytes) throw Error('Niepoprawny rozmiar modelu.');
        hash.update(chunk);
        const percent = Math.floor(100 * received / bytes);
        if (percent !== lastPercent) progress({ received, total: bytes });
        lastPercent = percent;
        yield chunk;
      }
    }, createWriteStream(temporary, { flags: 'wx' }), { signal });
    if (received !== bytes || hash.digest('hex') !== digest) throw Error('Błąd weryfikacji pobranego modelu.');
    await fs.rename(temporary, path.join(directory, model));
  } catch (error) {
    if (signal.aborted) throw Error('Anulowano pobieranie modelu.');
    throw Error('Nie udało się pobrać modelu Whisper. Sprawdź połączenie i spróbuj ponownie. ' + error.message);
  } finally { await fs.rm(temporary, { force: true }); }
}

function segmentsFromSrt(text) {
  const seconds = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;
  const segments = [];
  for (const block of text.trim().replace(/\r/g, '').split(/\n\s*\n/)) {
    const match = /^\d+\s*\n(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)\s*\n([\s\S]+)$/.exec(block);
    if (match) segments.push({ start: seconds(...match.slice(1, 5)), end: seconds(...match.slice(5, 9)),
      text: match[9].trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
  }
  return segments;
}

async function recognize(ffmpeg, directory, audio, signal, progress = () => {}) {
  const job = randomUUID();
  const input = path.join(directory, job + '.audio');
  const output = job + '.srt';
  try {
    await fs.writeFile(input, audio, { signal, flag: 'wx' });
    const result = run(ffmpeg, ['-nostdin', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', input, '-vn', '-af',
      'asetpts=PTS-STARTPTS,whisper=model=' + model + ':language=auto:use_gpu=0:queue=12:format=srt:destination=' + output,
      '-f', 'null', '-'], {
      cwd: directory, windowsHide: true, signal,
      // whisper.cpp in ffmpeg probes Vulkan devices even with use_gpu=0, and that probe crashes (0xC0000005)
      // on some drivers, e.g. Intel HD 520; recognition runs on the CPU anyway
      env: { ...process.env, GGML_DISABLE_VULKAN: '1' },
    });
    const lines = createInterface({ input: result.child.stdout });
    lines.on('line', line => {
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (match) progress(Number(match[1]) / 1e6);
    });
    try { await result; } finally { lines.close(); }
    return segmentsFromSrt(await fs.readFile(path.join(directory, output), 'utf8'));
  } catch (error) {
    if (signal.aborted) throw Error('Anulowano generowanie napisów.');
    throw Error('Błąd lokalnego rozpoznawania mowy. ' + (error.stderr || error.message).slice(-180));
  } finally {
    await Promise.all([input, path.join(directory, output)].map(file => fs.rm(file, { force: true })));
  }
}

module.exports = { modelReady, prepare, recognize, segmentsFromSrt };
