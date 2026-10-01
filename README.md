# Pulse-fork

适用于 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor) 的服务器监控主题，基于 [Pulse](https://github.com/loongkong/cf-server-monitor-theme-pulse) 修改。

## 功能

- 蓝紫色界面，支持深色、浅色与移动端布局。
- 服务器状态、资源占用、网络流量与历史趋势展示。
- 条形、圆环、表格三种展示方式。
- 关键词搜索、地区筛选、匹配台数与一键清除筛选。

## 本地预览

需要 Python 3 和可访问的 CF-Server-Monitor 服务，无需安装额外 Python 依赖。

1. 复制配置模板：

   ```bash
   cp dev_config.example.py dev_config.py
   ```

2. 编辑 `dev_config.py`，将 `UPSTREAM_HOST` 设置为上游域名（不带协议或路径）。`JWT_TOKEN` 可留空，需要登录权限时再填写。
3. 在项目目录启动：

   ```bash
   python dev_proxy.py
   ```

4. 打开 [http://127.0.0.1:8788/#](http://127.0.0.1:8788/#)。启动后终端会显示访问地址，按 `Ctrl+C` 停止服务。

代理通过 HTTPS / WSS 连接上游，并提供本地静态页面与 API 转发。`dev_config.py` 已被 Git 忽略，请勿提交其中的登录凭证。

## 项目结构

- `index.html`：页面入口。
- `assets/css/`、`assets/js/`：主题样式与交互逻辑。
- `dev_proxy.py`：本地预览代理，仅用于开发调试。
- `dev_config.example.py`：代理配置模板。

项目地址：[lovebai/cf-server-monitor-theme-pulse](https://github.com/lovebai/cf-server-monitor-theme-pulse)。
