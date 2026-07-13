# coder-bridge

> MOSS × Claude Code × Codex - 五层深度调度验证测试床

本项目验证 MOSS（白龙马 Agent）对本地 Claude Code 和 Codex CLI 的五层调度能力。每层使用同一套工作件代码（Rate Limiter + Task Queue + Scheduler）作为被操作对象，逐步加深控制粒度。

## 工作件代码

| 文件 | 功能 | 故意留的改进空间 |
|------|------|-----------------|
| `src/rateLimiter.js` | Token Bucket 限流器 | 无持久化、无并发安全、无 burst 控制 |
| `src/taskQueue.js` | 异步任务队列 | 无优先级、无取消、无重试 |
| `src/scheduler.js` | 限流 + 队列调度器 | busy-wait、无优雅关闭、无 metrics |
| `tests/unit.test.js` | 单元测试 | 最后一个并发测试故意会失败 |

## 五层验证计划

### Level 1 - 一次性执行（One-shot）

**目标**：验证 MOSS 能通过 `exec_command` 调用 Claude Code / Codex 完成单次编码任务。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 命令 | `claude -p "prompt"` | `codex exec "prompt"` |
| 工具白名单 | `--allowedTools "Edit" "Bash(npm test)"` | `-s workspace-write` |
| 预算控制 | `--max-budget-usd 1` | - |
| 输出格式 | `--output-format text` | 默认文本 |

**可运行 demo**：`npm run demo:1` - MOSS 实际调用 `claude -p` 和 `codex exec` 执行真实编码任务，展示调度命令、CLI 实时输出、产出的代码文件。你看到的是"MOSS 调度两个 AI 干活"这个过程本身。

### Level 2 - 流式多轮（Streaming Multi-turn）

**目标**：验证 MOSS 能在单个 session 内与 agent 进行多轮双向通信。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 通信协议 | `--input-format stream-json --output-format stream-json` | `codex exec-server` (websocket) |
| 多轮控制 | stdin 持续喂消息 | HTTP API 轮询 |
| 拦截能力 | 每轮可见工具调用 | - |

**验证任务**：第一轮让 agent 读代码并分析问题，第二轮让它修复并发安全 bug，第三轮让它写新测试验证修复。

**可运行 demo**：`npm run demo:2` - MOSS 通过 stream-json 与 Claude Code 在单个 session 内进行三轮渐进式编码对话（分析 -> 修改 -> 测试），终端实时展示 thinking / text / tool_use 消息流。

### Level 3 - MCP 互操作

**目标**：验证双向 MCP 能力互操作。

- **方向 A**：MOSS 把记忆检索暴露为 MCP server，Claude Code / Codex 消费
- **方向 B**：Codex 通过 `codex mcp-server` 暴露自身能力，MOSS 调用

**验证任务**：Claude Code 在编码时通过 MCP 调用 MOSS 的记忆检索，查询"这个项目的设计决策"，基于记忆上下文做重构。

**可运行 demo**：`npm run demo:3` - 终端展示跨 agent 的 MCP 工具调用链路。

### Level 4 - 后台 + 持久化

**目标**：验证跨时间的编码协作--MOSS 启动后台 agent，TICK 心跳检查进度，session 恢复。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 后台启动 | `claude --bg "prompt"` | `codex exec-server` 后台 |
| 会话恢复 | `claude --resume <session-id>` | `codex resume <session-id>` |
| 进度检查 | `claude agents` | exec-server API |

**验证任务**：MOSS 启动 Claude Code 后台重构整个 scheduler 模块，TICK 心跳检查进度，完成后通知用户。

**可运行 demo**：`npm run demo:4` - 启动后台编码任务，关掉终端后回来查看 TICK 心跳跟踪的进度和主动播报。

### Level 5 - Hook + 自定义 Agent

**目标**：验证最细粒度控制--工具调用拦截和角色化子 agent。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 事件拦截 | `--include-hook-events` + stream-json | - |
| 自定义 agent | `--agents '{"reviewer":{...}}'` | `codex review` / `codex apply` |
| 审查流水线 | 实现->自动审查->选择性应用 | - |

**验证任务**：定义"实现者"和"审查者"两个 agent 角色，实现者给 taskQueue 加优先级功能，审查者自动 review 代码质量。

**可运行 demo**：`npm run demo:5` - 终端展示 hook 拦截危险操作、双 agent 互 review 的全过程。

## 目录结构

