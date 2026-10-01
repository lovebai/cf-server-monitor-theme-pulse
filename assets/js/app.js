// Pulse 主题 · 应用入口
// 职责：配色模式、站点配置加载、顶栏/页脚、hash 路由（#/ 与 #/server/:id）
//
// 支持的主题自定义项（管理端「主题设置」theme_options，均为可选）：
//   accent: "#2dd4bf"   主题强调色
//   mode:   "dark" | "light"   默认配色模式（用户手动切换后优先用户选择）
//   sectionMark: false          关闭小标题（分组标题 / 趋势标题）前的 "//" 装饰

const THEME_VERSION = 'v1.3.1';

import {el, fmtClock, serverNow, stateBlock, svg, toast} from './utils.js?v=1.3.1';
import {getAuthToken, getConfig, saveThemeOptions} from './api.js?v=1.3.1';
import {renderHome} from './views/home.js?v=1.3.1';
import {renderDetail} from './views/detail.js?v=1.3.1';

const html = document.documentElement;
const THEME_KEY = 'probe_color_mode';

// ---------- 配色模式（尽早应用，避免闪烁） ----------

function initialColorMode() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  if (saved === 'light' || saved === 'dark') return saved;
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  return 'dark';
}
html.dataset.theme = initialColorMode();

// 站点配置了背景图时（worker 会向 body 注入背景），卡片切换为磨砂半透明。
// iOS 下 worker 改用 body::after 承载背景图，两处都要探测
function detectBgImage() {
  const bodyBg = getComputedStyle(document.body).backgroundImage;
  const afterBg = getComputedStyle(document.body, '::after').backgroundImage;
  if (bodyBg !== 'none' || afterBg !== 'none') html.dataset.bg = 'image';
}
detectBgImage();

// ---------- 全局上下文 ----------

const ctx = {
  config: null,
  setWsState: () => {},
  refresh: () => route(),
};

let currentView = null;
let routed = false;

async function route() {
  if (currentView && currentView.destroy) currentView.destroy();
  currentView = null;
  const main = document.getElementById('main');
  main.textContent = '';
  const m = location.hash.match(/^#\/server\/(.+)$/);
  if (m) currentView = await renderDetail(main, ctx, decodeURIComponent(m[1]));
  else currentView = await renderHome(main, ctx);
  window.scrollTo(0, 0);
}

// ---------- 图标 ----------

function sunIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' },
    svg('circle', { cx: '12', cy: '12', r: '4.2' }),
    svg('path', { d: 'M12 2.5v2.4M12 19.1v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.5 12h2.4M19.1 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7' }),
  );
}

function moonIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    svg('path', { d: 'M20.4 14.2A8.5 8.5 0 1 1 9.8 3.6a7 7 0 1 0 10.6 10.6Z' }),
  );
}

function gearIcon() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    svg('path', { d: 'M4 8h9M19 8h1M4 16h1M9 16h11' }),
    svg('circle', { cx: '16', cy: '8', r: '2.4' }),
    svg('circle', { cx: '6', cy: '16', r: '2.4' }),
  );
}

// ---------- 主题设置弹窗（仅管理员可见） ----------

function openSettingsDialog() {
  const current = (ctx.config && ctx.config.theme_options) || {};
  let showMark = current.sectionMark !== false;

  const btnShow = el('button', { class: 'seg-btn', text: '展示' });
  const btnHide = el('button', { class: 'seg-btn', text: '关闭' });
  const syncSeg = () => {
    btnShow.classList.toggle('active', showMark);
    btnHide.classList.toggle('active', !showMark);
  };
  btnShow.addEventListener('click', () => { showMark = true; syncSeg(); });
  btnHide.addEventListener('click', () => { showMark = false; syncSeg(); });
  syncSeg();

  const errBox = el('p', { class: 'probe-dialog-err' });
  const saveBtn = el('button', { class: 'btn', text: '保存' });
  const close = () => overlay.remove();
  const overlay = el(
    'div',
    { class: 'probe-overlay' },
    el(
      'div',
      { class: 'probe-dialog', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'probe-dialog-title', text: '主题设置' }),
      el(
        'div',
        { class: 'setting-row' },
        el('span', { class: 'setting-label', text: '小标题图标' }),
        el('div', { class: 'seg' }, btnShow, btnHide),
      ),
      errBox,
      el(
        'div',
        { class: 'probe-dialog-actions' },
        el('button', { class: 'btn btn-ghost', onClick: close }, '取消'),
        saveBtn,
      ),
    ),
  );
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    errBox.textContent = '';
    try {
      // 接口整体替换 theme_options，先合并已有配置避免覆盖 accent/mode 等键
      const merged = { ...current, sectionMark: showMark };
      const res = await saveThemeOptions(merged);
      ctx.config.theme_options = (res && res.theme_options) || merged;
      applyThemeOptions(ctx.config.theme_options);
      toast('主题设置已保存');
      close();
    } catch (err) {
      errBox.textContent = err.status === 401
        ? '登录已过期，请重新登录后再保存'
        : err.message || '保存失败，请稍后重试';
    } finally {
      saveBtn.disabled = false;
    }
  });

  (document.getElementById('overlay-root') || document.body).append(overlay);
}

