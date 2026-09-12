import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { PaykitImageBuilder } from '../../electron/paykitImageBuilder';

jest.mock('electron', () => ({ app: { isPackaged: false } }));

const sha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex');
const processResult = (stdout = '', code = 0) => {
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  process.nextTick(() => {
    if (stdout) child.stdout.write(stdout);
    child.emit('close', code);
  });
  return child;
};

describe('PaykitImageBuilder', () => {
  let directory: string;
  let trusted: { manifestSha256: string; contextSha256: string };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'paykit-image-builder-'));
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(directory, 'src', 'main.rs'), 'fn main() {}\n');
    const files = ['Dockerfile', 'src/main.rs'].map(file => {
      const body = readFileSync(join(directory, file));
      return { path: file, size: body.length, sha256: sha256(body) };
    });
    const contextSha256 = sha256(
      files.map(file => `${file.path}\0${file.size}\0${file.sha256}\n`).join(''),
    );
    const manifest = {
      schemaVersion: 1,
      appVersion: '4.0.0',
      imageTag: `polar-paykit/service:4.0.0-${contextSha256.slice(0, 16)}`,
      contextDigest: contextSha256,
      supportedArchitectures: ['amd64', 'arm64'],
      files,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(directory, 'service-image.json'), manifestBytes);
    trusted = { manifestSha256: sha256(manifestBytes), contextSha256 };
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test('rejects an image for a different architecture', async () => {
    const spawn = jest
      .fn()
      .mockImplementationOnce(() => processResult('amd64\n'))
      .mockImplementationOnce(() =>
        processResult(
          JSON.stringify({
            Architecture: 'arm64',
            Config: {
              Labels: {
                'com.lightningpolar.paykit.app-version': '4.0.0',
                'com.lightningpolar.paykit.context-sha256': trusted.contextSha256,
              },
            },
          }),
        ),
      );
    const builder = new PaykitImageBuilder(directory, spawn as any, trusted);
    expect((await builder.handle({ action: 'status' })).status).toBe('needed');
  });

  test('keeps one build job, bounds output, and cancels with SIGTERM', async () => {
    const build: any = new EventEmitter();
    build.stdout = new PassThrough();
    build.stderr = new PassThrough();
    build.kill = jest.fn();
    const spawn = jest
      .fn()
      .mockImplementationOnce(() => processResult('x86_64\n'))
      .mockImplementationOnce(() => processResult('missing', 1))
      .mockReturnValueOnce(build);
    const builder = new PaykitImageBuilder(directory, spawn as any, trusted);
    const first = await builder.handle({ action: 'build' });
    const second = await builder.handle({ action: 'build' });
    expect(second.jobId).toBe(first.jobId);
    expect(spawn).toHaveBeenCalledTimes(3);
    build.stdout.write(`${Array.from({ length: 120 }, (_, i) => `#${i}`).join('\n')}\n`);
    expect(builder.getState().recentOutput).toHaveLength(100);
    expect(builder.getState().recentOutput[99].length).toBeLessThanOrEqual(500);
    await builder.handle({ action: 'cancel', jobId: first.jobId! });
    expect(build.kill).toHaveBeenCalledWith('SIGTERM');
    expect(build.kill).toHaveBeenCalledTimes(1);
  });
});
