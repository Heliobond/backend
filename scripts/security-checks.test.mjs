// Tests for the CI security checks. Run with: node --test scripts/
// Uses node:test so it needs no installed dependencies, like the checks themselves.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_LINE_LENGTH,
  isScannedPath,
  scanFiles,
  scanRootScripts,
  scanText,
} from './check-hidden-content.mjs'
import {
  REVIEW_LABEL,
  isWatched,
  packageJsonChanges,
  requiresReview,
} from './check-supply-chain-changes.mjs'
import { findForeignLockfiles, lintLockfile, parseBunLock } from './lockfile-lint.mjs'

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPTS, '..')
const TABS = '\t'.repeat(300)
const rules = (findings) => findings.map((f) => f.rule)

describe('hidden-content: the #969 payload shapes', () => {
  // Same shape as the real payload, not the payload itself.
  it('flags a root api.js that is one tab-padded obfuscated line', () => {
    const apiJs = `${TABS}var _0x${'4c42d'}=function(){return 1};${'x'.repeat(500)}`
    assert.deepEqual(rules(scanRootScripts(['api.js'])), ['root-script'])
    const found = new Set(rules(scanText('api.js', apiJs)))
    for (const rule of ['padding', 'long-line', 'dynamic-code']) assert.ok(found.has(rule), rule)
  })

  it('flags a loader appended after the closing line of eslint.config.mjs', () => {
    const escapes = '\\u006C\\u0065\\u006E\\u0067\\u0074\\u0068'
    const config = `export default [];\n);${TABS}global['!']='8-9824-7';n['${escapes}']`
    const found = new Set(rules(scanText('eslint.config.mjs', config)))
    for (const rule of ['padding', 'dynamic-code']) assert.ok(found.has(rule), rule)
  })
})

describe('hidden-content: individual rules', () => {
  it('applies the length limit in source only', () => {
    assert.deepEqual(rules(scanText('src/a.ts', 'x'.repeat(MAX_LINE_LENGTH + 1))), ['long-line'])
    assert.deepEqual(scanText('src/a.ts', 'x'.repeat(MAX_LINE_LENGTH)), [])
    assert.deepEqual(scanText('docs/notes.txt', 'x'.repeat(MAX_LINE_LENGTH + 50)), [])
  })

  it('flags tab and space padding but not normal indentation', () => {
    assert.ok(rules(scanText('src/a.ts', `a();${'\t'.repeat(8)}b()`)).includes('padding'))
    assert.ok(rules(scanText('openapi.json', `${' '.repeat(40)}"x"`)).includes('padding'))
    assert.deepEqual(scanText('src/a.ts', '    if (x) {\n\t\treturn 1\n    }'), [])
  })

  it('flags zero-width and bidi characters, allowing a leading BOM only', () => {
    assert.deepEqual(rules(scanText('src/a.ts', 'const a\u200B = 1')), ['hidden-char'])
    assert.deepEqual(rules(scanText('src/a.ts', 'ok // \u202Eedoc')), ['hidden-char'])
    assert.deepEqual(scanText('src/a.ts', '\uFEFFconst a = 1'), [])
    assert.deepEqual(rules(scanText('src/a.ts', 'a\n\uFEFFb')), ['hidden-char'])
  })

  it('flags dynamic code in source, workflows and packages, but not in tests', () => {
    assert.deepEqual(rules(scanText('src/a.ts', 'ev' + 'al(x)')), ['dynamic-code'])
    assert.deepEqual(rules(scanText('src/a.ts', 'new Func' + 'tion(b)')), ['dynamic-code'])
    assert.deepEqual(rules(scanText('.github/workflows/ci.yml', 'run: ev' + 'al(1)')), [
      'dynamic-code',
    ])
    assert.deepEqual(rules(scanText('packages/api-client/src/x.ts', 'at' + 'ob(s)')), [
      'dynamic-code',
    ])
    assert.deepEqual(scanText('src/__tests__/a.test.ts', 'ev' + 'al(x)'), [])
    assert.deepEqual(scanText('src/a.ts', '/[\\u0000-\\u001f]/.test(s)'), [])
  })

  it('allows only the reviewed root scripts', () => {
    const paths = ['api.js', 'eslint.config.mjs', 'jest.config.ts', 'src/api.js', 'README.md']
    assert.deepEqual(
      scanRootScripts(paths).map((f) => f.file),
      ['api.js'],
    )
  })

  it('skips lockfiles, markdown and binary files', () => {
    assert.equal(isScannedPath('bun.lock'), false)
    assert.equal(isScannedPath('docs/DEPLOYMENT.md'), false)
    assert.equal(isScannedPath('package.json'), true)
    assert.deepEqual(scanFiles([{ path: 'src/x.bin', text: `\0${TABS}` }]), [])
  })

  it('passes on the committed tree', () => {
    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
    const files = paths.map((p) => {
      const abs = path.join(ROOT, p)
      return { path: p, text: isScannedPath(p) && fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '' }
    })
    assert.deepEqual(scanFiles(files), [])
  })
})

