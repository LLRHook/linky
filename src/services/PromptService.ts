import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const REPOSITORY = 'LLRHook/linky';
const WORKFLOW = 'discord-prompt.yml';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const DAY = 86_400_000;
const ACTIVE = new Set(['queued', 'running', 'uncertain']);
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'uncertain']);

export interface PromptJobView {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'uncertain';
  runUrl?: string;
  prUrl?: string;
  message: string;
}

interface Job extends Omit<PromptJobView, 'message'> {
  guildId: string;
  userId: string;
  createdAt: number;
  runId?: number;
}

export class PromptError extends Error {}

interface Options {
  token: string;
  guildIds: readonly string[];
}

interface Run {
  id: number;
  display_title: string;
  event: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
}

/** Intake records contain IDs and progress only, never the feature text or credentials. */
export class PromptService {
  private jobs: Job[];
  private pending: Promise<unknown> = Promise.resolve();
  private readonly checkedAt = new Map<string, number>();

  constructor(private readonly options: Options, private readonly file: string,
    private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    try {
      const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(saved) || saved.some(job => !job || !/^\d{17,20}$/.test(job.id) ||
        !/^\d{17,20}$/.test(job.guildId) || !/^\d{17,20}$/.test(job.userId) ||
        !STATES.has(job.state) || !Number.isFinite(job.createdAt))) throw new Error('Invalid prompt journal');
      this.jobs = saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read the prompt job journal');
      this.jobs = [];
    }
  }

  available(guildId: string): boolean {
    return Boolean(this.options.token) && this.options.guildIds.includes(guildId);
  }

  submit(input: { id: string; guildId: string; userId: string; request: string }): Promise<PromptJobView> {
    return this.serial(async () => {
      this.authorize(input.guildId);
      if (![input.id, input.guildId, input.userId].every(id => /^\d{17,20}$/.test(id)) ||
        input.request.trim().length < 10 || input.request.length > 3000) {
        throw new PromptError('Describe one feature in 10–3,000 characters.');
      }
      const existing = this.jobs.find(job => job.id === input.id);
      if (existing) {
        if (existing.guildId !== input.guildId || existing.userId !== input.userId) throw new PromptError('Job not found in this server.');
        return this.view(existing);
      }
      for (const job of this.jobs.filter(job => ACTIVE.has(job.state))) await this.refresh(job);
      if (this.jobs.some(job => ACTIVE.has(job.state))) throw new PromptError('A coding job is already active. Check its status before starting another.');
      const today = new Date(this.now()).toISOString().slice(0, 10);
      if (this.jobs.filter(job => new Date(job.createdAt).toISOString().slice(0, 10) === today).length >= 3) {
        throw new PromptError('Linky has reached its limit of 3 coding jobs today. Try again after midnight UTC.');
      }
      if (this.jobs.some(job => job.userId === input.userId && this.now() - job.createdAt < 30 * 60_000)) {
        throw new PromptError('Wait 30 minutes between feature requests.');
      }
      const job: Job = { id: input.id, guildId: input.guildId, userId: input.userId, createdAt: this.now(), state: 'uncertain' };
      this.jobs.push(job);
      this.save(); // Reserve before dispatch; a crash or lost response must never trigger a second paid run.
      try {
        const response = await this.request(`/actions/workflows/${WORKFLOW}/dispatches`, {
          method: 'POST', body: JSON.stringify({ ref: 'main', inputs: { job_id: job.id, request: input.request.trim() } }),
        });
        if (response.status === 204) job.state = 'queued';
        else if (response.status >= 400 && response.status < 500) job.state = 'failed';
      } catch { /* A timeout does not prove the request was rejected. Reconcile through status. */ }
      this.save();
      return this.view(job);
    });
  }

  status(id: string | undefined, guildId: string): Promise<PromptJobView> {
    return this.serial(async () => {
      this.authorize(guildId);
      const job = [...this.jobs].reverse().find(entry => (id === undefined || entry.id === id) && entry.guildId === guildId);
      if (!job) throw new PromptError('Job not found in this server.');
      await this.refresh(job);
      return this.view(job);
    });
  }

  private authorize(guildId: string): void {
    if (!this.available(guildId)) throw new PromptError('The bot operator has not enabled coding requests in this server.');
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private request(path: string, init: RequestInit = {}): Promise<Response> {
    return this.fetcher(`${API}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${this.options.token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    });
  }

  private async refresh(job: Job): Promise<void> {
    if (!ACTIVE.has(job.state) || this.now() - (this.checkedAt.get(job.id) ?? 0) < 10_000) return;
    this.checkedAt.set(job.id, this.now());
    try {
      let run: Run | undefined;
      if (job.runId) {
        const response = await this.request(`/actions/runs/${job.runId}`);
        if (!response.ok) return;
        run = await response.json() as Run;
      } else {
        const response = await this.request(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&branch=main&per_page=100`);
        if (!response.ok) return;
        const body = await response.json() as { workflow_runs: Run[] };
        run = body.workflow_runs.find(entry => entry.display_title === `Linky prompt ${job.id}`);
      }
      if (!run || run.event !== 'workflow_dispatch' || run.head_branch !== 'main' ||
        run.display_title !== `Linky prompt ${job.id}` || !Number.isSafeInteger(run.id) || run.id <= 0) return;
      job.runId = run.id;
      job.runUrl = `https://github.com/${REPOSITORY}/actions/runs/${run.id}`;
      job.state = run.status === 'completed' ? (run.conclusion === 'success' ? 'succeeded' : 'failed') : 'running';
      const response = await this.request(`/pulls?state=all&head=LLRHook:prompt/${job.id}&base=main`);
      if (response.ok) {
        const pulls = await response.json() as { number: number }[];
        if (pulls[0] && Number.isSafeInteger(pulls[0].number) && pulls[0].number > 0) {
          job.prUrl = `https://github.com/${REPOSITORY}/pull/${pulls[0].number}`;
        }
      }
      this.save();
    } catch { /* Keep the last known state if GitHub is temporarily unavailable. */ }
  }

  private save(): void {
    this.jobs = this.jobs.filter(job => ACTIVE.has(job.state) || this.now() - job.createdAt < 14 * DAY);
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.jobs), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  private view(job: Job): PromptJobView {
    const messages = {
      queued: 'Queued for GPT-6 Astra Ultra. A separate review and the required checks must pass before automatic merge and deployment.',
      running: 'The coding workflow is running. Open the run for coding, review, test, and deployment progress.',
      succeeded: 'The change passed review and checks, merged, and deployed to Hostinger.',
      failed: 'The coding workflow did not complete successfully. Check the run and PR before retrying; a late failure may have occurred after merging.',
      uncertain: 'Dispatch is not yet confirmed. Use Check status; do not resubmit this request. Contact the operator if it stays unconfirmed.',
    };
    return { id: job.id, state: job.state, runUrl: job.runUrl, prUrl: job.prUrl, message: messages[job.state] };
  }
}
