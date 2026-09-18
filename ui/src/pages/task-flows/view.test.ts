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

function baseProps(overrides: Partial<Parameters<typeof renderTaskFlows>[0]> = {}) {
  return {
    connected: true,
    loading: false,
    error: null,
    flows: [] as TaskFlowListAllEntry[],
    showSucceeded: false,
    showFailed: false,
    onShowSucceededChange: vi.fn(),
    onShowFailedChange: vi.fn(),
    canClearTerminal: false,
    clearingStatus: null,
    onClearSucceeded: vi.fn(),
    onClearFailed: vi.fn(),
    ...overrides,
  };
}

describe("renderTaskFlows", () => {
  it("hides succeeded and failed flows by default", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-running", status: "running" }),
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(renderTaskFlows(baseProps({ flows })), container);
    expect(flowIds(container)).toEqual(["flow-running"]);
  });

  it("reveals succeeded flows when showSucceeded is checked, independent of showFailed", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(renderTaskFlows(baseProps({ flows, showSucceeded: true })), container);
    expect(flowIds(container)).toEqual(["flow-succeeded"]);
  });

  it("reveals failed flows when showFailed is checked", () => {
    const container = document.createElement("div");
    const flows = [
      flow({ flowId: "flow-succeeded", status: "succeeded" }),
      flow({ flowId: "flow-failed", status: "failed" }),
    ];
    render(renderTaskFlows(baseProps({ flows, showFailed: true })), container);
    expect(flowIds(container)).toEqual(["flow-failed"]);
  });

  it("invokes the change callbacks when the filter checkboxes are toggled", () => {
    const container = document.createElement("div");
    const onShowSucceededChange = vi.fn();
    const onShowFailedChange = vi.fn();
    render(
      renderTaskFlows(
        baseProps({
          flows: [flow({ flowId: "flow-succeeded", status: "succeeded" })],
          onShowSucceededChange,
          onShowFailedChange,
        }),
      ),
      container,
    );
    const checkboxes = [
      ...container.querySelectorAll('input[type="checkbox"]'),
    ] as HTMLInputElement[];
    expect(checkboxes).toHaveLength(2);
    const [succeededCheckbox, failedCheckbox] = checkboxes;
    expect(succeededCheckbox).toBeDefined();
    expect(failedCheckbox).toBeDefined();
    succeededCheckbox!.checked = true;
    succeededCheckbox!.dispatchEvent(new Event("change"));
    expect(onShowSucceededChange).toHaveBeenCalledWith(true);
    failedCheckbox!.checked = true;
    failedCheckbox!.dispatchEvent(new Event("change"));
    expect(onShowFailedChange).toHaveBeenCalledWith(true);
  });

  it("shows the filtered-empty message when a filter hides every flow", () => {
    const container = document.createElement("div");
    render(
      renderTaskFlows(
        baseProps({ flows: [flow({ flowId: "flow-succeeded", status: "succeeded" })] }),
      ),
      container,
    );
    expect(flowIds(container)).toHaveLength(0);
    expect(container.textContent).toContain("No TaskFlows match the current filters.");
  });

  it("hides the clear-terminal buttons when the caller is not an operator admin", () => {
    const container = document.createElement("div");
    render(renderTaskFlows(baseProps({ canClearTerminal: false })), container);
    expect(container.textContent).not.toContain("Clear succeeded");
    expect(container.textContent).not.toContain("Clear failed");
  });

  it("shows both clear-terminal buttons for an operator admin and wires their callbacks", () => {
    const container = document.createElement("div");
    const onClearSucceeded = vi.fn();
    const onClearFailed = vi.fn();
    render(
      renderTaskFlows(baseProps({ canClearTerminal: true, onClearSucceeded, onClearFailed })),
      container,
    );
    const buttons = [...container.querySelectorAll("button")];
    const clearSucceeded = buttons.find(
      (button) => button.textContent?.trim() === "Clear succeeded",
    );
    const clearFailed = buttons.find((button) => button.textContent?.trim() === "Clear failed");
    expect(clearSucceeded).toBeDefined();
    expect(clearFailed).toBeDefined();
    clearSucceeded!.click();
    expect(onClearSucceeded).toHaveBeenCalledTimes(1);
    clearFailed!.click();
    expect(onClearFailed).toHaveBeenCalledTimes(1);
  });

  it("disables both clear-terminal buttons and shows a busy label for the one in flight", () => {
    const container = document.createElement("div");
    render(
      renderTaskFlows(baseProps({ canClearTerminal: true, clearingStatus: "succeeded" })),
      container,
    );
    const buttons = [...container.querySelectorAll("button")];
    const busyButton = buttons.find((button) => button.textContent?.trim() === "Clearing…");
    const otherButton = buttons.find((button) => button.textContent?.trim() === "Clear failed");
    expect(busyButton).toBeDefined();
    expect(busyButton!.disabled).toBe(true);
    expect(otherButton).toBeDefined();
    expect(otherButton!.disabled).toBe(true);
  });

  it("disables the clear-terminal buttons while disconnected", () => {
    const container = document.createElement("div");
    render(renderTaskFlows(baseProps({ canClearTerminal: true, connected: false })), container);
    const buttons = [...container.querySelectorAll("button")];
    const clearSucceeded = buttons.find(
      (button) => button.textContent?.trim() === "Clear succeeded",
    );
    expect(clearSucceeded).toBeDefined();
    expect(clearSucceeded!.disabled).toBe(true);
  });
});