```
coder-bridge/
├── README.md
├── package.json
├── .gitignore
├── src/
│   ├── index.js              # 入口 + demo
│   ├── rateLimiter.js        # Token Bucket 限流器（Level 2 后已添加 burst 支持）
│   ├── taskQueue.js          # 异步任务队列
│   ├── scheduler.js          # 限流调度器
│   ├── demo-level1.js        # Level 1 live dispatch demo
│   └── demo-level2.js        # Level 2 streaming multi-turn demo
├── scratch/                  # demo:1 运行时产出（自动清理）
│   ├── claude-output.js      # Claude Code 产出
│   └── codex-output.js       # Codex 产出
├── specs/
│   └── level2-demo-spec.md   # Level 2 demo 设计规格
├── tests/
│   ├── unit.test.js          # 单元测试（含一个故意失败的测试）
│   └── ratelimiter-burst.test.js  # Level 2 Round 3 产出的 burst 测试
└── integration/
    ├── level1-oneshot.sh
    ├── level2-stream.sh
    ├── level3-mcp/
    ├── level4-background.sh
    └── level5-hooks.sh
```

## 运行

```bash
cd /Volumes/T7/coder-bridge
npm test            # 跑单元测试
npm run demo        # 跑基础 demo
npm run demo:1      # 跑 Level 1 live dispatch 验证 demo
npm run demo:2      # 跑 Level 2 streaming multi-turn 验证 demo
```

## 环境

- Node.js 22 (nvm)
- Claude Code 2.1.206 (`/Users/lingxiao/.nvm/versions/node/v22.16.0/bin/claude`)
- Codex CLI 0.144.1 (`/Users/lingxiao/.nvm/versions/node/v22.16.0/bin/codex`)
- MOSS (BaiLongma) 2.1.479

## 验证状态

| 层级 | 状态 | 日期 | Demo |
|------|------|------|------|
| Level 1 - 一次性执行 | ✅ 已验证 | 2026-07-11 | `npm run demo:1` |
| Level 2 - 流式多轮 | ✅ 已验证 | 2026-07-13 | `npm run demo:2` |
| Level 3 - MCP 互操作 | 待验证 | - | `npm run demo:3` |
| Level 4 - 后台持久化 | 待验证 | - | `npm run demo:4` |
| Level 5 - Hook + Agent | 待验证 | - | `npm run demo:5` |

## Level 1 验证详情

**执行时间**：2026-07-11

**验证方式**：Live Dispatch - MOSS 实际调用 CLI 工具，Claude Code 和 Codex 各自独立完成一次性编码任务。

**Claude Code 任务**：创建 `scratch/claude-output.js`，导出 `formatTimestamp(date)` 函数
- 命令：`claude -p "..." --output-format text`
- 结果：14 秒完成，产出了正确的 formatTimestamp 函数（YYYY-MM-DD HH:mm:ss 格式化）

**Codex 任务**：创建 `scratch/codex-output.js`，导出 `generateId()` 函数
- 命令：`codex exec "..." -s workspace-write`
- 结果：35 秒完成，产出了正确的 generateId 函数（8 位随机字母数字 ID）

**验证结论**：MOSS 通过 `exec_command` 调用 CLI，Claude Code 和 Codex 各自独立完成了一次性编码任务，产出了真实可读的代码文件。Level 1 one-shot dispatch 调度链路验证通过。

## Level 2 验证详情

**执行时间**：2026-07-13

**验证方式**：Streaming Multi-turn - MOSS 通过 stream-json 协议在单个 session 内与 Claude Code 进行三轮渐进式编码对话。

**通信协议**：
- 输入：stdin 喂 NDJSON，每行 `{"type":"user","message":{"role":"user","content":"..."}}`
- 输出：stdout 流式返回 `system/init`、`assistant`（含 thinking/text/tool_use）、`result`（标记一轮结束）
- 多轮机制：收到 `result` 后继续喂下一条 user message，同一 session 上下文保持

**Round 1 - 分析代码**：
- 任务：读取 `src/rateLimiter.js`，分析设计缺陷
- 结果：duration=161s, cost=$0.17, 6 turns
- Claude Code 识别出 5 个维度的问题：无 burst 控制、并发安全、超时处理、API 设计、测试覆盖

**Round 2 - 修复 bug**：
- 任务：为 rateLimiter.js 添加 burst token 池支持
- 结果：duration=202s, cost=$0.47, 9 turns
- 4 处 Edit：构造函数、`_refill`、`tryConsume`、`waitForTokens`
- 全部 13 个现有测试通过

**Round 3 - 写测试**：
- 任务：为 burst 控制写单元测试
- 结果：duration=132s, cost=$0.68, 6 turns
- 创建 `tests/ratelimiter-burst.test.js`，16 个测试用例
- 覆盖：向后兼容、burst 借用、burst 恢复、参数校验、并发安全

**合计**：duration=496s (~8.3 min), cost=$1.33, 3/3 rounds, 29 tests pass (13 原有 + 16 新增)

**验证结论**：MOSS 在单个 stream-json session 内与 Claude Code 进行了三轮渐进式编码对话（分析 -> 修改 -> 测试），全程可见 thinking / text / tool_use 消息流。这证明 Level 2 流式多轮通信链路是通的，MOSS 能在同一个 session 内持续下发指令并观察 agent 的执行过程。
