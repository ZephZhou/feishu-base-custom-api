# 图片请求未完成：诊断、最小修复与异步评估

## 目前可以确认什么

代码中的图片请求原先使用 200 秒整行超时，而中转允许上传 300 秒、生成 600 秒；前端可能先断开，这是确定的配置问题。旧错误文本只覆盖 `fetch` 抛出的通用异常，无法区分入口断开、网络/CORS、连接失败，也没有覆盖读取响应体时的网络异常。

已知 Pages、`GET /health` 和 OPTIONS 成功，不能证明携带 multipart 的 POST 进入 Node 服务或抵达 OpenAI。Usage 暂无新增记录也不能证明上游未接收、未计费（需要核对时间窗口、项目及显示延迟）。没有本次线上请求证据时，不能断言根因就是 CORS、200 秒或 OpenAI。

本次只做同步最小修复：图片模式独立 1020 秒总预算；前后端请求 ID；Render 阶段与耗时日志；单独 30 秒上游连接期限；完整响应/中断诊断；显式 Content-Length。未增加重试、内存任务队列或自动部署。

## 更新后如何定位

需手动更新后端和 Pages 中本次相关代码；新前端会发送 `X-Request-ID`，必须同时更新中转的 CORS Allow-Headers。不要单独只更新前端。前端日志会显示请求 ID、阶段和累计秒数，失败同样带 ID。用该 ID 在 Render Logs 搜索（OPTIONS 预检通常有独立 ID，应查看 `method=POST`）。

服务端每条日志包含 `time`、`request_id`、`method`、`route`、`stage`、`elapsed_ms`，以及适用时的字节数、HTTP 状态或允许列举的网络错误代码。时间为 UTC ISO，耗时从该请求进入 Node 开始计；前端耗时包含此前的附件下载，不能直接相减当作网络耗时。日志不记录 Key、令牌、Origin 原文、附件 URL、提示词、图片/Base64、请求体、响应体或异常原文。`/health` 不打印逐请求日志，避免健康检查噪音。

| 最后阶段或现象 | 判断和下一步 |
| --- | --- |
| 前端 `reference_download` | 还在浏览器下载飞书参考图，尚未提交生图；检查附件请求状态、权限、大小和下载 CORS |
| 前端 `proxy_request`，没有同 ID POST 日志 | 尚无 Node 收到 POST 的证据；检查浏览器 Network 的 OPTIONS/POST、实际地址、入口状态和 Render 冷启动；确认实例已运行新代码 |
| 只有 `request_received` 后很快 `response_finished` | 按 HTTP 状态检查 Origin/令牌/路由；不能把 OPTIONS 204 当成 POST 成功 |
| `upload_receiving` 未到 `upload_received` | 正在上传、上传中断或客户端已断开；检查上传大小、入口限制和 `client_disconnected` |
| `upload_received` 后没有 `validated` | 请求解析或模型、尺寸、multipart 文件校验未完成/未通过；检查 HTTP 状态 |
| `upstream_start` / `upstream_serialized` / `upstream_socket` | 核对 DNS、TCP、TLS 阶段；ENOTFOUND/EAI_AGAIN 是解析问题，ETIMEDOUT 是连接期限到达（30 秒）；不要直接认定已提交生成 |
| `upstream_dns` → `upstream_tcp` → `upstream_tls` | 上游连接推进；连接复用时显示 `upstream_reused_socket`，不会重复出现 DNS/TCP/TLS |
| `upstream_sent`，无 `upstream_headers` | 请求字节已交给本地 TLS 连接，不代表 OpenAI 已接受或计费；仍可能是上游处理等待/网络中断 |
| `upstream_headers` | 已收到上游 HTTP 状态；401/403/429 应先检查账户/权限/额度，不要重发同一付费任务 |
| `upstream_body` → `response_parsed` | 已收到并解析完整上游响应；之后关注到浏览器的传输 |
| 服务端 `response_finished`，前端无 `response_complete` | Node 已把响应交给本地连接，不保证浏览器收到；排查 Render 入口、CORS 和 Base64 响应体下载 |
| 前端 `response_complete`，飞书未写入 | 生图响应已取到，排查本地图片校验、飞书上传或单元格权限；不要重复调用生成来解决写回失败 |
| `client_disconnected` / `generation_timeout` | 状态可能不确定；本地取消不保证撤销上游任务，不应盲目重跑 |

