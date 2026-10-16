import { BaseSequencer, type TestSpecification } from "vitest/node";
export interface ShardTimings { defaultSeconds: number; files: Record<string, number> }
export interface ShardItem<T = unknown> { key: string; tieBreak?: string; value?: T }
export function loadShardTimings(): ShardTimings;
export function planShards<T>(items: ShardItem<T>[], count: number, timings?: ShardTimings): { items: ShardItem<T>[]; deciseconds: number }[];
export class DurationShardSequencer extends BaseSequencer {
  shard(files: TestSpecification[]): Promise<TestSpecification[]>;
}
