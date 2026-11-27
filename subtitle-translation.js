const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const languages = require('./src/js/translation-languages');
const names = new Intl.DisplayNames(['en'], { type: 'language' });
const codesByName = new Map(languages.map(code => [names.of(code).toLowerCase(), code]));
const model = 'm2m100-418m-q8';
const address = 'https://huggingface.co/Xenova/m2m100_418M/resolve/9c374f0b7aca709787cea97b047bfbbd1559d177/';
const files = [
  ['config.json', 908],
  ['generation_config.json', 233],
  ['tokenizer.json', 7988527],
  ['tokenizer_config.json', 1813],
  ['onnx/encoder_model_quantized.onnx', 287856370, '13a94e354a9140764eb81102d77d3ec6952d796e6f113c651eeb3c3443da0386'],
  ['onnx/decoder_model_merged_quantized.onnx', 344128178, '007654bcabb6cea6fd3bde34ce933137b431330b3755781145d7b6906270b45a'],
];

function languageCode(value) {
  const name = String(value || '').trim().toLowerCase();
  const code = name.split(/[-_]/)[0];
  if (languages.includes(code)) return code;
  if (/^[a-z]{2,3}$/.test(code)) {
    const canonical = new Intl.Locale(code).language;
    if (languages.includes(canonical)) return canonical;
  }
  return codesByName.get(name) || '';
}

function escapeText(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

async function prepare(root, progress) {
  const total = files.reduce((sum, [, size]) => sum + size, 0);
  let received = 0, lastPercent = -1;
  const missing = [];
  for (const [file, size, digest] of files) {
    const destination = path.join(root, model, file);
    const cached = await fs.stat(destination).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (cached?.size === size) received += size;
    else missing.push({ file, size, digest, destination });
  }
  if (!missing.length) return;
  const update = bytes => {
    received += bytes;
    const percent = Math.floor(100 * received / total);
    if (percent !== lastPercent) progress({ phase: 'translation-model', percent });
    lastPercent = percent;
  };
  update(0);
  for (const { file, size, digest, destination } of missing) {
    const partial = destination + '.part';
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      const response = await fetch(address + file, { signal: AbortSignal.timeout(900000) });
      if (!response.ok || !response.body) throw Error('HTTP ' + response.status);
      const hash = digest ? createHash('sha256') : null;
      let length = 0;
      await pipeline(response.body, async function* (source) {
        for await (const chunk of source) {
          length += chunk.length;
          if (length > size) throw Error('Niepoprawny rozmiar modelu tłumaczenia.');
          hash?.update(chunk);
          update(chunk.length);
          yield chunk;
        }
      }, createWriteStream(partial));
      if (length !== size || (hash && hash.digest('hex') !== digest)) throw Error('Weryfikacja modelu tłumaczenia nie powiodła się.');
      await fs.rename(partial, destination);
    } finally { await fs.rm(partial, { force: true }); }
  }
}

async function translateInWorker({ root, cues, target }, progress) {
  await prepare(root, progress);
  progress({ phase: 'translate', percent: 0 });
  const { env, pipeline: createTranslator } = await import('@huggingface/transformers');
  env.allowRemoteModels = false;
  env.localModelPath = root;
  const translate = await createTranslator('translation', model, {
    dtype: 'q8', device: 'cpu', local_files_only: true,
    session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
  });
  const output = [];
  let lastPercent = 0;
  try {
    for (let i = 0; i < cues.length;) {
      const source = cues[i].lang;
      const batch = [cues[i++]];
      while (batch.length < 4 && cues[i]?.lang === source) batch.push(cues[i++]);
      if (source === target) output.push(...batch);
      else {
        const entities = { amp: '&', lt: '<', gt: '>' };
        const text = batch.map(c => c.text.replace(/&(amp|lt|gt);/g, (_, entity) => entities[entity]));
        const translated = await translate(text, { src_lang: source, tgt_lang: target, num_beams: 1, max_new_tokens: 128 });
        if (translated.length !== batch.length || translated.some(t => !t.translation_text?.trim())) {
          throw Error('Model tłumaczenia nie zwrócił pełnych napisów.');
        }
        output.push(...batch.map((c, n) => ({ ...c, lang: target, text: escapeText(translated[n].translation_text.trim()) })));
      }
      const percent = Math.floor(i * 100 / cues.length);
      if (percent !== lastPercent) progress({ phase: 'translate', percent });
      lastPercent = percent;
    }
    return output;
  } finally { await translate.dispose(); }
}

async function translateCues(root, cues, target, signal, progress) {
  signal.throwIfAborted();
  if (!languages.includes(target)) throw Error('Wybierz obsługiwany język tłumaczenia.');
  const normalized = cues.map(c => ({ ...c, lang: languageCode(c.lang) }));
  if (normalized.some(c => !c.lang)) throw Error('Nie udało się ustalić obsługiwanego języka mowy.');
  if (normalized.every(c => c.lang === target)) return normalized;

  return new Promise((resolve, reject) => {
    const worker = fork(__filename, ['--translation-worker'], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const abort = () => worker.kill();
    const complete = (error, value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve(value);
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (message.progress && !signal.aborted) progress(message.progress);
      else if (message.error) complete(Error(message.error));
      else if (message.cues) complete(null, message.cues);
    });
    worker.once('error', error => complete(error));
    worker.once('exit', async () => {
      if (signal.aborted) {
        await Promise.allSettled(files.map(([file]) => fs.rm(path.join(root, model, file + '.part'), { force: true })));
      }
      complete(Error('Proces tłumaczenia został przerwany.'));
    });
    worker.send({ root, cues: normalized, target }, error => { if (error) complete(error); });
  });
}

if (require.main === module && process.argv[2] === '--translation-worker') {
  process.once('message', async request => {
    const progress = data => process.send({ progress: data });
    try {
      const cues = await translateInWorker(request, progress);
      process.send({ cues }, () => process.disconnect());
    } catch (error) { process.send({ error: error.message }, () => process.disconnect()); }
  });
}

module.exports = { languageCode, translateCues };
