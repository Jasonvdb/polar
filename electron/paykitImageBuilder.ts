import { app } from 'electron';
import { ChildProcessWithoutNullStreams, spawn as nodeSpawn } from 'child_process';
import { createHash, timingSafeEqual } from 'crypto';
import { Dirent, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, sep } from 'path';
import {
  PaykitImageManifest,
  PaykitImageRequest,
  PaykitImageSetupState,
} from '../src/shared/paykitRuntime';
import {
  PAYKIT_IMAGE_CONTEXT_SHA256,
  PAYKIT_IMAGE_MANIFEST_SHA256,
} from '../src/shared/paykitImageMetadata';

type Spawn = typeof nodeSpawn;
const MAX_LINES = 100;
const MAX_LINE_LENGTH = 500;
const DIGEST = /^[a-f0-9]{64}$/;

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const equalHash = (actual: string, expected: string) =>
  DIGEST.test(actual) &&
  DIGEST.test(expected) &&
  timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
const architecture = (value: string) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'x86_64' || normalized === 'x64') return 'amd64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized;
};

export class PaykitImageBuilder {
  private state: PaykitImageSetupState = {
    status: 'checking',
    message: 'Checking Paykit service image',
    recentOutput: [],
  };
  private child?: ChildProcessWithoutNullStreams;
  private manifest?: PaykitImageManifest;
  private daemonArchitecture?: string;
  private cancelled = false;
  private starting = false;

  constructor(
    private readonly contextDirectory = app.isPackaged
      ? join(process.resourcesPath, 'paykit-service')
      : join(process.cwd(), 'build-resources', 'paykit-service'),
    private readonly spawn: Spawn = nodeSpawn,
    private readonly trusted = {
      manifestSha256: PAYKIT_IMAGE_MANIFEST_SHA256,
      contextSha256: PAYKIT_IMAGE_CONTEXT_SHA256,
    },
  ) {}

  async handle(request: PaykitImageRequest): Promise<PaykitImageSetupState> {
    if (request.action === 'cancel') return this.cancel(request.jobId);
    if (request.action === 'build') return this.build();
    if (this.state.status === 'failed' || this.state.status === 'cancelled')
      return this.getState();
    return this.refresh();
  }

  getState() {
    return { ...this.state, recentOutput: [...this.state.recentOutput] };
  }

  private setState(next: Partial<PaykitImageSetupState>) {
    this.state = { ...this.state, ...next };
  }

  private fail(
    code: NonNullable<PaykitImageSetupState['error']>['code'],
    message: string,
  ) {
    this.state = {
      status: 'failed',
      message,
      recentOutput: this.state.recentOutput,
      error: { code, message },
    };
    return this.getState();
  }

