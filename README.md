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

**可运行 demo**：`npm run demo:1` - MOSS 实际调用 `claude -p` 和 `codex exec` 执行真实编码任务，展示调度命令、CLI 实时输出、产出的代码文件。

📐 **架构文档**：[`docs/level1-architecture.md`](docs/level1-architecture.md) - 调度决策机制、服务生命周期、架构演进建议

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

**可运行 demo**：`npm run demo:3` - 终端展示跨 agent 的 MCP 工具调用链路。

### Level 4 - 后台 + 持久化

**目标**：验证跨时间的编码协作--MOSS 启动后台 agent，TICK 心跳检查进度，session 恢复。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 后台启动 | `claude --bg "prompt"` | `codex exec-server` 后台 |
| 会话恢复 | `claude --resume <session-id>` | `codex resume <session-id>` |
| 进度检查 | `claude agents` | exec-server API |

### Level 5 - Hook + 自定义 Agent

**目标**：验证最细粒度控制--工具调用拦截和角色化子 agent。

| 维度 | Claude Code | Codex |
|------|------------|-------|
| 事件拦截 | `--include-hook-events` + stream-json | - |
| 自定义 agent | `--agents '{"reviewer":{...}}'` | `codex review` / `codex apply` |

## 目录结构

```
coder-bridge/
├── README.md
├── package.json
├── .gitignore
├── docs/
│   └── level1-architecture.md   # Level 1 架构文档
├── src/
│   ├── index.js              # 入口 + demo
│   ├── rateLimiter.js        # Token Bucket 限流器（Level 2 后已添加 burst 支持）
│   ├── taskQueue.js          # 异步任务队列
│   ├── scheduler.js          # 限流调度器
│   ├── demo-level1.js        # Level 1 live dispatch demo
│   ├── demo-level2.js        # Level 2 streaming multi-turn demo
│   ├── demo-level3.js        # Level 3 MCP 互操作 demo
│   └── mcp-memory-server.js  # MOSS MCP memory server（Level 3）
├── scratch/                  # demo:1 运行时产出（自动清理）
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
npm run demo:3      # 跑 Level 3 MCP 互操作验证 demo
```

## 环境

- Node.js 22 (nvm)
- Claude Code 2.1.206
- Codex CLI 0.144.1
- MOSS (BaiLongma) 2.1.479

## 验证状态

| 层级 | 状态 | 日期 | Demo |
|------|------|------|------|
| Level 1 - 一次性执行 | ✅ 已验证 + 架构文档 | 2026-07-11 | `npm run demo:1` |
| Level 2 - 流式多轮 | ✅ 已验证 | 2026-07-13 | `npm run demo:2` |
| Level 3 - MCP 互操作 | ✅ 已验证 | 2026-07-14 | `npm run demo:3` |
| Level 4 - 后台持久化 | 待验证 | - | `npm run demo:4` |
| Level 5 - Hook + Agent | 待验证 | - | `npm run demo:5` |

## Level 1 验证详情

**执行时间**：2026-07-11

**验证方式**：Live Dispatch - MOSS 实际调用 CLI 工具，Claude Code 和 Codex 各自独立完成一次性编码任务。

**Claude Code 任务**：创建 `scratch/claude-output.js`，导出 `formatTimestamp(date)` 函数
- 命令：`claude -p "..." --output-format text`
- 结果：产出了正确的 formatTimestamp 函数（YYYY-MM-DD HH:mm:ss 格式化）

**Codex 任务**：创建 `scratch/codex-output.js`，导出 `generateId()` 函数
- 命令：`codex exec "..." -s workspace-write`
- 结果：产出了正确的 generateId 函数（8 位随机字母数字 ID）

**验证结论**：MOSS 通过 `exec_command` 调用 CLI，Claude Code 和 Codex 各自独立完成了一次性编码任务，产出了真实可读的代码文件。Level 1 one-shot dispatch 调度链路验证通过。

**架构文档**：[`docs/level1-architecture.md`](docs/level1-architecture.md) - 包含调度决策机制（MOSS 能力注册表概念、何时选择 one-shot）、服务生命周期（CLI 安装、进程管理、scratch 清理）、架构演进建议（并行 dispatch、能力注册表实例化、Agent 池管理）。

## Level 2 验证详情

**执行时间**：2026-07-13

**验证方式**：Streaming Multi-turn - MOSS 通过 stream-json 协议在单个 session 内与 Claude Code 进行三轮渐进式编码对话。

**Round 1 - 分析代码**：duration=161s, cost=$0.17, 6 turns。Claude Code 识别出 5 个维度的问题。

**Round 2 - 修复 bug**：duration=202s, cost=$0.47, 9 turns。给 rateLimiter.js 添加 burst token 池支持，4 处 Edit。

**Round 3 - 写测试**：duration=132s, cost=$0.68, 6 turns。创建 ratelimiter-burst.test.js，16 个测试用例。

**合计**：duration=496s (~8.3 min), cost=$1.33, 3/3 rounds, 29 tests pass

## Level 3 验证详情

**执行时间**：2026-07-14

**验证方式**：MCP 互操作 - 四个 Part 验证双向 MCP 链路。

- Part 1 · 直接 MCP 协议测试（0.6s）：MOSS 启动 mcp-memory-server.js，JSON-RPC 全流程通过
- Part 2 · Claude Code 消费 MOSS MCP（36.8s）：Claude Code 通过 --mcp-config 调用 search_memory / get_project_info
- Part 3 · Codex 消费 MOSS MCP（31.2s）：Codex 通过 codex mcp add 调用 search_memory
- Part 4 · MOSS 消费 Codex MCP（2.0s）：codex mcp-server 暴露 2 个工具，MOSS 通过 JSON-RPC 调用

**已知缺口**（待 Level 3 gap-filling 补全）：
- MOSS 消费 Claude Code MCP（`claude mcp serve`）方向未验证
- MCP 服务生命周期未文档化
- 架构演进建议未提供
