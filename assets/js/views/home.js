// 首页视图：全局统计 + 分组服务器卡片（条形 / 圆环 / 表格三种模式）
// 数据来源：GET /api/servers；实时更新：/api/ws (subscribe=all)

import {
  avgPing,
  billingText,
  daysUntil,
  debounce,
  el,
  flagImg,
  fmtBytes,
  fmtClock,
  fmtCount,
  fmtMB,
  fmtSpeed,
  fmtTimeShort,
  fmtUptime,
  icon,
  ipReachable,
  isOnline,
  normalizeWsTimeoutMinutes,
  num,
  osIconImg,
  osName,
  parseTrafficLimit,
  pct,
  pingClass,
  pingState,
  priceText,
  serverNow,
  shortOS,
  stateBlock,
  svg,
  timeAgo,
  updateFlagImg,
  updateOsIconImg,
  wsTimeoutDialog,
} from '../utils.js?v=1.3.1';
import {getServers} from '../api.js?v=1.3.1';
import {Playback, normalizeTs} from '../playback.js?v=1.3.1';
import {MetricSocket} from '../ws.js?v=1.3.1';

const MODE_LABELS = { bar: '条形', ring: '圆环', table: '表格' };

function levelClass(p) {
  if (p == null) return '';
  return p >= 90 ? ' lv-bad' : p >= 70 ? ' lv-warn' : '';
}

