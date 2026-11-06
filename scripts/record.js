// ضبط‌کننده‌ی فیلم‌های xtremestream روی رانر گیت‌هاب‌اکشن:
// صفحه‌ی تیوب -> آی‌فریم پخش‌کننده -> اجرای واقعی پخش‌کننده در کروم هدلس ->
// شکار بایت‌های رمزگشایی‌شده از SourceBuffer.appendBuffer -> فایل صوت/تصویر جدا -> mux با ffmpeg.
// ورودی‌ها از env: PAGE_URL (لینک صفحه یا پخش‌کننده)، MAXSEC (۰=کل فیلم)، OUT (مسیر خروجی)
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const { execFileSync } = require('child_process');

const PAGE_URL = process.env.PAGE_URL;
const OUT = process.env.OUT || '/tmp/out.mp4';
const MAXSEC = +(process.env.MAXSEC || 0);
const PORT = 18099;

async function resolvePlayer(pageUrl) {
  if (/xtremestream\.xyz\/player\//.test(pageUrl)) return pageUrl;
  const m = /[?&]data=([a-f0-9]{32})/.exec(pageUrl);
  if (m) return 'https://pervl5.xtremestream.xyz/player/index.php?data=' + m[1];
  const html = await (await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36' } })).text();
  const im = /<iframe[^>]+src="(https?:\/\/[^"]*xtremestream[^"]+)"/.exec(html);
  if (im) return im[1].replace(/&amp;/g, '&');
  throw new Error('player iframe not found in page');
}

const streams = new Map();
let appends = 0;
function streamFor(key) {
  if (!streams.has(key)) {
    const f = '/tmp/rec-' + key.replace(/[^\w.-]+/g, '_') + '.bin';
    streams.set(key, { path: f, ws: fs.createWriteStream(f), bytes: 0 });
  }
  return streams.get(key);
}
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/append')) {
    const u = new URL(req.url, 'http://x');
    const key = (u.searchParams.get('mime') || 'unknown').split(';')[0];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const b = Buffer.concat(chunks);
      const s = streamFor(key); s.ws.write(b); s.bytes += b.length; appends++;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('ok');
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': '*' }); res.end();
  } else { res.writeHead(404); res.end(); }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const PLAYER = await resolvePlayer(PAGE_URL);
  console.log('player:', PLAYER);
  await new Promise(r => server.listen(PORT, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 13; Galaxy A53) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36');
  // سقف پهنای‌باند دانلود ~۲٫۲ مگابیت: ABR روی ۴۸۰ می‌ماند و وسط ضبط کیفیت عوض نمی‌شود
  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: Math.floor(2.2 * 1024 * 1024 / 8), uploadThroughput: Math.floor(1024 * 1024 / 8) });
  } catch (e) { console.log('throttle failed:', e.message); }

  await page.evaluateOnNewDocument((port) => {
    const state = { bytes: 0, n: 0, types: new Map() };
    Object.defineProperty(window, '__pbq', { value: state, enumerable: false, configurable: true });
    function stealth(obj, name, orig, wrapper) {
      Object.defineProperty(wrapper, 'toString', { value: function () { return Function.prototype.toString.call(orig); }, configurable: true });
      Object.defineProperty(obj, name, { value: wrapper, writable: true, configurable: true, enumerable: false });
    }
    const origAdd = MediaSource.prototype.addSourceBuffer;
    stealth(MediaSource.prototype, 'addSourceBuffer', origAdd, function (type) {
      const sb = origAdd.call(this, type);
      state.types.set(sb, type);
      return sb;
    });
    const orig = SourceBuffer.prototype.appendBuffer;
    stealth(SourceBuffer.prototype, 'appendBuffer', orig, function (data) {
      try {
        const type = state.types.get(this) || 'unknown';
        const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
        state.bytes += u8.byteLength; state.n++;
        fetch('http://127.0.0.1:' + port + '/append?mime=' + encodeURIComponent(type), { method: 'POST', body: u8.slice().buffer }).catch(() => {});
      } catch (e) {}
      return orig.call(this, data);
    });
  }, PORT);

  await page.goto(PLAYER, { waitUntil: 'networkidle2', timeout: 120000 }).catch(e => console.log('goto:', e.message));
  await sleep(4000);

  // کیک‌استارت صبورانه: تا وقتی مدت ویدیو معلوم و appendها جاری نشده‌اند، کلیک/play را تکرار کن
  let dur = 0;
  for (let i = 0; i < 40; i++) {
    await page.evaluate(() => {
      const b = document.querySelector('.vjs-big-play-button');
      if (b) b.click();
      const v = document.querySelector('video');
      if (v) { v.muted = true; if (v.paused) v.play().catch(() => {}); }
    }).catch(() => {});
    await sleep(3000);
    const st = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { d: isFinite(v.duration) ? v.duration : 0, t: v.currentTime, rec: window.__pbq ? window.__pbq.n : -1 } : null;
    }).catch(() => null);
    if (st && st.d > 0) dur = st.d;
    if (st && st.d > 0 && st.rec > 0) break;
    if (i % 6 === 5) console.log('kickstart still waiting…', JSON.stringify(st));
  }
  if (!dur) { console.error('player never became ready'); process.exit(3); }
  const target = MAXSEC > 0 ? Math.min(MAXSEC, dur) : dur;
  console.log('duration:', Math.round(dur), 'target:', Math.round(target));

  const coverage = async () => page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return 0;
    let cov = 0;
    for (let i = 0; i < v.buffered.length; i++) cov += v.buffered.end(i) - v.buffered.start(i);
    return cov;
  }).catch(() => 0);

  let lastCov = -1, stale = 0;
  for (let t = 0; t < target; t += 15) {
    await page.evaluate((tt) => { const v = document.querySelector('video'); if (v) { try { v.currentTime = tt; } catch (e) {} } }, t).catch(() => {});
    for (let w = 0; w < 24; w++) {
      await sleep(1000);
      if (await coverage() >= Math.min(t + 14, target - 1)) break;
    }
    const covNow = await coverage();
    if (Math.abs(covNow - lastCov) < 0.5) { if (++stale >= 8) { console.log('no progress at t=' + t + ', stop'); break; } } else stale = 0;
    lastCov = covNow;
    if (t % 120 === 0) console.log('t=' + t, 'cov=' + Math.round(covNow) + 's', 'appends=' + appends, [...streams.entries()].map(([k, s]) => k + ':' + (s.bytes / 1048576).toFixed(1) + 'MB').join(' '));
  }
  await sleep(5000);
  await browser.close();
  for (const s of streams.values()) await new Promise(r => s.ws.end(r));
  server.close();
  console.log('streams:', [...streams.entries()].map(([k, s]) => k + ' ' + (s.bytes / 1048576).toFixed(2) + 'MB').join(' | '));

  const vids = [...streams.entries()].filter(([k]) => k.startsWith('video'));
  const auds = [...streams.entries()].filter(([k]) => k.startsWith('audio'));
  if (!vids.length) { console.error('NO VIDEO STREAM'); process.exit(4); }
  if (auds.length) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', vids[0][1].path, '-i', auds[0][1].path, '-c', 'copy', OUT]);
  } else {
    fs.copyFileSync(vids[0][1].path, OUT);
  }
  const sz = fs.statSync(OUT).size;
  console.log('DONE ->', OUT, (sz / 1048576).toFixed(2) + 'MB');
  if (sz < 100000) { console.error('output suspiciously small'); process.exit(5); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
