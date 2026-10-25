import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PAUSED_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const IDLE_AGENT_ID = "33333333-3333-4333-8333-333333333333";

const agentStatusById: Record<string, string> = {
  [AGENT_ACTOR_ID]: "idle",
  [PAUSED_AGENT_ID]: "paused",
  [IDLE_AGENT_ID]: "idle",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  findOpenAncestorCreatedByAgent: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getDependencyReadiness: vi.fn(async () => ({
    blockerIssueIds: [],
    isDependencyReady: false,
    unresolvedBlockerCount: 0,
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

import { heartbeatRuns, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

type Actor = Record<string, unknown>;

function boardActor(): Actor {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function agentActor(): Actor {
  return {
    type: "agent",
    agentId: AGENT_ACTOR_ID,
    companyId: "company-1",
    source: "agent_key",
    runId: AGENT_RUN_ID,
  };
}

// Minimal chainable/thenable db stub: a query resolves to the rows given for
// its table, otherwise an empty row set. Run containment is mocked because
// this suite targets assignee invokability.
function stubDb(rowsByTable: Map<unknown, unknown[]> = new Map()): any {
  return {
    select: () => {
      let rows: unknown[] = [];
      const query: any = {};
      for (const method of ["select", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
        query[method] = () => query;
      }
      query.from = (table: unknown) => {
        rows = rowsByTable.get(table) ?? [];
        return query;
      };
      query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows));
      return query;
    },
  };
}

function createApp(actor: Actor, rowsByTable?: Map<unknown, unknown[]>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(stubDb(rowsByTable) as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ACTOR_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Invokability test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue assignee invokability guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.update.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockClear();
    mockObserveCrossIssueInfluence.mockClear();
    mockObserveCrossIssueInfluence.mockResolvedValue(null);
  });

  it("refuses an agent assigning an issue to a paused agent", async () => {
    const existing = makeIssue();
    mockIssueService.getById.mockResolvedValue(existing);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent creating a child issue assigned to a paused agent", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Escalation for the manager",
        description: "Needs a decision",
        assigneeAgentId: PAUSED_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still allows an agent to assign to an invokable agent", async () => {
    const existing = makeIssue();
    const updated = makeIssue({ assigneeAgentId: IDLE_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(agentActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: IDLE_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows a board user to assign to a paused agent deliberately", async () => {
    const existing = makeIssue({ assigneeAgentId: null });
    const updated = makeIssue({ assigneeAgentId: PAUSED_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);

    const res = await request(createApp(boardActor()))
      .patch(`/api/issues/${existing.id}`)
      .send({ assigneeAgentId: PAUSED_AGENT_ID });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});

const openAncestorByIdleAgent = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  identifier: "PAP-100",
  parentId: null,
  createdByAgentId: IDLE_AGENT_ID,
  status: "in_progress",
};

function createdIssue(overrides: Record<string, unknown> = {}) {
  return makeIssue({
    id: "99999999-9999-4999-8999-999999999999",
    identifier: "PAP-1000",
    assigneeAgentId: IDLE_AGENT_ID,
    ...overrides,
  });
}

// Db rows that bind the agent's current run to `source`.
function runBoundTo(source: ReturnType<typeof makeIssue>) {
  return new Map<unknown, unknown[]>([
    [heartbeatRuns, [{
      id: AGENT_RUN_ID,
      companyId: "company-1",
      agentId: AGENT_ACTOR_ID,
      issueId: source.id,
      nativeIssueId: null,
      contextSnapshot: null,
    }]],
    [issues, [source]],
  ]);
}

describe("agent delegation cycle guard", () => {
  beforeEach(() => {
    mockIssueService.getById.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockReset();
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(null);
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
  });

  it("refuses an agent child assigned to the creator of an open ancestor", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      identifier: "PAP-100",
      parentId: null,
      createdByAgentId: IDLE_AGENT_ID,
      status: "in_progress",
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Delegation cycle");
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.findOpenAncestorCreatedByAgent).toHaveBeenCalledWith(parent.id, IDLE_AGENT_ID);
  });

  it("allows the same child when no open ancestor was created by the assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Legit subtask",
        description: "Fine",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalled();
  });

  it("allows a review child assigned to the creator of an open ancestor", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      identifier: "PAP-100",
      parentId: null,
      createdByAgentId: IDLE_AGENT_ID,
      status: "in_progress",
    });
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Visual review of the previs",
        description: "Review the frames",
        assigneeAgentId: IDLE_AGENT_ID,
        kind: "review",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      parent.id,
      expect.objectContaining({
        assigneeAgentId: IDLE_AGENT_ID,
        originKind: "review_request",
        originId: parent.id,
      }),
    );
    expect(mockIssueService.createChild.mock.calls[0]?.[1]).not.toHaveProperty("kind");
  });

  it("rejects an unknown child kind instead of exempting it", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Hand it back",
        description: "Bounce",
        assigneeAgentId: IDLE_AGENT_ID,
        kind: "execution",
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("still refuses an approval child assigned to a paused agent", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Approve the cut",
        description: "Sign off",
        assigneeAgentId: PAUSED_AGENT_ID,
        kind: "approval",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("paused agent");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("allows a company-route review under an explicit parent with an ancestor-creator assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(openAncestorByIdleAgent);
    mockIssueService.create.mockResolvedValue(createdIssue({ parentId: parent.id }));

    const res = await request(createApp(agentActor()))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Visual review of the previs",
        description: "Review the frames",
        parentId: parent.id,
        assigneeAgentId: IDLE_AGENT_ID,
        kind: "review",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        parentId: parent.id,
        assigneeAgentId: IDLE_AGENT_ID,
        originKind: "review_request",
        originId: parent.id,
      }),
    );
    expect(mockIssueService.create.mock.calls[0]?.[1]).not.toHaveProperty("kind");
  });

  it("still refuses a company-route execution child under an explicit parent with an ancestor-creator assignee", async () => {
    const parent = makeIssue();
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(openAncestorByIdleAgent);

    const res = await request(createApp(agentActor()))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Hand it back",
        description: "Bounce",
        parentId: parent.id,
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "delegation_cycle" });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("stamps a null origin id on a standalone company-route approval", async () => {
    mockIssueService.create.mockResolvedValue(createdIssue());

    const res = await request(createApp(agentActor()))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Approve the release notes",
        description: "Sign off",
        parentId: null,
        assigneeAgentId: IDLE_AGENT_ID,
        kind: "approval",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ parentId: null, originKind: "review_request", originId: null }),
    );
  });

  it("keeps the run's task as default parent for a review to an ancestor creator", async () => {
    const source = makeIssue();
    mockIssueService.getById.mockResolvedValue(source);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(openAncestorByIdleAgent);
    mockIssueService.create.mockResolvedValue(createdIssue({ parentId: source.id }));

    const res = await request(createApp(agentActor(), runBoundTo(source)))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Visual review of the previs",
        description: "Review the frames",
        assigneeAgentId: IDLE_AGENT_ID,
        kind: "review",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenAncestorCreatedByAgent).not.toHaveBeenCalled();
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        parentId: source.id,
        originKind: "review_request",
        originId: source.id,
      }),
    );
  });

  it("drops the run's default parent for an execution child to an ancestor creator", async () => {
    const source = makeIssue();
    mockIssueService.getById.mockResolvedValue(source);
    mockIssueService.findOpenAncestorCreatedByAgent.mockResolvedValue(openAncestorByIdleAgent);
    mockIssueService.create.mockResolvedValue(createdIssue());

    const res = await request(createApp(agentActor(), runBoundTo(source)))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Follow-up",
        description: "Standalone work",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenAncestorCreatedByAgent).toHaveBeenCalledWith(source.id, IDLE_AGENT_ID);
    const createBody = mockIssueService.create.mock.calls[0]?.[1];
    expect(createBody?.parentId ?? null).toBeNull();
    expect(createBody).not.toHaveProperty("originKind", "review_request");
  });

  it("rejects kind on accepted-plan decomposition children", async () => {
    const res = await request(createApp(agentActor()))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/accepted-plan-decompositions")
      .send({
        acceptedPlanRevisionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        children: [{ title: "Review", assigneeAgentId: IDLE_AGENT_ID, kind: "review" }],
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("kind is not supported");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("does not consult the guard for board actors", async () => {
    const parent = makeIssue({ assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(parent);
    mockIssueService.createChild.mockResolvedValue({
      issue: makeIssue({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", parentId: parent.id, assigneeAgentId: IDLE_AGENT_ID }),
      parentBlockerAdded: false,
    });

    const res = await request(createApp(boardActor()))
      .post(`/api/issues/${parent.id}/children`)
      .send({
        title: "Human-created child",
        description: "Deliberate",
        assigneeAgentId: IDLE_AGENT_ID,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.findOpenAncestorCreatedByAgent).not.toHaveBeenCalled();
  });
});
