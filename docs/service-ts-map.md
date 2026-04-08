# `src/bridge/service.ts` 职责地图

> **What is this**: a read-only survey of the 5344-line `src/bridge/service.ts`
> for use as input to a future split. Captured from HEAD `d8147f0` after the
> failover/pairing work landed. **No code changes were made to produce this
> document.**
>
> **Why**: `FeiqueService` is the largest file in feique by an order of
> magnitude. Before any restructuring, we need an accurate picture of which
> responsibilities live where, how they cluster, and where the cleavage
> planes naturally are. Splitting blind is a recipe for hidden behavior
> changes.

## High-level shape

| Region | Lines | Notes |
|---|---|---|
| Imports + types | 1–98 | ~17 imports across config / state / collab / feishu / backend / observability |
| `class FeiqueService` | **99–5051** | **4953 lines, 99 methods/fields** |
| Module-level helpers | 5052–5344 | 14 pure functions, 293 lines |

The class is the elephant. Everything below maps the inside of `FeiqueService`.

## Region-by-region inventory

### A. Class state + constructor (L99–148, ~50 lines)

11 instance fields and one constructor with **17 injected dependencies**.

```
queue, projectRootQueue, activeRuns, runReplyTargets, chatRateWindows,
failoverNotified, rejectedChatNotified, maintenanceTimer, digestTimer,
configWatcher, intentClassifier, currentMessageContext
```

**Smell**: 17-dep constructor. Most refactors of this file should preserve
the constructor as-is and split the methods across helper classes that take
the relevant subset of these deps as their own constructor.

### B. Lifecycle / startup / maintenance loops (L149–420, ~272 lines)

| Method | Lines | Purpose |
|---|---|---|
| `recoverRuntimeState` | 149–172 | Restart-time orphan run recovery |
| `reloadConfig` | 173–230 | Hot reload entry, diff + admin notify |
| `startConfigWatcher` / `stopConfigWatcher` | 231–253 | FSWatcher on config file |
| `startMaintenanceLoop` / `stopMaintenanceLoop` | 254–285 | Periodic maintenance scheduler |
| `startDigestLoop` | 286–299 | Periodic digest scheduler |
| `runDigestCycle` | 300–354 | Compose + send daily digest |
| `runMemoryMaintenance` | 355–369 | Cleanup expired memory entries |
| `runAuditMaintenance` | 370–400 | Audit log cleanup + archive |
| `runMaintenanceCycle` | 401–420 | Wraps memory + audit |

**Cohesion**: high (everything timer/lifecycle). **Cleavage**: clean. This
region is the strongest candidate for first split — `FeiqueServiceLifecycle`
or similar.

### C. Message intake / dispatcher (L421–732, ~312 lines)

| Method | Lines | Purpose |
|---|---|---|
| `handleIncomingMessage` | 421–597 | **177 lines** — main message dispatcher |
| `handleCardAction` | 598–732 | **135 lines** — interactive card callbacks |
| `listRuns` | 733–736 | Trivial accessor |

`handleIncomingMessage` is a giant switch over `parseBridgeCommand` results,
dispatching to ~30 `handle*Command` methods. Internally it does: dedupe →
project gate → AI intent classify → audit → metric → switch.

**Cohesion**: medium. **Cleavage**: this region IS the dispatcher — splitting
it requires either (a) a CommandRouter class that takes the service as a
backref, or (b) slim handlers that move into per-domain files but call back
through `service.something()` for state. Both patterns are common; pick one
explicitly before starting.

### D. The big one: `executePrompt` (L737–1207, **471 lines**)

Single private method. Internal phase markers (extracted from comments and
await sites):

```
1.  Conversation lookup / ensure                  (~750–755)
2.  Auto-adopt latest local session               (~756–774)
3.  Memory cleanup + retrieve memory context      (~776–789)
4.  "Direction 6": onboarding context for new actors (~790–807)
5.  Build bridge prompt                           (~809–812)
6.  Resolve backend (with failover)               (~819–833)  ← my code
7.  Update run-started reply                      (~835)
8.  Persist run state + audit                     (~837–871)
9.  Metrics: turn started                          (~880)
10. Codex/Claude turn execution loop              (~882–940)
11. File-attachment send pass                     (~959–971)
12. Audit completed turn                          (~974–988)
13. Persist session, thread summary               (~1008–1031)
14. Enforce session history limit                 (~1040)
15. Persist final run state                        (~1041)
16. Metrics: cost + tokens                         (~1057–1063)
17. "Direction 5": trust outcome                  (~1066–1071)
18. Alerts on completed run                       (~1076–1078)
19. "Direction 2": auto-extract knowledge memory  (~1082–1090)
20. (continues to ~L1207 with error handling tail)
```

