/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TaskFlowListAllEntry } from "../../lib/task-flows/data.ts";
import { renderTaskFlows } from "./view.ts";

function flow(overrides: Partial<TaskFlowListAllEntry> = {}): TaskFlowListAllEntry {
  return {
    flowId: "flow-1",
    ownerKey: "agent:ops:main",
    agentId: "ops",
    syncMode: "managed",
    status: "running",
    goal: "Ship the thing",
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function flowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-flow-id]")].map(
    (el) => el.getAttribute("data-flow-id") ?? "",
  );
}

describe("renderTaskFlows", () => {
  it("hides succeeded and failed flows by default", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-running", status: "running" }),
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(
      renderTaskFlows({
        connected: true,
        loading: false,
        error: null,
        flows,
        showSucceeded: false,
        showFailed: false,
        onShowSucceededChange: vi.fn(),
        onShowFailedChange: vi.fn(),
      }),
      container,
    );
    expect(flowIds(container)).toEqual(["flow-running"]);
  });

  it("reveals succeeded flows when showSucceeded is checked, independent of showFailed", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(
      renderTaskFlows({
        connected: true,
        loading: false,
        error: null,
        flows,
        showSucceeded: true,
        showFailed: false,
        onShowSucceededChange: vi.fn(),
        onShowFailedChange: vi.fn(),
      }),
      container,
    );
    expect(flowIds(container)).toEqual(["flow-succeeded"]);
  });

  it("reveals failed flows when showFailed is checked", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(
      renderTaskFlows({
        connected: true,
        loading: false,
        error: null,
        flows,
        showSucceeded: false,
        showFailed: true,
        onShowSucceededChange: vi.fn(),
        onShowFailedChange: vi.fn(),
      }),
      container,
    );
    expect(flowIds(container)).toEqual(["flow-failed"]);
  });

  it("invokes the change callbacks when the filter checkboxes are toggled", () => {
    const container = document.createElement("div");
    const onShowSucceededChange = vi.fn();
    const onShowFailedChange = vi.fn();
    render(
      renderTaskFlows({
        connected: true,
        loading: false,
        error: null,
        flows: [flow({ flowId: "flow-succeeded", status: "succeeded" })],
        showSucceeded: false,
        showFailed: false,
        onShowSucceededChange,
        onShowFailedChange,
      }),
      container,
    );
    const checkboxes = [
      ...container.querySelectorAll('input[type="checkbox"]'),
    ] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    const [succeededCheckbox, failedCheckbox] = checkboxes;
    succeededCheckbox.checked = true;
    succeededCheckbox.dispatchEvent(new Event("change"));
    expect(onShowSucceededChange).toHaveBeenCalledWith(true);
    failedCheckbox.checked = true;
    failedCheckbox.dispatchEvent(new Event("change"));
    expect(onShowFailedChange).toHaveBeenCalledWith(true);
  });

  it("shows the filtered-empty message when a filter hides every flow", () => {
    const container = document.createElement("div");
    render(
      renderTaskFlows({
        connected: true,
        loading: false,
        error: null,
        flows: [flow({ flowId: "flow-succeeded", status: "succeeded" })],
        showSucceeded: false,
        showFailed: false,
        onShowSucceededChange: vi.fn(),
        onShowFailedChange: vi.fn(),
      }),
      container,
    );
    expect(flowIds(container)).toHaveLength(0);
    expect(container.textContent).toContain("No TaskFlows match the current filters.");
  });
});
