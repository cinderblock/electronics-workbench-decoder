import commandLineArgs from 'command-line-args';
import winston from 'winston';
import { decode } from './decode';
import { decodeMdb } from './decodeMdb';
import { decodeEwnetFile } from './ewnet';
import { detectFileFormat, knownFormatsList } from './formats';

async function decodeFile(file: string, logger: winston.Logger): Promise<void> {
  const format = await detectFileFormat(file);
  if (!format) {
    throw new Error(`Could not detect format of "${file}". Known formats: ${knownFormatsList()}`);
  }

  logger.silly(`Detected ${format.label} (${format.key}, kind=${format.kind})`);

  switch (format.kind) {
    case 'compressed-xml':
      await decode(file, logger);
      return;
    case 'mdb':
      await decodeMdb(file, logger);
      return;
    case 'ewnet':
      await decodeEwnetFile(file, logger);
      return;
  }
}

export async function main() {
  const { files, verbose, concurrent } = commandLineArgs([
    { name: 'verbose', alias: 'v', type: Boolean },
    { name: 'concurrent', alias: 'c', type: Boolean },
    { name: 'files', type: String, multiple: true, defaultOption: true },
  ]) as {
    files: string[];
    verbose: boolean;
    concurrent: boolean;
  };

  const logger = winston.createLogger({
    level: verbose ? 'verbose' : 'info',
    format: winston.format.json(),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
      }),
    ],
  });

  if (!files) {
    logger.error('No files specified');
    process.exitCode = 1;
    return;
  }

  if (concurrent) {
    await Promise.all(files.map(f => decodeFile(f, logger)));
  } else {
    for (const f of files) {
      logger.info(`Next file: ${f}`);
      await decodeFile(f, logger);
    }
  }
}

if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
}