/** 字节数 → 整数 + 单字母单位（600G / 1T），用于流量包 chip */
function fmtLimitInt(bytes) {
  const units = ['B', 'K', 'M', 'G', 'T', 'P'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Math.round(v)}${units[i]}`;
}

function arrowIcon(dir) {
  // 两个箭头在画布里垂直居中对称（5..19），并排时不会一高一低
  const d =
    dir === 'down' ? 'M12 5v14m0 0-5-5m5 5 5-5' : 'M12 19V5m0 0-5 5m5-5 5 5';
  return svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: `ico ${dir === 'down' ? 'ico-down' : 'ico-up'}`,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    svg('path', { d }),
  );
}

// ---------- 条形卡片 ----------

function meterRow(label) {
  const fill = el('i', { class: 'meter-fill' });
  const val = el('span', { class: 'meter-val mono', text: '—' });
  const row = el(
    'div',
    { class: 'meter-row' },
    el('div', { class: 'meter-top' }, el('span', { class: 'meter-label', text: label }), val),
    el('div', { class: 'meter-bar' }, fill),
  );
  return {
    el: row,
    set(p, text) {
      fill.style.width = `${p == null ? 0 : Math.min(100, p)}%`;
      fill.className = `meter-fill${levelClass(p)}`;
      val.textContent = text != null ? text : p == null ? '—' : `${p.toFixed(0)}%`;
    },
  };
}

// 实时时间行（对齐官方 dataTimeText）
// 单条上报：(+Ns) = 当前全局时间 − 采集时间，随时间增长，下一样本应用时回落
// 批量上报：上报仅时钟，采集时钟 + (+Ns)，lag = display_ts - sample_ts
// 返回 [上报文本, 采集文本, lag 文本]；单条上报时上报为 null，采集位放合并文本；
// lag 文本独立返回，便于用固定宽度占位（避免位数变化导致布局抖动）
function liveParts(d) {
  if (!isOnline(d) || !d.sample_ts) return null;
  if (!d.report_ts || d.batch_size === 1) {
    // 单条上报：lag = 当前全局时间 − 采集时间；不足 1s（相等）不展示
    const lag = Math.max(0, Math.floor((serverNow() - d.sample_ts) / 1000));
    return [null, `上报 ${fmtClock(d.sample_ts)}`, lag > 0 ? `(+${lag}s)` : ''];
  }
  // 批量上报：上报仅时钟，采集带 lag
  const lag = d.display_ts
    ? Math.max(0, Math.floor((d.display_ts - d.sample_ts) / 1000))
    : 0;
  return [`上报 ${fmtClock(d.report_ts)}`, `采集 ${fmtClock(d.sample_ts)}`, lag > 0 ? `(+${lag}s)` : ''];
}

function fillLive(node, d) {
  node.textContent = '';
  const parts = liveParts(d);
  if (parts) {
    node.append(el('div', { class: 'live-row', text: parts.filter(Boolean).join(' · ') }));
    node.style.visibility = 'visible';
  } else {
    node.style.visibility = 'hidden';
  }
}

// 剩余价值 = 价格 × min(剩余天数, 周期天数) / 周期天数
// 需要价格 > 0 且有到期日；已过期返回 'expired'，无法计算返回 null
const CYCLE_DAYS = {
  month: 30,
  quarter: 91,
  half_year: 182,
  year: 365,
  two_years: 730,
  three_years: 1095,
  four_years: 1460,
  five_years: 1825,
};

// 货币符号 → ISO 代码（$ 默认美元；C$/A$/HK$/NT$ 等区分开；别名参考官方 finance.js）
const SYMBOL_TO_ISO = {
  '¥': 'cny',
  '￥': 'cny',
  RMB: 'cny',
  $: 'usd',
  US$: 'usd',
  'C$': 'cad',
  'CA$': 'cad',
  'A$': 'aud',
  'AU$': 'aud',
  'NZ$': 'nzd',
  'HK$': 'hkd',
  'NT$': 'twd',
  'S$': 'sgd',
  '€': 'eur',
  '£': 'gbp',
  '₽': 'rub',
  '₣': 'chf',
  '₹': 'inr',
  '₫': 'vnd',
  '฿': 'thb',
  '₩': 'krw',
  'JP¥': 'jpy',
  '¥JPY': 'jpy',
  '₱': 'php',
  RM: 'myr',
  '₺': 'try',
  '₪': 'ils',
  'R$': 'brl',
  'zł': 'pln',
  'ZŁ': 'pln',
  '₴': 'uah',
  '₦': 'ngn',
  '₮': 'mnt',
  '৳': 'bdt',
  '₨': 'pkr',
  '₸': 'kzt',
};

// ISO → 人民币汇率的静态兜底值（在线汇率优先，见 loadFxRates）
const FALLBACK_RATES = {
  cny: 1, usd: 7.2, eur: 7.8, gbp: 9.1, rub: 0.08, chf: 8.0,
  inr: 0.086, vnd: 0.00028, thb: 0.2, cad: 5.1, aud: 4.7, hkd: 0.92,
  twd: 0.23, sgd: 5.3, jpy: 0.048, krw: 0.0052, nzd: 4.3,
};

const FX_CACHE_KEY = 'pulse_fx_rates';
// 与官方一致的双源：frankfurter.dev → open.er-api.com（均为 1 CNY = rate 外币）
const FX_APIS = [
  'https://api.frankfurter.dev/v1/latest?base=CNY',
  'https://open.er-api.com/v6/latest/CNY',
];

let fxRates = FALLBACK_RATES;

/** 货币符号或 ISO 代码 → 人民币汇率 */
function curRate(currency) {
  const s = String(currency || '').trim();
  const iso = SYMBOL_TO_ISO[s] || SYMBOL_TO_ISO[s.toUpperCase()] || s.toLowerCase();
  return fxRates[iso] ?? FALLBACK_RATES[iso] ?? 1;
}

async function fetchFxFromCny() {
  for (const url of FX_APIS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const rates = (await res.json())?.rates;
      if (rates && typeof rates.USD === 'number') return rates;
    } catch {
      /* 尝试下一个源 */
    }
  }
  return null;
}

// 拉取每日汇率：localStorage 缓存 24h；拉取失败时依次用过期缓存、静态兜底值
async function loadFxRates() {
  let cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(FX_CACHE_KEY) || 'null');
  } catch {
    /* 缓存损坏则重新拉取 */
  }
  if (cached && cached.rates && Date.now() - cached.ts < 86_400_000) {
    fxRates = cached.rates;
    return;
  }
  const fromCny = await fetchFxFromCny();
  if (fromCny) {
    const rates = { cny: 1 };
    for (const [code, r] of Object.entries(fromCny)) {
      if (typeof r === 'number' && r > 0) rates[code.toLowerCase()] = 1 / r;
    }
    fxRates = rates;
    try {
      localStorage.setItem(FX_CACHE_KEY, JSON.stringify({ ts: Date.now(), rates }));
    } catch {
      /* 存储失败不影响使用 */
    }
  } else if (cached && cached.rates) {
    fxRates = cached.rates; // 过期缓存兜底
  }
}

function remainingValue(d) {
  const price = parseFloat(d.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const days = daysUntil(d.expire_date);
  if (days == null) return null;
  if (days < 0) return 'expired';
  const cycle = CYCLE_DAYS[d.billing_cycle] || 30;
  return (price * Math.min(days, cycle)) / cycle;
}

// meta 行：单行 marquee——内容超出时克隆一份，整体左移 -50% 无缝循环
function marqueeRow(items) {
  const clone = el('span', { class: 'mq-inner', 'aria-hidden': 'true' });
  clone.style.display = 'none';
  const inner = el('span', { class: 'mq-inner' }, ...items);
  const track = el('span', { class: 'mq-track' }, inner, clone);
  const row = el('div', { class: 'mq-row' }, track);
  return {
    el: row,
    fit() {
      if (!row.clientWidth) return; // 未入 DOM / 隐藏时跳过，下个 tick 再测
      const need = inner.scrollWidth > row.clientWidth;
      row.classList.toggle('marquee', need);
      clone.style.display = need ? '' : 'none';
      if (need) {
        clone.innerHTML = inner.innerHTML;
        track.style.animationDuration = `${Math.max(6, inner.scrollWidth / 40)}s`;
      }
    },
  };
}

// 卡片底部行三项：[在线 时长] [上报] [采集(+Ns)]（左中右）
// lag 独立 span 固定占位，(+Ns) 出现/消失/位数变化都不会推动布局；
// 离线时采集项 visibility 隐藏（保留占位），上报项 display 隐藏
function setLive(repEl, smpWrap, smpText, lagEl, d) {
  const parts = liveParts(d);
  repEl.textContent = parts && parts[0] ? parts[0] : '';
  repEl.style.display = parts && parts[0] ? '' : 'none';
  const has = !!(parts && parts[1]);
  smpText.nodeValue = has ? parts[1] : '';
  lagEl.textContent = has ? parts[2] : '';
  smpWrap.style.visibility = has ? '' : 'hidden';
}

// 负载显示：1m/5m/15m 分钟标签 + 值 + 按核心数颜色分级
function loadDisplay() {
  const items = ['1m', '5m', '15m'].map((lb) => {
    const v = el('span', { class: 'ld-val mono', text: '—' });
    const item = el('span', { class: 'ld-item' }, el('span', { class: 'ld-lb', text: lb }), v);
    return { item, v };
  });
  const box = el('span', { class: 'load-box' }, items.map((i) => i.item));
  return {
    el: box,
    update(d) {
      const parts = String(d.load_avg || '').trim().split(/\s+/).map(Number);
      const cores = num(d.cpu_cores) || 0;
      for (let i = 0; i < 3; i += 1) {
        const v = Number.isFinite(parts[i]) ? parts[i] : null;
        const valEl = items[i].v;
        valEl.textContent = v == null ? '—' : v.toFixed(2);
        // 按 load/cores 比值分级：<0.7 绿 / <1.0 黄 / ≥1.0 红
        let cls = '';
        if (v != null && cores > 0) {
          const ratio = v / cores;
          cls = ratio >= 1.0 ? 'bad' : ratio >= 0.7 ? 'mid' : 'good';
        } else if (v != null) {
          cls = v >= 2 ? 'bad' : v >= 1 ? 'mid' : 'good';
        }
        valEl.className = `ld-val mono${cls ? ` ${cls}` : ''}`;
      }
    },
  };
}

// Ping 分项（对齐官方 ping-panel）
const PING_CARRIERS = [
  { key: 'ct', label: '电信' },
  { key: 'cu', label: '联通' },
  { key: 'cm', label: '移动' },
  { key: 'bd', label: 'BGP' },
];

// ---------- 三网详情面板（站点开关 show_three_net_details，对齐官方 2.8.4） ----------
// 数据：server.ping / server.loss 时序数组 [{ts, ct, cu, cm, bd}]（ts 秒/毫秒兼容），
// 初始由后端窗口缓存下发，实时样本到达时在本地追加。
// 布局：2×2 四宫格（电信/联通/移动/BGP），每格只画丢包率桶条；
// 行头 左侧名称、右侧实时延迟，tooltip 合并展示 时间 · 延迟 · 丢包率。

const TN_CARRIERS = PING_CARRIERS;
// 窗口参数：2.8.4 Beta9+ 由 /api/config 的 latency_window {points, hours} 下发
// （renderHome 入口处 applyLatencyWindow 应用）；缺省对齐 Beta8 的 20 点 × 1 小时
let TN_BUCKETS = 20;
let TN_BUCKET_MS = 3 * 60 * 1000;

function applyLatencyWindow(config) {
  const w = config && config.latency_window;
  if (!w) return;
  const points = Math.floor(Number(w.points));
  const hours = Number(w.hours);
  if (Number.isInteger(points) && points > 0 && Number.isFinite(hours) && hours > 0) {
    TN_BUCKETS = points;
    TN_BUCKET_MS = Math.max(10_000, Math.round((hours * 3_600_000) / points));
  }
}
// 条带三级色：绿(正常) → 黄(关注) → 红(异常)
const TN_STRIP_COLORS = ['var(--ok)', 'var(--warn)', 'var(--bad)'];
// 延迟三档（好/低并档为绿）：用于历史点与当前点的等级比较
const tnPingLevel = (v) => (pingClass(v) === 'bad' ? 2 : pingClass(v) === 'mid' ? 1 : 0);
// 丢包三档：0% 绿 / <20% 黄 / ≥20% 红
const tnLossLevel = (v) => (v <= 0 ? 0 : v < 20 ? 1 : 2);

/** 提取某运营商的时序：过滤非法点、统一 ts 为毫秒、按时间排序 */
function tnSeries(d, name, key) {
  const src = Array.isArray(d[name]) ? d[name] : [];
  const out = [];
  for (const p of src) {
    if (!p || typeof p !== 'object') continue;
    let ts = Number(p.ts ?? p.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < 10_000_000_000) ts *= 1000;
    out.push({ ts, value: num(p[key]) });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function hasTnSeries(d) {
  return TN_CARRIERS.some(
    (c) => tnSeries(d, 'ping', c.key).length || tnSeries(d, 'loss', c.key).length,
  );
}

/** 实时样本应用到卡片数据后，把 ping/loss 采样点并入时序（保持最近 TN_BUCKETS 点）。
 *  桶宽 = 窗口小时数 × 1h / 点数（Beta9 为 2h/20 = 6 分钟），ts 向下取整进桶，
 *  同桶覆盖、新桶追加——条带密度与后端抽样窗口一致 */

function appendLatencyPoints(d, ts, data) {
  if (!ts) return;
  const bucketTs = Math.floor(ts / TN_BUCKET_MS) * TN_BUCKET_MS;
  for (const name of ['ping', 'loss']) {
    const point = { ts: bucketTs };
    let has = false;
    for (const c of ['ct', 'cu', 'cm', 'bd']) {
      const v = num(data[`${name}_${c}`]);
      if (v != null) {
        point[c] = v;
        has = true;
      }
    }
    if (!has) continue;
    const series = (Array.isArray(d[name]) ? d[name] : []).map((p) => {
      let pts = Number(p && (p.ts ?? p.timestamp));
      if (Number.isFinite(pts) && pts > 0 && pts < 10_000_000_000) pts *= 1000;
      return { ...p, ts: pts };
    });
    const existing = series.findIndex((p) => p.ts === bucketTs);
    if (existing >= 0) series[existing] = { ...series[existing], ...point };
    else series.push(point);
    series.sort((a, b) => a.ts - b.ts);
    d[name] = series.slice(-TN_BUCKETS);
  }
}

const trimFixed = (v, digits = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
};

// 悬浮 tooltip：挂 body、fixed 定位——卡片 overflow:hidden 会裁剪 CSS 伪元素浮层
let tnTip = null;

function getTnTip() {
  if (!tnTip) {
    tnTip = el('div', { class: 'tn-tip', role: 'tooltip' });
    tnTip.style.display = 'none';
    document.body.append(tnTip);
  }
  return tnTip;
}

function showTnTip(bucket) {
  const text = bucket.getAttribute('data-tooltip');
  if (!text) return;
  const tip = getTnTip();
  tip.textContent = text;
  tip.style.display = '';
  const r = bucket.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  // 水平居中于桶，压到视口内；卡片顶部放不下时翻转到桶下方
  const x = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
  let y = r.top - th - 8;
  if (y < 8) y = r.bottom + 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function hideTnTip() {
  if (tnTip) tnTip.style.display = 'none';
}

function threeNetPanel() {
  // 2×2 四宫格：每格一个运营商，只画丢包率桶条；
  // 行头左侧名称、右侧实时延迟+丢包（语意同 pingPanel，取实时标量字段）；
  // tooltip 合并展示 时间 · 延迟 · 丢包率
  const cells = TN_CARRIERS.map((c) => {
    const pingVal = el('b', { class: 'tn-val mono', text: '—' });
    const head = el(
      'div',
      { class: 'tn-head' },
      el('span', { class: 'tn-name', text: c.label }),
      el('span', { class: 'tn-vals' }, pingVal),
    );
    const fills = Array.from({ length: TN_BUCKETS }, () => {
      const fill = el('i', { class: 'tn-fill' });
      const bucket = el('span', { class: 'tn-bucket' }, fill);
      bucket.addEventListener('mouseenter', () => showTnTip(bucket));
      bucket.addEventListener('mouseleave', hideTnTip);
      return { bucket, fill };
    });
    const buckets = el('div', { class: 'tn-buckets' }, fills.map((f) => f.bucket));
    const cell = el('div', { class: 'tn-cell' }, head, buckets);
    return { key: c.key, cell, pingVal, fills, sig: '' };
  });
  const panel = el('div', { class: 'tn-panel' }, cells.map((c) => c.cell));
  panel.style.display = 'none';

  function paintBucket({ bucket, fill }, { color, height, opacity, tooltip }) {
    fill.style.background = color;
    fill.style.height = `${height}%`;
    fill.style.opacity = String(opacity);
    if (tooltip) bucket.setAttribute('data-tooltip', tooltip);
    else bucket.removeAttribute('data-tooltip');
  }

  return {
    el: panel,
    update(d) {
      for (const cell of cells) {
        const pingS = tnSeries(d, 'ping', cell.key);
        const lossS = tnSeries(d, 'loss', cell.key);
        // 行头：实时延迟（同 pingPanel 语意）；禁用该节点的服务器隐藏整格
        const pv = pingState(d[`ping_${cell.key}`]);
        cell.cell.style.display = pv.kind === 'disabled' ? 'none' : '';
        cell.pingVal.textContent = pv.kind === 'ok' ? `${pv.value.toFixed(0)}ms` : '—';
        cell.pingVal.className = `tn-val mono${pv.kind === 'ok' ? ` ${pingClass(pv.value)}` : ''}`;
        // 当前延迟等级：历史点比当前差时，桶色在丢包等级基础上加深一档（绿→黄→红）
        const curLevel = pv.kind === 'ok' ? tnPingLevel(pv.value) : null;
        // 签名：两个序列的最新点 ts；不变则跳过整排桶重绘（每秒 tick 省 DOM 写）
        const sig = `${pingS.length ? pingS[pingS.length - 1].ts : 0}:${lossS.length ? lossS[lossS.length - 1].ts : 0}`;
        if (sig === cell.sig) continue;
        cell.sig = sig;
        // 按 TN_BUCKET_MS 桶位渲染（对齐后端抽样窗口语义）：窗口 = 最新样本所在桶往前 TN_BUCKETS 桶；
        // 点 ts 一律向下取整到桶边界（后端窗口点已对齐，但「最新点」保留原始样本 ts）；
        // 窗口内无点的桶位显示「无样本」，早于首个样本的桶位显示为占位空桶
        const pingByTs = new Map(
          pingS.map((p) => [Math.floor(p.ts / TN_BUCKET_MS) * TN_BUCKET_MS, p]),
        );
        const lossByTs = new Map(
          lossS.map((p) => [Math.floor(p.ts / TN_BUCKET_MS) * TN_BUCKET_MS, p]),
        );
        const allTs = [...pingS, ...lossS].map((p) => p.ts);
        const lastBucket = allTs.length
          ? Math.floor(Math.max(...allTs) / TN_BUCKET_MS) * TN_BUCKET_MS
          : 0;
        const firstBucket = allTs.length
          ? Math.floor(Math.min(...allTs) / TN_BUCKET_MS) * TN_BUCKET_MS
          : 0;
        for (let i = 0; i < TN_BUCKETS; i += 1) {
          if (!lastBucket) {
            paintBucket(cell.fills[i], { color: 'var(--border)', height: 25, opacity: 0.25, tooltip: '' });
            continue;
          }
          const slotTs = lastBucket - (TN_BUCKETS - 1 - i) * TN_BUCKET_MS;
          if (slotTs < firstBucket) {
            paintBucket(cell.fills[i], { color: 'var(--border)', height: 25, opacity: 0.25, tooltip: '' });
            continue;
          }
          const pp = pingByTs.get(slotTs);
          const lp = lossByTs.get(slotTs);
          const hasP = !!(pp && pp.value != null && pp.value >= 0);
          const hasL = !!(lp && lp.value != null);
          const parts = [fmtTimeShort(slotTs)];
          parts.push(hasP ? `${trimFixed(pp.value)} ms` : '无样本');
          if (hasL) parts.push(`丢包 ${trimFixed(lp.value)}%`);
          // 基础色 = 丢包等级（绿/黄/红）；该时间点延迟等级比当前差 → 加深一档（红保持）
          let level = hasL ? tnLossLevel(lp.value) : null;
          if (level != null && hasP && curLevel != null && tnPingLevel(pp.value) > curLevel) {
            level = Math.min(2, level + 1);
          }
          paintBucket(cell.fills[i], {
            color: level == null ? 'var(--border)' : TN_STRIP_COLORS[level],
            height: 84,
            opacity: hasL ? 0.94 : 0.42,
            tooltip: parts.join(' · '),
          });
        }
      }
    },
  };
}

function pingPanel() {
  const items = PING_CARRIERS.map((c) => {
    const val = el('span', { class: 'pp-val mono', text: '—' });
    const item = el('span', { class: 'pp-item' },
      el('span', { class: 'pp-label', text: c.label }),
      val,
    );
    return { ...c, val, item };
  });
  const panel = el('div', { class: 'ping-panel' }, items.map((p) => p.item));
  panel.style.display = 'none';
  return {
    el: panel,
    update(d) {
      let has = false;
      for (const p of items) {
        const pv = pingState(d[`ping_${p.key}`]);
        if (pv.kind === 'disabled') { p.item.style.display = 'none'; continue; }
        p.item.style.display = '';
        if (pv.kind === 'ok') {
          p.val.textContent = `${pv.value.toFixed(0)}ms`;
          p.val.className = `pp-val mono ${pingClass(pv.value)}`;
        } else {
          p.val.textContent = '—';
          p.val.className = 'pp-val mono';
        }
        has = true;
      }
      panel.style.display = has ? '' : 'none';
    },
  };
}

function ipBadges() {
  const box = el('span', { class: 'tag-box' });
  return {
    el: box,
    update(d) {
      box.textContent = '';
      let n = 0;
      if (ipReachable(d.ip_v4)) {
        box.append(el('span', { class: 'tag-chip ip-chip', text: 'IPv4' }));
        n += 1;
      }
      if (ipReachable(d.ip_v6)) {
        box.append(el('span', { class: 'tag-chip ip-chip', text: 'IPv6' }));
        n += 1;
      }
      box.style.display = n ? '' : 'none';
    },
  };
}

function barCard(s, sysConfig) {
  const dot = el('i', { class: 'status-dot' });
  const name = el('h3', { class: 'srv-name' });
  const regionImg = flagImg(null);
  const regionText = document.createTextNode('');
  const region = el('span', { class: 'region-chip' }, regionImg, regionText);
  const osImg = osIconImg(null);
  const osText = document.createTextNode('');
  const osChip = el('span', { class: 'tag-chip' }, osImg, osText);
  const tagsBox = el('span', { class: 'tag-box' });
  const ips = ipBadges();
  const priceChip = el('span', { class: 'tag-chip' });
  const expChip = el('span', { class: 'tag-chip' });
  const tfDown = arrowIcon('down');
  const tfUp = arrowIcon('up');
  const tfText = document.createTextNode('');
  const tfChip = el('span', { class: 'tag-chip tf-chip' }, tfDown, tfUp, tfText);
  // meta 两行：地区/系统/标签/IP/隐藏 一行，价格/到期/流量包一行；每行溢出各自独立滚动
  const hiddenChip = el('span', { class: 'tag-chip warn', text: '隐藏' });
  hiddenChip.style.display = 'none';
  const meta1 = marqueeRow([region, osChip, tagsBox, ips.el, hiddenChip]);
  const meta2 = marqueeRow([priceChip, expChip, tfChip]);
  const subRow = el('div', { class: 'srv-sub' }, meta1.el, meta2.el);
  const lastSeen = el('span', { class: 'last-seen dim' });
  const cpu = meterRow('CPU');
  const ram = meterRow('内存');
  const disk = meterRow('磁盘');
  const load = loadDisplay();
  const upLabel = document.createTextNode('在线 ');
  const upText = document.createTextNode('—');
  const up = el('span', { class: 'bt-item mono' }, upLabel, upText);
  const downV = el('b', { class: 'mono' });
  const upV = el('b', { class: 'mono' });
  const trfDownV = el('b', { class: 'mono' });
  const trfUpV = el('b', { class: 'mono' });
  const pings = pingPanel();
  const tn = threeNetPanel();
  const liveRep = el('span', { class: 'bt-item mono' });
  const liveSmpText = document.createTextNode('');
  const liveLag = el('span', { class: 'bt-lag' });
  const liveSmp = el('span', { class: 'bt-item mono' }, liveSmpText, liveLag);

  const infoBox = el(
    'div',
    { class: 'srv-info' },
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '负载' }),
      load.el,
    ),
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '网络' }),
      el('span', { class: 'net-item' }, arrowIcon('down'), downV),
      el('span', { class: 'net-item' }, arrowIcon('up'), upV),
    ),
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '流量' }),
      el('span', { class: 'net-item' }, arrowIcon('down'), trfDownV),
      el('span', { class: 'net-item' }, arrowIcon('up'), trfUpV),
    ),
  );
  // 实时数据区：离线时整体盖遮罩（静态信息不受影响）
  const liveZone = el(
    'div',
    { class: 'srv-live' },
    el('div', { class: 'srv-meters' }, cpu.el, ram.el, disk.el),
    infoBox,
    pings.el,
    tn.el,
    el('div', { class: 'srv-bottom' }, up, liveRep, liveSmp),
  );

  const card = el(
    'a',
    { class: 'srv-card', href: `#/server/${encodeURIComponent(s.id)}` },
    el(
      'div',
      { class: 'srv-head' },
      dot,
      el('div', { class: 'srv-title' }, name),
      lastSeen,
    ),
    subRow,
    liveZone,
  );

  // ping / 三网面板：点击不跳转详情（浏览桶条 tooltip 时防误触）
  for (const zone of [pings.el, tn.el]) {
    zone.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function render(d) {
    const online = isOnline(d);
    card.classList.toggle('is-off', !online);
    card.classList.toggle('is-hidden-srv', String(d.is_hidden) === '1');
    hiddenChip.style.display = String(d.is_hidden) === '1' ? '' : 'none';
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    name.textContent = d.name || '未命名';

    updateFlagImg(regionImg, d.region);
    regionText.nodeValue = d.region || '';
    region.style.display = d.region ? '' : 'none';
    const osn = osName(d.os);
    updateOsIconImg(osImg, d.os);
    osText.nodeValue = osn;
    osChip.title = d.os || '';
    osChip.style.display = osn ? '' : 'none';
    // 价格 / 到期（站点开关控制；到期 ≤7 天变黄、已过期变红）
    const pr = sysConfig.show_price ? priceText(d.price, d.currency) : null;
    priceChip.textContent = pr ? (pr === '免费' ? pr : `${pr}/${billingText(d.billing_cycle)}`) : '';
    priceChip.style.display = pr ? '' : 'none';
    const days = sysConfig.show_expire && d.expire_date ? daysUntil(d.expire_date) : null;
    if (days != null) {
      expChip.textContent = days < 0 ? '已过期' : `${days}天`;
      expChip.className = `tag-chip${days < 0 ? ' bad' : days <= 7 ? ' warn' : ''}`;
      expChip.style.display = '';
    } else {
      expChip.style.display = 'none';
    }
// 流量包（站点开关 + 服务器设限）：按计费方向显示箭头 + 整数总量(剩余占比)
    const tfLimit = sysConfig.show_tf ? parseTrafficLimit(d.traffic_limit) : null;
    if (tfLimit) {
      const mRx = num(d.net_rx_monthly) || 0;
      const mTx = num(d.net_tx_monthly) || 0;
      const calcType = d.traffic_calc_type || 'total';
      const tfUsed =
        calcType === 'dl' ? mRx
        : calcType === 'ul' ? mTx
        : calcType === 'max' ? Math.max(mRx, mTx)
        : mRx + mTx;
      const remain = Math.max(0, 100 - Math.round((tfUsed / tfLimit) * 100));
      tfDown.style.display = calcType === 'ul' ? 'none' : '';
      tfUp.style.display = calcType === 'dl' ? 'none' : '';
      tfText.textContent = `${fmtLimitInt(tfLimit)}(${remain}%)`;
      tfChip.className = `tag-chip tf-chip${remain <= 0 ? ' bad' : remain <= 20 ? ' warn' : ''}`;
      tfChip.style.display = '';
    } else {
      tfChip.style.display = 'none';
    }
    // 第二行（价格/到期/流量包）为空时保留占位：visibility 隐藏而非撤掉，
    // 卡片高度不因计费信息缺失而缩水，同组卡片底边对齐
    meta2.el.style.visibility = pr || days != null || tfLimit ? '' : 'hidden';

    tagsBox.textContent = '';
    String(d.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((t) => tagsBox.append(el('span', { class: 'tag-chip', text: t })));
    tagsBox.style.display = tagsBox.childNodes.length ? '' : 'none';
    ips.update(d);

    const cpuV = num(d.cpu);
    cpu.set(cpuV, cpuV == null ? '—' : `${cpuV.toFixed(1)}%`);
    const rp = pct(d.ram_used, d.ram_total);
    ram.set(rp, rp == null ? '—' : `${fmtMB(d.ram_used)} / ${fmtMB(d.ram_total)}`);
    const dp = pct(d.disk_used, d.disk_total);
    disk.set(dp, dp == null ? '—' : `${fmtMB(d.disk_used)} / ${fmtMB(d.disk_total)}`);

    // 负载
    load.update(d);

    downV.textContent = fmtSpeed(d.net_in_speed);
    upV.textContent = fmtSpeed(d.net_out_speed);
    trfDownV.textContent = fmtBytes(num(d.net_rx_monthly) || 0);
    trfUpV.textContent = fmtBytes(num(d.net_tx_monthly) || 0);

    upLabel.textContent = online ? '在线 ' : '离线 ';
    upText.textContent = fmtUptime(d.boot_time);
    lastSeen.textContent = online ? '' : timeAgo(d.last_updated);

    // 三网详情（站点开关）：有序列数据时替换 ping 分项面板
    const tnOn = sysConfig.show_three_net_details && hasTnSeries(d);
    if (tnOn) {
      pings.el.style.display = 'none';
      tn.el.style.display = '';
      tn.update(d);
    } else {
      tn.el.style.display = 'none';
      pings.update(d);
    }
    setLive(liveRep, liveSmp, liveSmpText, liveLag, d);
    meta1.fit();
    meta2.fit();
  }

  render(s);
  return { el: card, update: render };
}

// ---------- 圆环卡片 ----------

function ringGauge() {
  const R = 30;
  const C = 2 * Math.PI * R;
  const val = svg('circle', {
    cx: '37',
    cy: '37',
    r: String(R),
    class: 'ring-val',
    'stroke-dasharray': C.toFixed(1),
    'stroke-dashoffset': C.toFixed(1),
  });
  const txt = svg('text', { x: '37', y: '41.5', 'text-anchor': 'middle', class: 'ring-txt mono' }, '—');
  const node = svg(
    'svg',
    { viewBox: '0 0 74 74', class: 'ring-svg' },
    svg('circle', { cx: '37', cy: '37', r: String(R), class: 'ring-track' }),
    val,
    txt,
  );
  return {
    el: node,
    set(p) {
      const v = p == null ? 0 : Math.min(100, Math.max(0, p));
      val.setAttribute('stroke-dashoffset', (C * (1 - v / 100)).toFixed(1));
      val.setAttribute('class', `ring-val${levelClass(p)}`);
      txt.textContent = p == null ? '—' : `${p.toFixed(0)}%`;
    },
  };
}

function ringCard(s, sysConfig) {
  const dot = el('i', { class: 'status-dot' });
  const name = el('h3', { class: 'srv-name' });
  const regionImg = flagImg(null);
  const regionText = document.createTextNode('');
  const region = el('span', { class: 'region-chip' }, regionImg, regionText);
  const osImg = osIconImg(null);
  const osText = document.createTextNode('');
  const osChip = el('span', { class: 'tag-chip' }, osImg, osText);
  const tagsBox = el('span', { class: 'tag-box' });
  const ips = ipBadges();
  const priceChip = el('span', { class: 'tag-chip' });
  const expChip = el('span', { class: 'tag-chip' });
  const tfDown = arrowIcon('down');
  const tfUp = arrowIcon('up');
  const tfText = document.createTextNode('');
  const tfChip = el('span', { class: 'tag-chip tf-chip' }, tfDown, tfUp, tfText);
  // meta 两行：地区/系统/标签/IP/隐藏 一行，价格/到期/流量包一行；每行溢出各自独立滚动
  const hiddenChip = el('span', { class: 'tag-chip warn', text: '隐藏' });
  hiddenChip.style.display = 'none';
  const meta1 = marqueeRow([region, osChip, tagsBox, ips.el, hiddenChip]);
  const meta2 = marqueeRow([priceChip, expChip, tfChip]);
  const subRow = el('div', { class: 'srv-sub' }, meta1.el, meta2.el);
  const lastSeen = el('span', { class: 'last-seen dim' });
  const cpu = ringGauge();
  const ram = ringGauge();
  const disk = ringGauge();
  const load = loadDisplay();
  const upLabel = document.createTextNode('在线 ');
  const upText = document.createTextNode('—');
  const up = el('span', { class: 'bt-item mono' }, upLabel, upText);
  const downV = el('b', { class: 'mono' });
  const upV = el('b', { class: 'mono' });
  const trfDownV = el('b', { class: 'mono' });
  const trfUpV = el('b', { class: 'mono' });
  const pings = pingPanel();
  const tn = threeNetPanel();
  const liveRep = el('span', { class: 'bt-item mono' });
  const liveSmpText = document.createTextNode('');
  const liveLag = el('span', { class: 'bt-lag' });
  const liveSmp = el('span', { class: 'bt-item mono' }, liveSmpText, liveLag);

  const infoBox = el(
    'div',
    { class: 'srv-info' },
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '负载' }),
      load.el,
    ),
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '网络' }),
      el('span', { class: 'net-item' }, arrowIcon('down'), downV),
      el('span', { class: 'net-item' }, arrowIcon('up'), upV),
    ),
    el(
      'div',
      { class: 'info-row' },
      el('span', { class: 'info-label', text: '流量' }),
      el('span', { class: 'net-item' }, arrowIcon('down'), trfDownV),
      el('span', { class: 'net-item' }, arrowIcon('up'), trfUpV),
    ),
  );
  // 实时数据区：离线时整体盖遮罩（静态信息不受影响）
  const liveZone = el(
    'div',
    { class: 'srv-live' },
    el(
      'div',
      { class: 'ring-row' },
      el('div', { class: 'ring-item' }, cpu.el, el('span', { class: 'ring-label', text: 'CPU' })),
      el('div', { class: 'ring-item' }, ram.el, el('span', { class: 'ring-label', text: '内存' })),
      el('div', { class: 'ring-item' }, disk.el, el('span', { class: 'ring-label', text: '磁盘' })),
    ),
    infoBox,
    pings.el,
    tn.el,
    el('div', { class: 'srv-bottom' }, up, liveRep, liveSmp),
  );

  const card = el(
    'a',
    { class: 'srv-card', href: `#/server/${encodeURIComponent(s.id)}` },
    el(
      'div',
      { class: 'srv-head' },
      dot,
      el('div', { class: 'srv-title' }, name),
      lastSeen,
    ),
    subRow,
    liveZone,
  );

  // ping / 三网面板：点击不跳转详情（浏览桶条 tooltip 时防误触）
  for (const zone of [pings.el, tn.el]) {
    zone.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  function render(d) {
    const online = isOnline(d);
    card.classList.toggle('is-off', !online);
    card.classList.toggle('is-hidden-srv', String(d.is_hidden) === '1');
    hiddenChip.style.display = String(d.is_hidden) === '1' ? '' : 'none';
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    name.textContent = d.name || '未命名';
    updateFlagImg(regionImg, d.region);
    regionText.nodeValue = d.region || '';
    region.style.display = d.region ? '' : 'none';
    const osn = osName(d.os);
    updateOsIconImg(osImg, d.os);
    osText.nodeValue = osn;
    osChip.title = d.os || '';
    osChip.style.display = osn ? '' : 'none';
    // 价格 / 到期（站点开关控制；到期 ≤7 天变黄、已过期变红）
    const pr = sysConfig.show_price ? priceText(d.price, d.currency) : null;
    priceChip.textContent = pr ? (pr === '免费' ? pr : `${pr}/${billingText(d.billing_cycle)}`) : '';
    priceChip.style.display = pr ? '' : 'none';
    const days = sysConfig.show_expire && d.expire_date ? daysUntil(d.expire_date) : null;
    if (days != null) {
      expChip.textContent = days < 0 ? '已过期' : `${days}天`;
      expChip.className = `tag-chip${days < 0 ? ' bad' : days <= 7 ? ' warn' : ''}`;
      expChip.style.display = '';
    } else {
      expChip.style.display = 'none';
    }
// 流量包（站点开关 + 服务器设限）：按计费方向显示箭头 + 整数总量(剩余占比)
    const tfLimit = sysConfig.show_tf ? parseTrafficLimit(d.traffic_limit) : null;
    if (tfLimit) {
      const mRx = num(d.net_rx_monthly) || 0;
      const mTx = num(d.net_tx_monthly) || 0;
      const calcType = d.traffic_calc_type || 'total';
      const tfUsed =
        calcType === 'dl' ? mRx
        : calcType === 'ul' ? mTx
        : calcType === 'max' ? Math.max(mRx, mTx)
        : mRx + mTx;
      const remain = Math.max(0, 100 - Math.round((tfUsed / tfLimit) * 100));
      tfDown.style.display = calcType === 'ul' ? 'none' : '';
      tfUp.style.display = calcType === 'dl' ? 'none' : '';
      tfText.textContent = `${fmtLimitInt(tfLimit)}(${remain}%)`;
      tfChip.className = `tag-chip tf-chip${remain <= 0 ? ' bad' : remain <= 20 ? ' warn' : ''}`;
      tfChip.style.display = '';
    } else {
      tfChip.style.display = 'none';
    }
    // 第二行（价格/到期/流量包）为空时保留占位：visibility 隐藏而非撤掉，
    // 卡片高度不因计费信息缺失而缩水，同组卡片底边对齐
    meta2.el.style.visibility = pr || days != null || tfLimit ? '' : 'hidden';

    tagsBox.textContent = '';
    String(d.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 3)
      .forEach((t) => tagsBox.append(el('span', { class: 'tag-chip', text: t })));
    tagsBox.style.display = tagsBox.childNodes.length ? '' : 'none';
    ips.update(d);

    cpu.set(num(d.cpu));
    ram.set(pct(d.ram_used, d.ram_total));
    disk.set(pct(d.disk_used, d.disk_total));

    load.update(d);

    downV.textContent = fmtSpeed(d.net_in_speed);
    upV.textContent = fmtSpeed(d.net_out_speed);
    trfDownV.textContent = fmtBytes(num(d.net_rx_monthly) || 0);
    trfUpV.textContent = fmtBytes(num(d.net_tx_monthly) || 0);

    upLabel.textContent = online ? '在线 ' : '离线 ';
    upText.textContent = fmtUptime(d.boot_time);
    lastSeen.textContent = online ? '' : timeAgo(d.last_updated);

    // 三网详情（站点开关）：有序列数据时替换 ping 分项面板
    const tnOn = sysConfig.show_three_net_details && hasTnSeries(d);
    if (tnOn) {
      pings.el.style.display = 'none';
      tn.el.style.display = '';
      tn.update(d);
    } else {
      tn.el.style.display = 'none';
      pings.update(d);
    }
    setLive(liveRep, liveSmp, liveSmpText, liveLag, d);
    meta1.fit();
    meta2.fit();
  }

  render(s);
  return { el: card, update: render };
}

