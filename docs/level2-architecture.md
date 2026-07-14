# Level 2 架构文档 - 流式多轮通信（Streaming Multi-turn）

## 1. 功能验证总结

**已验证通过。** MOSS 通过 stream-json 协议（NDJSON over stdin/stdout）与 Claude Code 在单个 session 内进行三轮渐进式编码对话（分析 → 修改 → 测试），全程实时展示 thinking / text / tool_use 消息流。

- 通信方式：`claude -p --model sonnet --input-format stream-json --output-format stream-json --verbose`
- 三轮任务：Round 1 分析 rateLimiter.js 设计缺陷 → Round 2 添加 burst 控制 → Round 3 写单元测试
- 上下文保持：同一 session 内，Claude Code 在 Round 2 记得 Round 1 的分析，Round 3 记得 Round 2 的修改
- 实际产出：rateLimiter.js 被修改（新增 burst token 池），ratelimiter-burst.test.js 新建（16 个测试全部通过）
- Demo：`npm run demo:2`

**已知问题（操作层面，非协议缺陷）：**
- Round 3 写测试任务可能因 AI 响应时间波动超过 300s 超时。不影响 stream-json 协议正确性，但影响 demo 可靠复现。
- 硬编码 nvm 路径 `/Users/lingxiao/.nvm/versions/node/v22.16.0/bin`，换机器无法运行。
- 注释错误：`ROUND_TIMEOUT = 300000` 注释写"120 秒"，实际 300 秒。

## 2. 调度决策机制

### 2.1 核心理念

MOSS 是一个完整的 agent，已有体系化能力：Tool use（动态加载工具、find_tool 按需加载）、Cognitive Loop（Think → Execute → Observe → Judge）、Memory（search / recall / probe 三层）、Agent Skills（SKILL.md 按场景加载）。这些现有能力就是"调度决策能力"本身，无需另建机制。

在流式多轮通信场景中，调度决策体现在：MOSS 通过 Cognitive Loop 判断任务是否需要多轮上下文延续，决定使用 stream-json session（而非 Level 1 的一次性 dispatch），并在 session 生命周期内通过 Observe 实时观察 Claude Code 的 thinking / tool_use，通过 Judge 决定是否继续下一轮或终止。

### 2.2 MOSS 现有 Agent 能力在流式多轮通信中的应用

| MOSS 能力 | 在流式多轮通信中的应用 |
|-----------|----------------------|
| Tool use | MOSS 将 `claude` CLI 作为工具调用，通过 `child_process.spawn` 启动进程，用 stream-json 协议双向通信。工具不是硬编码的--MOSS 可以通过 find_tool 发现并加载编码工具。 |
| Cognitive Loop | Think：分析任务是否需要多轮（如"先分析再修复再测试"是天然的多步任务）。Execute：spawn claude session、发送 prompt、等待 result。Observe：实时读取 thinking / text / tool_use 消息流，了解 Claude Code 在做什么。Judge：根据 result 的 success/error、duration、cost 决定是否继续下一轮。 |
| Memory | 跨轮上下文由 session 本身保持（Claude Code 记得前几轮）。MOSS 的 Memory 用于跨 session 场景：记住上次分析过什么、修改了哪些文件、花了多少成本，下次遇到类似任务可以复用经验。 |
| Agent Skills | 如果 MOSS 加载了编码相关的 SKILL.md，它知道如何组装 prompt、如何解读 stream-json 输出、如何验证产出。 |

### 2.3 何时选流式多轮 vs 一次性执行

这是 Cognitive Loop 的 Judge 步骤的自然产出，不是需要额外设计的决策引擎：

- **一次性执行（Level 1）**：任务边界清晰、单步可完成、不需要上下文延续。例："写一个防抖函数"。
- **流式多轮（Level 2）**：任务有明确的多步依赖关系、后续步骤依赖前序结果、需要观察中间过程。例："分析代码 → 修复 → 写测试"。
- **判断依据**：任务是否能拆成有依赖关系的子任务？需要观察中间产出吗？需要跨步骤保持上下文吗？是 → 流式多轮。

### 2.4 多工具适配

本次验证以 Claude Code 为主线（stream-json 协议）。Codex 的流式通信（exec-server / app-server --remote-control）未在本 demo 中验证，记为已知缺口。Tool use 机制天然支持多工具--MOSS 可以像加载 claude CLI 一样加载 codex exec-server，协议适配层不同但调度机制相同。