describe('supply-chain gate', () => {
  it('watches files that can run code in CI, Docker or on developer machines', () => {
    for (const f of [
      'package.json',
      'bun.lock',
      '.husky/pre-commit',
      '.github/workflows/ci.yml',
      '.github/CODEOWNERS',
      'eslint.config.mjs',
      'jest.config.ts',
      'tsconfig.test.json',
      '.releaserc.json',
      'Dockerfile',
      'docker-compose.yml',
      'packages/api-client/package.json',
      'scripts/check-hidden-content.mjs',
    ]) {
      assert.ok(isWatched(f), f)
    }
    for (const f of ['src/index.ts', 'README.md', 'packages/api-client/src/index.ts']) {
      assert.ok(!isWatched(f), f)
    }
  })

  it('needs the label, and a fresh one after every push', () => {
    assert.equal(requiresReview(['package.json'], [], 'opened'), true)
    assert.equal(requiresReview(['package.json'], [REVIEW_LABEL], 'labeled'), false)
    assert.equal(requiresReview(['package.json'], [REVIEW_LABEL], 'synchronize'), true)
    assert.equal(requiresReview(['src/index.ts'], [], 'synchronize'), false)
  })

  it('reports a script change verbatim', () => {
    const before = JSON.stringify({ scripts: { start: 'node dist/index.js' } })
    const after = JSON.stringify({ scripts: { start: 'node api.js && node dist/index.js' } })
    assert.deepEqual(packageJsonChanges(before, after), [
      {
        section: 'scripts',
        key: 'start',
        before: 'node dist/index.js',
        after: 'node api.js && node dist/index.js',
      },
    ])
  })

  it('fails the #969 package.json change in a real repo until labelled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-chain-'))
    try {
      const git = (...args) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
          cwd: dir,
          encoding: 'utf8',
        })
      git('init', '-q')
      fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"build":"tsc"}}\n')
      git('add', '.')
      git('commit', '-qm', 'base')
      const base = git('rev-parse', 'HEAD').trim()
      fs.writeFileSync(path.join(dir, 'package.json'), '{"scripts":{"build":"node api.js && tsc"}}\n')
      git('commit', '-qam', 'head')
      const head = git('rev-parse', 'HEAD').trim()

      const run = (labels, action) =>
        spawnSync(process.execPath, [path.join(SCRIPTS, 'check-supply-chain-changes.mjs'), base, head], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, PR_LABELS: JSON.stringify(labels), PR_ACTION: action, GITHUB_STEP_SUMMARY: '' },
        })

      const blocked = run([], 'opened')
      assert.equal(blocked.status, 1)
      assert.match(blocked.stdout, /scripts\.build: "tsc" -> "node api\.js && tsc"/)
      assert.equal(run([REVIEW_LABEL], 'labeled').status, 0)
      assert.equal(run([REVIEW_LABEL], 'synchronize').status, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('lockfile lint', () => {
  const SHA = 'sha512-' + 'A'.repeat(86) + '=='
  const lock = (packages, extra = {}) => ({ workspaces: { '': { dependencies: {} } }, packages, ...extra })

  it('accepts registry entries and rejects git, tarball and hashless ones', () => {
    assert.deepEqual(lintLockfile(lock({ a: ['a@1.0.0', '', {}, SHA] })), [])
    assert.equal(lintLockfile(lock({ e: ['e@github:x/e#abc', '', {}, SHA] })).length, 1)
    assert.equal(lintLockfile(lock({ e: ['e@1.0.0', 'https://evil/e.tgz', {}, SHA] })).length, 1)
    assert.equal(lintLockfile(lock({ e: ['e@1.0.0', '', {}] })).length, 1)
    assert.equal(lintLockfile(lock({}, { overrides: { e: 'git+https://x/e.git' } })).length, 1)
  })

  it('passes the committed bun.lock and finds no foreign lockfiles', () => {
    const committed = parseBunLock(fs.readFileSync(path.join(ROOT, 'bun.lock'), 'utf8'))
    assert.deepEqual(lintLockfile(committed), [])
    assert.deepEqual(findForeignLockfiles(ROOT), [])
  })
})