  private walk(directory: string, prefix = ''): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry: Dirent) => {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error('The bundled Paykit service files are invalid');
      if (entry.isDirectory()) return this.walk(join(directory, entry.name), name);
      if (!entry.isFile())
        throw new Error('The bundled Paykit service files are invalid');
      return [name];
    });
  }

  private verifyContext() {
    const manifestPath = join(this.contextDirectory, 'service-image.json');
    const manifestBytes = readFileSync(manifestPath);
    if (!equalHash(hash(manifestBytes), this.trusted.manifestSha256))
      throw new Error('Manifest trust check failed');
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as PaykitImageManifest;
    if (
      manifest.schemaVersion !== 1 ||
      !equalHash(manifest.contextDigest, this.trusted.contextSha256)
    )
      throw new Error('Manifest context check failed');
    const expected = manifest.files.map(file => file.path).sort();
    if (new Set(expected).size !== expected.length)
      throw new Error('Duplicate manifest file');
    for (const file of expected) {
      if (
        !file ||
        file.startsWith('/') ||
        file.split('/').includes('..') ||
        file.includes('\\')
      )
        throw new Error('Unsafe manifest path');
    }
    const actual = this.walk(this.contextDirectory)
      .filter(file => file !== 'service-image.json')
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('Context file set mismatch');
    const records = manifest.files
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(file => {
        const absolute = resolve(this.contextDirectory, ...file.path.split('/'));
        if (!absolute.startsWith(`${resolve(this.contextDirectory)}${sep}`))
          throw new Error('Unsafe context path');
        const info = statSync(absolute);
        const contents = readFileSync(absolute);
        if (
          !info.isFile() ||
          info.size !== file.size ||
          !equalHash(hash(contents), file.sha256)
        )
          throw new Error('Context file integrity mismatch');
        return `${file.path}\0${file.size}\0${file.sha256}\n`;
      });
    if (!equalHash(hash(records.join('')), manifest.contextDigest))
      throw new Error('Context digest mismatch');
    this.manifest = manifest;
    return manifest;
  }

  private command(args: string[]): Promise<string> {
    return new Promise((resolveCommand, reject) => {
      const child = this.spawn('docker', args, { shell: false, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => (stdout += data.toString()));
      child.stderr.on('data', data => (stderr += data.toString()));
      child.once('error', reject);
      child.once('close', code =>
        code === 0
          ? resolveCommand(stdout)
          : reject(new Error(stderr || 'Docker command failed')),
      );
    });
  }

  private async prerequisites() {
    this.setState({
      status: 'checking',
      phase: 'verifying-context',
      message: 'Verifying bundled service files',
      error: undefined,
    });
    const manifest = this.verifyContext();
    this.setState({ phase: 'checking-docker', message: 'Checking Docker Desktop' });
    const daemon = architecture(
      await this.command(['info', '--format', '{{.Architecture}}']),
    );
    if (!manifest.supportedArchitectures.includes(daemon as 'amd64' | 'arm64'))
      throw new Error(`architecture:${daemon}`);
    this.daemonArchitecture = daemon;
    return manifest;
  }

  private async imageIsValid(manifest: PaykitImageManifest) {
    try {
      const raw = await this.command([
        'image',
        'inspect',
        manifest.imageTag,
        '--format',
        '{{json .}}',
      ]);
      const image = JSON.parse(raw);
      const labels = image.Config?.Labels || {};
      return (
        architecture(image.Architecture || '') === this.daemonArchitecture &&
        labels['com.lightningpolar.paykit.app-version'] === manifest.appVersion &&
        labels['com.lightningpolar.paykit.context-sha256'] === manifest.contextDigest
      );
    } catch (_) {
      return false;
    }
  }

  async refresh() {
    if (this.child) return this.getState();
    try {
      const manifest = await this.prerequisites();
      this.setState({
        phase: 'checking-image',
        message: 'Checking the local service image',
        imageTag: manifest.imageTag,
      });
      if (await this.imageIsValid(manifest)) {
        this.state = {
          status: 'ready',
          phase: 'verifying-image',
          message: 'Paykit service image is ready',
          recentOutput: [],
          imageTag: manifest.imageTag,
        };
      } else {
        this.state = {
          status: 'needed',
          message: 'Build the Paykit service image to continue',
          recentOutput: [],
          imageTag: manifest.imageTag,
        };
      }
    } catch (error: any) {
      const detail = error?.message || '';
      const unsupported = detail.startsWith('architecture:');
      const docker = /docker|connect|ENOENT/i.test(detail);
      return this.fail(
        unsupported
          ? 'architecture-unsupported'
          : docker
          ? 'docker-unavailable'
          : 'context-invalid',
        unsupported
          ? 'This Docker Desktop architecture is not supported by the bundled Paykit service.'
          : docker
          ? 'Start Docker Desktop, then retry.'
          : 'The bundled Paykit service files failed verification. Reinstall the app.',
      );
    }
    return this.getState();
  }

  async build() {
    if (this.child || this.starting) return this.getState();
    this.starting = true;
    const checked = await this.refresh();
    if (checked.status === 'ready' || checked.status === 'failed') {
      this.starting = false;
      return checked;
    }
    const manifest = this.manifest!;
    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    this.cancelled = false;
    this.state = {
      status: 'building',
      jobId,
      phase: 'building-image',
      message: 'Building the Paykit service image',
      recentOutput: [],
      imageTag: manifest.imageTag,
    };
    const args = [
      'build',
      '--target',
      'production',
      '--tag',
      manifest.imageTag,
      '--label',
      `com.lightningpolar.paykit.app-version=${manifest.appVersion}`,
      '--label',
      `com.lightningpolar.paykit.context-sha256=${manifest.contextDigest}`,
      this.contextDirectory,
    ];
    const child = this.spawn('docker', args, { shell: false, windowsHide: true });
    this.child = child;
    this.starting = false;
    const output = (data: Buffer) => this.appendOutput(data.toString());
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    child.once('error', () => {
      this.child = undefined;
      this.fail('build-failed', 'Docker could not start the service image build.');
    });
    child.once('close', async code => {
      this.child = undefined;
      if (this.cancelled) {
        this.state = {
          status: 'cancelled',
          jobId,
          message: 'Service image build cancelled',
          recentOutput: this.state.recentOutput,
          imageTag: manifest.imageTag,
          error: { code: 'cancelled', message: 'Service image build cancelled' },
        };
      } else if (code !== 0)
        this.fail(
          'build-failed',
          'The service image build failed. Check Docker Desktop and your internet connection, then retry.',
        );
      else {
        this.setState({
          status: 'checking',
          phase: 'verifying-image',
          message: 'Verifying the built service image',
        });
        if (await this.imageIsValid(manifest))
          this.state = {
            status: 'ready',
            phase: 'verifying-image',
            message: 'Paykit service image is ready',
            recentOutput: this.state.recentOutput,
            imageTag: manifest.imageTag,
          };
        else
          this.fail(
            'image-invalid',
            'Docker built an image that did not pass verification. Retry the build.',
          );
      }
    });
    return this.getState();
  }

  private appendOutput(raw: string) {
    const lines = raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line =>
        line
          .replace(/\x1b\[[0-9;]*m/g, '')
          .split(this.contextDirectory)
          .join('[service context]')
          .replace(/(?:\/Users|\/home)\/[^\s:]+/g, '[local path]')
          .replace(/[A-Za-z]:\\[^\s:]+/g, '[local path]')
          .slice(0, MAX_LINE_LENGTH),
      );
    this.setState({
      recentOutput: [...this.state.recentOutput, ...lines].slice(-MAX_LINES),
    });
  }

  cancel(jobId: string) {
    if (!this.child || this.state.jobId !== jobId) return this.getState();
    this.cancelled = true;
    this.child.kill('SIGTERM');
    this.setState({ message: 'Cancelling the service image build' });
    return this.getState();
  }
}

export const paykitImageBuilder = new PaykitImageBuilder();
