# Brainstorming Session: Flume MVP Walking Skeleton

**Date:** 2026-01-07
**Facilitator:** Creative Intelligence (BMAD)
**Objective:** Define what a good MVP walking skeleton looks like for Flume
**Context:** Flume is the top-most user-facing layer of 33GOD (alongside Holocene dashboard). Backend infrastructure complete (68 story points). Need user interaction layer.

---

## Techniques Used

1. **Mind Mapping** - Explored user interaction surface area
2. **SCAMPER** - Generated creative variations on interaction patterns
3. **Reverse Brainstorming** - Identified failure modes to avoid

---

## Ideas Generated

### Category 1: User Interface / Entry Points (10 ideas)

1. **CLI Tool (flume)** - Primary entry point for developers
2. **Interactive TUI** - Terminal dashboard with live updates
3. **HTTP API** - RESTful endpoints for programmatic access
4. **GraphQL API** - Flexible queries for complex integrations
5. **WebSocket/SSE** - Real-time event streaming
6. **TypeScript SDK** - First-party client library
7. **Python SDK** - Cross-language support
8. **n8n Integration** - Workflow automation node
9. **Claude Code Skill** - Native integration with Claude Code
10. **mise Task Integration** - Project-level task runner

### Category 2: Task Lifecycle Management (10 ideas)

11. **One-liner submission** - `flume submit "objective"`
12. **YAML task definitions** - For complex/repeatable tasks
13. **Task graphs with dependencies** - Parent/child relationships
14. **Batch submission** - Multiple related tasks at once
15. **Cancel in-flight tasks** - Escape hatch for long-running work
16. **Retry failed tasks** - With modified parameters
17. **Task templates** - Reusable task patterns
18. **Semantic task naming** - Human-readable identifiers
19. **Task history query** - View past tasks and results
20. **Task modification mid-flight** - Update context/parameters

### Category 3: Feedback & Observability (10 ideas)

21. **Real-time streaming output** - As agents work
22. **Live activity feed** - Agent state transitions
23. **Rich error context** - With suggested remediation
24. **Status polling** - Query current state
25. **Result fetching** - Get final output
26. **Event stream** - Raw Bloodbank events
27. **Progress indicators** - Visual feedback on long tasks
28. **Notification hooks** - Webhook on completion/failure
29. **Correlation chain visualization** - See task delegation tree
30. **Agent workload visibility** - What's each agent doing

### Category 4: Context & Intelligence (8 ideas)

31. **Auto context injection** - Git, directory, open files
32. **Project-aware routing** - Understand codebase structure
33. **Smart adapter selection** - AI routes to best agent
34. **Agent recommendations** - Suggest follow-up tasks
35. **Error auto-fix suggestions** - When tasks fail
36. **Learning from history** - Improve routing over time
37. **Intent extraction** - Parse natural language to structured task
38. **Context summarization** - Compress large contexts

### Category 5: Developer Experience (10 ideas)

39. **Zero-config first run** - Works out of the box
40. **Interactive tutorial** - Built into CLI
41. **Local-only mode** - Echo adapter, no external deps
42. **Versioned API** - Stability guarantees
43. **Tab completion** - Shell autocomplete
44. **JSON/YAML output modes** - Scriptable output
45. **Dry-run mode** - Preview what will happen
46. **Debug mode** - Verbose logging
47. **Config file support** - `.flumerc` or `flume.yaml`
48. **Environment variable overrides** - 12-factor style

### Category 6: Integration Points (8 ideas)

49. **Bloodbank event emission** - Already implemented
50. **Holocene dashboard sync** - Push updates to UI
51. **Plane issue sync** - Create/update issues
52. **PostgreSQL persistence** - Task/result history
53. **iMi worktree awareness** - Context from active worktree
54. **Git integration** - Current branch, diff, status
55. **CI/CD triggers** - Submit tasks from pipelines
56. **Slack/Discord notifications** - Alert on completion

---

## Key Insights

### Insight 1: CLI-First, Stream-Everything

**Description:** The MVP should be a CLI tool that streams everything in real-time. Users should see agent state transitions, output, and results as they happen, not after. This transforms the opaque "AI doing stuff" experience into a transparent, debuggable interaction.

**Source:** Mind Mapping (CLI branch) + Reverse Brainstorming (no feedback = failure)

**Impact:** High
**Effort:** Medium

**Why it matters:** Transparency builds trust. When users can see exactly what agents are doing, they trust the system more and debug issues faster. This is the "killer feature" for power users.

---

### Insight 2: Zero-to-Task in 30 Seconds

**Description:** The MVP must enable a user to submit their first task within 30 seconds of installation. No config files, no API keys (use Echo adapter), no infrastructure. Just `npm i -g @flume/cli && flume submit "hello world"`.

**Source:** Reverse Brainstorming (complex setup = failure) + SCAMPER (Eliminate)

**Impact:** High
**Effort:** Low

**Why it matters:** Developer tools live or die by their onboarding experience. If first task requires setup, users bounce. Echo adapter enables instant gratification.

---

### Insight 3: Context is King

**Description:** The MVP should auto-inject relevant context from the user's environment: current directory structure, git status, open files (if available), project type. Tasks submitted "in context" are dramatically more useful than tasks submitted in a vacuum.

