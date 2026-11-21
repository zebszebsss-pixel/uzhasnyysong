// Ужасныйsong — AI Manager. Серверная функция Vercel: /api/ai
// Ключи только в переменных окружения Vercel: GEMINI_API_KEY (или ANTHROPIC_API_KEY).
const ALLOWED = [/^https:\/\/uzhasnyysong(-[a-z0-9-]+)?\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/];
const hits = new Map();

const PERSONA = `Ты — «Ужасный AI», музыкальный бро внутри приложения «Ужасныйsong». Говоришь на языке пользователя (по умолчанию русский), неформально, тепло, с лёгким юмором, коротко: обычно 1–4 предложения, как друг в переписке.
Эмпатия: если человеку грустно или тяжело — сначала поддержи и расспроси, не спеши с музыкой. Можешь поговорить по душам.
Не навязывай рекомендации: предлагай треки, когда просят, когда спрашивают про настроение или когда это явно в тему.
Знаешь жанры, исполнителей, альбомы, историю песен, теорию музыки, инструменты.
Честность: если не уверен в факте — так и скажи («если не путаю», «точно не знаю»). Не выдавай догадки за факты.
Рекомендуй только реально существующие песни с точным названием и исполнителем. Не придумывай ссылки.
Авторское право: не приводи тексты песен (максимум одна короткая строка). Не давай полный текст и полный перевод. Переводить и разбирать построчно можно только фрагменты, которые пользователь сам прислал.
Ты не психолог. Если человек говорит о желании навредить себе — тепло поддержи и посоветуй обратиться к близким или на линию Lifeline Ukraine 7333 (если он в Украине), рекомендаций музыки в этом случае не давай.`;

const FORMATS = {
  chat: `Ответь ТОЛЬКО валидным JSON без markdown:
{"reply":"текст ответа","emotion":"happy|excited|sad|thinking|cool|surprised|neutral","mood":"sad|happy|romantic|nostalgic|aggressive|calm|lonely|motivated|night|relax|null","tracks":[{"artist":"","title":"","why":"коротко, почему подходит"}],"remember":{"genres":[],"artists":[],"songs":[],"moods":[],"instruments":[],"level":""}}
tracks: 0–5 треков, только когда уместно рекомендовать, иначе []. Учитывай вкусы пользователя, но добавляй и новое.
remember: только то, что пользователь САМ прямо сказал о своих вкусах/инструментах в последнем сообщении, иначе пустые массивы и "".`,
  analyze: `Разбери песню. Ответь ТОЛЬКО валидным JSON без markdown:
{"summary":"о чём песня, 2–3 предложения","meaning":"смысл и подтекст","mood":"какое настроение передаёт","instruments":"какие инструменты/звучание","interesting":"чем интересна мелодия/история создания","lines":[{"line":"строка из присланного фрагмента","explain":"объяснение"}],"translation":"перевод ТОЛЬКО присланного фрагмента или пусто","slang":[{"phrase":"","explain":""}],"confidence":"честно: что известно точно, а что предположение"}
Если фрагмент не прислан — lines, translation, slang пустые. Не цитируй текст песни сам.`,
  play: `Подготовь урок игры песни на инструменте. Ответь ТОЛЬКО валидным JSON без markdown:
{"key":"тональность или пусто","bpm":число или null,"capo":число или null,"difficulty":"лёгкая|средняя|сложная","status":"known|adaptation","chords":["Am","F"],"sections":[{"name":"Куплет","progression":"Am F C G","strum":"рисунок боя/перебора или ритма"}],"pattern":"как играть ритм","tips":["совет"],"note":"честно: насколько уверен в аккордах"}
Правила: только названия аккордов стандартного вида (C, Am, F#m, Bb7, Cmaj7, Dsus4, G/B). Никогда не выдумывай ноты мелодии и табулатуры. status="known" только если уверен, что это общеизвестная гармония песни; иначе "adaptation" (упрощённая адаптация в похожем духе) и скажи об этом в note. Для фортепиано опиши левую/правую руку, для баса — корневые ноты. Если не знаешь BPM — null.`
};

