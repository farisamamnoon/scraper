/**
 * Exports the human-saved pairs of a channel as an eval fixture for the mapper UI's offline harness.
 * Read-only: it only reads the database. See docs/pipeline.md, "Eval fixture export".
 *
 * Usage:
 *   npx ts-node scripts/export-eval-fixtures.ts --channel <handle> [--batches 1,2] --out <path> [--no-ssl]
 *
 * Reads POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER and POSTGRES_PASSWORD from the environment
 * (`.env` is loaded; scripts/test-db.sh env shows the test DB values). The file holds real channel text:
 * keep it out of git and out of public places.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { DbService } from '../src/services/db.service';
import { serializeEvalFixture, toEvalBatch } from '../src/eval-fixtures';
import type { EvalBatch, EvalFixture } from '../src/eval-fixtures';

dotenv.config();

interface Args {
  channel: string;
  batches: number[] | null;
  out: string;
  ssl: boolean;
}

function fail(message: string): never {
  console.error(`export-eval-fixtures: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  let channel = '';
  let out = '';
  let batches: number[] | null = null;
  let ssl = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value.`);
    if (arg === '--channel') channel = value().replace(/^@/, '');
    else if (arg === '--out') out = value();
    else if (arg === '--batches') {
      batches = value()
        .split(',')
        .map((n) => (/^\d+$/.test(n.trim()) ? Number(n.trim()) : fail(`--batches needs positive integers, got "${n}".`)));
    } else if (arg === '--no-ssl') ssl = false;
    else fail(`unknown argument ${arg}.`);
  }
  if (!channel) fail('--channel <handle> is required.');
  if (!out) fail('--out <path> is required (there is no default: the file holds real channel text).');
  return { channel, batches, out: path.resolve(out), ssl };
}

function requiredEnv(key: string): string {
  return process.env[key] || fail(`${key} is not set.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const pool = new Pool({
    host: requiredEnv('POSTGRES_HOST'),
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: requiredEnv('POSTGRES_DB'),
    user: requiredEnv('POSTGRES_USER'),
    password: requiredEnv('POSTGRES_PASSWORD'),
    ssl: args.ssl ? { rejectUnauthorized: true } : false,
    max: 2,
  });
  try {
    const db = new DbService(pool);
    const channel = await db.getChannelByUsername(args.channel);
    if (!channel) fail(`channel @${args.channel} is not tracked.`);
    const { order, batches } = await db.getChannelBatches(channel.channel_id);
    if (!order) fail(`channel @${args.channel} has no stored order. Build its batches first (POST …/batches).`);
    const wanted = args.batches ? new Set(args.batches) : null;
    const selected = batches.filter((b) => !wanted || wanted.has(b.batch_no));
    if (wanted) {
      const missing = [...wanted].filter((n) => !batches.some((b) => b.batch_no === n));
      if (missing.length > 0) fail(`batches not found: ${missing.join(', ')}.`);
    }
    const mappings = await db.getChannelMappings(channel.channel_id);

    const exported: EvalBatch[] = [];
    for (const batch of selected) {
      if (batch.mapped_audio_count === 0) {
        console.error(`skip batch ${batch.batch_no}: no mappings`);
        continue;
      }
      const rows = await db.getBatchMessages(channel.channel_id, batch);
      const evalBatch = toEvalBatch({
        channel,
        batch,
        order,
        messages: rows.messages,
        contextMessage: rows.context_message,
        linkedMessages: rows.linked_messages,
        mappings,
        deleted: rows.deleted,
      });
      if (Object.keys(evalBatch.expected).length === 0) {
        console.error(`skip batch ${batch.batch_no}: no labelled audio left after deletions`);
        continue;
      }
      exported.push(evalBatch);
    }
    if (exported.length === 0) fail('no batch with mappings to export.');

    const fixture: EvalFixture = {
      version: 1,
      source: `scraper export of @${channel.channel_username ?? channel.channel_id} on ${new Date().toISOString()}`,
      batches: exported,
    };
    let json: string;
    try {
      json = serializeEvalFixture(fixture);
    } catch (err) {
      return fail((err as Error).message);
    }
    fs.writeFileSync(args.out, json, { mode: 0o600 });
    const pairs = exported.reduce((sum, b) => sum + Object.keys(b.expected).length, 0);
    console.error(`wrote ${args.out}: ${exported.length} batches, ${pairs} pairs, ${Buffer.byteLength(json)} bytes`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
