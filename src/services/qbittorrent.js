import { config } from '../config.js';

const { baseUrl, apiKey, username, password } = config.qb;
// qB 5.x 起会话 cookie 名带端口前缀（如 QBT_SID_8081），登录成功返回 204 无 body，
// 因此不能用固定 "SID" 或 body === "Ok." 判断，改为解析 set-cookie。
let sidCookie = null;

async function login() {
  const res = await fetch(`${baseUrl}/api/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: baseUrl,
      Origin: baseUrl,
    },
    body: new URLSearchParams({ username, password }),
  });
  const text = (await res.text()).trim();
  const cookie = (res.headers.get('set-cookie') || '').match(/^([^=]+)=([^;]+)/);
  if (!res.ok || !cookie || (text && text !== 'Ok.')) {
    throw new Error(`qB login failed: ${res.status} ${text}`);
  }
  sidCookie = `${cookie[1]}=${cookie[2]}`;
}

async function authHeaders(extra = {}) {
  if (apiKey) return { Authorization: `Bearer ${apiKey}`, ...extra };
  if (!sidCookie) await login();
  return { Cookie: sidCookie, ...extra };
}

async function request(path, { method = 'GET', body, headers = {}, retry = true } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: await authHeaders(headers),
    body,
  });
  if ((res.status === 401 || res.status === 403) && retry && !apiKey) {
    sidCookie = null;
    return request(path, { method, body, headers, retry: false });
  }
  return res;
}

export async function getVersion() {
  const res = await request('/api/v2/app/version');
  if (!res.ok) throw new Error(`qB version failed: ${res.status}`);
  return (await res.text()).trim();
}

export async function addTorrent({ urls, savePath, category, tags, paused = false, skipChecking = false }) {
  const form = new FormData();
  form.append('urls', Array.isArray(urls) ? urls.join('\n') : urls);
  if (savePath) form.append('savepath', savePath);
  if (category) form.append('category', category);
  if (tags) form.append('tags', Array.isArray(tags) ? tags.join(',') : tags);
  // qB 5.0 起把 add 的 "paused" 改名为 "stopped"，同时传两者以兼容 4.x/5.x。
  form.append('paused', paused ? 'true' : 'false');
  form.append('stopped', paused ? 'true' : 'false');
  if (skipChecking) form.append('skip_checking', 'true');

  const res = await request('/api/v2/torrents/add', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!res.ok || text === 'Fails.') throw new Error(`qB add failed: ${res.status} ${text}`);
  return text || 'Ok.';
}

export async function listTorrents({ filter = 'all', category = '', hashes = null } = {}) {
  const qs = new URLSearchParams({ filter });
  if (category) qs.set('category', category);
  if (hashes) qs.set('hashes', Array.isArray(hashes) ? hashes.join('|') : hashes);
  const res = await request(`/api/v2/torrents/info?${qs.toString()}`);
  if (!res.ok) throw new Error(`qB list failed: ${res.status}`);
  return res.json();
}

function hashForm(hashes) {
  const form = new FormData();
  form.append('hashes', Array.isArray(hashes) ? hashes.join('|') : hashes);
  return form;
}

export async function stopTorrents(hashes) {
  const res = await request('/api/v2/torrents/stop', { method: 'POST', body: hashForm(hashes) });
  if (!res.ok) throw new Error(`qB stop failed: ${res.status}`);
}

export async function startTorrents(hashes) {
  const res = await request('/api/v2/torrents/start', { method: 'POST', body: hashForm(hashes) });
  if (!res.ok) throw new Error(`qB start failed: ${res.status}`);
}

export async function deleteTorrents(hashes, { deleteFiles = false } = {}) {
  const form = hashForm(hashes);
  form.append('deleteFiles', deleteFiles ? 'true' : 'false');
  const res = await request('/api/v2/torrents/delete', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`qB delete failed: ${res.status}`);
}

export async function setCategory(hashes, category) {
  const form = hashForm(hashes);
  form.append('category', category ?? '');
  const res = await request('/api/v2/torrents/setCategory', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`qB setCategory failed: ${res.status}`);
}