底层 HTTPS 不自动重定向，仍固定请求官方两个图片接口。连接期限只覆盖 DNS/TCP/TLS；生成期限 600 秒独立计时。Render 入口、用户浏览器和其他网关仍可能提前切断同步连接。延长前端等待只能修复自身 200 秒限制，不能提供断线恢复能力。

## 异步任务何时值得做

优先用一张小参考图、并发 1、Mock 上游验证链路，读取阶段日志。若是地址/权限/上传/出网问题，改成异步也不会修好。若确认是生成耗时超过入口期限、页面经常刷新，或要求可靠恢复结果和严格费用保护，则应实施持久化异步任务。

当前同步服务**没有持久幂等记录或结果存储**。虽然没有自动重试，但手动重跑、刷新后再提交仍可能重复付费；本次没有把“等待更久”描述为已解决去重。请求 ID 用于追踪，不是幂等键。当前全局并发 2 是进程级限制，不能替代跨实例的单用户并发控制。

### 推荐的生产最小架构（评估，尚未实现）

使用持久 PostgreSQL 任务表与持久对象存储，Web 服务只校验/保存任务并返回 202；独立 worker 通过数据库领取任务。不使用仅存在内存中的队列，也不将 Render 临时文件系统当作结果存储。

1. **认证与提交**：每个用户有独立身份或可撤销令牌，服务端映射到稳定 user_id；保留 Origin 限制。`POST /v1/image-jobs` 接收图片和客户端稳定幂等键，返回 `job_id`。不要复用诊断请求 ID 作为幂等键。
2. **提交前防重复**：前端先保存操作 ID（表/行/输出字段对应的一次操作）再发送；刷新后使用原 ID 查询，不能生成新 ID 自动重交。数据库唯一约束 `(user_id, idempotency_key)`；相同键相同内容返回原 job，相同键不同内容返回 409。没有收到提交响应也应查询原键，而不是新建任务。
3. **持久状态**：`queued → dispatching → running → succeeded/failed/unknown`；记录输入指纹、对象存储键、时间、费用预留、worker lease、上游标识。状态和唯一约束在事务中更新，数据库锁/计数实现每用户最多 1 个活动任务，并设置全局上限及排队长度。
4. **费用保护**：提交时事务性预留用户每日请求/预算额度，固定模型、按用户所选 n（1～10）预留数量/预算、尺寸与上传限制；服务端核销预算。失败或结果不确定时不得轻易释放预留额度。项目级预算告警只是补充，不能替代应用限额。只有确认未发送上游的本地失败才允许有界安全重试。
5. **崩溃边界**：worker 将状态持久化为 dispatching 后才发请求；若在上游接收后、本地记录结果前崩溃，标记 unknown 并阻止自动重发。不能假设 OpenAI 图片接口支持幂等或找回结果；只有核实了上游合同才能依赖它。保守地停止 unknown 可防重扣，但可能牺牲自动恢复，不能宣称数据库可以保证跨外部 API 的 exactly-once。
6. **查询/回写**：`GET /v1/image-jobs/:id` 按所属用户校验权限；返回进度，完成后通过短时受控下载取图片，由前端写回飞书。刷新后只恢复轮询。记录回写状态；结果已生成但回写失败时只重试附件写回，不重生成。
7. **过期与清理**：输入/输出设置 TTL（如 24 小时，按隐私需求配置），过期 job 返回 410。保留更长时间的最小幂等 tombstone 和费用账本（如 30 天）；过期键必须拒绝自动新建，不能删完记录后让旧请求重新付费。取消/租约超时不代表上游未计费。任务状态、结果、用户与密钥隔离，限流覆盖提交及轮询，日志继续只记录非敏感元数据。

需要先确定 PostgreSQL、对象存储、用户认证以及费用额度策略，才能实施并验证此方案。尚未新增任何 job API，也未宣称刷新去重已实现。

## Mock 验证

```sh
node tests/image-api.test.cjs
npm --prefix server test
node tests/browser-smoke.cjs
```

测试覆盖请求 ID 关联、日志脱敏、允许预检自定义头、模拟 DNS 错误、连接期限、前端响应体中断、超时不重试及完整飞书模拟链路；所有 OpenAI 调用均为 Mock。没有访问真实 Render/OpenAI 或验证线上根因。
