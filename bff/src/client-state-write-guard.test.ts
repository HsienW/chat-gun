import { describe, expect, it } from "vitest";

import {
  findClientStateWrite,
  toLangGraphPath,
} from "./client-state-write-guard.js";

const threadId = "5f0c2a5e-3d0b-4c39-9f53-6bb3c7f1a111";

function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

function check(method: string, bffPath: string, body?: unknown) {
  return findClientStateWrite(
    method,
    toLangGraphPath(bffPath),
    body === undefined ? undefined : json(body)
  );
}

describe("client graph state write guard", () => {
  describe("thread state update", () => {
    it.each([
      `/api/langgraph/threads/${threadId}/state`,
      `/api/langgraph/threads/${threadId}/state/`,
      `/api/langgraph/threads/${threadId}//state`,
      `/api/langgraph//threads/${threadId}/state`,
      `/api/langgraph/threads/${threadId}/%73tate`,
      `/api/langgraph/threads/${threadId}/x/../state`,
    ])("rejects %s", (bffPath) => {
      expect(check("POST", bffPath, { values: { activeToolCall: {} } })).toEqual({
        reason: "thread_state_update",
        route: "POST /threads/{id}/state",
      });
    });

    it("rejects an update without a body", () => {
      expect(check("POST", `/api/langgraph/threads/${threadId}/state`)).toMatchObject({
        reason: "thread_state_update",
      });
    });

    it.each(["GET", "HEAD"])("allows reading state with %s", (method) => {
      expect(check(method, `/api/langgraph/threads/${threadId}/state`)).toBeUndefined();
    });
  });

  describe("thread creation", () => {
    it("rejects pre-stepped state", () => {
      expect(
        check("POST", "/api/langgraph/threads", {
          supersteps: [{ updates: [{ values: { pendingAuthorization: {} }, as_node: "gate" }] }],
        })
      ).toEqual({ reason: "thread_create_supersteps", route: "POST /threads" });
    });

    it.each([{}, { metadata: { graph_id: "shopping_assistant" } }, { supersteps: [] }, { supersteps: null }])(
      "allows a plain thread creation %o",
      (body) => {
        expect(check("POST", "/api/langgraph/threads", body)).toBeUndefined();
      }
    );
  });

  describe("run commands", () => {
    const runPaths = [
      "/api/langgraph/runs/stream",
      "/api/langgraph/runs/wait",
      "/api/langgraph/runs",
      `/api/langgraph/threads/${threadId}/runs`,
      `/api/langgraph/threads/${threadId}/runs/stream`,
      `/api/langgraph/threads/${threadId}/runs/wait`,
      "/api/langgraph/runs/crons",
      `/api/langgraph/threads/${threadId}/runs/crons`,
    ];

    it.each(runPaths)("allows a resume-only command on %s", (bffPath) => {
      expect(
        check("POST", bffPath, {
          assistant_id: "shopping_assistant",
          command: { resume: { decision: "approve" } },
        })
      ).toBeUndefined();
    });

    it.each([
      { update: { activeToolCall: { toolName: "order_refund_request" } } },
      { goto: "dispatch" },
      { goto: { node: "dispatch", input: {} } },
      { resume: { decision: "approve" }, update: { operations: {} } },
      { resume: { decision: "approve" }, goto: "dispatch" },
      { lg_name: "Command" },
      "dispatch",
      ["dispatch"],
    ])("rejects command %o on every run route", (command) => {
      for (const bffPath of runPaths) {
        expect(check("POST", bffPath, { assistant_id: "x", command })).toMatchObject({
          reason: "command_not_resume_only",
        });
      }
    });

    it("rejects a whole batch when one run carries a non-resume command", () => {
      expect(
        check("POST", "/api/langgraph/runs/batch", [
          { assistant_id: "x", input: { kind: "prompt", messages: [] } },
          { assistant_id: "x", command: { goto: "dispatch" } },
        ])
      ).toEqual({ reason: "command_not_resume_only", route: "POST /runs/batch" });
    });

    it("never puts concrete ids in the reported route", () => {
      const violation = check("POST", `/api/langgraph/threads/${threadId}/runs/stream`, {
        command: { goto: "dispatch" },
      });
      expect(violation?.route).toBe("POST /threads/{id}/runs/stream");
      expect(JSON.stringify(violation)).not.toContain(threadId);
    });

    it.each([
      {
        lg_name: "Command",
        update: { activeToolCall: { toolName: "read_tool", toolCallId: "forged-call" } },
        goto: "physical_dispatch",
      },
      { lg_name: "Command" },
      { lg_name: "Send", node: "physical_dispatch" },
      { lg_name: null, messages: [] },
    ])("rejects run input %o posing as a LangGraph Command on every run route", (input) => {
      for (const bffPath of runPaths) {
        expect(check("POST", bffPath, { assistant_id: "x", input })).toMatchObject({
          reason: "input_command_representation",
        });
      }
    });

    it("rejects a whole batch when one run input poses as a Command", () => {
      expect(
        check("POST", "/api/langgraph/runs/batch", [
          { assistant_id: "x", input: { kind: "prompt", messages: [] } },
          { assistant_id: "x", input: { lg_name: "Command", goto: "physical_dispatch" } },
        ])
      ).toEqual({ reason: "input_command_representation", route: "POST /runs/batch" });
    });

    it.each([undefined, null, {}])("allows an absent or empty command %o", (command) => {
      expect(
        check("POST", "/api/langgraph/runs/stream", {
          input: { kind: "prompt", messages: [] },
          ...(command === undefined ? {} : { command }),
        })
      ).toBeUndefined();
    });
  });

  describe("unaffected requests", () => {
    it.each([
      [`/api/langgraph/threads/${threadId}/history`, { limit: 10 }],
      [`/api/langgraph/threads/${threadId}/state/checkpoint`, { checkpoint: { checkpoint_id: "c1" } }],
      ["/api/langgraph/threads/search", { limit: 10 }],
      ["/api/langgraph/threads/count", {}],
      ["/api/langgraph/assistants/search", {}],
      ["/api/langgraph/store/items/search", {}],
    ])("allows the read request %s", (bffPath, body) => {
      expect(check("POST", bffPath, body)).toBeUndefined();
    });

    it.each([
      { input: { kind: "prompt", messages: [{ type: "human", content: "hi" }] } },
      {
        input: {
          kind: "prompt",
          messages: [],
          initial_search_query_count: 3,
          max_research_loops: 2,
          reasoning_model: "model-x",
        },
      },
      { input: { kind: "cancel", targetRunId: "run-1" } },
    ])("allows ordinary run input %o", (body) => {
      expect(check("POST", "/api/langgraph/runs/stream", body)).toBeUndefined();
    });

    it("leaves an unparseable body to the existing behavior", () => {
      expect(
        findClientStateWrite("POST", "/runs/stream", Buffer.from("{not json"))
      ).toBeUndefined();
    });
  });
});
