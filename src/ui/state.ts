// src/ui/state.ts
import type { Ticket } from "../providers/types.ts";

export type WorkerStatus = "idle" | "running" | "stopped";
export type JobStage = "pre-hook" | "executor" | "post-hook";
export type JobStatus = "done" | "failed" | "review";
// "review" = agent completed successfully and a PR was opened; the card waits for human dismissal

export interface ActiveJob {
  id: string;
  identifier: string;
  title: string;
  branch: string;
  stage: JobStage;
  startedAt: number;
  logLines: string[];
}

export interface JobHistoryRow {
  id: string;
  identifier: string;
  title: string;
  status: JobStatus;
  durationMs: number;
  prUrl?: string;
  completedAt: number;
}

export type UiEvent =
  | { type: "worker_status"; status: WorkerStatus }
  | { type: "job_start"; job: ActiveJob }
  | { type: "job_log"; line: string }
  | { type: "job_stage"; stage: JobStage }
  | { type: "job_end"; success: boolean; prUrl?: string }
  | { type: "job_error"; error: string }
  | { type: "history_add"; row: JobHistoryRow }
  | { type: "pending_tickets"; count: number }
  | { type: "config_update" };

export interface WorkerStateSnapshot {
  workerStatus: WorkerStatus;
  activeJob: ActiveJob | null;
  pendingTickets: Ticket[];
  history: JobHistoryRow[];
  ticketsProcessed: number;
  totalDurationMs: number;
}

export interface WorkerState {
  getSnapshot(): WorkerStateSnapshot;
  subscribe(listener: (event: UiEvent) => void): () => void;
  setWorkerStatus(status: WorkerStatus): void;
  setActiveJob(job: ActiveJob): void;
  setJobStage(stage: JobStage): void;
  appendLog(line: string): void;
  completeJob(opts: { success: boolean; prUrl?: string; review?: boolean }): void;
  errorJob(error: string): void;
  dismissJob(): void;
  setPendingTickets(tickets: Ticket[]): void;
  notifyConfigUpdate(): void;
}

export function createWorkerState(): WorkerState {
  const listeners = new Set<(event: UiEvent) => void>();
  let workerStatus: WorkerStatus = "idle";
  let activeJob: ActiveJob | null = null;
  const pendingTickets: Ticket[] = [];
  const history: JobHistoryRow[] = [];
  let ticketsProcessed = 0;
  let totalDurationMs = 0;

  function broadcast(event: UiEvent) {
    for (const listener of listeners) {
      try { listener(event); } catch { /* ignore listener errors */ }
    }
  }

  return {
    getSnapshot() {
      return {
        workerStatus,
        activeJob: activeJob ? { ...activeJob, logLines: [...activeJob.logLines] } : null,
        pendingTickets: [...pendingTickets],
        history: [...history],
        ticketsProcessed,
        totalDurationMs,
      };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setWorkerStatus(status) {
      workerStatus = status;
      broadcast({ type: "worker_status", status });
    },

    setActiveJob(job) {
      activeJob = { ...job };
      broadcast({ type: "job_start", job: { ...job } });
    },

    setJobStage(stage) {
      if (activeJob) {
        activeJob.stage = stage;
        broadcast({ type: "job_stage", stage });
      }
    },

    appendLog(line) {
      if (activeJob) {
        activeJob.logLines.push(line);
        broadcast({ type: "job_log", line });
      }
    },

    completeJob({ success, prUrl, review }) {
      if (!activeJob) return;
      const durationMs = Date.now() - activeJob.startedAt;
      // "review" status = success + PR opened; card stays visible until dismissed
      const status: JobStatus = !success ? "failed" : (review ? "review" : "done");
      const row: JobHistoryRow = {
        id: activeJob.id,
        identifier: activeJob.identifier,
        title: activeJob.title,
        status,
        durationMs,
        prUrl,
        completedAt: Date.now(),
      };
      // Keep last 50
      history.unshift(row);
      if (history.length > 50) history.splice(50);
      ticketsProcessed++;
      totalDurationMs += durationMs;
      broadcast({ type: "job_end", success, prUrl });
      broadcast({ type: "history_add", row });
      activeJob = null;
    },

    errorJob(error) {
      if (!activeJob) return;
      const durationMs = Date.now() - activeJob.startedAt;
      const row: JobHistoryRow = {
        id: activeJob.id,
        identifier: activeJob.identifier,
        title: activeJob.title,
        status: "failed",
        durationMs,
        completedAt: Date.now(),
      };
      history.unshift(row);
      if (history.length > 50) history.splice(50);
      ticketsProcessed++;
      totalDurationMs += durationMs;
      broadcast({ type: "job_error", error });
      broadcast({ type: "history_add", row });
      activeJob = null;
    },

    dismissJob() {
      activeJob = null;
      // Broadcast so SSE clients clear the card immediately
      broadcast({ type: "job_end", success: true });
    },

    setPendingTickets(tickets) {
      pendingTickets.splice(0, pendingTickets.length, ...tickets);
      broadcast({ type: "pending_tickets", count: tickets.length });
    },

    notifyConfigUpdate() {
      broadcast({ type: "config_update" });
    },
  };
}
