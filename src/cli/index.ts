#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../db/database.js';
import { resolvePaths, ensureDirs } from '../config.js';
import { ErasureService } from '../service/erasureService.js';
import { AppError } from '../errors.js';
import { sha256 } from '../crypto/digest.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function print(label: string, value: unknown): void {
  console.log(`  ${label}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(args.flags['data-dir']);
  ensureDirs(paths);
  const db = openDatabase(paths.dbFile);
  const service = new ErasureService(db, {
    shardsDir: paths.shardsDir,
    tmpDir: paths.tmpDir,
    recoveredDir: paths.recoveredDir,
  });

  const finish = (): void => {
    db.close();
  };

  try {
    switch (args.command) {
      case 'encode': {
        const file = args.positional[0];
        if (!file) throw new AppError('VALIDATION_ERROR', 'usage: encode <file> --k --m --stripe-size');
        const k = Number(args.flags.k);
        const m = Number(args.flags.m);
        const stripeSize = Number(args.flags['stripe-size'] ?? '64');
        const abs = path.resolve(file);
        const data = fs.readFileSync(abs);
        console.log(`[before] file=${abs} bytes=${data.length} sha256=${sha256(data)}`);
        const version = service.encodeBuffer(data, path.basename(abs), { k, m, stripeSize });
        console.log('[after] encoded version');
        print('versionId', version.id);
        print('stripes', version.stripe_count);
        print('k/m/stripeSize', `${k}/${m}/${stripeSize}`);
        print('tailOriginalLength', version.tail_original_length);
        break;
      }
      case 'inspect':
      case 'check': {
        const versionId = args.positional[0];
        if (!versionId) throw new AppError('VALIDATION_ERROR', 'usage: inspect <versionId>');
        const result = service.inspect(versionId);
        console.log(`[inspect] version=${versionId} recoverable=${result.recoverable}`);
        for (const st of result.stripes) {
          console.log(
            `  stripe ${st.stripeIndex}: valid=${st.available.join(',') || '-'} ` +
              `erased=${st.erased.join(',') || '-'}`,
          );
        }
        break;
      }
      case 'fault': {
        const [versionId, stripe, shard, fault] = args.positional;
        if (!versionId || !stripe || !shard || !fault) {
          throw new AppError(
            'VALIDATION_ERROR',
            'usage: fault <versionId> <stripe> <shard> <lose|bitflip>',
          );
        }
        console.log(`[before] fault injection stripe=${stripe} shard=${shard} type=${fault}`);
        const r = service.injectFault(versionId, Number(stripe), Number(shard), fault as 'lose' | 'bitflip');
        console.log(`[after] state=${r.state}`);
        break;
      }
      case 'recover': {
        const versionId = args.positional[0];
        if (!versionId) throw new AppError('VALIDATION_ERROR', 'usage: recover <versionId> [--indices 0,1,2]');
        let selected: number[] | undefined;
        if (args.flags.indices) selected = args.flags.indices.split(',').map((s) => Number(s.trim()));
        const before = service.inspect(versionId);
        console.log(`[before] recoverable=${before.recoverable}`);
        const recovery = service.recover(versionId, {
          selectedIndices: selected,
          idempotencyKey: args.flags['idempotency-key'],
        });
        console.log('[after] recovery result');
        print('recoveryId', recovery.id);
        print('status', recovery.status);
        print('digest', recovery.recovered_digest);
        print('output', recovery.output_path);
        break;
      }
      case 'compare': {
        const [original, recoveredFile] = args.positional;
        if (!original || !recoveredFile) {
          throw new AppError('VALIDATION_ERROR', 'usage: compare <original> <recovered>');
        }
        const a = fs.readFileSync(path.resolve(original));
        const b = fs.readFileSync(path.resolve(recoveredFile));
        const da = sha256(a);
        const db2 = sha256(b);
        const identical = a.equals(b);
        console.log(`original  sha256=${da} bytes=${a.length}`);
        console.log(`recovered sha256=${db2} bytes=${b.length}`);
        console.log(identical ? 'RESULT: byte-identical ✓' : 'RESULT: MISMATCH ✗');
        if (!identical) process.exitCode = 1;
        break;
      }
      case 'list': {
        let cursor: string | null = null;
        do {
          const page = service.repo.listVersions(cursor, 50);
          for (const v of page.rows) {
            console.log(`${v.id}  ${v.original_size}B  stripes=${v.stripe_count}  ${v.original_name}`);
          }
          cursor = page.next;
        } while (cursor && args.flags.all === 'true');
        break;
      }
      case 'list-recoveries': {
        const versionId = args.positional[0];
        if (!versionId) throw new AppError('VALIDATION_ERROR', 'usage: list-recoveries <versionId>');
        const page = service.repo.listRecoveries(versionId, null, 50);
        for (const r of page.rows) {
          console.log(`${r.id}  ${r.status}  ${r.error_code ?? ''}  ${r.output_path ?? ''}`);
        }
        break;
      }
      default:
        console.log(
          [
            'commands:',
            '  encode <file> --k N --m N [--stripe-size N]',
            '  inspect <versionId>',
            '  fault <versionId> <stripe> <shard> <lose|bitflip>',
            '  recover <versionId> [--indices 0,1,2] [--idempotency-key K]',
            '  compare <original> <recovered>',
            '  list',
            '  list-recoveries <versionId>',
          ].join('\n'),
        );
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    finish();
  }
}

main();
