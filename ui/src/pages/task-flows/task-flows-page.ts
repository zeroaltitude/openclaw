import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { html } from "lit";
import { state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import {
  normalizeTaskFlowListAllResult,
  sortTaskFlowsByCreatedAtDesc,
  type TaskFlowListAllEntry,
} from "../../lib/task-flows/data.ts";
import { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { renderTaskFlows } from "./view.ts";

type ClearableTerminalStatus = "succeeded" | "failed";

async function loadTaskFlowSnapshot(params: {
  client: GatewayBrowserClient;
  signal: AbortSignal;
}): Promise<TaskFlowListAllEntry[]> {
  const payload = await params.client.request("taskFlows.listAll", {}, { signal: params.signal });
  const result = normalizeTaskFlowListAllResult(payload);
  if (!result) {
    throw new Error(t("taskFlowsPage.invalidResponse"));
  }
  return sortTaskFlowsByCreatedAtDesc(result.flows);
}

class TaskFlowsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private flows: TaskFlowListAllEntry[] = [];
  @state() private error: string | null = null;
  // Terminal states are hidden by default; these mirror the two filter checkboxes.
  @state() private showSucceeded = false;
  @state() private showFailed = false;
  // Which manual clear (if any) is currently in flight; disables both clear
  // buttons and swaps the busy one's label until the request settles.
  @state() private clearingStatus: ClearableTerminalStatus | null = null;

  private readonly gateway = new GatewayPageController(this, {
    getGateway: () => this.context?.gateway,
    onIdentityChange: () => {
      this.flows = [];
      this.error = null;
    },
    invalidateRequests: () => void this.listFlowsTask.run([null, null]),
    ensureInitialData: () => void this.refreshFlows(),
  });

  private readonly listFlowsTask = new Task(this, {
    autoRun: false,
    args: () =>
      [
        this.gateway.connected ? this.gateway.gateway : null,
        this.gateway.connected ? this.gateway.client : null,
      ] as const,
    task: async ([gateway, client], { signal }) => {
      if (!gateway || !client) {
        return initialState;
      }
      return loadTaskFlowSnapshot({ client, signal });
    },
    onComplete: (flows) => {
      this.error = null;
      this.flows = flows;
    },
    onError: (error) => {
      this.error = formatUiError(error, t("taskFlowsPage.loadFailed"));
    },
  });

  private refreshFlows(): Promise<void> {
    const gateway = this.gateway.gateway;
    const client = this.gateway.client;
    if (!gateway || this.context.gateway !== gateway || !this.gateway.connected || !client) {
      return Promise.resolve();
    }
    this.error = null;
    return this.listFlowsTask.run([gateway, client]);
  }

  private canClearTerminal(): boolean {
    return canCallGatewayMethod(this.gateway.snapshot, "taskFlows.clearTerminal", "operator.admin");
  }

  private async clearTerminal(status: ClearableTerminalStatus): Promise<void> {
    const client = this.gateway.client;
    if (!client || this.clearingStatus !== null || !this.canClearTerminal()) {
      return;
    }
    const confirmed = await showConfirmDialog({
      title:
        status === "succeeded"
          ? t("taskFlowsPage.clearSucceededConfirmTitle")
          : t("taskFlowsPage.clearFailedConfirmTitle"),
      message:
        status === "succeeded"
          ? t("taskFlowsPage.clearSucceededConfirmMessage")
          : t("taskFlowsPage.clearFailedConfirmMessage"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed || this.gateway.client !== client) {
      return;
    }
    this.clearingStatus = status;
    try {
      await client.request("taskFlows.clearTerminal", { status });
      this.error = null;
    } catch (error) {
      this.error = formatUiError(error, t("taskFlowsPage.clearFailedRequest"));
    } finally {
      this.clearingStatus = null;
    }
    await this.refreshFlows();
  }

  override render() {
    return html`
      ${renderSettingsPageHeader({
        title: titleForRoute("task-flows"),
        subtitle: subtitleForRoute("task-flows"),
        actions: html`
          <button
            class="btn"
            type="button"
            ?disabled=${!this.gateway.connected || this.listFlowsTask.status === TaskStatus.PENDING}
            @click=${() => void this.refreshFlows()}
          >
            ${
              this.listFlowsTask.status === TaskStatus.PENDING
                ? t("common.refreshing")
                : t("common.refresh")
            }
          </button>
        `,
      })}
      ${renderSettingsWorkspace(
        renderTaskFlows({
          connected: this.gateway.connected,
          loading: this.listFlowsTask.status === TaskStatus.PENDING,
          error: this.error,
          flows: this.flows,
          showSucceeded: this.showSucceeded,
          showFailed: this.showFailed,
          onShowSucceededChange: (value) => {
            this.showSucceeded = value;
          },
          onShowFailedChange: (value) => {
            this.showFailed = value;
          },
          canClearTerminal: this.canClearTerminal(),
          clearingStatus: this.clearingStatus,
          onClearSucceeded: () => void this.clearTerminal("succeeded"),
          onClearFailed: () => void this.clearTerminal("failed"),
        }),
      )}
    `;
  }
}

if (!customElements.get("openclaw-task-flows-page")) {
  customElements.define("openclaw-task-flows-page", TaskFlowsPage);
}
