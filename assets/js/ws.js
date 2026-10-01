// WebSocket 实时推送客户端：/api/ws
// - subscribe=all 时需在连接后发送 {type:'subscribe', ids:[...]} 限定范围
// - 自动心跳（ping 25s）、指数退避重连
// - 对齐官方 2.8.4：连接寿命超时（frontend_ws_timeout_minutes）到期断开并回调，
//   等待用户选择继续/关闭；页面隐藏时挂起连接（省 DO 时长），可见时恢复
// - 跨域 API 基座时把管理端 JWT 拼到 WS URL（官方同 Host 免带，跨域必须带）
// - batchUpdate 的服务端时间戳同时用于校准全局服务器时钟（见 utils.syncServerTime）

import {normalizeWsTimeoutMinutes, syncServerTime} from './utils.js?v=1.3.0';

export class MetricSocket {
  /**
   * @param {object} opts
   * @param {string} opts.scope  'all' 或具体 serverId
   * @param {string[]} opts.ids  scope=all 时的服务器过滤列表
   * @param {function} opts.onBatch  (batchUpdate 消息) => void
   * @param {function} opts.onState  ('connecting'|'open'|'closed') => void
   * @param {function} opts.onTimeout  连接寿命到期回调（视图弹确认框）
   * @param {number} opts.timeoutMinutes  连接寿命（分钟），0 = 不超时
   */
  constructor({ scope = 'all', ids = [], onBatch, onState, onTimeout, timeoutMinutes } = {}) {
    this.scope = scope;
    this.ids = ids;
    this.onBatch = onBatch || (() => {});
    this.onState = onState || (() => {});
    this.onTimeout = onTimeout || (() => {});
    this._lifeMs = normalizeWsTimeoutMinutes(timeoutMinutes) * 60_000;
    this._closed = false;
    this._expired = false; // 寿命到期，等待用户选择（期间不重连）
    this._suspended = false; // 页面隐藏挂起（回可见时恢复）
    this._retry = 0;
    this._ws = null;
    this._timer = null;
    this._pingTimer = null;
    this._lifeTimer = null;
    this._onVisibility = () => {
      if (document.visibilityState === 'hidden') this._suspend();
      else this._resume();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    this._connect();
  }

  _url() {
    const base = (window.__API_BASE__ || '').replace(/\/$/, '');
    let u;
    if (/^https?:/.test(base)) u = `${base.replace(/^http/, 'ws')}/api/ws`;
    else u = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`;
    const url = new URL(u);
    url.searchParams.set('subscribe', this.scope);
    // 跨 Host 时 WS 无法同源鉴权，显式带 token（对齐官方 isSameHostWebSocket）
    if (url.host !== location.host) {
      let token = null;
      try {
        token = localStorage.getItem('jwt_token') || localStorage.getItem('token');
      } catch {
        /* ignore */
      }
      if (token) url.searchParams.set('token', token);
    }
    return url.toString();
  }

  _connect() {
    if (this._closed || this._expired) return;
    this._suspended = false;
    this.onState('connecting');
    let ws;
    try {
      ws = new WebSocket(this._url());
    } catch {
      this._schedule();
      return;
    }
    this._ws = ws;

    ws.onopen = () => {
      this._retry = 0;
      this.onState('open');
      // 对齐官方：连接建立后总是发送 subscribe（含具体 scope 与 ids 过滤），
      // 服务端据此更新订阅附件并提示探针进入实时上报
      this._sendSubscribe();
      this._pingTimer = setInterval(() => this._send({ type: 'ping' }), 25_000);
      // 连接寿命计时：到期断开并等待用户选择（对齐官方 connectionLifetimeTimer）
      clearTimeout(this._lifeTimer);
      if (this._lifeMs > 0) {
        this._lifeTimer = setTimeout(() => this._expire(), this._lifeMs);
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.type === 'batchUpdate') {
        if (msg.ts) syncServerTime(msg.ts);
        this.onBatch(msg);
      }
    };

    ws.onclose = () => {
      this._cleanupPing();
      clearTimeout(this._lifeTimer);
      if (!this._closed && !this._expired && !this._suspended) this._schedule();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  _expire() {
    this._expired = true;
    this._disconnect();
    this.onState('closed');
    this.onTimeout({ durationMs: this._lifeMs });
  }

  _disconnect() {
    this._cleanupPing();
    clearTimeout(this._lifeTimer);
    clearTimeout(this._timer);
    try {
      if (this._ws) this._ws.close();
    } catch {
      /* ignore */
    }
  }

  _suspend() {
    if (this._closed || this._expired) return;
    this._suspended = true;
    this._disconnect();
    this.onState('closed');
  }

  _resume() {
    if (this._closed || this._expired) return;
    this._suspended = false;
    if (!this._ws || this._ws.readyState > 1) {
      clearTimeout(this._timer);
      this._retry = 0;
      this._connect();
    }
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(obj));
    }
  }

  _sendSubscribe() {
    this._send({ type: 'subscribe', scope: this.scope, ids: this.ids.slice(0, 500) });
  }

  setIds(ids) {
    this.ids = ids;
    if (this._ws && this._ws.readyState === WebSocket.OPEN) this._sendSubscribe();
  }

  _schedule() {
    this.onState('closed');
    const delay = Math.min(30_000, 1000 * 2 ** this._retry);
    this._retry += 1;
    this._timer = setTimeout(() => this._connect(), delay);
  }

  _cleanupPing() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }

  /** 超时弹窗选「继续」：清除到期标记并立即重连 */
  reconnect() {
    if (this._closed) return;
    this._expired = false;
    this._retry = 0;
    this._disconnect();
    this._connect();
  }

  close() {
    this._closed = true;
    this._disconnect();
    document.removeEventListener('visibilitychange', this._onVisibility);
  }
}
