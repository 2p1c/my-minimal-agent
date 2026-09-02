import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PendingCall = {
  toolCallId: string;
  name: string;
  arguments: string;
};

export type RunCheckpoint = {
  runId: string;
  messages: OpenAI.ChatCompletionMessageParam[];
  pending: PendingCall[];
  browserEvalFailures: number;
  stepsUsed: number;
  createdAt: string;
  updatedAt: string;
};

export interface CheckpointStore {
  save(checkpoint: RunCheckpoint): Promise<void>;
  load(runId: string): Promise<RunCheckpoint | null>;
  delete(runId: string): Promise<void>;
}

function assertRunId(runId: string): void {
  if (!UUID_RE.test(runId)) {
    throw new Error(`invalid runId: ${runId}`);
  }
}

function isExpired(checkpoint: RunCheckpoint, now = Date.now()): boolean {
  const t = Date.parse(checkpoint.updatedAt);
  if (Number.isNaN(t)) return true;
  return now - t > MAX_AGE_MS;
}

export class FileCheckpointStore implements CheckpointStore {
  constructor(private rootDir = process.env.AGENT_RUNS_DIR ?? "runs") {}

  private fileFor(runId: string): string {
    assertRunId(runId);
    return path.join(this.rootDir, `${runId}.json`);
  }

  async save(checkpoint: RunCheckpoint): Promise<void> {
    assertRunId(checkpoint.runId);
    await mkdir(this.rootDir, { recursive: true });
    const file = this.fileFor(checkpoint.runId);
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(checkpoint), "utf8");
    await rename(tmp, file);
    await this.sweepExpired();
  }

  async load(runId: string): Promise<RunCheckpoint | null> {
    if (!UUID_RE.test(runId)) return null;
    await this.sweepExpired();
    try {
      const raw = await readFile(this.fileFor(runId), "utf8");
      const checkpoint = JSON.parse(raw) as RunCheckpoint;
      if (isExpired(checkpoint)) {
        await this.delete(runId);
        return null;
      }
      return checkpoint;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async delete(runId: string): Promise<void> {
    if (!UUID_RE.test(runId)) return;
    try {
      await unlink(this.fileFor(runId));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }

  private async sweepExpired(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const runId = name.slice(0, -".json".length);
      if (!UUID_RE.test(runId)) continue;
      try {
        const raw = await readFile(path.join(this.rootDir, name), "utf8");
        const checkpoint = JSON.parse(raw) as RunCheckpoint;
        if (isExpired(checkpoint, now)) {
          await this.delete(runId);
        }
      } catch {
        // 坏文件留给下次；不要让 sweep 打断 save/load
      }
    }
  }
}
