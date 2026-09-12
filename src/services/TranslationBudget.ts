import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

interface Options {
  dailyLimit?: number;
  now?: () => number;
  write?: (path: string, content: string) => Promise<void>;
}
interface BudgetRecord { day: string; characters: number }
const calendar = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

function parseRecord(value: unknown): BudgetRecord {
  const entry = value as Partial<BudgetRecord> | null;
  if (!entry || typeof entry !== 'object' || Object.keys(entry).length !== 2 ||
    typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) ||
    !Number.isSafeInteger(entry.characters) || entry.characters! < 0 ||
    new Date(`${entry.day}T00:00:00.000Z`).toISOString().slice(0, 10) !== entry.day) {
    throw new Error('Invalid translation budget record.');
  }
  return entry as BudgetRecord;
}

/** Reserve code points durably before calling a billable translation service. */
export class TranslationBudget {
  private readonly path: string;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly write: NonNullable<Options['write']>;
  private value: BudgetRecord;
  private latestDay: string;
  private latestTime: number;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(path: string, options: Options = {}) {
    this.path = resolve(path);
    this.limit = options.dailyLimit ?? 15_000;
    this.now = options.now ?? Date.now;
    this.write = options.write ?? atomicWrite;
    if (!Number.isSafeInteger(this.limit) || this.limit < 0) throw new Error('Invalid translation daily limit.');
    this.latestTime = this.now();
    this.latestDay = calendar.format(this.latestTime);
    this.value = { day: this.latestDay, characters: 0 };
    try { this.value = parseRecord(JSON.parse(readFileSync(this.path, 'utf8'))); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Could not load translation budget.', { cause });
      }
    }
    if (this.value.day > this.latestDay) this.latestDay = this.value.day;
  }

  reserve(characters: number): Promise<boolean> {
    if (!Number.isSafeInteger(characters) || characters <= 0 || characters > this.limit) return Promise.resolve(false);
    const reserved = this.pending.then(async () => {
      const time = this.now(), day = calendar.format(time);
      if (time < this.latestTime || day < this.latestDay) return false;
      this.latestTime = time;
      this.latestDay = day;
      const used = day === this.value.day ? this.value.characters : 0;
      if (characters > this.limit - used) return false;
      const next = { day, characters: used + characters };
      await this.write(this.path, `${JSON.stringify(next)}\n`);
      this.value = next;
      return true;
    }).catch(() => false);
    this.pending = reserved;
    return reserved;
  }
}
