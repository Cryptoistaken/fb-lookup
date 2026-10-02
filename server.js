import { randomUUID } from 'crypto';
import http from 'http';
import { pathToFileURL } from 'url';

const DOC_ID = '26328147246854413';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BASE = 'https://www.facebook.com';
const PORT = parseInt(process.env.PORT || '8080');

// ============================================================
// OLD METHOD (session + cookies) — kept for reference.
// Removed from the request flow: the graphql endpoint does not
// validate cookies or the LSD token, so this whole session
// dance (fetching the ~424KB homepage per check) is unnecessary.
// ============================================================
// const PAGE_HEADERS = {
//   'User-Agent': UA,
//   Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
//   'Accept-Language': 'en-US,en;q=0.9',
//   'Sec-Fetch-Dest': 'document',
//   'Sec-Fetch-Mode': 'navigate',
//   'Sec-Fetch-Site': 'none',
// };
//
// function parseCookies(setCookieHeaders) {
//   const cookies = {};
//   for (const header of setCookieHeaders) {
//     const semi = header.indexOf(';');
//     const kv = semi >= 0 ? header.slice(0, semi) : header;
//     const eq = kv.indexOf('=');
//     if (eq > 0) cookies[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
//   }
//   return cookies;
// }
//
// function getSetCookieArray(res) {
//   if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
//   return (res.headers.get('set-cookie') || '').split(/,(?=\s*[\w.-]+=)/);
// }
//
// function cookieStr(map) {
//   return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
// }
//
// async function acquireSession() {
//   const res = await fetch(`${BASE}/`, {
//     headers: PAGE_HEADERS,
//     redirect: 'follow',
//   });
//
//   const html = await res.text();
//   const lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1];
//   if (!lsd) throw new Error('Failed to extract LSD token');
//
//   const cookies = parseCookies(getSetCookieArray(res));
//   if (!Object.keys(cookies).length) throw new Error('No cookies received');
//
//   return { lsd, cookies, acquiredAt: Date.now() };
// }
//
// function buildBody(phone, lsd) {
//   const uid = randomUUID();
//   const p = new URLSearchParams();
//   p.set('lsd', lsd);
//   p.set('variables', JSON.stringify({
//     params: {
//       cipher_text: null,
//       context: 'recover',
//       event_request_id: uid,
//       friend_name: '',
//       search_query: phone,
//       waterfall_id: uid,
//     },
//   }));
//   p.set('doc_id', DOC_ID);
//   return p.toString();
// }
//
// function graphqlHeaders(session) {
//   return {
//     'Content-Type': 'application/x-www-form-urlencoded',
//     'User-Agent': UA,
//     Accept: '*/*',
//     'Accept-Language': 'en-US,en;q=0.9',
//     'X-FB-LSD': session.lsd,
//     Cookie: cookieStr(session.cookies),
//     Origin: BASE,
//     Referer: `${BASE}/login/identify/`,
//     'Sec-Fetch-Dest': 'empty',
//     'Sec-Fetch-Mode': 'cors',
//     'Sec-Fetch-Site': 'same-origin',
//   };
// }
//
// async function checkNumber(phone) {
//   const session = await acquireSession();
//
//   const res = await fetch(`${BASE}/api/graphql/`, {
//     method: 'POST',
//     headers: graphqlHeaders(session),
//     body: buildBody(phone, session.lsd),
//   });
//
//   if (!res.ok) return { phone, ok: false, found: false, error: `HTTP ${res.status}` };
//
//   let text = await res.text();
//   if (text.startsWith('for (;;);')) text = text.slice(9);
//
//   try {
//     const parsed = JSON.parse(text);
//     const search = parsed?.data?.caa_ar_fb_account_search;
//     if (!search) return { phone, ok: false, found: false, error: 'Empty response' };
//     const found = search.accounts.length > 0;
//     const desc = search.error_content?.description || null;
//     console.log(`[check] ${phone} -> ${found ? 'USED (account found)' : 'FRESH'} | ${desc || ''}`);
//     return { phone, ok: true, found, error: desc };
//   } catch (e) {
//     console.log(`[check] ${phone} -> ERROR: ${e.message}`);
//     return { phone, ok: false, found: false, error: e.message };
//   }
// }
// ============================================================
// END OLD METHOD
// ============================================================

