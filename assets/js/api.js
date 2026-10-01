// 公开 API 客户端（探针主题仅使用公开端点，不调用任何管理端接口）：
//   GET /api/config        站点配置（含 Turnstile 状态、theme_options）
//   GET /api/servers       服务器列表 + 聚合统计
//   GET /api/server?id=    单台服务器详情
//   GET /api/history/all   历史指标
//
// 说明：
// - 若浏览器 localStorage 中存在管理端登录过的 token，会附带 Authorization 头，
//   用于解锁 1 小时以上的历史查询；主题本身不提供登录功能。
// - 站点开启 Turnstile 时，先完成人机验证换取 turnstile_verified 凭证再请求数据。

import {el, syncServerTime} from './utils.js?v=1.3.1';

const API_BASE = (window.__API_BASE__ || '').replace(/\/$/, '');
const CRED_KEY = 'probe_ts_cred';

// 用响应的 Date 头校准服务器时钟（精度 1s，取区间中点 +500ms 减少系统性低估）
function anchorClock(res) {
  const d = res.headers.get('date');
  if (!d) return;
  const t = Date.parse(d);
  if (!Number.isNaN(t)) syncServerTime(t + 500);
}

let _config = null;
let _turnstileCred = loadCred();
let _tsScriptPromise = null;
let _tsVerifyPromise = null;

function loadCred() {
  try {
    const raw = localStorage.getItem(CRED_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    // 凭证有效期 1 小时，本地按 55 分钟保守复用
    if (!obj.value || Date.now() - obj.savedAt > 55 * 60 * 1000) {
      localStorage.removeItem(CRED_KEY);
      return null;
    }
    return obj.value;
  } catch {
    return null;
  }
}

function saveCred(value) {
  _turnstileCred = value;
  try {
    localStorage.setItem(CRED_KEY, JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}

function clearCred() {
  _turnstileCred = null;
  try {
    localStorage.removeItem(CRED_KEY);
  } catch {
    /* ignore */
  }
}

// 管理端登录的 JWT 存储键（与官方默认主题一致：jwt_token；token 为旧键兜底）
export function getAuthToken() {
  try {
    return localStorage.getItem('jwt_token') || localStorage.getItem('token');
  } catch {
    return null;
  }
}

function authHeaders() {
  const headers = {};
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (_turnstileCred) headers['X-Turnstile-Verified'] = _turnstileCred;
  return headers;
}

async function toError(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  const err = new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  err.status = res.status;
  err.data = data;
  return err;
}

async function request(path, { retryOnTurnstile = true } = {}) {
  const res = await fetch(API_BASE + path, { headers: authHeaders() });
  anchorClock(res);
  if (res.status === 403 && retryOnTurnstile && _config && _config.turnstile_enabled) {
    clearCred();
    await ensureTurnstile();
    return request(path, { retryOnTurnstile: false });
  }
  if (!res.ok) throw await toError(res);
  return res.json();
}

// ---------- Turnstile 人机验证 ----------

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (_tsScriptPromise) return _tsScriptPromise;
  _tsScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('人机验证组件加载失败，请检查网络或 CSP 配置'));
    document.head.append(s);
  });
  return _tsScriptPromise;
}

async function exchangeTurnstile(token) {
  const headers = { 'X-Turnstile-Token': token };
  const jwt = getAuthToken();
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(`${API_BASE}/api/config`, { headers });
  anchorClock(res);
  if (!res.ok) throw await toError(res);
  const data = await res.json();
  _config = data;
  if (data.turnstile_verified) saveCred(data.turnstile_verified);
}

export function ensureTurnstile() {
  if (_turnstileCred) return Promise.resolve();
  if (_tsVerifyPromise) return _tsVerifyPromise;

  _tsVerifyPromise = (async () => {
    const siteKey = _config && _config.turnstile_site_key;
    if (!siteKey) throw new Error('站点未配置 Turnstile site key');
    await loadTurnstileScript();

    await new Promise((resolve, reject) => {
      const holder = el('div', { class: 'ts-holder' });
      const errBox = el('p', { class: 'probe-dialog-err' });
      const overlay = el(
        'div',
        { class: 'probe-overlay' },
        el(
          'div',
          { class: 'probe-dialog' },
          el('div', { class: 'probe-dialog-title', text: '安全验证' }),
          el('p', {
            class: 'probe-dialog-desc',
            text: '站点已开启人机验证，完成验证后即可浏览监控数据。',
          }),
          holder,
          errBox,
        ),
      );
      (document.getElementById('overlay-root') || document.body).append(overlay);
      const cleanup = () => overlay.remove();

      try {
        window.turnstile.render(holder, {
          sitekey: siteKey,
          theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
          callback: async (token) => {
            try {
              await exchangeTurnstile(token);
              cleanup();
              resolve();
            } catch {
              errBox.textContent = '验证失败，请重试';
              try {
                window.turnstile.reset();
              } catch {
                /* ignore */
              }
            }
          },
          'error-callback': () => {
            errBox.textContent = '验证组件出错，请刷新页面重试';
          },
          'expired-callback': () => {
            try {
              window.turnstile.reset();
            } catch {
              /* ignore */
            }
          },
        });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  })().finally(() => {
    _tsVerifyPromise = null;
  });

  return _tsVerifyPromise;
}

// ---------- 公开端点 ----------

export async function getConfig(force = false) {
  if (_config && !force) return _config;
  const res = await fetch(`${API_BASE}/api/config`, { headers: authHeaders() });
  anchorClock(res);
  if (!res.ok) throw await toError(res);
  _config = await res.json();
  if (_config.turnstile_enabled && !_config.verified) {
    await ensureTurnstile();
  }
  return _config;
}

export function getServers() {
  return request('/api/servers');
}

export function getServer(id) {
  return request(`/api/server?id=${encodeURIComponent(id)}`);
}

export function getHistory(id, hours) {
  return request(`/api/history/all?id=${encodeURIComponent(id)}&hours=${hours}`);
}

// 主题配置保存（2.8.4 Beta10+）：整体替换 theme_options，
// 调用方需先合并已有配置再提交，避免覆盖其他键
export async function saveThemeOptions(themeOptions) {
  const res = await fetch(`${API_BASE}/api/theme_options`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_options: themeOptions }),
  });
  anchorClock(res);
  if (!res.ok) throw await toError(res);
  return res.json();
}

