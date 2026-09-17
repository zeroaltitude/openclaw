import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("task-flows"),
  component: () =>
    import("./task-flows-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-task-flows-page></openclaw-task-flows-page>`,
    })),
});
