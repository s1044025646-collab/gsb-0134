import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { ErasureService } from '../service/erasureService.js';
import { AppError } from '../errors.js';
import {
  parsePageParams,
  encodeCursor,
  decodeCursor,
  decodeCursorInt,
} from './pagination.js';

export interface CreatedServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

function readJson(req: http.IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new AppError('VALIDATION_ERROR', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError('VALIDATION_ERROR', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createHttpServer(db: DatabaseSync, dirs: any): Omit<CreatedServer, 'port'> & { port: number | null } {
  const service = new ErasureService(db, dirs);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // Health / math disclosure
      if (method === 'GET' && pathname === '/health') {
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/api/spec') {
        return send(res, 200, {
          field: 'GF(2^8)',
          primitivePolynomial: 'x^8+x^4+x^3+x^2+1 (0x11D)',
          primitiveElement: 2,
          systematic: true,
          parityConstruction: 'Cauchy: G[k+p][c] = 1 / (p XOR (m+k+c))',
          recoveryRule: 'any k distinct valid shards per stripe',
        });
      }

      // Encode (JSON with base64 data)
      if (method === 'POST' && pathname === '/api/versions') {
        const body = await readJson(req);
        if (typeof body.name !== 'string' || body.name.length === 0) {
          throw new AppError('VALIDATION_ERROR', 'name is required');
        }
        if (typeof body.dataBase64 !== 'string') {
          throw new AppError('VALIDATION_ERROR', 'dataBase64 is required');
        }
        let data: Buffer;
        try {
          data = Buffer.from(body.dataBase64, 'base64');
        } catch {
          throw new AppError('VALIDATION_ERROR', 'dataBase64 is invalid base64');
        }
        const version = service.encodeBuffer(data, body.name, {
          k: Number(body.k),
          m: Number(body.m),
          stripeSize: Number(body.stripeSize),
        });
        return send(res, 201, { version });
      }

      const versionMatch = pathname.match(/^\/api\/versions\/([^/]+)(\/.*)?$/);
      if (versionMatch) {
        const versionId = decodeURIComponent(versionMatch[1]!);
        const sub = versionMatch[2] ?? '';

        if (method === 'GET' && sub === '') {
          const version = service.repo.getVersion(versionId);
          if (!version) throw new AppError('NOT_FOUND', 'version not found');
          return send(res, 200, { version });
        }

        if (method === 'GET' && sub === '/shards') {
          service.requireVersion(versionId);
          const page = parsePageParams(url);
          const after = decodeCursorInt(page.cursor);
          const { rows, next } = service.repo.listShards(versionId, after, page.limit);
          return send(res, 200, {
            items: rows,
            nextCursor: encodeCursor(next),
          });
        }

        if (method === 'GET' && sub === '/inspect') {
          return send(res, 200, service.inspect(versionId));
        }

        if (method === 'POST' && sub === '/faults') {
          const body = await readJson(req);
          const fault = body.fault;
          if (fault !== 'lose' && fault !== 'bitflip') {
            throw new AppError('VALIDATION_ERROR', "fault must be 'lose' or 'bitflip'");
          }
          const result = service.injectFault(
            versionId,
            Number(body.stripeIndex),
            Number(body.shardIndex),
            fault,
          );
          return send(res, 200, result);
        }

        if (method === 'POST' && sub === '/recover') {
          const body = await readJson(req);
          let selected: number[] | undefined;
          if (body.selectedIndices !== undefined) {
            if (!Array.isArray(body.selectedIndices)) {
              throw new AppError('VALIDATION_ERROR', 'selectedIndices must be an array');
            }
            selected = body.selectedIndices.map((x: unknown) => Number(x));
          }
          const recovery = service.recover(versionId, {
            idempotencyKey: typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
            selectedIndices: selected,
          });
          return send(res, 200, { recovery });
        }

        if (method === 'GET' && sub === '/recoveries') {
          service.requireVersion(versionId);
          const page = parsePageParams(url);
          const after = decodeCursor(page.cursor);
          const { rows, next } = service.repo.listRecoveries(versionId, after, page.limit);
          return send(res, 200, {
            items: rows.map((r) => ({ ...r, selected: JSON.parse(r.selected_shard_indices) })),
            nextCursor: encodeCursor(next),
          });
        }

        throw new AppError('NOT_FOUND', 'no such route', { pathname });
      }

      if (method === 'GET' && pathname === '/api/versions') {
        const page = parsePageParams(url);
        const after = decodeCursor(page.cursor);
        const { rows, next } = service.repo.listVersions(after, page.limit);
        return send(res, 200, { items: rows, nextCursor: encodeCursor(next) });
      }

      throw new AppError('NOT_FOUND', 'no such route', { pathname });
    } catch (err) {
      if (err instanceof AppError) {
        const status =
          err.code === 'NOT_FOUND'
            ? 404
            : err.code === 'VALIDATION_ERROR' ||
                err.code === 'DUPLICATE_SHARD_INDEX' ||
                err.code === 'SHARD_INDEX_OUT_OF_RANGE'
              ? 400
              : err.code === 'IDEMPOTENCY_MISMATCH' || err.code === 'CONFLICT'
                ? 409
                : 422;
        return send(res, status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: String(err) } });
    }
  });

  return {
    server,
    port: null,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Create the server and wait until it is listening on a loopback ephemeral port. */
export function startHttpServer(db: DatabaseSync, dirs: any): Promise<CreatedServer> {
  const created = createHttpServer(db, dirs);
  return new Promise((resolve, reject) => {
    created.server.once('error', reject);
    // Bind loopback only; port 0 lets the OS assign an ephemeral port.
    created.server.listen(0, '127.0.0.1', () => {
      const address = created.server.address() as AddressInfo;
      resolve({ server: created.server, port: address.port, close: created.close });
    });
  });
}

export function writePidFile(runDir: string, port: number): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(`${runDir}/server.pid`, `${process.pid}\n${port}\n`, 'utf8');
}