**Smell**: this is a 20-phase pipeline crammed into one method. Each phase
is independently testable and most have no shared mutable state beyond
`runId` / `input`. The natural shape is:

```ts
class RunPipeline {
  async run(input): Promise<RunOutcome> {
    const ctx = await this.ensureConversation(input);
    await this.autoAdoptLatestSession(ctx);
    const memory = await this.collectMemoryContext(ctx);
    const onboarding = await this.collectOnboardingContext(ctx);
    const prompt = await this.buildPrompt(ctx, memory, onboarding);
    const backend = await this.resolveBackend(ctx);
    // ...
  }
}
```

But: each phase reads/writes through 6+ injected stores. Splitting requires
deciding whether `RunPipeline` becomes a god-object with all stores
re-injected, or a thin orchestrator that calls helper functions.

### E. Command handlers — chat-driven (L1208–1693)

| Method | Lines |
|---|---|
| `handleProjectCommand` | 1208–1281 |
| `handleReadOnlyFollowupCommand` | 1282–1337 |
| `handlePromptMessage` | 1338–1507 |
| `handleStatusCommand` | 1508–1552 |
| `handleNewCommand` | 1553–1574 |
| `handleCancelCommand` | 1575–1594 |
| `handleSessionCommand` | 1595–1684 |
| `handleTeamCommand` | 1685–1693 |

Total ~487 lines. Each method is largely self-contained but needs the
session/run/audit stores. Good split candidates if `CommandRouter` pattern
is chosen.

### F. Collaboration commands (L1694–2077, ~384 lines)

| Method | Lines |
|---|---|
| `handleLearnCommand` | 1694–1725 |
| `handleRecallCommand` | 1726–1742 |
| `handleHandoffCommand` | 1743–1774 |
| `handlePickupCommand` | 1775–1827 |
| `handleReviewCommand` | 1828–1862 |
| `handleApproveCommand` | 1863–1889 |
| `handleRejectCommand` | 1890–1919 |
| `handleInsightsCommand` | 1920–1929 |
| `handleTrustCommand` | 1930–1997 |
| `handleDigestCommand` | 1998–2011 |
| `checkAndSendAlerts` | 2012–2042 |
| `handleGapsCommand` | 2043–2054 |
| `handleTimelineCommand` | 2055–2077 |

All depend on `handoffStore`, `trustStore`, `runStateStore`, `memoryStore`.
**Strong cleavage candidate**: extract a `CollaborationCommands` class taking
just those 4 stores + `feishuClient` for replies.

### G. Admin commands (L2078–2423, ~346 lines)

| Method | Lines |
|---|---|
| `handleAdminCommand` | 2078–2336 (**259 lines**) |
| `handleSessionAdoptCommand` | 2337–2369 |
| `handleBackendCommand` | 2370–2423 |

`handleAdminCommand` alone is 259 lines — internal switch over
`/admin <resource> <action>` permutations. Touches config mutation,
project create/setup (← the WIP touches this), allowlist mutation,
service restart.

### H. Memory commands (L2424–2819, ~396 lines)

| Method | Lines |
|---|---|
| `handleMemoryCommand` | 2424–2811 (**388 lines**) |
| `renderMemoryFilterLines` | 2812–2819 |

`handleMemoryCommand` is the second-largest single method after
`executePrompt`. Internal switch over `/memory list/save/pin/...`.
Strong split candidate — owns no shared state with most other handlers.

### I. Feishu integration commands (L2820–3488, ~669 lines)

| Method | Lines | Wraps Feishu SDK |
|---|---|---|
| `handleKnowledgeCommand` | 2820–2885 | knowledge_paths |
| `handleDocCommand` | 2886–2951 | `FeishuDocClient` |
| `handleTaskCommand` | 2952–3048 | `FeishuTaskClient` |
| `handleBaseCommand` | 3049–3139 | `FeishuBaseClient` |
| `handleWikiCommand` | 3140–3488 (**349 lines**) | `FeishuWikiClient` |