// ============================================================
// NEW METHOD — minimal graphql call, DIRECT (no proxy).
// No session, no cookies, no LSD token. The proxy pool was
// removed: every line pointed at the same change6.owlproxy.com
// host so it never actually failed over, and the webshare
// fallback returned 407 on nearly every attempt.
// ============================================================

const GRAPHQL_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: BASE,
  Referer: `${BASE}/login/identify/`,
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
};

function buildBody(phone, _lsd) {
  const p = new URLSearchParams();
  p.set('variables', JSON.stringify({
    params: {
      cipher_text: null,
      context: 'recover',
      event_request_id: randomUUID(),
      friend_name: '',
      search_query: phone,
      waterfall_id: randomUUID(),
    },
  }));
  p.set('doc_id', DOC_ID);
  return p.toString();
}

function graphqlHeaders(_session) {
  return { ...GRAPHQL_HEADERS };
}

function acquireSession() {
  return { lsd: '', cookies: {}, acquiredAt: Date.now() };
}

const RETRIES = parseInt(process.env.FB_RETRIES || '3', 10);
const TIMEOUT_MS = parseInt(process.env.FB_TIMEOUT_MS || '20000', 10);

async function directPost(targetHost, targetPath, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${targetPath}`, {
      method: 'POST',
      headers,
      body,
      signal: ctl.signal,
    });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkNumber(phone) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await directPost('www.facebook.com', '/api/graphql/', GRAPHQL_HEADERS, buildBody(phone), TIMEOUT_MS);
      let text = res.body.toString();
      if (text.startsWith('for (;;);')) text = text.slice(9);
      const parsed = JSON.parse(text);
      const search = parsed?.data?.caa_ar_fb_account_search;
      if (!search) throw new Error(`Empty response (HTTP ${res.status})`);
      const found = search.accounts.length > 0;
      const desc = search.error_content?.description || null;
      console.log(`[check] ${phone} -> ${found ? 'USED (account found)' : 'FRESH'} | ${desc || ''} | direct, ${TIMEOUT_MS}ms budget, attempt ${attempt}/${RETRIES}`);
      return { phone, ok: true, found, error: desc };
    } catch (e) {
      lastError = e.name === 'AbortError' ? 'Request timeout' : e.message;
      console.log(`[check] ${phone} -> direct failed: ${lastError} (attempt ${attempt}/${RETRIES})`);
    }
  }

  return { phone, ok: false, found: false, error: lastError || 'Request failed' };
}

// ============================================================
// END NEW METHOD
// ============================================================

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/health') {
    return jsonResponse(res, 200, { status: 'ok', uptime: process.uptime(), mode: 'direct', proxies: 0 });
  }

  if ((req.method === 'GET' || req.method === 'POST') && path === '/check') {
    let phone;
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try { phone = JSON.parse(body).phone; } catch { phone = null; }
    } else {
      phone = url.searchParams.get('phone');
    }

    if (!phone) {
      return jsonResponse(res, 400, { ok: false, error: 'Missing phone parameter' });
    }

    phone = String(phone).replace(/\s+/g, '');
    if (!phone.startsWith('+')) phone = '+' + phone;

    try {
      const result = await checkNumber(phone);
      return jsonResponse(res, 200, result);
    } catch (e) {
      return jsonResponse(res, 500, { phone, ok: false, found: false, error: e.message });
    }
  }

  jsonResponse(res, 404, { error: 'Not found' });
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  server.listen(PORT, () => {
    console.log(`FB Lookup Service running on port ${PORT}`);
    console.log(`  direct connection (no proxies), ${RETRIES} retries, ${TIMEOUT_MS}ms timeout`);
    console.log(`  GET  /check?phone=+8801869365360`);
    console.log(`  POST /check { "phone": "+8801869365360" }`);
    console.log(`  GET  /health`);
  });
}

export { acquireSession, buildBody, graphqlHeaders, checkNumber, GRAPHQL_HEADERS, DOC_ID, BASE };
