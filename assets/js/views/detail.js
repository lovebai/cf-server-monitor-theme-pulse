// 详情页视图：单台服务器全量指标 + 历史图表 + 实时追加
// 数据来源：GET /api/server、GET /api/history/all；实时更新：/api/ws (subscribe=<id>)

import {
  billingText,
  daysUntil,
  el,
  flagImg,
  fmtBytes,
  fmtClock,
  fmtDateTime,
  fmtMB,
  fmtPct,
  fmtSpeed,
  fmtUptime,
  icon,
  ipReachable,
  isOnline,
  normalizeWsTimeoutMinutes,
  num,
  osIconImg,
  parseGPU,
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
  toast,
  updateFlagImg,
  updateOsIconImg,
  wsTimeoutDialog,
} from '../utils.js?v=1.3.1';
import {getAuthToken, getHistory, getServer, getServers} from '../api.js?v=1.3.1';
import {Playback, normalizeTs} from '../playback.js?v=1.3.1';
import {MetricSocket} from '../ws.js?v=1.3.1';
import {LineChart} from '../charts.js?v=1.3.1';

const COLORS = {
  teal: '#2dd4bf',
  blue: '#38bdf8',
  purple: '#a78bfa',
  amber: '#f59e0b',
  pink: '#f472b6',
  green: '#34d399',
  red: '#fb7185',
};

// hours=0 为「实时」：WS 秒级样本直接入图，最多保留 60 个点
const RANGES = [
  { label: '实时', hours: 0 },
  { label: '10分钟', hours: 0.167 },
  { label: '30分钟', hours: 0.5 },
  { label: '1小时', hours: 1 },
  { label: '6小时', hours: 6 },
  { label: '12小时', hours: 12 },
  { label: '24小时', hours: 24 },
  { label: '2天', hours: 48 },
  { label: '4天', hours: 96 },
  { label: '7天', hours: 168 },
];

const CARRIERS = [
  { key: 'ct', label: '电信' },
  { key: 'cu', label: '联通' },
  { key: 'cm', label: '移动' },
  { key: 'bd', label: 'BGP' },
];

function levelClass(p) {
  if (p == null) return '';
  return p >= 90 ? ' lv-bad' : p >= 70 ? ' lv-warn' : '';
}