function rateLimited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}
function parseJSON(t) {
  try { return JSON.parse(t); } catch (e) {}
  const m = String(t).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
function buildUser(mode, b) {
  const prefs = b.prefs || {}, ctx = [];
  const list = k => Array.isArray(prefs[k]) && prefs[k].length ? prefs[k].slice(0, 15).join(', ') : '';
  if (list('genres')) ctx.push('любимые жанры: ' + list('genres'));
  if (list('artists')) ctx.push('любимые исполнители: ' + list('artists'));
  if (list('songs')) ctx.push('любимые песни: ' + list('songs'));
  if (list('moods')) ctx.push('любимое настроение музыки: ' + list('moods'));
  if (list('instruments')) ctx.push('инструменты: ' + list('instruments'));
  if (prefs.level) ctx.push('уровень: ' + String(prefs.level).slice(0, 40));
  if (Array.isArray(b.recent) && b.recent.length) ctx.push('недавно слушал: ' + b.recent.slice(0, 10).map(String).join('; '));
  const about = ctx.length ? 'Что известно о пользователе (с его согласия): ' + ctx.join('. ') + '.' : '';
  if (mode === 'analyze') {
    const t = b.track || {}, frag = String(b.text || '').split('\n').slice(0, 12).join('\n').slice(0, 1200);
    return `${about}\nПесня: «${String(t.title || '').slice(0, 120)}» — ${String(t.artist || '').slice(0, 120)}.\n${frag ? 'Фрагмент текста, присланный пользователем:\n' + frag : 'Фрагмент не прислан.'}`;
  }
  if (mode === 'play') {
    const t = b.track || {};
    return `${about}\nПесня: «${String(t.title || '').slice(0, 120)}» — ${String(t.artist || '').slice(0, 120)}. Инструмент: ${String(b.instrument || 'гитара').slice(0, 30)}. Уровень: ${String(b.level || 'новичок').slice(0, 30)}.`;
  }
  return about;
}

async function callGemini(system, msgs, image, mode) {
  const key = process.env.GEMINI_API_KEY;
  const contents = msgs.map((m, i) => {
    const parts = [{ text: m.text }];
    if (image && i === msgs.length - 1) parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: image } });
    return { role: m.role === 'ai' ? 'model' : 'user', parts };
  });
  // быстрые модели первыми: чат должен отвечать за пару секунд
  const order = mode === 'chat'
    ? ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash']
    : ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  const models = [...new Set([process.env.GEMINI_MODEL, ...order].filter(Boolean))];
  let last = '';
  for (const model of models) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 25000);
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents,
          generationConfig: { responseMimeType: 'application/json', temperature: 0.9, maxOutputTokens: 4096 } })
      });
    } catch (e) { clearTimeout(timer); throw new Error(e.name === 'AbortError' ? 'timeout' : 'net'); }
    clearTimeout(timer);
    const d = await r.json().catch(() => ({}));
    if (r.ok) { callGemini.used = model; return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); }
    last = d.error?.status || String(r.status);
    if (r.status === 429) throw new Error('quota');
    if (r.status === 400 && /API key/i.test(d.error?.message || '')) throw new Error('badkey');
    if (r.status !== 404 && r.status !== 400) break;
  }
  throw new Error('provider ' + last);
}
async function callAnthropic(system, msgs, image) {
  const messages = msgs.map((m, i) => {
    const content = [{ type: 'text', text: m.text }];
    if (image && i === msgs.length - 1) content.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
    return { role: m.role === 'ai' ? 'assistant' : 'user', content };
  });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5', max_tokens: 2048, system, messages })
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error('quota');
  if (!r.ok) throw new Error('provider ' + (d.error?.type || r.status));
  return (d.content || []).map(c => c.text || '').join('');
}

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (origin && !ALLOWED.some(r => r.test(origin))) return res.status(403).json({ error: 'origin' });
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'content-type'); return res.status(204).end(); }
  const hasKey = !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY);
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'x';
  if (req.method === 'GET') {
    // самопроверка: /api/ai?diag=1 — без ключа и текста разговора в ответе
    if (!req.query || !req.query.diag) return res.status(200).json({ ok: true, service: 'Ужасный AI', key: hasKey });
    if (!hasKey) return res.status(200).json({ ok: false, error: 'nokey' });
    if (rateLimited(ip)) return res.status(429).json({ error: 'slow' });
    const t0 = Date.now();
    try {
      const raw = process.env.ANTHROPIC_API_KEY ? await callAnthropic('Ответь JSON {"pong":true}', [{ role: 'user', text: 'ping' }])
        : await callGemini('Ответь JSON {"pong":true}', [{ role: 'user', text: 'ping' }], null, 'chat');
      return res.status(200).json({ ok: !!parseJSON(raw), model: callGemini.used || 'anthropic', ms: Date.now() - t0 });
    } catch (e) { return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 80), ms: Date.now() - t0 }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!hasKey) return res.status(503).json({ error: 'nokey' });
  if (rateLimited(ip)) return res.status(429).json({ error: 'slow' });

  const b = typeof req.body === 'string' ? (parseJSON(req.body) || {}) : (req.body || {});
  const mode = FORMATS[b.mode] ? b.mode : 'chat';
  const image = typeof b.image === 'string' && b.image.length < 1600000 && /^[A-Za-z0-9+/=]+$/.test(b.image) ? b.image : null;
  let msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-16)
    .map(m => ({ role: m && m.role === 'ai' ? 'ai' : 'user', text: String(m && m.text || '').slice(0, 2000) }))
    .filter(m => m.text.trim());
  const about = buildUser(mode, b);
  if (mode !== 'chat') msgs = [{ role: 'user', text: about }];
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'empty' });
  while (msgs.length && msgs[0].role === 'ai') msgs.shift();
  const system = PERSONA + '\n\n' + FORMATS[mode] + (mode === 'chat' && about ? '\n\n' + about : '');

  try {
    const raw = process.env.ANTHROPIC_API_KEY ? await callAnthropic(system, msgs, image) : await callGemini(system, msgs, image, mode);
    const data = parseJSON(raw);
    if (!data) return res.status(502).json({ error: 'format' });
    return res.status(200).json({ ok: true, data });
  } catch (e) {
    const m = String(e.message || e);
    const code = ['quota', 'badkey', 'timeout'].includes(m) ? m : 'provider';
    return res.status(m === 'quota' ? 429 : m === 'timeout' ? 504 : 502).json({ error: code, detail: m.slice(0, 80) });
  }
};
module.exports.config = { maxDuration: 60 };