// ---------- 表格模式 ----------

function miniCell() {
  const val = el('span', { class: 'mini-val mono', text: '—' });
  const fill = el('i');
  const wrap = el('div', { class: 'mini-cell' }, val, el('div', { class: 'mini-bar' }, fill));
  return {
    el: wrap,
    set(p) {
      val.textContent = p == null ? '—' : `${p.toFixed(0)}%`;
      fill.style.width = `${p == null ? 0 : Math.min(100, p)}%`;
      fill.className = levelClass(p).trim();
    },
  };
}

function tableRow(s) {
  const dot = el('i', { class: 'status-dot' });
  const nameEl = el('span', { text: s.name || '未命名' });
  const hiddenChip = el('span', { class: 'tag-chip warn', text: '隐藏' });
  hiddenChip.style.display = 'none';
  hiddenChip.style.marginLeft = '6px';
  const osIcon = osIconImg(null);
  const osText = document.createTextNode('');
  const osEl = el('span', { class: 't-sub' }, osIcon, osText);
  const regionImg = flagImg(null);
  const regionText = document.createTextNode('');
  const regionEl = el('span', {}, regionImg, regionText);
  const cpu = miniCell();
  const ram = miniCell();
  const disk = miniCell();
  const connEl = el('span', { class: 'mono t-conn', title: 'TCP / UDP' });
  const downEl = el('span', { class: 'mono' });
  const upEl = el('span', { class: 'mono' });
  const pingText = document.createTextNode('—');
  const pingEl = el('span', { class: 'ping-chip mono' }, icon('signal'), pingText);
  const uptimeEl = el('span', { class: 't-sub mono' });
  const liveEl = el('div', { class: 't-sub mono' });

  const tr = el(
    'tr',
    { tabindex: '0' },
    el('td', {}, el('div', { class: 't-name' }, dot, el('div', {}, el('span', {}, nameEl, hiddenChip), el('div', {}, osEl)))),
    el('td', {}, regionEl),
    el('td', {}, cpu.el),
    el('td', {}, ram.el),
    el('td', {}, disk.el),
    el('td', {}, connEl),
    el('td', {}, downEl),
    el('td', {}, upEl),
    el('td', {}, pingEl),
    el('td', {}, el('div', {}, uptimeEl, liveEl)),
  );

  const go = () => {
    location.hash = `#/server/${encodeURIComponent(s.id)}`;
  };
  tr.addEventListener('click', go);
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go();
  });

  function render(d) {
    const online = isOnline(d);
    tr.classList.toggle('is-off', !online);
    hiddenChip.style.display = String(d.is_hidden) === '1' ? '' : 'none';
    dot.className = `status-dot ${online ? 'on' : 'off'}`;
    nameEl.textContent = d.name || '未命名';
    osText.nodeValue = online ? ` ${shortOS(d.os)}` : timeAgo(d.last_updated);
    updateOsIconImg(osIcon, online ? d.os : null);
    updateFlagImg(regionImg, d.region);
    regionText.nodeValue = d.region ? ` ${d.region}` : '—';
    cpu.set(num(d.cpu));
    ram.set(pct(d.ram_used, d.ram_total));
    disk.set(pct(d.disk_used, d.disk_total));
    connEl.textContent = `${fmtCount(d.tcp_conn)} / ${fmtCount(d.udp_conn)}`;
    downEl.textContent = fmtSpeed(d.net_in_speed);
    upEl.textContent = fmtSpeed(d.net_out_speed);
    const ap = avgPing(d);
    pingText.textContent = ap == null ? '—' : `${ap.toFixed(0)} ms`;
    pingEl.className = `ping-chip mono${ap == null ? '' : ` ${pingClass(ap)}`}`;
    uptimeEl.textContent = fmtUptime(d.boot_time);
    fillLive(liveEl, d);
  }

  render(s);
  return { el: tr, update: render };
}