function backIcon() {
  return svg(
    'svg',
    {
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2.2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    svg('path', { d: 'M15 5l-7 7 7 7' }),
  );
}

// ---------- 磁贴 ----------

function tile(label, { withBar = false, smallValue = false, icon: iconName } = {}) {
  const value = el('div', { class: `tile-value mono${smallValue ? ' small' : ''}`, text: '—' });
  const sub = el('div', { class: 'tile-sub' });
  const barFill = el('i');
  const bar = el('div', { class: 'tile-bar' }, barFill);
  const labelEl = el(
    'div',
    { class: 'tile-label' },
    iconName ? icon(iconName) : null,
    el('span', { text: label }),
  );
  const node = el('div', { class: 'tile' }, labelEl, value, sub);
  if (withBar) node.append(bar);
  return {
    el: node,
    set(v, subText, title) {
      value.textContent = v == null ? '—' : v;
      sub.textContent = subText || '';
      if (v != null) value.title = title != null ? String(title) : String(v);
    },
    setBar(p) {
      barFill.style.width = `${p == null ? 0 : Math.min(100, p)}%`;
      barFill.className = levelClass(p).trim();
    },
    sub,
  };
}

function pingCell(label) {
  const val = el('div', { class: 'p-val mono', text: '—' });
  const loss = el('div', { class: 'p-loss mono', text: '' });
  const node = el(
    'div',
    { class: 'ping-cell' },
    el('div', { class: 'p-label', text: label }),
    val,
    loss,
  );
  return {
    el: node,
    set(pingV, lossV) {
      const p = pingState(pingV);
      const l = pingState(lossV);
      node.className = `ping-cell${p.kind === 'ok' ? ` ${pingClass(p.value)}` : ''}`;
      if (p.kind === 'disabled') val.textContent = '关闭';
      else if (p.kind === 'ok') val.textContent = `${p.value.toFixed(0)} ms`;
      else val.textContent = '—';
      loss.textContent = l.kind === 'ok' ? `丢包 ${l.value}%` : '';
    },
  };
}

// ---------- 图表卡片 ----------

function chartCard(container, title, seriesDefs, opts) {
  const legend = el(
    'div',
    { class: 'legend' },
    seriesDefs.map((d) => {
      const dot = el('i', { class: 'legend-dot' });
      dot.style.backgroundColor = d.color;
      return el('span', { class: 'legend-item' }, dot, el('span', { text: d.label }));
    }),
  );
  const body = el('div');
  const card = el(
    'div',
    { class: 'chart-card' },
    el('div', { class: 'chart-card-head' }, el('span', { class: 'chart-card-title', text: title }), legend),
    body,
  );
  container.append(card);
  return new LineChart(body, opts);
}

// ---------- 历史数据映射 ----------

function loadParts(loadAvg) {
  const parts = String(loadAvg || '').trim().split(/\s+/).map(Number);
  return [parts[0], parts[1], parts[2]].map((v) => (Number.isFinite(v) ? v : null));
}

function mapRows(rows) {
  const data = {
    cpu: [], ram: [], swap: [], disk: [],
    diskRead: [], diskWrite: [],
    netIn: [], netOut: [],
    pingCt: [], pingCu: [], pingCm: [], pingBd: [],
    load1: [], load5: [], load15: [],
  };
  const sorted = [...(rows || [])].sort((a, b) => a.timestamp - b.timestamp);
  for (const r of sorted) {
    const x = r.timestamp;
    if (!x) continue;
    data.cpu.push({ x, y: num(r.cpu) });
    data.ram.push({ x, y: pct(r.ram_used, r.ram_total) });
    data.swap.push({ x, y: pct(r.swap_used, r.swap_total) });
    data.disk.push({ x, y: pct(r.disk_used, r.disk_total) });
    // 磁盘 IO：历史行为平铺字段，实时上报可能嵌套在 disk 对象
    data.diskRead.push({ x, y: num(r.disk_read_bps ?? (r.disk && r.disk.read_bps)) });
    data.diskWrite.push({ x, y: num(r.disk_write_bps ?? (r.disk && r.disk.write_bps)) });
    data.netIn.push({ x, y: num(r.net_in_speed) });
    data.netOut.push({ x, y: num(r.net_out_speed) });
    data.pingCt.push({ x, y: pingState(r.ping_ct).value });
    data.pingCu.push({ x, y: pingState(r.ping_cu).value });
    data.pingCm.push({ x, y: pingState(r.ping_cm).value });
    data.pingBd.push({ x, y: pingState(r.ping_bd).value });
    const [l1, l5, l15] = loadParts(r.load_avg);
    data.load1.push({ x, y: l1 });
    data.load5.push({ x, y: l5 });
    data.load15.push({ x, y: l15 });
  }
  return data;
}

// ---------- 骨架屏 ----------

function skeletonDetail() {
  const box = el('div');
  const tiles = el('div', { class: 'tiles-grid' });
  for (let i = 0; i < 8; i += 1) tiles.append(el('div', { class: 'sk sk-tile' }));
  const charts = el('div', { class: 'charts-grid' });
  for (let i = 0; i < 4; i += 1) charts.append(el('div', { class: 'sk sk-chart' }));
  box.append(el('div', { class: 'sk', style: { height: '44px', marginBottom: '18px' } }), tiles, charts);
  return box;
}

// ---------- 主视图 ----------

export async function renderDetail(root, ctx, id) {
  const view = el('div', { class: 'view view-enter' });
  root.append(view);
  view.append(skeletonDetail());

  let srv;
  try {
    srv = await getServer(id);
  } catch (err) {
    view.textContent = '';
    const notFound = err.status === 404;
    view.append(
      stateBlock({
        icon: notFound ? 'empty' : 'err',
        title: notFound ? '服务器不存在' : '加载失败',
        desc: notFound
          ? '该服务器不存在，或未对匿名访客开放。'
          : err.message || '网络错误',
        actionText: '返回总览',
        onAction: () => {
          location.hash = '';
        },
      }),
    );
    return { destroy() {} };
  }

  // /api/server 的 sysConfig 仅含 show_long_history，价格/到期/流量开关
  // 需合并首页缓存的 sysConfig；直接打开详情页时兜底补拉一次
  const sysConfig = { ...(ctx.sysConfig || {}), ...(srv.sysConfig || {}) };
  if (!ctx.sysConfig) {
    getServers()
      .then((p) => {
        ctx.sysConfig = p.sysConfig || {};
        Object.assign(sysConfig, ctx.sysConfig, srv.sysConfig || {});
        renderTiles(srv);
      })
      .catch(() => {});
  }
  // ----- 头部 -----
  const headDot = el('i', { class: 'status-dot' });
  const titleEl = el('h2', { class: 'detail-title' });
  const chipRow = el('div', { class: 'chip-row' });
  const regionImg = flagImg(null);
  const regionText = document.createTextNode('');
  const regionChip = el('span', {}, regionImg, regionText);
  const osIcon = osIconImg(null);
  const osChipText = document.createTextNode('');
  const osChipNode = el('span', {}, osIcon, osChipText);

  function renderHead(d) {
    const online = isOnline(d);
    headDot.className = `status-dot ${online ? 'on' : 'off'}`;
    titleEl.textContent = d.name || '未命名';
    chipRow.textContent = '';
    const chips = [];
    if (d.server_group) chips.push(d.server_group);
    if (d.region) {
      updateFlagImg(regionImg, d.region);
      regionText.nodeValue = ` ${d.region}`;
      chips.push(regionChip);
    }
    if (d.os) {
      updateOsIconImg(osIcon, d.os);
      osChipText.nodeValue = ` ${d.os}`;
      chips.push(osChipNode);
    }
    if (d.arch) chips.push(d.arch);
    if (d.agent_version) chips.push(`Agent ${d.agent_version}`);
    if (String(d.is_hidden) === '1') chips.push('隐藏');
    chips.push(online ? '在线' : `离线 · ${timeAgo(d.last_updated)}`);
    chips.forEach((t, i) => {
      const cls = `chip${i === chips.length - 1 && online ? ' accent' : ''}`;
      if (typeof t === 'string') {
        chipRow.append(el('span', { class: cls, text: t }));
      } else {
        t.className = cls;
        chipRow.append(t);
      }
    });
    // 实时时间芯片（对齐官方 dataTimeText）
    // lag = display_ts - sample_ts；display_ts 为展示时钟，在线时随 wall clock
    // 每秒前进，(+Ns) 随之增长，下一个样本应用时回落
    // 批量上报：上报芯片 + 采集芯片；单条上报：仅一个「上报」芯片
    if (online && d.sample_ts) {
      if (d.report_ts && d.batch_size !== 1) {
        const lag = d.display_ts
          ? Math.max(0, Math.floor((d.display_ts - d.sample_ts) / 1000))
          : 0;
        chipRow.append(el('span', { class: 'chip chip-live', text: `上报 ${fmtClock(d.report_ts)}` }));
        chipRow.append(el('span', { class: 'chip chip-live accent', text: `采集 ${fmtClock(d.sample_ts)}${lag > 0 ? `(+${lag}s)` : ''}` }));
      } else {
        const t = d.display_ts || d.report_ts || d.sample_ts;
        const lag = Math.max(0, Math.floor((t - d.sample_ts) / 1000));
        chipRow.append(el('span', { class: 'chip chip-live accent', text: `上报 ${fmtClock(d.sample_ts)}${lag > 0 ? `(+${lag}s)` : ''}` }));
      }
    }
  }

  const backBtn = el(
    'button',
    {
      class: 'back-btn',
      onClick: () => {
        location.hash = '';
      },
    },
    backIcon(),
    '返回总览',
  );

  const head = el('div', { class: 'detail-head' }, headDot, titleEl, chipRow);

  // ----- 指标磁贴 -----
  const tCpu = tile('CPU', { withBar: true, icon: 'cpu' });
  const tRam = tile('内存', { withBar: true, smallValue: true, icon: 'layers' });
  const tSwap = tile('Swap', { withBar: true, smallValue: true, icon: 'swap' });
  const tDisk = tile('磁盘', { withBar: true, smallValue: true, icon: 'disk' });
  const tLoad = tile('负载', { icon: 'gauge' });
  const tNet = tile('网络', { smallValue: true, icon: 'activity' });
  const tMonth = tile('月流量', { withBar: true, smallValue: true, icon: 'pie' });
  const tProc = tile('进程', { smallValue: true, icon: 'list' });
  const tSys = tile('系统', { smallValue: true, icon: 'server' });
  const tUptime = tile('时长', { icon: 'clock' });
  // IP 磁贴自定义构建：避免通用 tile.set() 清空 sub 导致徽章丢失
  const ipV4 = el('span', { class: 'ip-badge', text: 'IPv4' });
  const ipV6 = el('span', { class: 'ip-badge', text: 'IPv6' });
  const tIp = el(
    'div',
    { class: 'tile' },
    el('div', { class: 'tile-label' }, icon('globe'), el('span', { text: 'IP' })),
    el('div', { class: 'ip-badges' }, ipV4, ipV6),
  );

  const pingCells = CARRIERS.map((c) => ({ ...c, ref: pingCell(c.label) }));
  const pingTile = el(
    'div',
    { class: 'tile' },
    el('div', { class: 'tile-label' }, icon('signal'), el('span', { text: '测速' })),
    el('div', { class: 'ping-grid' }, pingCells.map((c) => c.ref.el)),
  );

  const gpuTile = tile('GPU', { smallValue: true, icon: 'gpu' });
  gpuTile.el.style.display = 'none';

  const billTile = el(
    'div',
    { class: 'tile' },
    el('div', { class: 'tile-label' }, icon('card'), el('span', { text: '账单' })),
  );
  const billBox = el('div');
  billTile.append(billBox);
  billTile.style.display = 'none';

  // 测速磁贴较高，放到靠后位置与账单（同样偏高）相邻，避免把行高顶起来
  const tilesGrid = el(
    'div',
    { class: 'tiles-grid' },
    tCpu.el, tRam.el, tSwap.el, tDisk.el,
    tLoad.el, tNet.el, tMonth.el, tProc.el,
    tUptime.el, tSys.el, pingTile, tIp,
    gpuTile.el, billTile,
  );

  function renderTiles(d) {
    const cpuV = num(d.cpu);
    tCpu.set(cpuV == null ? '—' : `${cpuV.toFixed(1)}%`,
      [d.cpu_info, d.cpu_cores ? `${d.cpu_cores} 核` : null].filter(Boolean).join(' · '));
    tCpu.setBar(cpuV);

    const rp = pct(d.ram_used, d.ram_total);
    tRam.set(`${fmtMB(d.ram_used)} / ${fmtMB(d.ram_total)}`, rp == null ? '' : `已用 ${rp.toFixed(1)}%`);
    tRam.setBar(rp);

    const sp = pct(d.swap_used, d.swap_total);
    const hasSwap = num(d.swap_total) > 0;
    tSwap.set(hasSwap ? `${fmtMB(d.swap_used)} / ${fmtMB(d.swap_total)}` : '未启用',
      hasSwap && sp != null ? `已用 ${sp.toFixed(1)}%` : '');
    tSwap.setBar(hasSwap ? sp : 0);

    const dp = pct(d.disk_used, d.disk_total);
    tDisk.set(`${fmtMB(d.disk_used)} / ${fmtMB(d.disk_total)}`, dp == null ? '' : `已用 ${dp.toFixed(1)}%`);
    tDisk.setBar(dp);

    const [l1, l5, l15] = loadParts(d.load_avg);
    tLoad.set(l1 == null ? '—' : `${l1} / ${l5} / ${l15}`, '1 / 5 / 15 分钟');

    tNet.set(`↓ ${fmtSpeed(d.net_in_speed)}   ↑ ${fmtSpeed(d.net_out_speed)}`,
      `↓ ${fmtBytes(d.net_rx)} · ↑ ${fmtBytes(d.net_tx)}`);

    const mRx = num(d.net_rx_monthly) || 0;
    const mTx = num(d.net_tx_monthly) || 0;
    const limit = parseTrafficLimit(d.traffic_limit);
    if (limit) {
      const usedP = ((mRx + mTx) / limit) * 100;
      tMonth.set(`${fmtBytes(mRx + mTx)} / ${fmtBytes(limit)}`, `${usedP.toFixed(1)}% · ${d.reset_day || 1} 日重置`);
      tMonth.setBar(usedP);
    } else {
      tMonth.set(fmtBytes(mRx + mTx), `下行 ${fmtBytes(mRx)} · 上行 ${fmtBytes(mTx)}`);
      tMonth.setBar(0);
    }

    tProc.set(`${num(d.processes) ?? '—'}`,
      `TCP ${num(d.tcp_conn) ?? '—'} · UDP ${num(d.udp_conn) ?? '—'}`);

    tSys.set(d.os ? shortOS(d.os) : '—', [d.arch, d.kernel_version].filter(Boolean).join(' · '), d.os);

    tUptime.set(fmtUptime(d.boot_time),
      d.boot_time ? `启动于 ${fmtDateTime(num(d.boot_time))}` : '');

    ipV4.className = `ip-badge${ipReachable(d.ip_v4) ? ' ok' : ''}`;
    ipV4.textContent = `IPv4 ${ipReachable(d.ip_v4) ? '可达' : '不可达'}`;
    ipV6.className = `ip-badge${ipReachable(d.ip_v6) ? ' ok' : ''}`;
    ipV6.textContent = `IPv6 ${ipReachable(d.ip_v6) ? '可达' : '不可达'}`;

    for (const c of pingCells) {
      c.ref.set(d[`ping_${c.key}`], d[`loss_${c.key}`]);
    }

    const gpus = parseGPU(d.gpu_info);
    if (gpus.length) {
      gpuTile.el.style.display = '';
      gpuTile.set(
        gpus.map((g) => `${g.name}${g.info != null ? ` · ${fmtPct(g.info, 0)}` : ''}`).join('\n'),
        `${gpus.length} 块 GPU`,
      );
    } else {
      gpuTile.el.style.display = 'none';
    }

    const billRows = [];
    if (sysConfig.show_price) {
      const p = priceText(d.price, d.currency);
      if (p) {
        billRows.push(['价格', p === '免费' ? p : `${p} / ${billingText(d.billing_cycle)}`]);
        billRows.push(['自动续费', String(d.auto_renewal) === '1' ? '已开启' : '已关闭']);
      }
    }
    if (sysConfig.show_expire && d.expire_date) {
      const days = daysUntil(d.expire_date);
      billRows.push(['到期时间', d.expire_date]);
      if (days != null) billRows.push(['剩余', days < 0 ? `已过期 ${-days} 天` : `${days} 天`]);
    }
    if (sysConfig.show_tf && d.traffic_limit) {
      billRows.push(['流量限额', d.traffic_limit]);
    }
    if (billRows.length) {
      billTile.style.display = '';
      billBox.textContent = '';
      billRows.forEach(([k, v]) =>
        billBox.append(
          el('div', { class: 'kv-row' }, el('span', { class: 'k', text: k }), el('span', { class: 'v mono', text: v })),
        ),
      );
    } else {
      billTile.style.display = 'none';
    }
  }

  renderHead(srv);
  renderTiles(srv);

  // ----- 图表区 -----
  const chartsGrid = el('div', { class: 'charts-grid' });
  const rangeSeg = el('div', { class: 'seg' });
  const rangeBtns = new Map();
  // 时间范围全部展示，是否可取由后端判定（游客 hours>1 会 401，走兜底提示）
  for (const r of RANGES) {
    const b = el('button', { class: 'seg-btn', text: r.label, dataset: { hours: String(r.hours) } });
    b.addEventListener('click', () => loadRange(r.hours));
    rangeBtns.set(r.hours, b);
    rangeSeg.append(b);
  }

  const chartsHead = el(
    'div',
    { class: 'charts-head' },
    el('h3', { class: 'charts-title', text: '趋势' }),
    rangeSeg,
  );

  const charts = {
    cpu: chartCard(chartsGrid, 'CPU', [{ key: 'cpu', label: 'CPU', color: COLORS.teal }], {
      yMax: 100, yFormat: (v) => `${v.toFixed(0)}%`,
    }),
    ram: chartCard(
      chartsGrid,
      '内存·Swap',
      [
        { key: 'ram', label: '内存', color: COLORS.blue },
        { key: 'swap', label: 'Swap', color: COLORS.purple },
      ],
      { yMax: 100, yFormat: (v) => `${v.toFixed(0)}%` },
    ),
    disk: chartCard(chartsGrid, '磁盘', [{ key: 'disk', label: '磁盘', color: COLORS.amber }], {
      yMax: 100, yFormat: (v) => `${v.toFixed(0)}%`,
    }),
    diskio: chartCard(
      chartsGrid,
      '磁盘 IO',
      [
        { key: 'diskRead', label: '读取', color: COLORS.green },
        { key: 'diskWrite', label: '写入', color: COLORS.purple },
      ],
      { yMax: null, yFormat: (v) => `${fmtBytes(v)}/s` },
    ),
    net: chartCard(
      chartsGrid,
      '网络',
      [
        { key: 'netIn', label: '下行', color: COLORS.green },
        { key: 'netOut', label: '上行', color: COLORS.blue },
      ],
      { yMax: null, yFormat: (v) => fmtBytes(v) },
    ),
    ping: chartCard(
      chartsGrid,
      'Ping',
      [
        { key: 'pingCt', label: '电信', color: COLORS.red },
        { key: 'pingCu', label: '联通', color: COLORS.amber },
        { key: 'pingCm', label: '移动', color: COLORS.blue },
        { key: 'pingBd', label: 'BGP', color: COLORS.purple },
      ],
      { yMax: null, area: false, yFormat: (v) => `${v.toFixed(0)} ms` },
    ),
    load: chartCard(
      chartsGrid,
      '负载',
      [
        { key: 'load1', label: '1分', color: COLORS.teal },
        { key: 'load5', label: '5分', color: COLORS.pink },
        { key: 'load15', label: '15分', color: COLORS.purple },
      ],
      { yMax: null, area: false, yFormat: (v) => v.toFixed(2) },
    ),
  };

  const CHART_SERIES = {
    cpu: [{ key: 'cpu', label: 'CPU', color: COLORS.teal }],
    ram: [
      { key: 'ram', label: '内存', color: COLORS.blue },
      { key: 'swap', label: 'Swap', color: COLORS.purple },
    ],
    disk: [{ key: 'disk', label: '磁盘', color: COLORS.amber }],
    diskio: [
      { key: 'diskRead', label: '读取', color: COLORS.green },
      { key: 'diskWrite', label: '写入', color: COLORS.purple },
    ],
    net: [
      { key: 'netIn', label: '下行', color: COLORS.green },
      { key: 'netOut', label: '上行', color: COLORS.blue },
    ],
    ping: [
      { key: 'pingCt', label: '电信', color: COLORS.red },
      { key: 'pingCu', label: '联通', color: COLORS.amber },
      { key: 'pingCm', label: '移动', color: COLORS.blue },
      { key: 'pingBd', label: 'BGP', color: COLORS.purple },
    ],
    load: [
      { key: 'load1', label: '1分', color: COLORS.teal },
      { key: 'load5', label: '5分', color: COLORS.pink },
      { key: 'load15', label: '15分', color: COLORS.purple },
    ],
  };

  let currentHours = 1;
  let longLocked = false;

  // ----- 实时模式（hours=0）：秒级样本环形缓冲，最多 60 点 -----
  const LIVE_MAX_POINTS = 60;
  const liveData = {
    cpu: [], ram: [], swap: [], disk: [],
    diskRead: [], diskWrite: [],
    netIn: [], netOut: [],
    pingCt: [], pingCu: [], pingCm: [], pingBd: [],
    load1: [], load5: [], load15: [],
  };

  function appendLiveSample(d, ts) {
    if (!ts) return;
    const mapped = mapRows([{ ...d, timestamp: ts }]);
    for (const [key, pts] of Object.entries(mapped)) {
      const arr = liveData[key];
      if (!arr) continue;
      arr.push(...pts);
      if (arr.length > LIVE_MAX_POINTS) arr.splice(0, arr.length - LIVE_MAX_POINTS);
    }
  }

  function applyLiveToCharts() {
    for (const [cid, chart] of Object.entries(charts)) {
      chart.setSeries(CHART_SERIES[cid].map((d) => ({ ...d, data: liveData[d.key] })));
    }
  }

  function syncRangeBtns() {
    for (const [h, b] of rangeBtns) b.classList.toggle('active', h === currentHours);
  }

  async function loadRange(hours) {
    // 实时模式：不发历史请求，直接展示已累积的秒级样本
    if (hours === 0) {
      currentHours = 0;
      syncRangeBtns();
      applyLiveToCharts();
      return;
    }
    // 访客上限 24h（服务端强制 401）：未登录点击更长范围直接提示，不发必败的请求
    if (hours > 24 && !getAuthToken()) {
      toast('非登录最多查询 24 小时数据，请先登录');
      syncRangeBtns();
      return;
    }
    currentHours = hours;
    syncRangeBtns();
    try {
      const rows = await getHistory(id, hours);
      const mapped = mapRows(rows);
      for (const [cid, chart] of Object.entries(charts)) {
        chart.setSeries(CHART_SERIES[cid].map((d) => ({ ...d, data: mapped[d.key] })));
      }
    } catch (err) {
      if (err.status === 401 && hours > 24) {
        toast('非登录最多查询 24 小时数据，请先登录');
        if (currentHours > 24) loadRange(24);
      } else if (err.status === 409) {
        toast('历史数据库需要升级，请联系管理员');
      } else {
        toast('历史数据加载失败');
      }
    }
  }

  // ----- 组装 -----
  view.textContent = '';
  view.append(backBtn, head, tilesGrid, chartsHead, chartsGrid);
  loadRange(0.167);

  // ----- WebSocket 实时刷新（全局统一 1s tick 回放） -----
  // 刷新头部芯片与磁贴；样本同时进入实时环形缓冲（60 点），
  // 「实时」范围下趋势图随样本逐点追加，其余范围保持静态
  const playback = new Playback(
    (serverId, data, ts, displayTs, meta) => {
      if (serverId !== id) return;
      Object.assign(srv, data);
      appendLiveSample(data, ts);
      if (currentHours === 0) applyLiveToCharts();
      // 在线判定使用批次上报时间（对齐官方 last_updated = report_timestamp）
      srv.last_updated = meta && meta.reportTs ? meta.reportTs : serverNow();
      srv.sample_ts = ts;
      srv.display_ts = displayTs;
      srv.report_ts = meta ? meta.reportTs : null;
      srv.batch_size = meta ? meta.batchSize : 1;
    },
    () => {
      // onTick：同步展示时钟（(+Ns) 每秒增长），再统一驱动头部芯片 + 磁贴刷新
      const c = playback.displayTs(id);
      if (c && srv.sample_ts) srv.display_ts = c;
      renderHead(srv);
      renderTiles(srv);
    },
    { isOnline: () => isOnline(srv) },
  );
  // 以 /api/server 已合并的指标时间为种子，避免首批实时消息重复回放已展示数据；
  // 同时让时间芯片立即显示（对齐首页 seed 行为）
  const seedTs = normalizeTs(srv.sample_ts ?? srv.sample_timestamp ?? srv.last_updated, null);
  if (seedTs) {
    playback.seed(id, seedTs);
    srv.sample_ts = seedTs;
    srv.display_ts = seedTs;
    appendLiveSample(srv, seedTs);
  }
  // 详情页初始回放：/api/server 返回的 latestReportUpdates（对齐官方 2ec4518）
  for (const u of srv.latestReportUpdates || []) {
    playback.queue(u.serverId, u.samples, u.reportTs, {
      replayCachedReport: true,
      reportAgeMs: u.reportAgeMs,
    });
  }
  playback.start();

  // 前端 WSS 超时（站点配置 frontend_ws_timeout_minutes，0 = 不超时）
  let socket = null;
  const wsTimeout = wsTimeoutDialog({
    onClose: () => socket && socket.close(),
    onContinue: () => socket && socket.reconnect(),
  });

  socket = new MetricSocket({
    scope: id,
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
      for (const chart of Object.values(charts)) chart.destroy();
    },
  };
}

