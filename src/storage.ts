import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CustomerRecord {
  customerId: number;
  topicId: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  createdAt: string;
}

interface Persisted {
  version: 1;
  customers: Record<string, CustomerRecord>;
}

/**
 * Small JSON-file backed store mapping a Telegram customer (user id) to an
 * admin-group forum topic id, kept in memory and flushed atomically on writes.
 */
export class CustomerTopicStore {
  private readonly filePath: string;
  private customers = new Map<number, CustomerRecord>();
  private topicIndex = new Map<number, CustomerRecord>();
  private writing: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) {
      await this.flush();
      return;
    }

    const raw = await readFile(this.filePath, 'utf8');
    let parsed: Persisted;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch (err) {
      throw new Error(`Failed to parse ${this.filePath}`, { cause: err });
    }

    this.customers.clear();
    this.topicIndex.clear();
    const entries = parsed.customers as Record<string, CustomerRecord> | undefined;
    if (entries) {
      for (const rec of Object.values(entries)) {
        this.customers.set(rec.customerId, rec);
        this.topicIndex.set(rec.topicId, rec);
      }
    }
  }

  getByCustomer(customerId: number): CustomerRecord | undefined {
    return this.customers.get(customerId);
  }

  getByTopic(topicId: number): CustomerRecord | undefined {
    return this.topicIndex.get(topicId);
  }

  async upsert(record: CustomerRecord): Promise<void> {
    const existing = this.customers.get(record.customerId);
    if (existing && existing.topicId !== record.topicId) {
      this.topicIndex.delete(existing.topicId);
    }
    this.customers.set(record.customerId, record);
    this.topicIndex.set(record.topicId, record);
    await this.flush();
  }

  async remove(customerId: number): Promise<void> {
    const rec = this.customers.get(customerId);
    if (!rec) return;
    this.customers.delete(customerId);
    this.topicIndex.delete(rec.topicId);
    await this.flush();
  }

  private snapshot(): Persisted {
    const customers: Record<string, CustomerRecord> = {};
    for (const [id, rec] of this.customers) {
      customers[String(id)] = rec;
    }
    return { version: 1, customers };
  }

  /** Serializes writes so concurrent upserts don't corrupt the file. */
  private async flush(): Promise<void> {
    const previous = this.writing;
    let release!: () => void;
    this.writing = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const tmp = `${this.filePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.snapshot(), null, 2), 'utf8');
      await rename(tmp, this.filePath);
    } finally {
      release();
    }
  }
}
