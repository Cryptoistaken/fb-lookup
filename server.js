import { randomUUID } from 'crypto';
import http from 'http';
import https from 'https';
import tls from 'tls';
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
// NEW METHOD — minimal graphql call through a proxy pool.
// No session, no cookies, no LSD token. Round-robin with
// failover across all proxies.
// ============================================================

const DEFAULT_PROXIES = `
change6.owlproxy.com:7778:xwngkCybPO20_custom_zone_DE:4995486
change6.owlproxy.com:7778:s2xCkyV0ua10_custom_zone_GB:4995496
change6.owlproxy.com:7778:BqrgEG4HDJ30_custom_zone_FR:4995519
change6.owlproxy.com:7778:Qn4d5uzwDG60_custom_zone_IT:4995604
change6.owlproxy.com:7778:fuhtbT5SAy20_custom_zone_ES:4995614
change6.owlproxy.com:7778:lNzJvGYj4Q10_custom_zone_PL:4995622
change6.owlproxy.com:7778:Kky6pMkIR060_custom_zone_RO:4995630
change6.owlproxy.com:7778:U98ukt2SeM90_custom_zone_NL:4998927
change6.owlproxy.com:7778:j1RNH3Cowd30_custom_zone_BE:4999069
change6.owlproxy.com:7778:W2VVi5gLKE70_custom_zone_CZ:4999794
change6.owlproxy.com:7778:SFFXNIABkJ70_custom_zone_SE:5000107
`.trim();

function parseProxy(line) {
  const [host, port, user, pass] = line.split(':');
  return { host, port: parseInt(port, 10), user, pass };
}

const PROXIES = (process.env.FB_PROXIES || DEFAULT_PROXIES)
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseProxy);

// Fallback pool (WebShare) — used only when every primary proxy fails.
const DEFAULT_FALLBACK_PROXIES = `
31.59.20.176:6754:ratulUsername:ratulproxy
31.56.127.193:7684:ratulUsername:ratulproxy
45.38.107.97:6014:ratulUsername:ratulproxy
198.105.121.200:6462:ratulUsername:ratulproxy
64.137.96.74:6641:ratulUsername:ratulproxy
198.23.243.226:6361:ratulUsername:ratulproxy
38.154.185.97:6370:ratulUsername:ratulproxy
84.247.60.125:6095:ratulUsername:ratulproxy
142.111.67.146:5611:ratulUsername:ratulproxy
191.96.254.138:6185:ratulUsername:ratulproxy
`.trim();

const FALLBACK_PROXIES = (process.env.FB_FALLBACK_PROXIES || DEFAULT_FALLBACK_PROXIES)
  .split('\n')
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseProxy);

let rrCounter = 0;

function proxyTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64');
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}`, 'Proxy-Authorization': `Basic ${auth}` },
    });
    req.setTimeout(20000, () => req.destroy(new Error('CONNECT timeout')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT failed: HTTP ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => resolve(tlsSocket));
      tlsSocket.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function proxiedPost(proxy, targetHost, targetPath, headers, body, timeoutMs = 25000) {
  return new Promise(async (resolve, reject) => {
    let socket;
    try { socket = await proxyTunnel(proxy, targetHost, 443); } catch (e) { return reject(e); }
    const bodyBuf = Buffer.from(body);
    const req = https.request({
      createConnection: () => socket,
      hostname: targetHost,
      port: 443,
      path: targetPath,
      method: 'POST',
      headers: { ...headers, 'Content-Length': bodyBuf.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

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

async function checkNumber(phone) {
  if (!PROXIES.length && !FALLBACK_PROXIES.length) return { phone, ok: false, found: false, error: 'No proxies configured' };

  const pools = [
    { list: PROXIES, tag: 'owlproxy' },
    { list: FALLBACK_PROXIES, tag: 'webshare' },
  ];
  let lastError = null;

  for (const pool of pools) {
    if (!pool.list.length) continue;
    const start = (rrCounter++) % pool.list.length;
    for (let i = 0; i < pool.list.length; i++) {
      const proxy = pool.list[(start + i) % pool.list.length];
      try {
        const res = await proxiedPost(proxy, 'www.facebook.com', '/api/graphql/', GRAPHQL_HEADERS, buildBody(phone));
        let text = res.body.toString();
        if (text.startsWith('for (;;);')) text = text.slice(9);
        const parsed = JSON.parse(text);
        const search = parsed?.data?.caa_ar_fb_account_search;
        if (!search) return { phone, ok: false, found: false, error: 'Empty response' };
        const found = search.accounts.length > 0;
        const desc = search.error_content?.description || null;
        console.log(`[check] ${phone} -> ${found ? 'USED (account found)' : 'FRESH'} | ${desc || ''}`);
        return { phone, ok: true, found, error: desc };
      } catch (e) {
        lastError = e.message;
        console.log(`[check] ${phone} -> ${pool.tag} ${proxy.host}:${proxy.port} failed: ${e.message}`);
      }
    }
  }

  return { phone, ok: false, found: false, error: lastError || 'All proxies failed' };
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
    return jsonResponse(res, 200, { status: 'ok', uptime: process.uptime(), owlproxy: PROXIES.length, webshare: FALLBACK_PROXIES.length });
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
    console.log(`  ${PROXIES.length} owlproxy + ${FALLBACK_PROXIES.length} webshare proxies loaded`);
    console.log(`  GET  /check?phone=+8801869365360`);
    console.log(`  POST /check { "phone": "+8801869365360" }`);
    console.log(`  GET  /health`);
  });
}

export { acquireSession, buildBody, graphqlHeaders, checkNumber, proxyTunnel, proxiedPost, GRAPHQL_HEADERS, DOC_ID, BASE, PROXIES, FALLBACK_PROXIES };
