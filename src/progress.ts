export type StepState = {
  label: string;
  state: "pending" | "active" | "done" | "error";
  detail?: string;
  progress?: number;
};

export interface ProgressUI {
  setWidget(id: string, lines: string[] | undefined, options?: { placement: "belowEditor" }): void;
  setStatus(key: string, text: string | undefined): void;
}

export interface Progress {
  /** Mark `index` active; earlier unfinished steps become done, later active steps go back to pending. */
  activate(index: number, detail?: string): void;
  update(index: number, patch: Partial<StepState>): void;
  done(index: number, detail?: string): void;
  fail(index: number, detail?: string): void;
  /** Animate the status bar with `label`; a numeric `progress` (0..1) turns the spinner into a bar. */
  status(label: string, options?: { progress?: number; showElapsed?: boolean }): void;
  /** Stop the status-bar animation, leave the step widget in place. */
  stop(): void;
  /** Stop the animation and remove the step widget. */
  clear(): void;
}

const SPINNER_WIDTH = 16;
const BAR_WIDTH = 18;
const SPINNER_INTERVAL_MS = 120;

export function formatBar(progress: number, width: number): string {
  const pct = Math.max(0, Math.min(1, progress));
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${Math.round(pct * 100)}%`;
}

function isProgress(value: number | undefined): value is number {
  return value != null && !Number.isNaN(value);
}

export function createProgress(
  ui: ProgressUI,
  options: { widgetId: string; statusKey: string; title: string; steps: string[] },
): Progress {
  const steps: StepState[] = options.steps.map((label) => ({ label, state: "pending" }));

  let timer: ReturnType<typeof setInterval> | null = null;
  let spinnerIndex = 0;
  let label = "";
  let barProgress: number | undefined;
  let startedAt: number | null = null;
  let showElapsed = false;

  const renderWidget = () => {
    const activeIndex = steps.findIndex((s) => s.state === "active");
    const errorIndex = steps.findIndex((s) => s.state === "error");
    const lastDoneIndex = steps.reduce((last, s, i) => (s.state === "done" ? i : last), -1);

    const idx = errorIndex >= 0 ? errorIndex : activeIndex >= 0 ? activeIndex : lastDoneIndex;
    const current = idx >= 0 ? steps[idx] : null;

    const lines: string[] = [options.title, ""];
    if (current) {
      const icon = current.state === "done" ? "✓" : current.state === "active" ? "●" : current.state === "error" ? "✗" : "○";
      lines.push(`${icon} ${current.label}`);
      if (current.detail) lines.push(`   ${current.detail}`);
      const progress = current.progress ?? (current.state === "done" ? 1 : undefined);
      if (isProgress(progress)) lines.push(`   ${formatBar(progress, BAR_WIDTH)}`);
    }

    ui.setWidget(options.widgetId, lines, { placement: "belowEditor" });
  };

  const renderStatus = () => {
    const elapsed = showElapsed && startedAt ? ` (${Math.floor((Date.now() - startedAt) / 1000)}s)` : "";
    if (isProgress(barProgress)) {
      ui.setStatus(options.statusKey, `${formatBar(barProgress, SPINNER_WIDTH)} ${label}${elapsed}`);
      return;
    }
    const pos = spinnerIndex % SPINNER_WIDTH;
    const chars = Array.from({ length: SPINNER_WIDTH }, (_, i) => (i === pos ? "█" : "░"));
    ui.setStatus(options.statusKey, `[${chars.join("")}] ${label}${elapsed}`);
  };

  const update = (index: number, patch: Partial<StepState>) => {
    if (index < 0 || index >= steps.length) return;
    steps[index] = { ...steps[index], ...patch };
    renderWidget();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    label = "";
    barProgress = undefined;
    startedAt = null;
    showElapsed = false;
  };

  renderWidget();

  return {
    update,
    activate(index, detail) {
      steps.forEach((s, i) => {
        if (i < index && s.state !== "done") s.state = "done";
        if (i > index && s.state === "active") s.state = "pending";
      });
      update(index, { state: "active", detail });
    },
    done: (index, detail) => update(index, { state: "done", detail, progress: 1 }),
    fail: (index, detail) => update(index, { state: "error", detail }),
    status(text, statusOptions = {}) {
      const elapsedWanted = statusOptions.showElapsed ?? false;
      if (label !== text || showElapsed !== elapsedWanted || startedAt == null) startedAt = Date.now();
      label = text;
      barProgress = statusOptions.progress;
      showElapsed = elapsedWanted;
      if (!timer) {
        timer = setInterval(() => {
          spinnerIndex = (spinnerIndex + 1) % SPINNER_WIDTH;
          renderStatus();
        }, SPINNER_INTERVAL_MS);
      }
      renderStatus();
    },
    stop,
    clear() {
      stop();
      ui.setWidget(options.widgetId, undefined);
    },
  };
}