These methods all instantiate `new FeishuXClient(this.feishuClient.createSdkClient())`
internally on each call. **Each Feishu vertical (doc/task/base/wiki) is a
self-contained slice with zero state interaction with the rest of the file.**

**Best cleavage in the entire file.** Each can move to its own file
(`src/bridge/feishu-doc-commands.ts`, etc) trivially.

### J. Status / project resolution helpers (L3489–3754, ~266 lines)

| Method | Lines |
|---|---|
| `buildProjectsText` | 3489–3504 |
| `buildStatusText` | 3505–3525 |
| `buildDetailedStatusText` | 3526–3554 |
| `buildStatusCardFromConversation` | 3555–3610 |
| `buildBridgePrompt` | 3611–3683 |
| `requireProject` | 3684–3691 |
| `resolveProjectAlias` | 3692–3704 |
| `resolveProjectContext` | 3705–3736 |
| `getSelectionConversationKey` | 3737–3754 |

Pure read helpers + prompt assembly. Easy to extract into a `RunContext`
or `ProjectResolver` helper.

### K. Selection / scope / memory targeting (L3755–3826, ~72 lines)

Small grab bag: `getSelectionScope`, `shouldRequireMention`,
`resolveMemoryTarget`, `buildMemoryExpiresAt`, `cancelActiveRun`.

### L. Run scheduling / queue (L3827–3989, ~163 lines)

| Method | Lines |
|---|---|
| `scheduleProjectExecution` | 3827–3868 |
| `prepareQueuedExecution` | 3869–3944 |
| `buildAcknowledgedRunReply` | 3945–3956 |
| `buildQueuedStatusDetail` | 3957–3982 |
| `buildRunStatusSummary` | 3983–3989 |

Couples directly to `queue` and `projectRootQueue`. Strong cohesion.
Could become `RunScheduler` taking those two queues + `runStateStore`.

### M. Access control / role checks / admin views (L3990–4166, ~177 lines)

17 methods, mostly 4-line wrappers around `src/security/access.ts`. The
non-trivial ones are the `buildAdmin*Text` view builders.

The wrappers are pure thin shims — could be inlined at call sites and the
class shed 60 lines for nearly free.

### N. Admin config mutation / persistence (L4167–4394, ~228 lines)

| Method | Lines |
|---|---|
| `handleAdminConfigCommand` | 4167–4229 |
| `snapshotConfigForAdminMutation` | 4230–4247 |
| `appendAdminAudit` | 4248–4251 |
| `reloadRuntimeConfigFromDisk` | 4252–4261 |
| `parseProjectPatch` | 4262–4321 |
| `resolveListPatch` | 4322–4342 |
| `resolveProjectDownloadDir/TempDir/CacheDir` | 4343–4354 |
| `appendProjectAuditEvent` | 4355–4359 |
| `notifyProjectChats` | 4360–4369 |
| `listManagedAuditTargets` | 4370–4394 |

Cohesive: all about persisting admin-driven config changes. Coupled to
`configHistoryStore` and `auditLog`.

### O. Rate limit / list mutation / backend resolve / failover / pairing (L4395–4555, ~161 lines)

| Method | Lines |
|---|---|
| `checkAndConsumeChatRateLimit` | 4395–4417 |
| `applyAdminListValues` | 4418–4449 |
| `resolveProjectRoot` | 4450–4453 |
| `resolveBackendByName` | 4454–4466 |
| `handleBackendFailover` | 4467–4520 ← landed in d8147f0 |
| `handleRejectedChat` | 4521–4555 ← landed in d8147f0 |

Mixed bag. The two new methods are isolated single-purpose; the rest
are utility shims.

### P. Reply rendering / card UI (L4556–5042, ~487 lines)

| Method | Lines |
|---|---|
| `enforceSessionHistoryLimit` | 4556–4563 |
| `sendTextReply` | 4564–4646 (**83 lines**) |
| `sendCardReply` | 4647–4653 |
| `sendRunLifecycleReply` | 4654–4722 |
| `buildInitialRunLifecycleReply` | 4723–4744 |
| `sendInitialRunLifecycleReply` | 4745–4772 |
| `rememberRunReplyTarget` | 4773–4783 |
| `updateRunStartedReply` | 4784–4801 |
| `updateRunProgressReply` | 4802–4839 |
| `sendOrUpdateRunOutcome` | 4840–4889 |
| `updateRunLifecycleReply` | 4890–4973 (**84 lines**) |
| `formatQuotedReply` | 4974–4977 |
| `buildReplyTitle` | 4978–4985 |
| `sanitizeUserVisibleReply` | 4986–4994 |
| `supportsInteractiveCardActions` | 4995–4998 |
| `resolveRunLifecycleReplyMode` | 4999–5005 |
| `buildRunLifecycleCard` | 5006–5042 |
| `stripLifecycleMetadata` | 5043–5050 |

