// Translation engine: wraps Chrome's built-in Translator and LanguageDetector
// APIs (on-device, free). Exposed as globalThis.GTE.engine for the other
// content scripts.
(() => {
  const GTE = (globalThis.GTE = globalThis.GTE || {});
  const LANGS = { sourceLanguage: 'de', targetLanguage: 'en' };
  // Upper bound per request even when the quota is larger, so a huge paragraph
  // doesn't block the queue for a long time.
  const MAX_CHUNK_CHARS = 1500;

  class EngineError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code; // 'unsupported' | 'needs-download' | 'unavailable' | 'failed'
    }
  }

  let translatorPromise = null;
  let detectorPromise = null;
  const cache = new Map();

  // Serial queue; on-device translation runs one request at a time anyway.
  let generation = 0;
  let tail = Promise.resolve();

  function log(...args) {
    console.debug('[GTE]', ...args);
  }

  async function getTranslator() {
    if (!translatorPromise) {
      translatorPromise = (async () => {
        if (!('Translator' in self)) {
          throw new EngineError('unsupported', 'Chrome built-in Translator API not available (needs desktop Chrome 138+).');
        }
        const availability = await Translator.availability(LANGS);
        if (availability === 'unavailable') {
          // Also happens when Chrome's translation service has stopped for the session.
          throw new EngineError('unavailable', "Chrome's translator isn't available right now. Restarting Chrome usually fixes this.");
        }
        if (availability !== 'available') {
          // Chrome requires a click on this page before a site may create a translator.
          throw new EngineError('needs-download', 'Chrome needs one click to enable translation on this site.');
        }
        return Translator.create(LANGS);
      })();
      // Allow a retry later (e.g. after the model is downloaded).
      translatorPromise.catch(() => (translatorPromise = null));
    }
    return translatorPromise;
  }

  async function getDetector() {
    if (!detectorPromise) {
      detectorPromise = (async () => {
        if (!('LanguageDetector' in self)) return null;
        const availability = await LanguageDetector.availability();
        if (availability !== 'available') return null;
        return withTimeout(LanguageDetector.create(), 5000);
      })().catch((err) => {
        log('Language detector unavailable, translating all blocks', err);
        return null;
      });
    }
    return detectorPromise;
  }

  // Never let a stuck built-in API call stall page translation.
  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)),
    ]);
  }

  const pageIsGerman = () => (document.documentElement.lang || '').toLowerCase().startsWith('de');

  async function isGerman(text) {
    const trimmed = text.trim();
    if (trimmed.length < 20 && pageIsGerman()) return true;
    const detector = await getDetector();
    if (!detector) return true;
    let top;
    try {
      [top] = await withTimeout(detector.detect(trimmed), 3000);
    } catch (err) {
      log('Language detection failed, assuming German', err);
      return true;
    }
    if (!top) return pageIsGerman();
    if (top.detectedLanguage === 'de') return top.confidence >= (trimmed.length < 20 ? 0.3 : 0.5);
    if (top.detectedLanguage === 'und') return pageIsGerman();
    return false;
  }

  // Split text into sentence groups no larger than the limit.
  function splitSentences(text, limit) {
    const segmenter = new Intl.Segmenter('de', { granularity: 'sentence' });
    const chunks = [];
    let current = '';
    for (const { segment } of segmenter.segment(text)) {
      if (current && current.length + segment.length > limit) {
        chunks.push(current);
        current = '';
      }
      if (segment.length > limit) {
        // A single enormous "sentence": hard-split on whitespace.
        for (let i = 0; i < segment.length; ) {
          let end = Math.min(i + limit, segment.length);
          const space = segment.lastIndexOf(' ', end);
          if (end < segment.length && space > i) end = space + 1;
          chunks.push(segment.slice(i, end));
          i = end;
        }
      } else {
        current += segment;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async function translateLong(translator, text) {
    let limit = MAX_CHUNK_CHARS;
    if (text.length <= limit) {
      const usage = await translator.measureInputUsage(text);
      if (usage <= translator.inputQuota) return translator.translate(text);
      limit = Math.floor(text.length * (translator.inputQuota / usage) * 0.8);
    }
    const parts = [];
    for (const chunk of splitSentences(text, limit)) {
      parts.push(await translator.translate(chunk));
    }
    return parts.join(' ');
  }

  async function run(source) {
    if (cache.has(source)) return cache.get(source);
    const translator = await getTranslator();
    let result;
    try {
      result = await translateLong(translator, source);
    } catch (err) {
      // The translator itself failed (e.g. Chrome's translation service stopped).
      translatorPromise = null;
      throw new EngineError('failed', `Translation stopped: ${describeError(err)} Click the icon twice to retry, or restart Chrome.`);
    }
    cache.set(source, result);
    return result;
  }

  // Translate German text to English. Page blocks go through the queue and
  // reject with {cancelled: true} if cancelAll() is called before they run;
  // `urgent` (user-selected text) skips the queue.
  function translate(text, { urgent = false } = {}) {
    // Soft hyphens (common on German news sites) would otherwise leak into the English.
    const source = text.replace(/\u00AD/g, '').trim();
    if (!source) return Promise.resolve('');
    if (cache.has(source)) return Promise.resolve(cache.get(source));
    if (urgent) return run(source);

    const gen = generation;
    const job = tail.then(async () => {
      if (gen !== generation) throw { cancelled: true };
      return run(source);
    });
    tail = job.catch(() => {});
    return job;
  }

  // Drop every queued (not yet started) job.
  function cancelAll() {
    generation++;
  }

  // Download the model from a click handler on the current page. Must be called
  // synchronously inside the click (no await before it) so Chrome sees the
  // user activation it requires for downloads.
  function downloadModel(onProgress) {
    const created = Translator.create({
      ...LANGS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
      },
    });
    translatorPromise = created;
    created.catch(() => (translatorPromise = null));
    return created;
  }

  // Readable message for anything a built-in API might reject with (even undefined).
  function describeError(err) {
    if (!err) return 'Chrome refused the request without giving a reason.';
    if (err.name === 'NotAllowedError') return 'Chrome needs a click to start the download. Click the button again.';
    return err.message || String(err);
  }

  GTE.engine = { translate, isGerman, cancelAll, getTranslator, downloadModel, describeError, EngineError, log };
})();
