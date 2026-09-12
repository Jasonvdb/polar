'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createManifest,
  copyContext,
  verifyContext,
} = require('./package-paykit-context');

const makeSource = root => {
  const source = path.join(root, 'paykit');
  fs.mkdirSync(path.join(source, 'src', 'bin'), { recursive: true });
  for (const file of ['Dockerfile', '.dockerignore', 'Cargo.toml', 'Cargo.lock'])
    fs.writeFileSync(path.join(source, file), `${file}\n`);
  fs.writeFileSync(path.join(source, 'src', 'main.rs'), 'fn main() {}\n');
  fs.writeFileSync(path.join(source, 'src', 'lib.rs'), 'pub fn value() {}\n');
  fs.writeFileSync(path.join(source, 'src', 'lib_tests.rs'), 'secret fixture\n');
  fs.writeFileSync(path.join(source, 'src', 'bin', 'paykit-backup-fixture.rs'), 'fixture\n');
  return source;
};

test('packaged context is deterministic and excludes test and fixture sources', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = makeSource(root);
    const first = createManifest(source, '4.0.0');
    const second = createManifest(source, '4.0.0');
    assert.deepEqual(second, first);
    assert(!first.files.some(file => ['src/lib_tests.rs', 'src/bin/paykit-backup-fixture.rs'].includes(file.path)));
});

test('packaged context rejects tampering and extra files', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = makeSource(root);
    const output = path.join(root, 'output');
    const manifest = createManifest(source, '4.0.0');
    copyContext(source, output, manifest);
    fs.appendFileSync(path.join(output, 'src', 'main.rs'), 'changed');
    assert.throws(() => verifyContext(output, manifest), /integrity/);
    copyContext(source, output, manifest);
    fs.writeFileSync(path.join(output, 'extra'), 'extra');
    assert.throws(() => verifyContext(output, manifest), /file set/);
});

test('packaged context rejects source symlinks', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paykit-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = makeSource(root);
    fs.symlinkSync(path.join(source, 'src', 'main.rs'), path.join(source, 'src', 'linked.rs'));
    assert.throws(() => createManifest(source, '4.0.0'), /Symlinks/);
});

test('shipping image builds select production and keep fixtures out of its stage', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'paykit.yml'), 'utf8');
  const builder = fs.readFileSync(path.join(repositoryRoot, 'electron', 'paykitImageBuilder.ts'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'paykit', 'Dockerfile'), 'utf8');

  assert.match(workflow, /docker build --target production -t polar-paykit\/service:/);
  assert.match(builder, /const args = \[\s*'build',\s*'--target',\s*'production',/);

  const productionStage = dockerfile.match(/FROM runtime AS production\n([\s\S]*?)(?=\nFROM )/);
  assert(productionStage, 'Dockerfile must define a production stage');
  assert.match(productionStage[1], /ENTRYPOINT \["polar-paykit"\]/);
  assert.match(productionStage[1], /CMD \["serve"\]/);
  assert.doesNotMatch(productionStage[1], /paykit-(?:backup|receipt)-fixture/);
});

test('package workflow runs image CI broadly and keeps release packaging gated', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'package.yml'), 'utf8');

  assert.match(workflow, /pull_request:/);
  for (const branch of ["'master'", "'codex/**'", "'release/*'"])
    assert.ok(workflow.includes(`- ${branch}`));
  assert.match(workflow, /package:\n[\s\S]*?if: startsWith\(github\.ref_name, 'release\/'\)/);
  assert.match(workflow, /--publish never/);
});

test('package image smoke invokes the binary without its serve CMD and checks status', () => {
  const repositoryRoot = path.resolve(__dirname, '..');
  const workflow = fs.readFileSync(path.join(repositoryRoot, '.github', 'workflows', 'package.yml'), 'utf8');

  assert.match(workflow, /--entrypoint \/bin\/sh polar-paykit\/service:ci -c 'exec polar-paykit'/);
  assert.match(workflow, /status=\$\?/);
  assert.match(workflow, /if \[ "\$status" -ne 0 \]; then[\s\S]*?printf[\s\S]*?exit "\$status"/);
  assert.match(workflow, /grep -F 'Usage: polar-paykit' <<<"\$output"/);
  assert.doesNotMatch(workflow, /docker run --rm polar-paykit\/service:ci 2>&1 \| grep/);
});
