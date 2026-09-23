import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  activeRequestDiagnosticCount,
  startRequestDiagnostic,
} from '../request-diagnostics.ts';

describe('request start diagnostics', () => {
  const oldFlag = process.env.DIGSITE_REQUEST_DIAGNOSTICS;
  const originalLog = console.log;

  afterEach(() => {
    if (oldFlag === undefined)
      Reflect.deleteProperty(process.env, 'DIGSITE_REQUEST_DIAGNOSTICS');
    else process.env.DIGSITE_REQUEST_DIAGNOSTICS = oldFlag;
    console.log = originalLog;
  });

  test('records safe tile coordinates and memory, then clears on response finish', () => {
    process.env.DIGSITE_REQUEST_DIAGNOSTICS = '1';
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    const req = new EventEmitter() as IncomingMessage;
    const res = new EventEmitter() as ServerResponse;
    Object.defineProperty(res, 'writableFinished', { get: () => true });

    startRequestDiagnostic(req, res, {
      requestId: 'test-request',
      method: 'GET',
      route: '/boards/:id/tiles/:sortId/:z/:x/:yfile',
      params: {
        id: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1',
        sortId: 'uploaded_at.desc',
        z: '-1',
        x: '3',
        yfile: '4.png',
      },
    });

    expect(activeRequestDiagnosticCount()).toBe(1);
    const start = JSON.parse(lines[0] ?? '{}');
    expect(start.event).toBe('request-start');
    expect(start.params).toEqual({
      boardId: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1',
      sortId: 'uploaded_at.desc',
      z: -1,
      x: 3,
      y: 4,
    });
    expect(start.memory.rss).toBeNumber();
    expect(JSON.stringify(start)).not.toContain('cookie');

    res.emit('finish');
    res.emit('close');
    expect(activeRequestDiagnosticCount()).toBe(0);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      'request-start',
      'request-end',
    ]);
  });

  test('records board metadata reads without query data', () => {
    process.env.DIGSITE_REQUEST_DIAGNOSTICS = '1';
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    const req = new EventEmitter() as IncomingMessage;
    const res = new EventEmitter() as ServerResponse;
    startRequestDiagnostic(req, res, {
      requestId: 'board-request',
      method: 'GET',
      route: '/boards/:id',
      params: { id: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1' },
    });
    const start = JSON.parse(lines[0] ?? '{}');
    expect(start.params).toEqual({
      boardId: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1',
    });
    expect(activeRequestDiagnosticCount()).toBe(1);
    res.emit('close');
    expect(activeRequestDiagnosticCount()).toBe(0);
  });

  test('does not record unrelated routes or run when disabled', () => {
    process.env.DIGSITE_REQUEST_DIAGNOSTICS = '0';
    const lines: string[] = [];
    console.log = (line: string) => lines.push(line);
    const req = new EventEmitter() as IncomingMessage;
    const res = new EventEmitter() as ServerResponse;
    const base = {
      requestId: 'test-request-2',
      method: 'GET',
      route: '/boards/:id',
      params: { id: '25f375ea-4e5e-40c4-b21b-9ad863dbbab1' },
    };
    startRequestDiagnostic(req, res, base);
    process.env.DIGSITE_REQUEST_DIAGNOSTICS = '0';
    startRequestDiagnostic(req, res, {
      ...base,
      route: '/boards/:id/tiles/:sortId/:z/:x/:yfile',
    });
    expect(lines).toHaveLength(0);
    expect(activeRequestDiagnosticCount()).toBe(0);
  });

  test('bounds unfinished requests and releases their listeners on abort', () => {
    process.env.DIGSITE_REQUEST_DIAGNOSTICS = '1';
    console.log = () => {};
    const requests = Array.from({ length: 200 }, (_, index) => {
      const req = new EventEmitter() as IncomingMessage;
      const res = new EventEmitter() as ServerResponse;
      startRequestDiagnostic(req, res, {
        requestId: `pending-${index}`,
        method: 'GET',
        route: '/boards/:id',
        params: {},
      });
      return { req, res };
    });
    expect(activeRequestDiagnosticCount()).toBeLessThanOrEqual(128);
    for (const { req, res } of requests) {
      req.emit('aborted');
      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('finish')).toBe(0);
    }
    expect(activeRequestDiagnosticCount()).toBe(0);
  });
});
