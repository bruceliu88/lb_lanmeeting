# LanMeeting — WebRTC P2P 会议 MVP

基于 WebRTC 的点对点会议原型：公网/内网信令服务器 + 浏览器 Mesh 互联。媒体与文件经 P2P（必要时由 TURN 中继）。

详细架构与路线图见 Project 文档：`docs/webrtc-p2p-meeting-plan.md`（Cursor Project Store）。

## 功能（MVP）

- 房间加入（WebSocket 信令）
- 音视频：`getUserMedia` + Full Mesh `RTCPeerConnection`
- 即时消息：RTCDataChannel（JSON）
- 文件：DataChannel 分块 + Base64 原型
- `GET /api/ice`：STUN/TURN 配置（环境变量）

## 本地运行

```bash
cd /path/to/lb_lanmeeting
npm install
npm start
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。开两个标签页，使用**相同房间 ID** 即可互连。

开发模式（自动重载信令进程）：

```bash
npm run dev
```

### 可选环境变量

| 变量 | 说明 |
|------|------|
| `PORT` | 默认 `3000` |
| `ROOM_SECRET` | 设置后 join 需 HMAC 令牌；`GET /api/room-token?roomId=` 生成 |
| `MAX_PEERS_PER_ROOM` | 默认 `8` |
| `STUN_URLS` | 逗号分隔，如 `stun:stun.example.com:3478` |
| `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | TURN 配置 |

## 跳板机部署（简要）

1. 安装 Node 20+，克隆仓库，`npm install`，用 `systemd` 或 Docker 运行 `npm start`。
2. 前方 Caddy/nginx 终止 TLS，反代 `http://127.0.0.1:3000`，WebSocket 升级路径 `/ws`。
3. 同机部署 **coturn**，防火墙放行 `3478` UDP/TCP 与 relay 端口段。
4. 设置 `STUN_URLS` / `TURN_*` 指向跳板公网域名或 IP。
5. 生产环境设置 `ROOM_SECRET`，仅通过带令牌链接入会。

## 与 `lanmeeting.md` 的关系

原稿为服务器推拉流模型；本仓库实现 **WebRTC P2P**，服务器不承担媒体转发（除 TURN）。