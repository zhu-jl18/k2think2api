// Cloudflare Worker: K2 Think demo proxy
// Copy-pasteable single-file worker. Also used by wrangler (see wrangler.toml).

// Upstream settings
const UPSTREAM_BASE = 'https://www.k2think.ai';
const UPSTREAM_PATH = '/api/guest/chat/completions';

// Local paths exposed by this worker
const LOCAL_RAW_PATH = '/api/guest/chat/completions';
const LOCAL_OPENAI_PATH = '/v1/chat/completions';

// OpenAI-compatible model metadata
const MODEL_ID = 'MBZUAI-IFM/K2-Think';
const MODEL_ALIASES = ['K2-Think', 'k2think', 'k2-think', 'k2'];

function openaiModelObject() {
  return {
    id: MODEL_ID,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'MBZUAI-IFM',
    root: MODEL_ID,
    parent: null
  };
}

// CORS helpers
function corsHeaders(origin) {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', origin || '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return h;
}

function sseHeaders(origin) {
  const h = corsHeaders(origin);
  h.set('content-type', 'text/event-stream; charset=utf-8');
  h.set('cache-control', 'no-cache');
  h.set('connection', 'keep-alive');
  return h;
}

function isPreflight(request) {
  return request.method === 'OPTIONS' && request.headers.has('Origin') && request.headers.has('Access-Control-Request-Method');
}

function withCors(resp, origin) {
  const ch = corsHeaders(origin);
  const out = new Headers(resp.headers);
  // Remove hop-by-hop/invalid headers for Workers
  out.delete('content-length');
  out.delete('transfer-encoding');
  out.delete('content-encoding');
  out.set('Access-Control-Allow-Origin', ch.get('Access-Control-Allow-Origin'));
  out.set('Access-Control-Allow-Methods', ch.get('Access-Control-Allow-Methods'));
  out.set('Access-Control-Allow-Headers', ch.get('Access-Control-Allow-Headers'));
  out.set('Access-Control-Max-Age', ch.get('Access-Control-Max-Age'));
  out.set('Vary', ch.get('Vary'));
  out.set('X-Proxy-By', 'k2think2api-worker');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
}

function json(data, init = {}, origin) {
  const headers = new Headers(init.headers || {});
  for (const [k, v] of corsHeaders(origin).entries()) headers.set(k, v);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function wantFlat(url, request) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const qp = (name) => u.searchParams.get(name);
  const hv = (name) => request.headers.get(name) || '';
  return ['flat', 'strip_newlines', 'flat_content']
    .some(k => (qp(k) || hv('x-' + k)) && (qp(k) === '1' || qp(k) === '' || hv('x-' + k) === '1'));
}

function sanitizeContent(str, opts = {}) {
  let s = (str == null ? '' : String(str));
  if (opts.stripNewlines) s = s.replace(/[\r\n]+/g, ' ');
  return s;
}

function splitThinkAnswer(content) {
  const src = String(content || '');
  const thinkM = src.match(/<think>([\s\S]*?)<\/think>/i);
  const ansM = src.match(/<answer>([\s\S]*?)<\/answer>/i);
  let think = '', answer = '';
  if (thinkM) think = thinkM[1].trim();
  if (ansM) answer = ansM[1].trim();
  if (!ansM) {
    // If no explicit <answer>, treat remaining as answer (excluding think block)
    if (thinkM) {
      const before = src.slice(0, thinkM.index).trim();
      const after = src.slice(thinkM.index + thinkM[0].length).trim();
      answer = [before, after].filter(Boolean).join('\n').trim();
    } else {
      answer = src.trim();
    }
  }
  return { think, answer, hasTags: Boolean(thinkM || ansM), raw: src };
}


async function proxyCompletions(request) {
  const origin = request.headers.get('Origin');
  const rawBody = await request.text();
  let accept = 'application/json';
  let bodyText = rawBody;
  try {
    const j = JSON.parse(rawBody || '{}');
    if (j && j.stream === true) accept = 'text/event-stream';
    if (j && typeof j.model === 'string' && j.model !== MODEL_ID) {
      const m = j.model.trim();
      if (MODEL_ALIASES.map(a => a.toLowerCase()).includes(m.toLowerCase())) {
        j.model = MODEL_ID;
      }
    }
    bodyText = JSON.stringify(j);
  } catch (_) {
    // keep original body if not JSON
  }

  const u = new URL(UPSTREAM_BASE);
  u.pathname = UPSTREAM_PATH;

  const upstreamResp = await fetch(u, {
    method: 'POST',
    headers: {
      'accept': accept,
      'content-type': 'application/json',
      // Spoof minimal browser-like headers to pass basic bot checks
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'origin': 'https://www.k2think.ai',
      'referer': 'https://www.k2think.ai/k2think',
      'accept-language': 'en-US,en;q=0.9,zh;q=0.8',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'empty'
    },
    body: bodyText,
    redirect: 'manual'
  });

  return withCors(upstreamResp, origin);
}