function tableCard(list) {
  const tbody = el('tbody');
  const refs = new Map();
  for (const s of list) {
    const r = tableRow(s);
    refs.set(s.id, r);
    tbody.append(r.el);
  }
  const node = el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'srv-table' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          ['服务器', '地区', 'CPU', '内存', '磁盘', 'TCP/UDP', 'down', 'up', '延迟', '时长'].map((h) =>
            h === 'down' || h === 'up' ? el('th', {}, arrowIcon(h)) : el('th', { text: h }),
          ),
        ),
      ),
      tbody,
    ),
  );
  return { el: node, refs };
}

// ---------- 骨架屏 ----------

function skeletonHome() {
  const box = el('div');
  const sg = el('div', { class: 'stats-grid' });
  for (let i = 0; i < 4; i += 1) sg.append(el('div', { class: 'sk sk-stat' }));
  const grid = el('div', { class: 'cards-grid' });
  for (let i = 0; i < 6; i += 1) grid.append(el('div', { class: 'sk sk-card' }));
  box.append(sg, el('div', { style: { height: '18px' } }), grid);
  return box;
}

// ---------- 主视图 ----------

export async function renderHome(root, ctx) {
  applyLatencyWindow(ctx.config);
  const view = el('div', { class: 'view view-enter' });
  root.append(view);
  view.append(skeletonHome());

  let payload;
  try {
    payload = await getServers();
  } catch (err) {
    view.textContent = '';
    if (err.status === 401) {
      view.append(
        stateBlock({
          icon: 'lock',
          title: '私有站点',
          desc: '该站点未公开访问。探针主题不包含管理端登录入口，请在默认主题中登录后再访问，或联系站长开启公开模式。',
          actionText: '重试',
          onAction: () => ctx.refresh(),
        }),
      );
    } else {
      view.append(
        stateBlock({
          icon: 'err',
          title: '加载失败',
          desc: err.message || '网络错误',
          actionText: '重试',
          onAction: () => ctx.refresh(),
        }),
      );
    }
    return { destroy() {} };
  }

  const servers = payload.servers || [];
  const sysConfig = payload.sysConfig || {};
  // 缓存站点显示开关，详情页合并使用（/api/server 仅返回 show_long_history）
  ctx.sysConfig = sysConfig;
  const dataMap = new Map(servers.map((s) => [s.id, s]));

  // 过滤条件持久化在 hash 查询串（#/?q=xxx&region=CC），刷新/分享链接可还原
  const urlQuery = () => new URLSearchParams((location.hash.match(/\?(.+)$/) || [])[1] || '');
  const initialQuery = (urlQuery().get('q') || '').trim();
  const initialRegion = (urlQuery().get('region') || '').trim().toUpperCase();
  const state = {
    mode:
      localStorage.getItem('probe_display_mode') ||
      sysConfig.display_mode ||
      (ctx.config && ctx.config.display_mode) ||
      'bar',
    filter: initialQuery.toLowerCase(),
    region: /^[A-Z]{2}$/.test(initialRegion) ? initialRegion : null,
  };
  if (!MODE_LABELS[state.mode]) state.mode = 'bar';

  // ----- 统计卡片 -----
  const statOnline = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statDown = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statUp = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  const statValue = { v: el('div', { class: 'stat-value mono' }), s: el('div', { class: 'stat-sub' }) };
  // 下行/上行：网速(固定 10ch 占位) + 右侧累计流量，网速变化不会推动布局
  const downSpeed = el('span', { class: 'stat-speed', text: '—' });
  const downTotal = el('span', { class: 'stat-side' });
  const upSpeed = el('span', { class: 'stat-speed', text: '—' });
  const upTotal = el('span', { class: 'stat-side' });
  statDown.v.append(downSpeed, downTotal);
  statUp.v.append(upSpeed, upTotal);

  function statCard(iconNode, label, ref) {
    ref.s.style.display = 'none';
    return el(
      'div',
      { class: 'stat-card' },
      el('div', { class: 'stat-label' }, iconNode, el('span', { text: label })),
      ref.v,
      ref.s,
    );
  }

  const statsGrid = el(
    'section',
    { class: 'stats-grid' },
    statCard(icon('server'), '在线', statOnline),
    statCard(arrowIcon('down'), '下行', statDown),
    statCard(arrowIcon('up'), '上行', statUp),
    statCard(icon('card'), '价值', statValue),
  );

  const regionStats = payload.regionStats || {};
  const regionChips = new Map();
  const regionRow = el(
    'div',
    { class: 'regions-row' },
    Object.entries(regionStats).map(([cc, n]) => {
      const chip = el(
        'button',
        { class: 'region-chip', type: 'button', title: `只看 ${cc}` },
        flagImg(cc),
        document.createTextNode(` ${cc} · ${n}`),
      );
      chip.addEventListener('click', () => {
        state.region = state.region === cc ? null : cc;
        syncRegionChips();
        syncUrl();
        applyFilter();
        refreshStats();
      });
      regionChips.set(cc, chip);
      return chip;
    }),
  );
  regionRow.style.display = Object.keys(regionStats).length ? '' : 'none';

  function syncRegionChips() {
    for (const [cc, chip] of regionChips) chip.classList.toggle('active', state.region === cc);
  }
  syncRegionChips();

  // ----- 工具栏 -----
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: '搜索名称、分组、地区或系统…',
    'aria-label': '搜索服务器',
    value: initialQuery,
  });
  const segBtns = new Map();
  const seg = el(
    'div',
    { class: 'seg', role: 'group', 'aria-label': '服务器展示方式' },
    Object.entries(MODE_LABELS).map(([mode, label]) => {
      const b = el('button', { class: 'seg-btn', text: label, dataset: { mode } });
      b.addEventListener('click', () => {
        if (state.mode === mode) return;
        state.mode = mode;
        try {
          localStorage.setItem('probe_display_mode', mode);
        } catch {
          /* ignore */
        }
        syncSeg();
        renderList();
      });
      segBtns.set(mode, b);
      return b;
    }),
  );

  function syncSeg() {
    for (const [m, b] of segBtns) {
      b.classList.toggle('active', m === state.mode);
      b.setAttribute('aria-pressed', String(m === state.mode));
    }
  }
  syncSeg();

  const toolbar = el('div', { class: 'toolbar' }, search, seg);
  const resultCount = el('span', { class: 'filter-count', role: 'status', 'aria-live': 'polite' });
  const clearFilter = el('button', { class: 'filter-reset', text: '清除筛选', hidden: true });
  clearFilter.addEventListener('click', () => {
    search.value = '';
    state.filter = '';
    state.region = '';
    syncRegionChips();
    syncUrl();
    applyFilter();
    refreshStats();
    search.focus();
  });
  const filterSummary = el('div', { class: 'filter-summary' }, resultCount, clearFilter);

  // ----- 服务器列表 -----
  const groupsBox = el('div', { class: 'groups' });
  let cardRefs = new Map();
  let tableRefs = new Map();

  function groupList() {
    const groups = new Map();
    for (const s of dataMap.values()) {
      const g = s.server_group || 'Default';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    return groups;
  }

  function matchFilter(d) {
    if (state.region && String(d.region || '').toUpperCase() !== state.region) return false;
    if (!state.filter) return true;
    const hay = `${d.name || ''} ${d.server_group || ''} ${d.tags || ''} ${d.region || ''} ${d.os || ''}`.toLowerCase();
    return hay.includes(state.filter);
  }

  function renderList() {
    cardRefs = new Map();
    tableRefs = new Map();
    groupsBox.textContent = '';
    const groups = groupList();

    if (!groups.size) {
      groupsBox.append(
        stateBlock({ icon: 'empty', title: '暂无服务器', desc: '还没有任何服务器探针上报数据。' }),
      );
      return;
    }

    for (const [g, list] of groups) {
      const grid =
        state.mode === 'table' ? null : el('div', { class: 'cards-grid' });
      const sec = el(
        'section',
        { class: 'group-section', dataset: { group: g } },
        el(
          'header',
          { class: 'group-header' },
          el('h2', { class: 'group-title', text: g }),
          el('span', { class: 'group-count', text: `${list.length} 台` }),
        ),
      );

      if (state.mode === 'table') {
        const t = tableCard(list);
        // 合并各分组的行引用（覆写会导致其他分组丢失实时更新且被过滤逻辑隐藏）
        for (const [k, v] of t.refs) tableRefs.set(k, v);
        sec.append(t.el);
      } else {
        for (const s of list) {
          const c = state.mode === 'ring' ? ringCard(s, sysConfig) : barCard(s, sysConfig);
          cardRefs.set(s.id, c);
          grid.append(c.el);
        }
        sec.append(grid);
      }
      groupsBox.append(sec);
    }
    applyFilter();
  }

  function applyFilter() {
    const sections = groupsBox.querySelectorAll('.group-section');
    let visibleTotal = 0;
    sections.forEach((sec) => {
      let visible = 0;
      const refs = state.mode === 'table' ? tableRefs : cardRefs;
      for (const [sid, ref] of refs) {
        const nodeEl = ref.el;
        if (!sec.contains(nodeEl)) continue;
        const show = matchFilter(dataMap.get(sid));
        nodeEl.style.display = show ? '' : 'none';
        if (show) visible += 1;
      }
      sec.style.display = visible ? '' : 'none';
      const count = sec.querySelector('.group-count');
      if (count) count.textContent = `${visible} 台`;
      visibleTotal += visible;
    });
    const filtered = Boolean(state.filter || state.region);
    resultCount.textContent = filtered
      ? `匹配 ${visibleTotal} / ${dataMap.size} 台服务器`
      : `共 ${dataMap.size} 台服务器`;
    clearFilter.hidden = !filtered;
    let note = groupsBox.querySelector('.filter-empty');
    if (!visibleTotal && dataMap.size) {
      if (!note) {
        note = el('div', { class: 'filter-empty' });
        note.append(stateBlock({ icon: 'empty', title: '没有匹配的服务器', desc: '换个关键词试试。' }));
        groupsBox.append(note);
      }
    } else if (note) {
      note.remove();
    }
  }

  // replaceState 不产生历史记录、不触发 hashchange 重路由
  function syncUrl() {
    const params = new URLSearchParams();
    const q = search.value.trim();
    if (q) params.set('q', q);
    if (state.region) params.set('region', state.region);
    const qs = params.toString();
    history.replaceState(null, '', qs ? `#/?${qs}` : '#/');
  }

  search.addEventListener(
    'input',
    debounce(() => {
      state.filter = search.value.trim().toLowerCase();
      syncUrl();
      applyFilter();
      refreshStats();
    }, 120),
  );

  // ----- 统计刷新 -----
  function refreshStats() {
    let online = 0;
    let speedIn = 0;
    let speedOut = 0;
    let totalRx = 0;
    let totalTx = 0;
    let totalValue = 0; // 剩余价值合计（折算人民币）
    let totalAll = 0; // 总价值合计（全周期价格，折算人民币）
    for (const s of dataMap.values()) {
      // 上下行（网速 + 累计流量）只统计过滤后可见的机器；在线数与价值保持全量
      const visible = matchFilter(s);
      if (isOnline(s)) {
        online += 1;
        if (visible) {
          speedIn += num(s.net_in_speed) || 0;
          speedOut += num(s.net_out_speed) || 0;
        }
      }
      if (visible) {
        totalRx += num(s.net_rx) || 0;
        totalTx += num(s.net_tx) || 0;
      }
      const rate = curRate(s.currency);
      const price = parseFloat(s.price);
      if (Number.isFinite(price) && price > 0) totalAll += price * rate;
      const rv = remainingValue(s);
      if (typeof rv === 'number') totalValue += rv * rate;
    }
    statOnline.v.textContent = '';
    statOnline.v.append(`${online}`, el('em', { text: ` / ${dataMap.size}` }));
    statOnline.s.textContent = `${dataMap.size - online} 离线`;
    statOnline.s.style.display = dataMap.size - online > 0 ? '' : 'none';
    downSpeed.textContent = fmtSpeed(speedIn);
    downTotal.textContent = `共 ${fmtBytes(totalRx)}`;
    upSpeed.textContent = fmtSpeed(speedOut);
    upTotal.textContent = `共 ${fmtBytes(totalTx)}`;
    statValue.v.textContent = '';
    if (totalAll > 0) {
      statValue.v.append(`¥${totalValue.toFixed(0)}`, el('em', { text: ` / ¥${totalAll.toFixed(0)}` }));
    } else {
      statValue.v.textContent = '—';
    }
  }

  // ----- WebSocket 实时更新（全局统一 1s tick 回放） -----
  // 全局单一定时器：样本回放与界面秒级刷新共用同一个 tick，
  // 所有卡片以相同频率同步变化，避免各服务器各自计时导致的杂乱跳变
  const playback = new Playback(
    (serverId, data, ts, displayTs, meta) => {
      const cur = dataMap.get(serverId);
      if (!cur) return;
      Object.assign(cur, data);
      // 三网时序本地追加（对齐后端窗口缓存行为，桶图随实时样本滚动）
      appendLatencyPoints(cur, ts, data);
      // 在线判定使用批次上报时间（对齐官方 last_updated = report_timestamp）：
      // 回放过期缓存批次时服务器按真实上报时间离线，而非回放期间"假在线"
      cur.last_updated = meta && meta.reportTs ? meta.reportTs : serverNow();
      // 采集/上报时间：保留 report_ts / display_ts / batch_size 供显示逻辑判断
      cur.sample_ts = ts;
      cur.display_ts = displayTs;
      cur.report_ts = meta ? meta.reportTs : null;
      cur.batch_size = meta ? meta.batchSize : 1;
    },
    () => {
      // onTick：同步展示时钟（(+Ns) 每秒增长），再统一驱动所有卡片刷新
      for (const [sid, d] of dataMap) {
        const c = playback.displayTs(sid);
        if (c && d.sample_ts) d.display_ts = c;
      }
      for (const [sid, ref] of cardRefs) ref.update(dataMap.get(sid));
      for (const [sid, ref] of tableRefs) ref.update(dataMap.get(sid));
      refreshStats();
    },
    { isOnline: (sid) => isOnline(dataMap.get(sid)) },
  );

  // 以 /api/servers 已合并的指标时间为种子（对齐官方 mergeServersIntoList）：
  // 避免首批实时消息重复回放已展示数据；无缓存批次可回放的在线服务器
  // 也立即显示时间行，展示时钟从指标时间起步、lag 随 tick 增长
  for (const s of servers) {
    const ts = normalizeTs(s.sample_ts ?? s.sample_timestamp ?? s.last_updated, null);
    if (!ts) continue;
    playback.seed(s.id, ts);
    const d = dataMap.get(s.id);
    d.sample_ts = ts;
    d.display_ts = ts;
  }

  // 初始数据：latestReportUpdates 经统一回放管线消化（对齐官方 replayCachedReport），
  // 以 reportAgeMs 把缓存批次平移到当前时间线，再回放追赶到最新样本
  for (const u of payload.latestReportUpdates || []) {
    playback.queue(u.serverId, u.samples, u.reportTs, {
      replayCachedReport: true,
      reportAgeMs: u.reportAgeMs,
    });
  }

  // ----- 组装 -----
  view.textContent = '';
  const overview = el(
    'div',
    { class: 'overview-head' },
    el('div', { class: 'overview-copy' },
      el('p', { class: 'overview-eyebrow', text: 'SAKURA / PULSE' }),
      el('p', { class: 'overview-description', text: '服务器状态、资源负载与网络表现，一览掌握。' }),
    ),
    el('span', { class: 'overview-badge', text: '全局监控' }),
    el('img', { class: 'sakura-girl', src: 'assets/sakura-girl.webp', alt: '', 'aria-hidden': 'true' }),
  );
  view.append(overview, statsGrid, regionRow, toolbar, filterSummary, groupsBox);
  renderList();
  refreshStats();
  // 在线汇率就绪后刷新一次剩余价值（缓存命中时同步返回）
  loadFxRates().then(refreshStats);

  playback.start();

  // 前端 WSS 超时（站点配置 frontend_ws_timeout_minutes，0 = 不超时）：
  // 到期断开并弹确认框——关闭则不再重连，继续则立即重连
  let socket = null;
  const wsTimeout = wsTimeoutDialog({
    onClose: () => socket && socket.close(),
    onContinue: () => socket && socket.reconnect(),
  });

  socket = new MetricSocket({
    scope: 'all',
    ids: [...dataMap.keys()],
    timeoutMinutes: normalizeWsTimeoutMinutes(ctx.config && ctx.config.frontend_ws_timeout_minutes),
    onTimeout: () => wsTimeout.show(),
    onState: ctx.setWsState,
    onBatch(msg) {
      for (const u of msg.updates || []) {
        playback.queue(u.serverId, u.samples, u.reportTs ?? u.report_timestamp ?? msg.ts);
      }
    },
  });

  return {
    destroy() {
      playback.destroy();
      socket.close();
      wsTimeout.destroy();
    },
  };
}

