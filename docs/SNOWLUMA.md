# SnowLuma 对接方案

- 版本：0.2（对应 SnowLuma 2.2.0）
- 日期：2026-10-26
- 相关：[REQUIREMENTS.md](./REQUIREMENTS.md) 的 P-001 / P-006 / P-008

---

## 1. 先确认事实

| 项 | 事实 |
|---|---|
| 协议 | **OneBot v11**（标准动作 + 事件），不是私有协议 |
| 形态 | TypeScript 运行时，把 QQ 客户端会话桥接成 OneBot |
| 接入方式 | WebSocket 服务端 / 客户端、HTTP 服务端 / 上报，四种都有 |
| 默认端口 | OneBot **HTTP `3000`**、**WS `3001`**、WebUI `5099` |
| 多账号 | 一个 SnowLuma 实例可跑多个 QQ 号，各账号独立连接 |
| Action 数量 | 约 **73 个**，含标准 OneBot 之外的扩展 |
| 许可 | 源码可见**非商业**许可，自用没问题；商用或公开发布修改版需授权 |

**结论：不需要为 SnowLuma 写专用适配层。** 它就是标准 OneBot 11，我们的协议层按 v11 写即可。要额外处理的只有五件事，下面逐条说。

参考：[SnowLuma README](https://github.com/SnowLuma/SnowLuma)、[动作参考](https://snowluma.github.io/zh/docs/api)

---

## 2. 连接模式选型

SnowLuma 四种模式，我们的框架只需要支持前两种：

| 模式 | 谁连谁 | 适用 | 建议 |
|---|---|---|---|
| **正向 WS** | 框架 → `ws://host:3001` | SnowLuma 和框架同机/同局域网 | ✅ **默认** |
| 反向 WS | SnowLuma → 框架 | 框架有固定地址、SnowLuma 在内网 | 可选（P2） |
| HTTP 上报 | SnowLuma → 框架 `/onebot/event` | 无 WS 需求时 | 不做 |
| HTTP API | 框架 → `POST http://host:3000/{action}` | 大文件、调试、curl 验证 | 作为**兜底通道**保留 |

**为什么正向 WS 是默认**：SnowLuma 和 QQ 客户端必须在同一台 Windows 机器上，而框架大概率也在同一台或同一局域网。正向 WS 的连接方向最自然，防火墙也最少折腾。

**HTTP API 仍然值得留一条**：调试时 `curl -X POST http://127.0.0.1:3000/send_group_msg -d '{...}'` 比写代码快得多；另外大文件上传在 HTTP 上更顺手。

---

## 3. 配置结构

```toml
# config.toml
[[accounts]]
id            = "main"                      # 框架内部标识
ws_url        = "ws://127.0.0.1:3001"
access_token  = "xxxxxxxx"                  # SnowLuma 的 WS 令牌，没设就留空
http_url      = "http://127.0.0.1:3000"     # 可选，兜底调用
http_token    = "xxxxxxxx"                  # 可与 WS 令牌不同

# 第二个号：SnowLuma 多实例时端口会 +100 偏移
# [[accounts]]
# id            = "second"
# ws_url        = "ws://127.0.0.1:3101"
# access_token  = "yyyyyyyy"
```

要点：

- **`id` 由我们自己定**，不要用 QQ 号（QQ 号是运行后才拿到的）。
- 一个 `[[accounts]]` 对应一条 WS 连接、一个 `self_id`。
- **同一台 SnowLuma 不能被两个框架实例同时连**——会各自处理一遍消息。QQ-agent 的注释里专门记了这个坑（多实例要端口偏移）。

---

## 3.1 关闭内置 `#sl` 状态命令

SnowLuma 2.x 默认响应 `#sl`；不想让它抢消息，在账号配置里关掉：

```json
// config/onebot_<QQ号>.json
"statusCommand": {
  "enabled": false,
  "swallow": false,
  "cooldownSeconds": 5,
  "trigger": "#sl"
}
```

- `enabled=false`：完全不响应
- `swallow=true`：只回复、不转发给下游适配器（这里不需要）
- 改完重启 SnowLuma

## 4. 鉴权

OneBot 11 标准：

```
Authorization: Bearer <access_token>
```

- WS 握手时放在 Header 里。
- HTTP 调用同理，但 SnowLuma 允许 **WS 和 HTTP 用不同令牌**（`accessToken` / `httpAccessToken`），所以配置里分开写。
- 令牌留空 = 不鉴权，**只监听 127.0.0.1**。跨机部署时必须设。

---

## 5. 事件

### 5.1 收到的 `post_type`

| post_type | 子类型 | 用途 |
|---|---|---|
| `message` | `group` / `private` | 主链路 |
| `message_sent` | — | **必须丢弃**，否则机器人会响应自己 |
| `notice` | `group_upload` / `group_admin` / `group_decrease` / `group_increase` / `group_ban` / `friend_add` / `notify`(poke) | 插件事件 |
| `request` | `friend` / `group` | 加好友/加群申请 |
| `meta_event` | `lifecycle` / `heartbeat` | 探活 |

### 5.2 处理顺序（重要）

```
WS 帧 → 解析 JSON
      → 丢弃 message_sent
      → 丢弃 self_id 与当前账号不符的（多账号时）
      → 按 message_id + self_id 去重（LRU，5 分钟）
      → 归一化成 Event
      → 投递到调度器
```

### 5.3 事件过滤原则

**不要用 SnowLuma 侧的过滤**（它的 WebUI 有事件开关，但那是给人用的），框架必须自己按 `post_type` 和 `message_type` 过滤，这样换协议端行为一致。

---

## 6. Action 调用：透传 + 分级

### 6.1 协议层不做白名单

SnowLuma 有 73 个接口，还会随版本增加。**协议层实现成纯透传**：

```go
func (c *Client) Call(ctx context.Context, action string, params map[string]any) (json.RawMessage, error)
```

- 不做 action 名的本地枚举，不维护接口清单。
- 只在收到响应后判断 `retcode`（0 = 成功，非 0 = 转成 error 并带上 `message`/`wording`）。
- 每个调用带 `context.WithTimeout`，默认 10s。

### 6.2 权限层做分级

透传不等于放任。**在权限层**给 action 分四级，插件声明了自己能用到哪一级：

| 级别 | 代表接口 | 谁能调 |
|---|---|---|
| `read` | `get_login_info`、`get_group_list`、`get_group_member_list` | 所有插件，默认允许 |
| `write` | `send_group_msg`、`send_private_msg`、`delete_msg`、`set_group_card` | 声明 `permissions = ["onebot.write"]` |
| `admin` | `set_group_ban`、`set_group_kick`、`set_group_whole_ban`、`set_group_admin`、`set_essence_msg` | 声明 + owner 授权 |
| `dangerous` | `get_cookies`、`send_like`、`_send_group_notice`、`set_group_add_option` | **默认禁用**，需显式开启 |

`get_cookies` 尤其注意：它能拿到 QQ 登录态，等于账号接管。默认关死。

### 6.3 错误处理

```json
{ "status": "failed", "retcode": 100, "data": null, "message": "", "wording": "" }
```

- `retcode != 0` 一律转 error，不要把 `data: null` 当成功。
- 错误信息原样往上抛，方便插件日志定位；对用户只暴露友好文案。

---

## 7. SnowLuma 扩展接口

这些**不是**标准 OneBot 11，属于 SnowLuma 的扩展。协议层照常透传，但文档里要标出来，避免换协议端时静默失效：

| 接口 | 用途 | 备注 |
|---|---|---|
| `send_poke` / `group_poke` / `friend_poke` | 戳一戳 | 各端都有，命名不同 |
| `set_group_reaction` | 表情回应 | 扩展 |
| `set_essence_msg` / `delete_essence_msg` / `get_essence_msg_list` | 群精华 | 扩展 |
| `add_custom_face` / `modify_custom_face` / `delete_custom_face` | 自定义表情 | 扩展 |
| `get_group_msg_history` / `get_friend_msg_history` | 历史消息 | 扩展 |
| `_send_group_notice` / `_get_group_notice` | 群公告 | 下划线前缀 = 非标准 |
| `upload_forward_msg` | 合并转发 | 扩展 |
| `get_cookies` | 拿登录态 | **危险** |
| `fetch_ptt_text` | 语音转文字 | 扩展 |
| `get_qzone_*` / `send_qzone_msg` | QQ 空间 | 扩展 |
| `set_group_kick_members` | 批量踢人 | 扩展 |

策略：**能力探测 + 降级**。插件用到扩展接口时，启动阶段用 `get_version_info` 检查 `app_name == "SnowLuma"`；不是就标 degraded，不要等运行时报错。

---

## 8. 流式接口（v1 不做）

SnowLuma 提供 `upload_file_stream` / `download_file_stream` / `download_file_image_stream` / `download_file_record_stream`，返回的是**流式帧**而不是普通 JSON。

- 用途：超大文件（几百 MB 视频）分块传输，避免 base64 撑爆内存。
- **v1 不做**。先把普通路径跑通。
- v1 的大文件方案：

| 大小 | 方案 |
|---|---|
| < 5MB | base64 内联 |
| 5–50MB | HTTP URL 让协议端自己下载 |
| > 50MB 或必须本地 | `file://` 绝对路径（要求框架与 SnowLuma 同机） |

流式留到 P2，接口先留占位。

---

## 9. 多账号

SnowLuma 一个实例可以挂多个 QQ 号。框架侧：

```go
type Account struct {
    ID        string
    SelfID    int64   // 首次 get_login_info 后填充
    Client    *Client
    Router    *Router   // 每个账号独立的会话/发送队列
}
```

要点：

- **发送队列按 (account, chat) 分键**，不同账号不共享限频。
- 事件去重的 key 也要带 `account`，否则两个号在同一群会互相吃掉消息。
- 配置里 `[[accounts]]` 的顺序不影响行为，但日志里要带 `account=main` 前缀。

---

## 10. 重连与健康

```
启动 → 连接 → 握手（get_login_info + get_version_info）
     → 失败：指数退避 1s/2s/4s…60s（±20% 抖动）
     → 成功：记录 self_id，启动心跳检查
心跳：15s 没收到任何帧 → 主动 ping（meta_event 或 get_status）
     → 两次无响应 → 判定假死 → 主动断开重连
```

- `get_status` 返回 `{online, good}`，可以拿来做 WebUI 上的健康灯。
- 重连成功后**必须重新拉一次 `get_login_info`**，`self_id` 可能变。

---

## 11. 本地开发与测试

**不要每次改动都开真 QQ。** 写一个 mock OneBot 服务端：

```
tools/mock-onebot/
  main.go          # 起 WS :3001，按脚本推事件
  fixtures/
    group-message.json
    poke.json
    recall.json
```

能力：

- 按文件顺序推事件，支持 sleep 间隔。
- 记录所有 `Call` 请求到 `calls.jsonl`，测试断言用。
- 可注入"上游卡死""retcode 100""断线"三种故障。

这一个工具能省掉 80% 的联调时间，**M1 就要做**。

---

## 12. 坑清单

1. **QQ 客户端必须先登录**。SnowLuma 是桥接，QQ 没登录就什么都收不到。SnowLuma WebUI（5099）能看到 QQ 进程状态。
2. **`message_sent` 事件**：不丢弃会出现"机器人自问自答"。
3. **多实例端口偏移**：第二个 SnowLuma 实例默认 `3001+100 = 3101`，两个框架都连 3001 会导致同一条消息被处理两遍。
4. **令牌分两种**：WS 和 HTTP 的 token 可能不同，别只配一个。
5. **扩展接口不稳定**：`_` 前缀的接口随时可能变，插件里用要 try/catch + 降级。
6. **`get_cookies` 等于账号接管**：默认禁用，日志里出现要报警。
7. **许可**：SnowLuma 是非商业许可；你的框架自己用没问题，但别把它的二进制打包进发布物。
8. **端口冲突**：3000 常被本地开发服务器占用，装完先在 WebUI 里确认实际端口。

---

## 13. 对接验收清单

M1 结束前逐条勾：

- [ ] 配置里写 `[[accounts]]`，能连上 `ws://127.0.0.1:3001`
- [ ] 带 token 和不带 token 都能工作
- [ ] `get_login_info` 拿到 `self_id`，日志里打印
- [ ] 群消息、私聊消息都能收到并归一化
- [ ] `message_sent` 被丢弃
- [ ] 断开 SnowLuma 后自动重连（拔 30 秒再恢复）
- [ ] `send_group_msg` 能发文字 + 图片
- [ ] `retcode != 0` 时返回明确 error
- [ ] 同一条消息不会回复两次（去重生效）
- [ ] mock 服务端能跑通全流程
