const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

for (const mode of ['missing', 'empty', 'whitespace', 'valid']) {
  test(`secret-backed entrypoint handles ${mode} secrets without disclosing them`, async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'codexui-entrypoint-'))
    try {
      await fs.writeFile(join(directory, 'cat'), `#!/bin/sh
test "$1" = /run/secrets/ninerouter-api-key || exit 9
case "$ENTRYPOINT_FIXTURE_MODE" in
  missing) exit 1 ;;
  empty) exit 0 ;;
  whitespace) printf ' \\t\\n' ;;
  valid) printf 'fixture-entrypoint-key\\n' ;;
esac
`, { mode: 0o755 })
      await fs.writeFile(join(directory, 'codexapp'), `#!/bin/sh
test "$NINEROUTER_API_KEY" = fixture-entrypoint-key || exit 8
printf 'fixture-codexapp'
printf ' <%s>' "$@"
printf '\\n'
`, { mode: 0o755 })
      const result = spawnSync('/bin/sh', [resolve(__dirname, 'codex-mobile-ninerouter-entrypoint.sh'), '--port', '4199'], {
        encoding: 'utf8', env: { PATH: `${directory}:/usr/bin:/bin`, ENTRYPOINT_FIXTURE_MODE: mode },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.stdout.includes('fixture-entrypoint-key'), false)
      assert.equal(result.stderr.includes('fixture-entrypoint-key'), false)
      if (mode === 'valid') {
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, 'fixture-codexapp <--port> <4199>\n')
      } else {
        assert.notEqual(result.status, 0)
        assert.equal(result.stdout, '')
      }
    } finally { await fs.rm(directory, { recursive: true, force: true }) }
  })
}
