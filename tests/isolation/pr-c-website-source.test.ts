import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { UsageService } from '@brandspace/entitlements';
import { pinnedLookup } from '@brandspace/ai-gateway/egress';
import {
  BrandIngestionService,
  ExtractorRegistry,
  InMemoryObjectStore,
  PlainTextExtractor,
  WebReader,
  readWebsiteIntoSource,
  websiteHome,
  type IngestionPolicy,
} from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PR C (owner, 2026-11-14) — THE BRAND'S WEBSITE BECOMES ONE BRAND BRAIN
 * SOURCE IN ITS OWN WORKSPACE, AND WHAT IT SAYS WAITS IN PENDING.
 *
 * A local site stands in for the brand's (through the real reader, robots.txt
 * included); the source takes exactly a file's path (`receive`, then the
 * worker's `process`). Proven: one plain-text source named after the site,
 * every candidate PENDING, no knowledge item approved by reading, and another
 * workspace cannot see the source, its chunks or its candidates.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let server: Server;
let port = 0;
const store = new InMemoryObjectStore();

const POLICY: IngestionPolicy = {
  allowedMimeTypes: ['text/plain'],
  maxFileBytes: 1024 * 1024,
  maxDocumentsPerBrand: 50,
  maxAttempts: 3,
  retryBackoffSeconds: 60,
  chunkTargetChars: 300,
  chunkOverlapChars: 50,
  maxChunksPerDocument: 50,
  minimumCandidateConfidenceMilli: 400,
};

const RUN = randomUUID().slice(0, 8);
const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
  server = createServer((req, res) => {
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /admin\n');
    } else if (req.url === '/') {
      html(
        PAGE(
          `Bayt Coffee ${RUN}`,
          `<p>Our mission is to serve honest speciality coffee in Riyadh (${RUN}).</p><a href="/about">About</a><a href="/admin">Admin</a>`,
        ),
      );
    } else if (req.url === '/about') {
      html(
        PAGE(
          'About',
          '<p>Our audience is young professionals who care where their coffee comes from.</p>',
        ),
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app?.$disconnect();
});

const reader = () =>
  new WebReader({
    port,
    request: httpRequest,
    lookup: pinnedLookup(
      (_host, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]),
      (address) => address === '127.0.0.1',
    ),
  });

type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const ingestionIn = (workspaceId: string, db: ScopedDb) =>
  new BrandIngestionService({
    db,
    workspaceId,
    storage: { usage: new UsageService({ prisma: db as unknown as PrismaClient }), limitGb: null },
    store,
    policy: POLICY,
    extractors: new ExtractorRegistry([
      new PlainTextExtractor({
        maxPages: 50,
        maxTextChars: 200_000,
        maxArchiveEntries: 256,
        maxArchiveBytes: 8 * 1024 * 1024,
        maxCompressionRatio: 200,
        timeoutMs: 30_000,
      }),
    ]),
  });
const inWs = <T>(workspaceId: string, fn: (db: ScopedDb) => Promise<T>) =>
  withWorkspace(workspaceId, fn as never, { prisma: app }) as Promise<T>;

describe('PR C · the brand’s website, read into Brand Brain', () => {
  it('the home page and its About page become ONE source in A; its facts wait in Pending; B sees none of it', async () => {
    const home = websiteHome('bayt-coffee.example.com');
    expect(home).toBe('https://bayt-coffee.example.com/');
    const before = await inWs(fixtures.a.workspaceId, (db) =>
      db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId, status: 'ACTIVE' } }),
    );

    const { reading, received } = await readWebsiteIntoSource({
      reader: reader(),
      home: home!,
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      actorUserId: fixtures.a.userId,
      actorBrandScope: [],
      receive: (upload) =>
        inWs(fixtures.a.workspaceId, (db) =>
          ingestionIn(fixtures.a.workspaceId, db).receive(upload),
        ),
    });
    // robots.txt kept /admin out; the About page was read.
    expect(reading.pages.map((page) => new URL(page.url).pathname)).toEqual(['/', '/about']);
    expect(received.document).toMatchObject({
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      mimeType: 'text/plain',
      fileName: 'bayt-coffee.example.com — website (2 pages).txt',
    });

    // The worker's own step, as for any uploaded file.
    const jobId = received.job!.id;
    const outcome = await inWs(fixtures.a.workspaceId, (db) =>
      ingestionIn(fixtures.a.workspaceId, db).process(jobId),
    );
    expect(outcome.status).toBe('READY');
    const candidates = await inWs(fixtures.a.workspaceId, (db) =>
      db.brandKnowledgeCandidate.findMany({ where: { sourceDocumentId: received.document.id } }),
    );
    expect(candidates.length).toBeGreaterThan(0);
    // PENDING: nothing the site says is approved by reading it.
    expect(candidates.every((candidate) => candidate.status === 'PENDING')).toBe(true);
    const after = await inWs(fixtures.a.workspaceId, (db) =>
      db.brandKnowledgeItem.count({ where: { brandId: fixtures.a.brandId, status: 'ACTIVE' } }),
    );
    expect(after).toBe(before);

    // TENANT ISOLATION: B cannot read, count, find or change any of it.
    const seenByB = await inWs(fixtures.b.workspaceId, async (db) => ({
      document: await db.brandSourceDocument.findFirst({ where: { id: received.document.id } }),
      chunks: await db.brandSourceChunk.count({
        where: { sourceDocumentId: received.document.id },
      }),
      candidates: await db.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: received.document.id },
      }),
      byName: await db.brandSourceDocument.count({
        where: { fileName: { contains: 'bayt-coffee.example.com' } },
      }),
      changed: (
        await db.brandKnowledgeCandidate.updateMany({
          where: { sourceDocumentId: received.document.id },
          data: { status: 'ACCEPTED' },
        })
      ).count,
    }));
    expect(seenByB).toEqual({ document: null, chunks: 0, candidates: 0, byName: 0, changed: 0 });
  });

  it('the same site read again is the same source (a replay), not a second one', async () => {
    const run = () =>
      readWebsiteIntoSource({
        reader: reader(),
        home: 'https://bayt-coffee.example.com/',
        workspaceId: fixtures.a.workspaceId,
        brandId: fixtures.a.brandId,
        actorUserId: fixtures.a.userId,
        actorBrandScope: [],
        receive: (upload) =>
          inWs(fixtures.a.workspaceId, (db) =>
            ingestionIn(fixtures.a.workspaceId, db).receive(upload),
          ),
      });
    const first = await run();
    const second = await run();
    expect(second.received.document.id).toBe(first.received.document.id);
  });
});
