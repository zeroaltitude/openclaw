import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import "../../styles/tasks.css";
import { renderAgentRowChip } from "../../components/agent-row-chip.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import { createMsFormatter, formatRelativeTimestamp } from "../../lib/format.ts";
import {
  taskFlowGoal,
  taskFlowOwnerLabel,
  taskFlowStatusKind,
  taskFlowStatusLabel,
  type TaskFlowListAllEntry,
} from "../../lib/task-flows/data.ts";

type TaskFlowsProps = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  flows: TaskFlowListAllEntry[];
  /** Terminal states are hidden by default; these two checkboxes reveal them. */
  showSucceeded: boolean;
  showFailed: boolean;
  onShowSucceededChange: (value: boolean) => void;
  onShowFailedChange: (value: boolean) => void;
  /** Manual, operator-governed cleanup ahead of the 7-day retention sweep. */
  canClearTerminal: boolean;
  clearingStatus: "succeeded" | "failed" | null;
  onClearSucceeded: () => void;
  onClearFailed: () => void;
};

function renderClearButton(props: {
  status: "succeeded" | "failed";
  label: string;
  busyLabel: string;
  clearingStatus: "succeeded" | "failed" | null;
  connected: boolean;
  onClick: () => void;
}) {
  const busy = props.clearingStatus === props.status;
  return html`
    <button
      type="button"
      class="btn btn--xs danger"
      ?disabled=${!props.connected || props.clearingStatus !== null}
      @click=${props.onClick}
    >
      ${busy ? props.busyLabel : props.label}
    </button>
  `;
}

function renderFilterControls(props: TaskFlowsProps) {
  return html`
    <label class="task-flows-filter">
      <input
        type="checkbox"
        .checked=${props.showSucceeded}
        @change=${(event: Event) =>
          props.onShowSucceededChange((event.target as HTMLInputElement).checked)}
      />
      ${t("taskFlowsPage.showSucceeded")}
    </label>
    ${
      props.canClearTerminal
        ? renderClearButton({
            status: "succeeded",
            label: t("taskFlowsPage.clearSucceeded"),
            busyLabel: t("taskFlowsPage.clearing"),
            clearingStatus: props.clearingStatus,
            connected: props.connected,
            onClick: props.onClearSucceeded,
          })
        : nothing
    }
    <label class="task-flows-filter">
      <input
        type="checkbox"
        .checked=${props.showFailed}
        @change=${(event: Event) =>
          props.onShowFailedChange((event.target as HTMLInputElement).checked)}
      />
      ${t("taskFlowsPage.showFailed")}
    </label>
    ${
      props.canClearTerminal
        ? renderClearButton({
            status: "failed",
            label: t("taskFlowsPage.clearFailed"),
            busyLabel: t("taskFlowsPage.clearing"),
            clearingStatus: props.clearingStatus,
            connected: props.connected,
            onClick: props.onClearFailed,
          })
        : nothing
    }
  `;
}

function renderHeadingFacts(flows: readonly TaskFlowListAllEntry[]) {
  const active = flows.filter(
    (flow) => flow.status === "queued" || flow.status === "running",
  ).length;
  const waiting = flows.filter((flow) => flow.status === "waiting").length;
  const blocked = flows.filter((flow) => flow.status === "blocked").length;
  const issues = flows.filter((flow) => flow.status === "failed" || flow.status === "lost").length;
  const facts: Array<[number, string]> = [
    [active, t("taskFlowsPage.status.running")],
    [waiting, t("taskFlowsPage.status.waiting")],
    [blocked, t("taskFlowsPage.status.blocked")],
    [issues, t("taskFlowsPage.status.failed")],
  ];
  return html`<span class="task-heading-facts">
    ${facts.map(
      ([value, label], index) => html`
        ${index > 0 ? html`<span aria-hidden="true">·</span>` : nothing}
        <span><strong>${value}</strong> ${label}</span>
      `,
    )}
  </span>`;
}

function renderFlow(
  flow: TaskFlowListAllEntry,
  formatTimestamp: ReturnType<typeof createMsFormatter>,
) {
  const goal = taskFlowGoal(flow);
  const detail = flow.currentStep ?? flow.blockedSummary;
  const waitingLabel =
    flow.status === "waiting" && flow.waitingForMs !== undefined
      ? t("taskFlowsPage.waitingFor", { duration: formatDurationHuman(flow.waitingForMs) })
      : null;
  return html`
    <div class="settings-row task-row" data-flow-id=${flow.flowId}>
      <div class="settings-row__text task-row__content">
        <div class="settings-row__title">${goal}</div>
        <div class="task-row__facts">
          <span data-flow-status
            >${renderSettingsStatus({
              kind: taskFlowStatusKind(flow.status),
              label: taskFlowStatusLabel(flow.status),
            })}</span
          >
          <span>${taskFlowOwnerLabel(flow)}</span>
          ${flow.agentId ? renderAgentRowChip(flow.agentId) : nothing}
        </div>
        ${detail ? html`<div class="settings-row__desc">${detail}</div>` : nothing}
        ${waitingLabel ? html`<div class="task-row__warning"><span>${waitingLabel}</span></div>` : nothing}
      </div>
      <div class="settings-row__control task-row__control">
        <div class="task-row__links">
          <span title=${formatTimestamp(flow.createdAt)}
            >${formatRelativeTimestamp(flow.createdAt)}</span
          >
        </div>
      </div>
    </div>
  `;
}

export function renderTaskFlows(props: TaskFlowsProps) {
  const formatTimestamp = createMsFormatter();
  // Terminal flows (succeeded/failed) are noisy by default once a flow list
  // accumulates history; the two filter checkboxes opt back in per state.
  const visibleFlows = props.flows.filter((flow) => {
    if (flow.status === "succeeded") {
      return props.showSucceeded;
    }
    if (flow.status === "failed") {
      return props.showFailed;
    }
    return true;
  });
  const rows =
    visibleFlows.length === 0
      ? renderSettingsEmpty(
          props.flows.length === 0 ? t("taskFlowsPage.empty") : t("taskFlowsPage.emptyFiltered"),
        )
      : repeat(
          visibleFlows,
          (flow) => flow.flowId,
          (flow) => renderFlow(flow, formatTimestamp),
        );
  return renderSettingsPage(
    html`<div class="tasks-page-list">
      ${
        !props.connected
          ? html`<div class="callout warn">${t("taskFlowsPage.disconnected")}</div>`
          : nothing
      }
      ${props.error ? html`<div class="callout danger" role="alert">${props.error}</div>` : nothing}
      ${
        props.loading && props.flows.length === 0
          ? renderSettingsEmpty(t("taskFlowsPage.loading"))
          : nothing
      }
      ${
        !props.loading
          ? renderSettingsSection(
              {
                title: html`${t("taskFlowsPage.title")}${renderHeadingFacts(props.flows)}`,
                actions: renderFilterControls(props),
              },
              rows,
            )
          : nothing
      }
    </div>`,
    { wide: true },
  );
}