// OpenAI-compatible completions endpoint with streaming shim
async function openaiCompletions(request) {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);
  const bodyText = await request.text();
  let wantsStream = false;
  let payload = {};
  try {
    payload = JSON.parse(bodyText || '{}');
    wantsStream = payload.stream === true;
    if (typeof payload.model === 'string' && payload.model !== MODEL_ID) {
      const m = payload.model.trim();
      if (MODEL_ALIASES.map(a => a.toLowerCase()).includes(m.toLowerCase())) {
        payload.model = MODEL_ID;
      }
    }
  } catch (_) {
    // if not JSON, reject as OpenAI would
    return json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, { status: 400 }, origin);
  }

  // Always ask upstream for non-streaming JSON; we will synthesize SSE if client requested stream
  if (wantsStream) {
    delete payload.stream;
  }

  const u = new URL(UPSTREAM_BASE);
  u.pathname = UPSTREAM_PATH;

  const upstreamResp = await fetch(u, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'origin': 'https://www.k2think.ai',
      'referer': 'https://www.k2think.ai/k2think',
      'accept-language': 'en-US,en;q=0.9,zh;q=0.8',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'empty'
    },
    body: JSON.stringify(payload),
    redirect: 'manual'
  });

  // Parse upstream JSON once for both paths so we can post-process
  if (!upstreamResp.ok) {
    // Bubble up error in OpenAI-compatible shape
    let msg = await upstreamResp.text();
    try {
      const errobj = JSON.parse(msg);
      msg = errobj.detail || errobj.message || msg;
    } catch {}
    return json({ error: { message: String(msg), type: 'upstream_error', code: upstreamResp.status } }, { status: upstreamResp.status }, origin);
  }

  let upstreamJSON;
  try {
    upstreamJSON = await upstreamResp.json();
  } catch (e) {
    return json({ error: { message: 'Invalid upstream JSON', type: 'upstream_error' } }, { status: 502 }, origin);
  }

  const flat = wantFlat(url, request);
  const created = Math.floor(Date.now() / 1000);
  const id = (upstreamJSON && upstreamJSON.id) ? String(upstreamJSON.id) : `chatcmpl_${cryptoRandomId()}`;
  const model = MODEL_ID;
  const rawContent = (((upstreamJSON || {}).choices || [])[0] || {}).message?.content || '';
  const parts = splitThinkAnswer(rawContent);
  const flatAnswer = flat ? sanitizeContent(parts.answer, { stripNewlines: true }) : parts.answer;

  // Non-stream path: return OpenAI response with sanitized content if requested
  if (!wantsStream) {
    const respObj = {
      id,
      object: 'chat.completion',
      created,
      model,
      system_fingerprint: upstreamJSON.system_fingerprint,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: flatAnswer, reasoning_content: parts.think },
          finish_reason: 'stop'
        }
      ],
      usage: upstreamJSON.usage,
      time_info: upstreamJSON.time_info
    };
    return json(respObj, { status: 200 }, origin);
  }

  // Stream path: synthesize SSE with optional flat content

  // Build stream
  const encoder = new TextEncoder();
  const delayParam = Number(url.searchParams.get('chunk_delay_ms') || request.headers.get('x-chunk-delay-ms') || 0);
  const delayMs = Number.isFinite(delayParam) ? Math.max(0, Math.min(2000, delayParam)) : 0;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // First: role delta (optional but improves compatibility)
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });

      // First, stream reasoning_content if available
      if (parts.think) {
        for (const piece of chunkString(parts.think, 400)) {
          if (!piece) continue;
          send({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }]
          });
          if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        }
      }

      // Then stream the final answer content (apply flat to answer only)
      for (const piece of chunkString(flatAnswer, 400)) {
        if (!piece) continue;
        send({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
        });
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      }

      // Final stop chunk
      send({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  const headers = sseHeaders(origin);
  headers.set('X-Proxy-By', 'k2think2api-worker');
  return new Response(stream, { status: 200, headers });
}

function chunkString(str, size) {
  const out = [];
  if (!str || typeof str !== 'string') return out;
  for (let i = 0; i < str.length; i += size) {
    out.push(str.slice(i, i + size));
  }
  return out;
}

function cryptoRandomId() {
  // 12 random bytes -> 24 hex chars
  const arr = new Uint8Array(12);
  (crypto || self.crypto).getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (isPreflight(request)) {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ status: 'ok', upstream: `${UPSTREAM_BASE}${UPSTREAM_PATH}` }, { status: 200 }, origin);
    }

    if (request.method === 'POST' && url.pathname === LOCAL_RAW_PATH) {
      // Raw passthrough
      return proxyCompletions(request);
    }
    if (request.method === 'POST' && url.pathname === LOCAL_OPENAI_PATH) {
      // OpenAI-compatible with streaming shim
      return openaiCompletions(request);
    }

    // OpenAI-compatible: model list and read
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return json({ object: 'list', data: [openaiModelObject()] }, { status: 200 }, origin);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      const id = decodeURIComponent(url.pathname.replace('/v1/models/', ''));
      if (id === MODEL_ID || MODEL_ALIASES.map(a => a.toLowerCase()).includes(id.toLowerCase())) {
        return json(openaiModelObject(), { status: 200 }, origin);
      }
      return json({ error: { message: 'The model is not found', type: 'invalid_request_error', param: 'model', code: 'model_not_found' } }, { status: 404 }, origin);
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        name: 'k2think2api-worker',
        endpoints: {
          raw: LOCAL_RAW_PATH,
          openai_compatible: LOCAL_OPENAI_PATH,
          health: '/health',
          models: '/v1/models'
        },
        upstream: `${UPSTREAM_BASE}${UPSTREAM_PATH}`,
        model: MODEL_ID,
        aliases: MODEL_ALIASES
      }, { status: 200 }, origin);
    }

    return json({ error: 'Not found', note: `Use ${LOCAL_RAW_PATH} or ${LOCAL_OPENAI_PATH}` }, { status: 404 }, origin);
  }
};


