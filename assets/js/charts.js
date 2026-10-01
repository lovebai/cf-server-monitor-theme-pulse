// 轻量 SVG 折线图组件（零依赖，CSP 友好）：
// - 多序列、空值断线、渐变面积填充
// - 悬浮十字线 + tooltip
// - ResizeObserver 自适应宽度

import {el, fmtClock, fmtDateTime, fmtTimeShort, serverNow, svg} from './utils.js?v=1.3.0';

let chartUid = 0;

function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  if (v <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
  const nice = steps.find((s) => n <= s) || 10;
  return nice * p;
}

export class LineChart {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {function} opts.yFormat  y 轴/提示框数值格式化
   * @param {number|null} opts.yMin  固定 y 下限（默认 0）
   * @param {number|null} opts.yMax  固定 y 上限（如 100）
   * @param {number} opts.height     图表高度 px
   * @param {boolean} opts.area      是否绘制渐变面积
   */
  constructor(container, opts = {}) {
    this.c = container;
    this.o = Object.assign(
      { yFormat: (v) => String(Math.round(v * 10) / 10), yMin: 0, yMax: null, height: 190, area: true },
      opts,
    );
    this.series = [];
    this._uid = ++chartUid;
    this._scale = null;
    this._hoverG = null;

    this.c.classList.add('probe-chart');
    this.svg = svg('svg', { width: '100%', height: this.o.height, role: 'img' });
    this.tip = el('div', { class: 'chart-tip' });
    this.tip.style.display = 'none';
    this.c.append(this.svg, this.tip);

    this._ac = new AbortController();
    const sig = { signal: this._ac.signal };
    this.c.addEventListener('mousemove', (e) => this._onMove(e), sig);
    this.c.addEventListener('mouseleave', () => this._hideHover(), sig);

    this._ro = new ResizeObserver(() => this._draw());
    this._ro.observe(this.c);
  }

  /** series: [{ key, label, color, data: [{x: ms, y: number|null}] }] */
  setSeries(series) {
    this.series = series;
    this._draw();
  }

  destroy() {
    this._ac.abort();
    this._ro.disconnect();
  }

  // ---------- 内部 ----------

  _draw() {
    const W = this.c.clientWidth || 320;
    const H = this.o.height;
    const P = { l: 48, r: 12, t: 10, b: 24 };
    const iw = W - P.l - P.r;
    const ih = H - P.t - P.b;

    while (this.svg.firstChild) this.svg.firstChild.remove();
    this._hoverG = null;
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMaxSeen = -Infinity;
    let hasData = false;
    for (const s of this.series) {
      for (const p of s.data) {
        hasData = true;
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.y != null && p.y > yMaxSeen) yMaxSeen = p.y;
      }
    }
    if (!hasData) {
      xMax = serverNow();
      xMin = xMax - 3_600_000;
      yMaxSeen = 0;
    }
    if (xMax - xMin < 60_000) xMin = xMax - 60_000;

    const lo = this.o.yMin != null ? this.o.yMin : 0;
    const hi = this.o.yMax != null ? this.o.yMax : niceMax(yMaxSeen * 1.15);
    const X = (x) => P.l + ((x - xMin) / (xMax - xMin)) * iw;
    const Y = (y) => P.t + ih - ((y - lo) / (hi - lo)) * ih;
    this._scale = { X, Y, xMin, xMax, P, W, H, span: xMax - xMin };

    // 网格 + y 轴标签
    for (let i = 0; i <= 4; i += 1) {
      const yv = lo + ((hi - lo) * i) / 4;
      const y = Y(yv);
      this.svg.append(svg('line', { x1: P.l, y1: y, x2: W - P.r, y2: y, class: 'grid-line' }));
      this.svg.append(
        svg('text', { x: P.l - 6, y: y + 3.5, 'text-anchor': 'end', class: 'axis-label' }, this.o.yFormat(yv)),
      );
    }