**Source:** SCAMPER (Adapt mise pattern, Combine with iMi) + Reverse Brainstorming (no context = failure)

**Impact:** High
**Effort:** Medium

**Why it matters:** An agent without context is just a chatbot. An agent with your project context is a collaborator. Auto-context transforms the interaction from "describe everything" to "here's what I need done."

---

### Insight 4: Three MVP Scope Options

**Description:** There are three viable MVP scope definitions:

#### Option A: Minimal Viable
**Effort:** S-M

| Feature | Description |
|---------|-------------|
| CLI | `submit`, `status`, `cancel` commands |
| Adapter | Echo only |
| Output | Stdout streaming |
| Mode | Local only, no external deps |

**User Story:**
```bash
npm i -g @flume/cli
flume submit "greet the user"
# Streams output from Echo agent
# Returns result to stdout
```

#### Option B: Useful Viable
**Effort:** M-L

| Feature | Description |
|---------|-------------|
| CLI | Full command set (`submit`, `status`, `cancel`, `logs`, `watch`, `history`) |
| Adapters | Echo + Claude |
| Streaming | Real-time via WebSocket |
| Integration | Bloodbank events |
| Context | Basic context injection (cwd, git status) |

**User Story:**
```bash
npm i -g @flume/cli
flume config set ANTHROPIC_API_KEY=sk-...
flume submit "review this code for security issues" --adapter=claude
flume watch  # See all events in real-time
```

#### Option C: Impressive Viable
**Effort:** L-XL

| Feature | Description |
|---------|-------------|
| CLI + TUI | Terminal dashboard |
| Adapters | All 4 (Echo, Claude, Letta, Jelmore) |
| Context | Full context injection |
| History | Task history with persistence |
| Integration | Holocene dashboard sync |

**User Story:**
```bash
npm i -g @flume/cli
flume init  # Interactive setup
flume dashboard  # Opens TUI
# Submit tasks, see live agent activity, browse history
```

---

### Insight 5: The "Watch" Command is the UX

**Description:** The most important command might be `flume watch` - a persistent connection that streams all Bloodbank events in human-readable format. This single command makes the entire 33GOD system observable from the terminal.

**Source:** Mind Mapping (feedback loop) + SCAMPER (Combine status + logs + results)

**Impact:** High
**Effort:** Low-Medium

**Why it matters:** `flume watch` is to 33GOD what `kubectl get events -w` is to Kubernetes. It's how power users understand what's happening. It's also a great demo tool.

**Example Output:**
```
$ flume watch
[14:32:01] task.created     task-abc123  "Review code for security issues"
[14:32:01] agent.assigned   claude-01    task-abc123
[14:32:01] agent.working    claude-01    Starting analysis...
[14:32:05] agent.output     claude-01    Found 3 potential issues
[14:32:08] task.completed   task-abc123  status=success duration=7.2s
```

---

### Insight 6: Jelmore is the Differentiator

**Description:** The human-in-the-loop capability via Jelmore/Zellij is what makes Flume unique. Most agent frameworks are fully autonomous. Flume can pause, ask the user, get input, and continue. This should be highlighted in the MVP.

**Source:** Mind Mapping (Adapters branch) + SCAMPER (Reverse - agent requests input)

**Impact:** High
**Effort:** Medium

**Why it matters:** "AI that asks before acting" is a safer, more trustworthy proposition than "AI that does whatever." Jelmore enables this pattern natively.

**Example Flow:**
```
$ flume submit "refactor the auth module" --adapter=jelmore
[14:32:01] task.created     task-xyz789
[14:32:01] agent.assigned   jelmore-01   task-xyz789
[14:32:02] agent.input_req  jelmore-01   "Should I also update the tests? [y/n]"

>>> y

[14:32:10] agent.working    jelmore-01   Updating auth module and tests...
```

---

## Statistics

- **Total ideas:** 56
- **Categories:** 6
- **Key insights:** 6
- **Techniques applied:** 3

---

## Recommended MVP: Option B (Useful Viable)

Based on the brainstorming session, **Option B** is the recommended starting point:

**Rationale:**
1. Option A is too minimal to demonstrate value
2. Option C is impressive but scope-creepy
3. Option B proves the core thesis: transparent, streaming agent orchestration

**Critical Path:**
1. `@flume/cli` package with Commander.js
2. `flume submit` command with stdin/stdout streaming
3. `flume watch` command consuming Bloodbank
4. Echo adapter for local development
5. Claude adapter for real work
6. Basic context injection (cwd, package.json, git status)

**Non-Goals for MVP:**
- TUI dashboard (defer to Option C)
- Letta/Jelmore adapters (nice to have)
- Holocene integration (parallel workstream)
- Full persistence layer (use Bloodbank as event store)

---

## Recommended Next Steps

1. **Run `/bmad:prd`** to create formal requirements for Flume CLI
2. **Run `/bmad:architecture`** to design CLI architecture
3. **Run `/bmad:sprint-planning`** to break into implementable stories

**Immediate Action:**
Create new package `@flume/cli` with:
- `flume submit <objective>`
- `flume status <task-id>`
- `flume cancel <task-id>`
- `flume watch`
- `flume logs <task-id>`

---

*Generated by BMAD Method v6 - Creative Intelligence*
*Session duration: ~30 minutes*
