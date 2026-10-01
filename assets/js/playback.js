// 批量上报回放引擎（对齐官方前端 Dashboard.vue queueLiveSamples + advanceServerClocks）
//
// 探针按 collect_interval 采集、report_interval 批量上报，一次 batchUpdate
// 最多携带 300 个样本（缓冲上限 600）。回放引擎为每台服务器维护一个
// 「展示时钟」displayTs：在线时随 wall clock 前进，样本在展示时钟越过
// 其采集时刻时被应用。lag = displayTs - sampleTs，因此 (+Ns) 每秒增长，
// 直到下一个样本应用时回落（官方 dataTimeText 行为）。
//
// 初始加载的 latestReportUpdates 走与 WebSocket 实时消息相同的回放管线，
// 仅以 reportAgeMs 把整批样本平移到「它刚到达」的时间线上
// （回放游标 = 首样本 ts + reportAgeMs）。
//
// 全局统一节拍：整个视图只有这一个 1s 定时器，展示时钟前进、样本应用、
// (+Ns) 滞后文本、在线状态刷新全部在同一个 tick 上发生，所有卡片以完全
// 相同的频率变化，避免各服务器各自计时导致的杂乱跳变。

import {serverNow} from './utils.js?v=1.3.1';

const MAX_BUFFER_SAMPLES = 600;
const TICK_MS = 1000;