## 3. 服务生命周期

### 3.1 Session 生命周期

```
启动 → init 确认 → Round 1 (send → receive result) → Round 2 → Round 3 → 关闭
```

| 阶段 | 动作 | 代码位置 |
|------|------|----------|
| 启动 | `spawn('claude', [...stream-json flags])` | `ClaudeStreamSession.start()` |
| 初始化确认 | 收到 `system/init` 消息，确认 session_id 和 model | `_handleLine()` case 'system' |
| 发送轮次 | 向 stdin 写 NDJSON `{"type":"user","message":{...}}` | `sendRound()` |
| 接收结果 | 等待 `result` 消息，含 duration / cost / num_turns | `sendRound()` Promise resolve |
| 关闭 | stdin EOF + SIGTERM 兜底 | `close()` |

**关键特性：** session 在进程存活期间保持上下文。收到 `result` 后不关闭进程，继续向 stdin 写下一条 user message，Claude Code 在同一 session 内响应，记得前几轮内容。

### 3.2 进程管理

- 使用 `child_process.spawn` 启动 claude CLI，stdio 配置为 `['pipe', 'pipe', 'pipe']`
- `readline.createInterface` 逐行读取 stdout，每行解析为 NDJSON
- stderr 缓存到 `_stderrBuf`，进程异常退出时用于诊断
- 进程退出检测：`close` 事件触发时，若仍有未 resolve 的 Promise 则 reject

### 3.3 超时与错误处理

- **每轮超时**：`ROUND_TIMEOUT`（当前 300000ms = 300s）。超时后 reject Promise，demo 标记该轮失败并终止后续。
- **进程退出**：`close` 事件检测，若进程意外退出且仍有 pending round，reject 并携带 stderr 尾部信息。
- **stdin 错误**：`stdin.on('error')` 防止写入失败导致 demo 崩溃。
- **某轮失败**：终止后续轮次（session 状态已不确定），进入产出验证阶段。

### 3.4 成本可观测

每轮 `result` 消息包含 `duration_ms` / `total_cost_usd` / `num_turns`，demo 实时展示并汇总。这让 MOSS（和用户）能看到每轮的实际消耗，为成本管理提供数据基础。

## 4. 架构演进建议

### 4.1 短期（demo 可靠性）

- **修复硬编码路径**：用 `process.env.CLAUDE_BIN || ''` 替代硬编码 nvm 路径，通过环境变量或 PATH 适配不同机器。
- **修复注释错误**：`ROUND_TIMEOUT = 300000` 注释改为"300 秒"。
- **Round 3 超时调整**：写测试任务较重，给 Round 3 单独配置 600s 超时，避免因 AI 响应波动导致失败。
- **轮次失败后 session 恢复**：当前某轮失败直接终止。可改为检测 session 是否仍可用，若可用则重试当前轮或跳过继续。

### 4.2 中期（MOSS 集成）

- **成本预算管理**：Claude Code 支持 `--max-budget-usd` 参数。MOSS 在启动 session 时设定预算上限，超出时自动终止，防止单次任务成本失控。
- **session 持久化与恢复**：Claude Code 支持 `--resume <session_id>` 恢复历史 session。MOSS 可以在 Memory 中记录 session_id，后续任务恢复上下文继续工作，而非每次从零开始。
- **并行 session**：独立任务可并行 dispatch 多个 session（如同时修改不同文件）。需要 MOSS 管理多个并发 session 的生命周期和成本汇总。

### 4.3 长期（系统级）

- **流式 vs 一次性自动选择**：MOSS 通过 Cognitive Loop 分析任务特征，自动判断用 Level 1（one-shot）还是 Level 2（streaming），无需人工指定。这不需要新机制--就是 Think 步骤的判断产出。
- **Session 池管理**：MOSS 维护一组活跃 session，按任务类型复用或新建，类似数据库连接池。Session 空闲超时自动关闭，活跃时保持上下文。
- **跨 session 记忆持久化**：当前上下文在 session 内保持，session 关闭后丢失。MOSS 的 Memory 可以补充跨 session 记忆--记录"上次在 session X 分析了什么、修改了哪些文件"，新 session 可以从 MOSS Memory 获取前序工作摘要。