// ---------- 顶栏 / 页脚 ----------

function renderHeader(config) {
  const header = document.getElementById('site-header');
  header.textContent = '';

  const brand = el(
    'a',
    { class: 'brand', href: '#/' },
    el('span', { class: 'pulse-logo' }),
    el(
      'span',
      { class: 'brand-text' },
      el('span', { class: 'brand-title', text: config.site_title || 'Server Monitor' }),
    ),
  );
  brand.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '';
  });

  // WebSocket 状态指示
  const pillText = el('span', { class: 'ws-pill-text', text: '未连接' });
  const pill = el('span', { class: 'ws-pill' }, el('i', { class: 'pill-dot' }), pillText);
  ctx.setWsState = (s) => {
    pill.className = `ws-pill ${s === 'open' ? 'on' : s === 'connecting' ? 'mid' : 'off'}`;
    pillText.textContent = s === 'open' ? '实时' : s === 'connecting' ? '连接中' : '断开';
  };

  // 深浅色切换
  const toggle = el('button', { class: 'icon-btn', title: '切换深色 / 浅色', 'aria-label': '切换配色模式' });
  const syncIcon = () => {
    toggle.textContent = '';
    toggle.append(html.dataset.theme === 'light' ? moonIcon() : sunIcon());
  };
  toggle.addEventListener('click', () => {
    html.dataset.theme = html.dataset.theme === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, html.dataset.theme);
    } catch {
      /* ignore */
    }
    syncIcon();
  });
  syncIcon();

  const clock = el('span', { class: 'clock mono' });
  const tick = () => {
    clock.textContent = fmtClock(serverNow());
  };
  tick();
  setInterval(tick, 1000);

  // 主题设置入口：仅管理端 JWT 存在时可见（主题本身无登录功能）
  const right = [pill, toggle];
  if (getAuthToken()) {
    const settingsBtn = el('button', {
      class: 'icon-btn',
      title: '主题设置',
      'aria-label': '主题设置',
      onClick: () => openSettingsDialog(),
    });
    settingsBtn.append(gearIcon());
    right.push(settingsBtn);
  }
  right.push(clock);

  header.append(brand, el('div', { class: 'header-right' }, right));
}

function renderFooter(config) {
  const footer = document.getElementById('site-footer');
  footer.textContent = '';
  footer.append(
    el('a', {
      class: 'f-brand',
      href: 'https://github.com/huilang-me/CF-Server-Monitor',
      target: '_blank',
      rel: 'noopener',
      text: 'CF-Server-Monitor',
    }),
    el('span', { text: ` ${config.version || ''} · ` }),
    el('a', {
      class: 'f-brand',
      href: 'https://github.com/lovebai/cf-server-monitor-theme-pulse',
      target: '_blank',
      rel: 'noopener',
      text: 'Pulse-fork',
    }),
    el('span', { text: ` ${THEME_VERSION}` }),
  );
}

// ---------- 主题自定义项 ----------

function applyThemeOptions(options) {
  if (!options || typeof options !== 'object') return;
  if (typeof options.accent === 'string' && /^#[0-9a-f]{3,8}$/i.test(options.accent)) {
    html.style.setProperty('--accent', options.accent);
  }
  // 未手动选择过配色时，遵循主题配置的默认模式
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* ignore */
  }
  if (!saved && (options.mode === 'light' || options.mode === 'dark')) {
    html.dataset.theme = options.mode;
  }
  // 小标题 "//" 装饰开关（默认展示）
  if (options.sectionMark === false) html.dataset.sectionMark = 'off';
  else delete html.dataset.sectionMark;
}

// ---------- 启动 ----------

async function boot() {
  const main = document.getElementById('main');
  try {
    const config = await getConfig();
    ctx.config = config;
    if (config.site_title) document.title = config.site_title;
    applyThemeOptions(config.theme_options);
    renderHeader(config);
    renderFooter(config);
    if (!routed) {
      routed = true;
      window.addEventListener('hashchange', route);
    }
    await route();
  } catch (err) {
    main.textContent = '';
    main.append(
      stateBlock({
        icon: 'err',
        title: '初始化失败',
        desc: err.message || '无法获取站点配置',
        actionText: '重试',
        onAction: () => window.location.reload(),
      }),
    );
  }
}

boot();

