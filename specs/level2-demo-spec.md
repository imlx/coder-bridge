# Level 2 Demo - Stream-JSON Multi-Turn Communication

## Goal
Create `src/demo-level2.js` that demonstrates MOSS communicating with Claude Code CLI via stream-json protocol in multiple turns within a single session.

## Technical Spec

### 1. Process Spawn
Use `child_process.spawn` to start:
```
claude -p --input-format stream-json --output-format stream-json --verbose
```
Working directory: `/Volumes/T7/coder-bridge`

### 2. Stream-JSON Protocol (Verified)

**Input** (stdin, NDJSON, one JSON per line):
```json
{"type":"user","message":{"role":"user","content":"your instruction here"}}
```

**Output** (stdout, NDJSON messages):
- `{"type":"system","subtype":"init",...}` - session initialized
- `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"..."},{"type":"text","text":"..."},{"type":"tool_use","name":"Read","input":{...}}]}}` - AI response
- `{"type":"result","subtype":"success","duration_ms":1234,"cost_usd":0.01,"num_turns":1}` - round complete

After receiving `result`, write the next user message to stdin. Same session, context preserved.

### 3. Three Progressive Rounds

**Round 1 - Analyze Code:**
Instruction: "分析 src/rateLimiter.js 的代码，找出它的设计缺陷和改进空间。只分析，不修改。"

**Round 2 - Fix Bug:**
Instruction: "基于你刚才的分析，修改 src/rateLimiter.js，添加 burst 控制支持。允许在桶满时短暂超过容量上限。"

**Round 3 - Write Tests:**
Instruction: "为修改后的 rateLimiter.js 写单元测试，保存到 tests/ratelimiter-burst.test.js，用 Node.js 内置 test runner。"

### 4. Terminal Display

Use ANSI colors:
- `\x1b[90m` (gray) for thinking
- `\x1b[37m` (white) for text  
- `\x1b[33m` (yellow) for tool_use (show tool name + key params)
- `\x1b[36m` (cyan) for MOSS instructions
- `\x1b[32m` (green) for round headers and success
- `\x1b[0m` to reset

Display format per round:
```
═══════════════════════════════════════════
🟢 Round 1: Analyze Code
═══════════════════════════════════════════
📤 MOSS: 分析 src/rateLimiter.js 的代码...

💭 [thinking] Let me analyze the rate limiter...
📝 [text] The rate limiter has several issues...
🔧 [tool_use] Read {file_path: "src/rateLimiter.js"}

✅ Round 1 complete | 3.2s | $0.02 | 1 turn
```

Final summary:
```
═══════════════════════════════════════════
📊 Level 2 Verification Summary
═══════════════════════════════════════════
Round 1: Analyze  | 3.2s  | $0.02 | 1 turn
Round 2: Fix Bug  | 8.5s  | $0.05 | 2 turns
Round 3: Tests    | 12.1s | $0.08 | 3 turns
───────────────────────────────────────────
Total: 23.8s | $0.15 | 6 turns
Multi-turn session persistence: ✅ Verified
═══════════════════════════════════════════
```

### 5. Requirements
- Pure Node.js, ESM (import/export), no third-party deps
- Use only: `child_process`, `readline`
- Export `runDemo()` async function, call it at file end
- Error handling: process crash, timeout (120s per round), non-zero exit
- JSDoc comment at top explaining Level 2 purpose
- Add `demo:2` to package.json scripts: `node src/demo-level2.js`
