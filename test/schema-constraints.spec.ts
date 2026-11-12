import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const schemaDir = join(__dirname, '..', 'prisma', 'schema');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function readPrisma(): string {
  return stripComments(
    readdirSync(schemaDir)
      .filter((name) => name.endsWith('.prisma'))
      .map((name) => readFileSync(join(schemaDir, name), 'utf8'))
      .join('\n'),
  );
}

function readMigrations(): string {
  const root = join(schemaDir, 'migrations');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry === 'migration.sql') {
        files.push(readFileSync(path, 'utf8'));
      }
    }
  };
  walk(root);
  return files.join('\n');
}

describe('schema has no enforced foreign keys or database business clocks', () => {
  const prisma = readPrisma();
  const sql = readMigrations();

  it('does not declare prisma relations or current-timestamp defaults', () => {
    expect(prisma).not.toMatch(/@relation\b/);
    expect(prisma).not.toMatch(/@updatedAt\b/);
    expect(prisma).not.toMatch(/@default\(\s*now\(\s*\)\s*\)/);
    expect(prisma).not.toMatch(/\bonDelete\b|\bonUpdate\b/);
  });

  it('does not emit foreign keys or CURRENT_TIMESTAMP', () => {
    expect(sql).not.toMatch(/FOREIGN KEY/i);
    expect(sql).not.toMatch(/\bREFERENCES\b/i);
    expect(sql).not.toMatch(/CURRENT_TIMESTAMP/i);
    expect(sql).not.toMatch(/\bNOW\(\)/i);
    expect(sql).toMatch(/CREATE TABLE `users`/);
    expect(sql).toMatch(/CREATE TABLE `admin_settings`/);
    expect(sql).toMatch(/CREATE TABLE `red_packet_rounds`/);
  });
});