**Largest single domain after `executePrompt`.** All methods route through
`feishuClient` to send/update text/card/post messages to chat. Strong
cohesion. **Top split candidate** — all these can move to a `ReplyRenderer`
class taking just `feishuClient` + the active run reply state map.

### Q. Module-level helpers (L5052–5344, ~293 lines)

14 pure functions outside the class:

```
extractFileMarkers, diffConfigs, truncateExcerpt, friendlyErrorMessage,
splitCommaSeparatedValues, resolveAdminListTarget,
buildConversationKeyForConversation, renderMemorySection, formatAgeFromNow,
parseJsonObject, clampListLimit, mapRunStatusToPhase, replaceObject,
replaceProjects, createDeferred
```

These are already pure utilities and **could be moved to
`src/bridge/service-utils.ts` with zero risk** as a warmup exercise.

## Cleavage planes — recommended split order

If β proceeds, do it in this exact order to minimize risk at each step.
After every step: `npm run typecheck` + run the **stable** test subset
(`backend-probe`, `backend-factory-failover`, `webhook-bridge`,
`access-control`, `doctor`, plus `bridge-service` 3× for flake check).

| Step | What | Lines moved | Risk | Notes |
|---|---|---|---|---|
| **1** | Module-level helpers → `src/bridge/service-utils.ts` | 293 | ~0 | Pure functions, no `this`. Smoke check. |
| **2** | Feishu vertical commands → 4 files (`feishu-doc-commands.ts`, `-task-`, `-base-`, `-wiki-`) | 669 | low | Self-contained, no shared state |
| **3** | Reply renderer → `src/bridge/reply-renderer.ts` | 487 | medium | Needs `runReplyTargets` access — pass it in |
| **4** | Collaboration commands → `src/bridge/collaboration-commands.ts` | 384 | medium | 4 stores + feishuClient |
| **5** | Memory command → `src/bridge/memory-commands.ts` | 396 | medium | One huge method with internal switch |
| **6** | Lifecycle / maintenance → `src/bridge/service-lifecycle.ts` | 272 | medium | Touches several stores |
| **7** | Admin config mutation → `src/bridge/admin-config.ts` | 228 | medium-high | Touches running config |
| **8** | Run scheduler → `src/bridge/run-scheduler.ts` | 163 | medium | Couples to both queues |
| **9** | `executePrompt` pipeline phases → `src/bridge/run-pipeline.ts` | 471 | **HIGH** | The crown jewel. Last. |

After all 9 steps: `service.ts` shrinks from 5344 → roughly 1700 lines
(intake dispatcher + status helpers + access wrappers + state +
constructor). Still big, but each region remaining is genuinely
single-purpose.

## What NOT to extract

- **Constructor & state** stay in the class. The 17-dep injection list is
  the truth — every helper class will need a subset.
- **`handleIncomingMessage` dispatcher** stays. It IS the routing table.
- **Access-control wrappers** (region M) — 4-line shims. Inlining beats
  extracting.
- **`canExecuteProjectRuns` and friends** — same.

## Open risks to settle BEFORE step 1

1. **Test suite is unreliable** (see diagnostic in this session: v1.3.3
   baseline shows 32–37 failed tests, all timeouts in `bridge-service.test.ts`
   and `collaboration-e2e.test.ts`). β cannot use "tests pass before/after"
   as the safety net. Each step needs:
   - typecheck ✅
   - smoke run of stable test subset ✅
   - 3× run of `bridge-service.test.ts` and intersect failures (regression =
     failures present in all 3 runs that weren't in baseline)
2. **WIP commit `8c7c99b`** modifies `handleAdminCommand` (the
   `/admin project setup` action) at L2143–2200ish. Step 7 (admin config
   mutation extraction) will collide with this region. Either land a
   follow-up to that WIP first, or carefully patch around it.
3. **Many methods reach across regions** via `this.something()`. Each
   extracted class needs its constructor decided up front — what subset of
   the 17 deps does it need? Sketch the dep table per step before writing
   any code.
