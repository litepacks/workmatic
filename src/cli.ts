#!/usr/bin/env node

/**
 * Workmatic CLI — thin entrypoint; logic in ./cli/handlers.ts
 */

import {
  printUsage,
  parseOptions,
  getPositionalArgs,
  runCommand,
  type CliCommand,
} from './cli/handlers.js';

const args = process.argv.slice(2);
const command = args[0];

const KNOWN_COMMANDS: readonly CliCommand[] = [
  'stats',
  'list',
  'export',
  'import',
  'purge',
  'retry',
  'pause',
  'resume',
  'queues',
  'transfer',
];

function isCliCommand(value: string): value is CliCommand {
  return (KNOWN_COMMANDS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  if (!isCliCommand(command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const positionalArgs = getPositionalArgs(args.slice(1));
  const options = parseOptions(args);
  const dbPath = positionalArgs[0];

  if (!dbPath) {
    console.error('Error: Database path is required');
    printUsage();
    process.exit(1);
  }

  try {
    await runCommand(command, dbPath, positionalArgs, options);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
