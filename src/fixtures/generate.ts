import fs from 'node:fs';
import path from 'node:path';

/** Deterministic PRNG (mulberry32) so fixtures are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureSpec {
  name: string;
  bytes: number;
  kind: 'zeros' | 'random';
  seed: number;
}

export function buildFixture(spec: FixtureSpec): Buffer {
  const buf = Buffer.alloc(spec.bytes);
  if (spec.kind === 'random') {
    const rand = mulberry32(spec.seed);
    for (let i = 0; i < spec.bytes; i++) buf[i] = Math.floor(rand() * 256);
  }
  return buf;
}

export function defaultFixtures(): { spec: FixtureSpec; data: Buffer }[] {
  const specs: FixtureSpec[] = [
    { name: '空文件-empty.bin', bytes: 0, kind: 'zeros', seed: 1 },
    { name: '全零数据-zeros.bin', bytes: 300, kind: 'zeros', seed: 2 },
    { name: '随机数据-random.bin', bytes: 500, kind: 'random', seed: 20260930 },
    { name: '尾条带-tail-中文报告.dat', bytes: 137, kind: 'random', seed: 4242 },
  ];
  return specs.map((spec) => ({ spec, data: buildFixture(spec) }));
}

export function writeFixtures(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (const { spec, data } of defaultFixtures()) {
    const file = path.join(dir, spec.name);
    fs.writeFileSync(file, data);
    paths.push(file);
  }
  return paths;
}