    // x 轴时间标签：≤10 分钟的窗口（实时模式）精确到秒
    const span = xMax - xMin;
    const xFmt = span > 86_400_000 ? fmtDateTime : span > 600_000 ? fmtTimeShort : fmtClock;
    for (let i = 0; i <= 4; i += 1) {
      const xv = xMin + (span * i) / 4;
      this.svg.append(
        svg('text', { x: X(xv), y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, xFmt(xv)),
      );
    }

    if (!hasData) {
      this.svg.append(
        svg(
          'text',
          { x: P.l + iw / 2, y: P.t + ih / 2, 'text-anchor': 'middle', class: 'chart-empty' },
          '暂无数据',
        ),
      );
      return;
    }

    // 渐变定义
    const defs = svg('defs');
    this.series.forEach((s, i) => {
      const gid = `grad-${this._uid}-${i}`;
      const lg = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' });
      lg.append(svg('stop', { offset: '0%', 'stop-color': s.color, 'stop-opacity': '0.20' }));
      lg.append(svg('stop', { offset: '100%', 'stop-color': s.color, 'stop-opacity': '0' }));
      defs.append(lg);
      s._gid = gid;
    });
    this.svg.append(defs);

    // 序列路径（y 为 null 时断线）
    const baseY = Y(lo);
    for (const s of this.series) {
      const points = [...s.data].sort((a, b) => a.x - b.x);
      let lineD = '';
      let areaD = '';
      let open = false;
      for (const p of points) {
        if (p.y == null) {
          if (open) {
            areaD += `L${X(p.x).toFixed(1)},${baseY.toFixed(1)}Z`;
            open = false;
          }
          continue;
        }
        const px = X(p.x).toFixed(1);
        const py = Y(p.y).toFixed(1);
        if (!open) {
          lineD += `M${px},${py}`;
          areaD += `M${px},${baseY.toFixed(1)}L${px},${py}`;
          open = true;
        } else {
          lineD += `L${px},${py}`;
          areaD += `L${px},${py}`;
        }
      }
      if (open) {
        const lastX = X(points[points.length - 1].x).toFixed(1);
        areaD += `L${lastX},${baseY.toFixed(1)}Z`;
      }
      if (this.o.area && areaD) {
        this.svg.append(svg('path', { d: areaD, fill: `url(#${s._gid})`, stroke: 'none' }));
      }
      if (lineD) {
        this.svg.append(
          svg('path', {
            d: lineD,
            fill: 'none',
            stroke: s.color,
            'stroke-width': '1.6',
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
          }),
        );
      }
    }
  }

  _nearest(data, x, tol) {
    let best = null;
    let bd = Infinity;
    for (const p of data) {
      const d = Math.abs(p.x - x);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return bd <= tol ? best : null;
  }

  _onMove(e) {
    if (!this._scale) return;
    const { X, Y, xMin, xMax, P, W, H } = this._scale;
    const rect = this.c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const iw = W - P.l - P.r;
    if (mx < P.l || mx > W - P.r) {
      this._hideHover();
      return;
    }
    const xv = xMin + ((mx - P.l) / iw) * (xMax - xMin);
    const ref = this.series.find((s) => s.data.length);
    if (!ref) return;
    const anchor = this._nearest(ref.data, xv, (xMax - xMin) / 120);
    if (!anchor) {
      this._hideHover();
      return;
    }
    const hx = X(anchor.x);

    if (this._hoverG) this._hoverG.remove();
    const g = svg('g');
    g.append(svg('line', { x1: hx, y1: P.t, x2: hx, y2: H - P.b, class: 'chart-cross' }));

    const tol = (xMax - xMin) / 120;
    const rows = [];
    for (const s of this.series) {
      const p = this._nearest(s.data, anchor.x, tol);
      if (!p || p.y == null) continue;
      g.append(svg('circle', { cx: hx, cy: Y(p.y), r: '3.2', fill: s.color, class: 'chart-dot' }));
      rows.push({ color: s.color, label: s.label, value: this.o.yFormat(p.y) });
    }
    this.svg.append(g);
    this._hoverG = g;

    this.tip.textContent = '';
    const tipFmt = this._scale.span > 600_000 ? fmtDateTime : fmtClock;
    this.tip.append(el('div', { class: 'chart-tip-time', text: tipFmt(anchor.x) }));
    for (const r of rows) {
      const dotEl = el('i', { class: 'chip-dot' });
      dotEl.style.backgroundColor = r.color;
      this.tip.append(
        el(
          'div',
          { class: 'chart-tip-row' },
          dotEl,
          el('span', { class: 'l', text: r.label }),
          el('b', { class: 'v mono', text: r.value }),
        ),
      );
    }
    this.tip.style.display = 'block';
    const tw = this.tip.offsetWidth || 140;
    let left = hx + 14;
    if (left + tw > W) left = hx - tw - 14;
    this.tip.style.left = `${Math.max(4, left)}px`;
    this.tip.style.top = '10px';
  }

  _hideHover() {
    this.tip.style.display = 'none';
    if (this._hoverG) {
      this._hoverG.remove();
      this._hoverG = null;
    }
  }
}