/** 时间戳归一化：秒 → 毫秒；兼容数字字符串与日期字符串 */
export function normalizeTs(value, fallback = null) {
  const ts = Number(value);
  if (Number.isFinite(ts) && ts > 0) return ts < 10_000_000_000 ? ts * 1000 : ts;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class Playback {
  /**
   * @param {function} applySample (serverId, data, sampleTs, displayTs, meta) => void
   *   样本应用：sampleTs 为归一化采集时间（毫秒），displayTs 为展示时钟当前位置
   * @param {function} onTick (now) => void
   *   每个 tick 驱动视图刷新（展示时钟同步 / 滞后文本 / 在线状态 / 统计）
   * @param {object} [opts]
   * @param {function} [opts.isOnline] (serverId) => boolean
   *   在线判定；仅在线服务器的展示时钟随 wall clock 前进（对齐官方）
   */
  constructor(applySample, onTick, { isOnline } = {}) {
    this.applySample = applySample;
    this.onTick = typeof onTick === 'function' ? onTick : () => {};
    this.isOnline = typeof isOnline === 'function' ? isOnline : () => true;
    this.buffers = new Map(); // serverId -> 待回放样本 [{ts, data}]
    this.cursors = new Map(); // serverId -> 展示时钟 displayTs
    this.lastSampleTs = new Map(); // serverId -> 最后应用的样本采集时刻
    this.meta = new Map(); // serverId -> { reportTs, batchSize }
    this.lastTick = null;
    this.timer = null;
    this._tick = this._tick.bind(this);
  }

  /**
   * 用 /api/servers 已合并的指标时间做种子，避免首批实时消息把
   * 页面已展示的数据再回放一遍（官方以服务器当前 sample_ts 过滤）。
   * 同时把展示时钟播种到该时刻（官方 mergeServersIntoList 行为）：
   * 无缓存批次可回放的在线服务器也立即显示时间行，lag 随 tick 增长
   */
  seed(serverId, sampleTs) {
    const ts = normalizeTs(sampleTs, null);
    if (!serverId || !ts) return;
    this.lastSampleTs.set(serverId, ts);
    if (!this.cursors.has(serverId)) this.cursors.set(serverId, ts);
  }

  /** 当前展示时钟（视图在 tick 上同步 display_ts，使 (+Ns) 每秒增长） */
  displayTs(serverId) {
    return this.cursors.get(serverId) ?? null;
  }

  /**
   * 将一批样本排入回放队列
   * @param {string} serverId
   * @param {Array} rawSamples batchUpdate 的 samples（元素可取 data/payload/metrics）
   * @param {number|string} msgTs 上报时间（兜底）
   * @param {object} [opts]
   * @param {boolean} [opts.replayCachedReport] 回放 latestReportUpdates 缓存批次：
   *   不按已应用样本过滤，游标 = 首样本 ts + reportAgeMs
   * @param {number} [opts.reportAgeMs] 缓存批次距今的毫秒数
   */
  queue(serverId, rawSamples, msgTs, { replayCachedReport = false, reportAgeMs = 0 } = {}) {
    if (!serverId || !Array.isArray(rawSamples) || !rawSamples.length) return;

    const events = [];
    for (const s of rawSamples) {
      if (!s || typeof s !== 'object') continue;
      const data = s.data || s.payload || s.metrics;
      if (!data) continue;
      const ts = normalizeTs(
        s.ts ?? s.timestamp ?? data.last_updated ?? data.timestamp ?? msgTs,
        null,
      );
      if (!ts) continue;
      events.push({ ts, data });
    }
    if (!events.length) return;

    // 客户端时钟修正：reportTs 是服务端接收时刻（可信），
    // 批次最新样本≈采集于上报瞬间，两者之差即探针时钟偏移。
    // |偏移| ≥ 5s 才修正（更小的视为网络延迟），滞后/偏快都会平移回正
    const reportMs = normalizeTs(msgTs, null);
    if (reportMs) {
      let newest = 0;
      for (const e of events) if (e.ts > newest) newest = e.ts;
      const skew = reportMs - newest;
      if (newest && Math.abs(skew) >= 5000) {
        for (const e of events) e.ts += skew;
      }
    }

    // 实时消息跳过已展示过的样本；缓存批次回放不过滤（对齐官方 replayCachedReport）
    const lastTs = this.lastSampleTs.get(serverId);
    const incoming = replayCachedReport
      ? events
      : events.filter((e) => !lastTs || e.ts > lastTs);
    if (!incoming.length) return;

    // 按采集时间排序、去重、限量
    incoming.sort((a, b) => a.ts - b.ts);
    const seen = new Set();
    const unique = [];
    for (const e of incoming) {
      if (seen.has(e.ts)) continue;
      seen.add(e.ts);
      unique.push(e);
    }
    const buf = unique.slice(-MAX_BUFFER_SAMPLES);

    // 批次元信息：上报时间与样本数（单样本批次不展示上报时间）
    this.meta.set(serverId, {
      reportTs: normalizeTs(msgTs, serverNow()),
      batchSize: buf.length,
    });

    // 回放游标（对齐官方 resolvePlaybackCursor）：
    // 缓存批次 = 首样本 ts + reportAgeMs（把批次平移到当前时间线）；
    // 实时批次 = max(首样本 ts, 当前展示时钟)
    const first = buf[0].ts;
    let cursor;
    if (replayCachedReport) {
      cursor = first + Math.max(0, Number(reportAgeMs) || 0);
    } else {
      const current = this.cursors.get(serverId);
      cursor = current == null ? first : Math.max(first, current);
    }

    // 单样本批次直接应用（丢弃尚未回放的旧样本）；
    // 缓存的单点没有批次时间线可还原，按普通单点上报处理：
    // 展示该点采集时刻（游标从样本 ts 起步），滞后从打开页面起随 tick 增长
    if (buf.length === 1) {
      this.buffers.delete(serverId);
      this._apply(serverId, buf[0], replayCachedReport ? buf[0].ts : cursor);
      return;
    }

    // 新批次到达时丢弃该服务器尚未回放的旧样本
    this.buffers.set(serverId, buf);
    this.cursors.set(serverId, cursor);
    this._drain(serverId);
    this._ensureTimer();
  }

  /** 启动全局节拍（每个视图仅此一个定时器） */
  start() {
    this._ensureTimer();
  }

  _ensureTimer() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(this._tick, TICK_MS);
  }

  _apply(serverId, event, displayTs) {
    this.lastSampleTs.set(serverId, event.ts);
    this.cursors.set(serverId, displayTs);
    this.applySample(serverId, event.data, event.ts, displayTs, this.meta.get(serverId));
  }

  /** 应用展示时钟已越过的样本 */
  _drain(serverId) {
    const buf = this.buffers.get(serverId);
    if (!buf) return;
    const cursor = this.cursors.get(serverId) ?? 0;
    while (buf.length && buf[0].ts <= cursor) {
      this._apply(serverId, buf.shift(), cursor);
    }
    if (!buf.length) this.buffers.delete(serverId);
  }

  /**
   * 全局 1s tick：在线服务器的展示时钟随 wall clock 前进
   * （官方 advanceServerClocks），再应用到期样本，最后统一刷新界面
   */
  _tick() {
    const now = Date.now();
    const elapsed = this.lastTick == null ? TICK_MS : Math.max(0, now - this.lastTick);
    this.lastTick = now;
    for (const serverId of [...this.cursors.keys()]) {
      if (this.isOnline(serverId)) {
        this.cursors.set(serverId, this.cursors.get(serverId) + elapsed);
      }
      this._drain(serverId);
    }
    this.onTick(now);
  }

  destroy() {
    clearInterval(this.timer);
    this.timer = null;
    this.buffers.clear();
    this.cursors.clear();
    this.lastSampleTs.clear();
    this.meta.clear();
  }
}
