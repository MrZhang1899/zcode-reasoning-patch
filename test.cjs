'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const api = require('./patcher.cjs');
const {patches, transform, run, hash, discover, discoveryRows, backupOnly, restore, listBackups} = api;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ZCode patch tests with spaces '));
const packageRoot = path.join(root, 'package');
fs.mkdirSync(packageRoot);
for (const file of ['patcher.cjs', 'restart.ps1', 'restart.test.ps1', 'discover.ps1', 'run-patch.cmd']) fs.copyFileSync(path.join(__dirname, file), path.join(packageRoot, file));
api.setStorage(packageRoot);
let checks = 0;
const ok = (condition, message) => { assert(condition, message); checks++; };
const quiet = () => {};
function fixture(name, source) {
  const dir = path.join(root, name); fs.mkdirSync(dir);
  const target = path.join(dir, 'zcode.cjs'); fs.writeFileSync(target, source); return target;
}
function unchangedFailure(target, pattern) {
  const before = hash(fs.readFileSync(target));
  const names = fs.readdirSync(path.dirname(target));
  assert.throws(() => run(target, false, quiet), pattern); checks++;
  ok(hash(fs.readFileSync(target)) === before, 'failure changed target');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), names); checks++;
}
function cmd(args, env = {}) {
  const launcher = path.join(packageRoot, 'run-patch.cmd');
  return cp.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args}"`], {
    encoding: 'utf8', timeout: 60000, windowsVerbatimArguments: true,
    env: {...process.env, ZCODE_PATCH_NO_PAUSE: '1', ...env}
  });
}
try {
  // Valid isolated syntax fixtures embed all six exact before signatures.
  const synthetic = patches.map(p => p.symbol ? p.before : p.id.startsWith('GPT') ? `var preceding=0${p.before}following=0;` : `var schema={${p.before}};`).join('\n');
  const target = fixture('synthetic original', synthetic);
  const first = run(target, false, quiet);
  ok(first.changed && first.pending === 6, 'six patches expected');
  ok(fs.readFileSync(first.backup, 'utf8') === synthetic, 'backup bytes');
  ok(fs.readFileSync(target, 'utf8') === transform(synthetic).candidate, 'output bytes');
  const beforeFiles = fs.readdirSync(path.dirname(target));
  ok(!run(target, false, quiet).changed, 'repeat must be idempotent');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), beforeFiles); checks++;
  const dry = fixture('dry run', synthetic);
  ok(run(dry, true, quiet).pending === 6, 'dry run pending');
  ok(fs.readFileSync(dry, 'utf8') === synthetic && fs.readdirSync(path.dirname(dry)).length === 1, 'dry run writes');
  for (const p of patches) {
    unchangedFailure(fixture(`unknown ${checks}`, synthetic.replace(p.before, p.before.replace(p.symbol ? `function ${p.symbol}(` : p.id.startsWith('GPT') ? 'JS=' : 'reasoningEffort:', p.symbol ? `function renamed_${p.symbol}(` : p.id.startsWith('GPT') ? 'renamedJS=' : 'renamedEffort:'))), /Unsupported/);
    unchangedFailure(fixture(`duplicate ${checks}`, synthetic + '\n' + p.before), /Unsupported/);
  }
  unchangedFailure(fixture('invalid candidate syntax', synthetic + '\nconst broken = ;'), /syntax check failed/);
  const mixed = fixture('partially patched', synthetic.replace(patches[0].before, patches[0].after));
  ok(run(mixed, false, quiet).pending === 5, 'mixed state');
  const restoreTarget = fixture('restore guarded', synthetic);
  const manifest = path.join(path.dirname(restoreTarget), 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({version: '1.0'}));
  const pre = backupOnly(restoreTarget, quiet);
  ok(fs.existsSync(`${pre}.json`), 'metadata exists');
  ok(!restore(restoreTarget, pre, true, quiet).changed, 'restore no-op');
  run(restoreTarget, false, quiet);
  ok(listBackups(restoreTarget).some(entry => entry.file === pre && entry.compatible), 'prepatch backup eligible');
  assert.throws(() => restore(restoreTarget, pre, false, quiet), /--yes/); checks++;
  const restored = restore(restoreTarget, pre, true, quiet);
  ok(restored.changed && fs.readFileSync(restoreTarget, 'utf8') === synthetic, 'restored original');
  ok(fs.existsSync(pre) && fs.existsSync(restored.backup), 'all backups retained');
  ok(!restore(restoreTarget, pre, true, quiet).changed, 'repeat restore idempotent');
  fs.writeFileSync(manifest, JSON.stringify({version: '2.0'}));
  assert.throws(() => restore(restoreTarget, pre, true, quiet), /版本/); checks++;
  ok(listBackups(restoreTarget).every(entry => !entry.compatible), 'old version hidden');
  fs.writeFileSync(manifest, JSON.stringify({version: '1.0'}));
  fs.appendFileSync(restoreTarget, '\n// unrelated update');
  assert.throws(() => restore(restoreTarget, pre, true, quiet), /备份内容或当前代码与校验记录不一致/); checks++;
  ok(listBackups(restoreTarget).every(entry => !entry.compatible), 'changed source hidden');
  fs.writeFileSync(restoreTarget, synthetic);
  const other = fixture('other target', synthetic);
  assert.throws(() => restore(other, pre, true, quiet), /外部/); checks++;
  const copied = `${other}.reasoning-copied.bak`;
  fs.copyFileSync(pre, copied); fs.copyFileSync(`${pre}.json`, `${copied}.json`);
  assert.throws(() => restore(other, copied, true, quiet), /备份对应的安装位置或版本不同/); checks++;
  fs.appendFileSync(pre, '\n// tampered');
  assert.throws(() => restore(restoreTarget, pre, true, quiet), /备份内容或当前代码与校验记录不一致/); checks++;
  const unknown = fixture('unknown backup allowed', 'module.exports = 42;');
  const unknownBackup = backupOnly(unknown, quiet);
  ok(fs.existsSync(unknownBackup) && listBackups(unknown).length === 1 && !listBackups(unknown)[0].compatible, 'unknown backup not restorable');
  const concurrent = fixture('concurrent apply', synthetic);
  assert.throws(() => run(concurrent, false, text => {
    if (text.includes('[安全 2/4]')) fs.appendFileSync(concurrent, '\n// updater');
  }), /ZCode 文件或版本信息被其他程序改动/); checks++;
  ok(fs.readFileSync(concurrent, 'utf8').endsWith('// updater'), 'concurrent change preserved');
  const concurrentRestore = fixture('concurrent restore', synthetic);
  const raceBackup = run(concurrentRestore, false, quiet).backup;
  assert.throws(() => restore(concurrentRestore, raceBackup, true, text => {
    if (text.includes('[4/5]')) fs.appendFileSync(concurrentRestore, '\n// updater');
  }), /ZCode 文件或版本信息被其他程序改动/); checks++;
  ok(fs.readFileSync(concurrentRestore, 'utf8').endsWith('// updater'), 'restore concurrent change preserved');
  const discovered = discoveryRows([{target}, {target}, {target: path.join(root, 'missing')}, {target: other}]);
  assert.deepEqual(discovered, [target, other]); checks++;
  ok(api.isPending(target), 'apply persists pendingRestart');
  api.setStorage(packageRoot);
  ok(api.isPending(target), 'pendingRestart survives reload');
  run(target, true, quiet);
  run(target, false, quiet);
  ok(api.isPending(target), 'check and apply no-op preserve pendingRestart');
  ok(api.isPending(restoreTarget), 'restore persists pendingRestart');
  ok(listBackups(target).some(e => e.reason === 'preapply' && e.originalState === 'unpatched'), 'preapply classified');
  const fullBackup = backupOnly(target, quiet);
  ok(listBackups(target).some(e => e.file === fullBackup && e.reason === 'manual' && e.originalState === 'full'), 'full manual backup classified');
  ok(listBackups(restoreTarget).some(e => e.reason === 'prerestore' && e.originalState === 'full'), 'prerestore classified');
  ok(listBackups(mixed).some(e => e.originalState === 'partial'), 'partial backup classified');
  ok(listBackups(unknown)[0].originalState === 'unknown', 'unknown classification');
  const historical = `${target}.reasoning-historical.bak`;
  fs.writeFileSync(historical, synthetic);
  ok(listBackups(target).some(e => e.file === historical && !e.compatible && e.originalState === 'unpatched'), 'historical backup visible');
  api.remember(target);
  ok(api.preferred([other, target]) === target, 'remembered choice among multiple');
  ok(api.preferred([other]) === null, 'stale preference fallback');
  fs.writeFileSync(path.join(packageRoot, 'settings.json'), '{broken');
  api.setStorage(packageRoot);
  ok(api.preferred([other, target]) === null, 'corrupt settings fallback');
  const diagnosticTarget = fixture('multiple diagnosis', synthetic.replace(patches[0].before, '') + '\n' + patches[1].before);
  const diagnosticOutput = [];
  assert.throws(() => run(diagnosticTarget, false, text => diagnosticOutput.push(text)), error => error.message.includes(patches[0].id) && error.message.includes(patches[1].id)); checks++;
  ok(diagnosticOutput.some(t => t.includes('版本：') && t.includes('SHA-256')), 'version and build diagnostic');
  ok(fs.readdirSync(path.dirname(diagnosticTarget)).length === 1, 'diagnostic no installation writes');
  api.audit('api_key=TOPSECRET token=TOKENVALUE Bearer BEARERVALUE https://private.example sk-SECRETKEY');
  const logText = fs.readdirSync(path.join(packageRoot, 'logs')).map(file => fs.readFileSync(path.join(packageRoot, 'logs', file), 'utf8')).join('\n');
  ok(logText.includes('ERROR check/apply') && logText.includes('[安全 2/4]') && logText.includes('备份位置：'), 'logs include errors stages backups');
  ok(!/TOPSECRET|TOKENVALUE|BEARERVALUE|private\.example|SECRETKEY/.test(logText), 'log secrets redacted');
  const blockedStorage = path.join(root, 'blocked-storage');
  fs.writeFileSync(blockedStorage, 'not a directory');
  api.setStorage(blockedStorage);
  ok(run(dry, true, quiet).changed === false, 'unwritable log directory does not block check');
  api.setStorage(packageRoot);
  function cli(args, input) {
    return cp.spawnSync(process.execPath, [path.join(packageRoot, 'patcher.cjs'), ...args], {
      encoding: 'utf8', input, timeout: 60000, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
    });
  }
  const menu = cli(['--target', target], '1\n0\n');
  ok(menu.status === 0 && menu.stdout.includes('换一个 ZCode 安装位置') && menu.stdout.includes('CHECK OK') && menu.stdout.includes('[补丁 6/6]'), 'Chinese piped menu');
  ok(!menu.stdout.includes('\x1b') && !menu.stdout.includes('按 Enter'), 'piped menu has no ANSI or pause');
  ok(menu.stdout.includes('选择要修改的 ZCode 安装位置，不会更换模型或供应商'), 'target description');
  // Simulate terminal capabilities in an isolated child; all operations use fixtures.
  function ttyMenu(input, env = {}, selectedTarget = target, inputTTY = true, outputTTY = true) {
    const script = `Object.defineProperty(process.stdin, 'isTTY', {value: ${inputTTY}});
      Object.defineProperty(process.stdout, 'isTTY', {value: ${outputTTY}});
      require(${JSON.stringify(path.join(packageRoot, 'patcher.cjs'))}).main(['--target', ${JSON.stringify(selectedTarget)}])
        .catch(error => { console.error(error); process.exitCode = 1; });`;
    const childEnv = {...process.env, TERM: 'xterm', ELECTRON_RUN_AS_NODE: '1', ...env};
    if (!Object.hasOwn(env, 'NO_COLOR')) delete childEnv.NO_COLOR;
    return cp.spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', input, timeout: 60000, env: childEnv});
  }
  const restartRoot = path.join(root, 'restart installation');
  fs.mkdirSync(path.join(restartRoot, 'resources', 'glm'), {recursive: true});
  const restartTarget = path.join(restartRoot, 'resources', 'glm', 'zcode.cjs');
  fs.writeFileSync(restartTarget, synthetic);
  fs.writeFileSync(path.join(restartRoot, 'ZCode.exe'), 'NOT AN EXECUTABLE: test fixture only');
  // Confirmation success is tested only with an injected executor, never the OS helper.
  const restartScript = `const assert = require('node:assert/strict');
    const {requestRestart, restartExecutable, run, restore, isPending} = require(${JSON.stringify(path.join(packageRoot, 'patcher.cjs'))});
    (async () => {
      let calls = 0;
      const target = ${JSON.stringify(restartTarget)};
      const applied = run(target, false, () => {});
      assert(isPending(target));
      for (const answer of ['NO', '', null, 'yes']) {
        await requestRestart(target, async prompt => {
          assert(prompt.includes('保存所有工作') && prompt.includes('当前会话将中断'));
          return answer;
        }, () => {}, () => { calls++; throw Error('must not execute'); });
      }
      assert.equal(calls, 0);
      assert(isPending(target));
      await assert.rejects(requestRestart(target, async () => 'YES', () => {}, () => 'submitted'), /无法确认新的 ZCode 窗口已启动/);
      assert(isPending(target));
      await requestRestart(target, async () => 'YES', () => {}, exe => {
        calls++; assert.equal(exe, restartExecutable(target)); return 'restarted';
      });
      assert.equal(calls, 1);
      assert(!isPending(target));
      restore(target, applied.backup, true, () => {});
      assert(isPending(target));
      restore(target, applied.backup, true, () => {});
      assert(isPending(target));
      await assert.rejects(requestRestart(target, async () => 'YES', () => {}, () => {
        throw Error('mock ancestor refusal');
      }), /ancestor refusal/);
      assert(isPending(target));
    })().catch(e => { console.error(e); process.exitCode = 1; });`;
  const restartChecks = cp.spawnSync(process.execPath, ['-e', restartScript], {
    encoding: 'utf8', timeout: 10000, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
  });
  ok(restartChecks.status === 0, `mock restart confirmation: ${restartChecks.stderr}`);
  ok(menu.stdout.includes('6. 重启 ZCode') && menu.stdout.includes('请选择 [0-6]'), 'restart menu option');
  const restartCancelled = cli(['--target', restartTarget], '6\nNO\n0\n');
  ok(restartCancelled.status === 0 && restartCancelled.stdout.includes('已取消重启'), 'restart menu cancellation');
  ok(cli(['--restart', '--yes', '--target', restartTarget]).status === 1, 'no noninteractive restart command');
  const clearScreen = '\x1b[2J\x1b[H';
  function retainedResult(result, text) {
    ok(result.status === 0, `TTY exit: ${result.stderr}`);
    const start = result.stdout.indexOf(clearScreen);
    const content = result.stdout.indexOf(text, start);
    const pause = result.stdout.indexOf('按 Enter', content);
    const returned = result.stdout.indexOf(clearScreen, start + clearScreen.length);
    ok(start >= 0 && content > start && pause > content && returned > pause, 'result before pause before return clear');
    ok(result.stdout.indexOf('ZCode 思考等级补丁', returned) > returned, 'return redraws menu');
  }
  retainedResult(ttyMenu('6\nNO\n\n0\n', {}, restartTarget), '已取消重启');
  const tty = ttyMenu('1\n\n0\n');
  retainedResult(tty, 'CHECK OK');
  ok(tty.stdout.includes('\x1b[36m'), 'TTY restrained color');
  retainedResult(ttyMenu('invalid\n\n0\n'), '无效选项');
  retainedResult(ttyMenu('4\n1\nNO\n\n0\n'), '已取消恢复');
  retainedResult(ttyMenu('4\n\n0\n', {}, dry), '没有找到这个 ZCode 的备份文件。');
  const failed = ttyMenu('1\n\n0\n', {}, path.join(root, 'missing.cjs'));
  ok(failed.stderr.includes('错误：') && failed.stdout.includes('按 Enter'), 'TTY errors await acknowledgment');
  const eof = ttyMenu('1\n');
  ok(eof.status === 0 && eof.stdout.split(clearScreen).length === 2, 'EOF at pause exits without erasing result');
  const noColor = ttyMenu('1\n\n0\n', {NO_COLOR: ''});
  retainedResult(noColor, 'CHECK OK');
  ok(!/\x1b\[[0-9;]*m/.test(noColor.stdout), 'NO_COLOR disables styling');
  const dumb = ttyMenu('1\n\n0\n', {TERM: 'dumb'});
  ok(dumb.status === 0 && !dumb.stdout.includes('\x1b'), 'dumb terminal has no escape codes');
  for (const [inputTTY, outputTTY] of [[false, true], [true, false]]) {
    const redirected = ttyMenu('1\n0\n', {}, target, inputTTY, outputTTY);
    ok(redirected.status === 0 && !redirected.stdout.includes('\x1b') && !redirected.stdout.includes('按 Enter'), 'redirected stream has no ANSI or pause');
  }
  const cancel = cli(['--target', target], '4\n1\nNO\n0\n');
  ok(cancel.status === 0 && cancel.stdout.includes('已取消恢复'), 'interactive restore cancellation');
  const noYes = cli(['--target', target, '--restore', first.backup]);
  ok(noYes.status === 1 && noYes.stderr.includes('--yes'), 'CLI restore confirmation');
  ok(cli(['--target', target, '--list-backups']).stdout.includes(first.backup), 'CLI backup list');
  const applyResult = cli(['--target', target, '--apply']);
  ok(applyResult.status === 0, 'CLI apply idempotence');
  ok(!applyResult.stdout.includes('输入 YES') && !applyResult.stdout.includes('启动请求'), 'apply does not request restart');
  const patcherSource = fs.readFileSync(path.join(packageRoot, 'patcher.cjs'), 'utf8');
  ok(!run.toString().includes('Restart') && !restore.toString().includes('Restart'), 'apply and restore never call restart');
  ok(patcherSource.includes("else if (answer === '6') await requestRestart(target, ask)"), 'restart restricted to explicit menu action');
  ok(cli(['--target', target, '--backup']).status === 0, 'CLI backup');
  ok(cli(['--target', target, '--restore', first.backup, '--yes']).status === 0, 'CLI restore fixture');
  if (process.platform === 'win32') {
    const restartTests = cp.spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'restart.test.ps1')],
      {encoding: 'utf8', timeout: 15000, windowsHide: true});
    ok(restartTests.status === 0, `mock PowerShell restart tests: ${restartTests.stderr}`);
    console.log(restartTests.stdout.trim());
    const actual = discover();
    ok(Array.isArray(actual) && actual.every(file => fs.existsSync(file)), 'real read-only discovery');
    console.log(`PASS: read-only discovery found ${actual.length} installation(s).`);
  }
  const baselinePath = process.argv[2] || 'D:/ZCode/resources/glm/zcode.cjs.reasoning-effort.bak';
  const currentPath = process.argv[3] || 'D:/ZCode/resources/glm/zcode.cjs';
  if (fs.existsSync(baselinePath) && fs.existsSync(currentPath)) {
    const baseline = fs.readFileSync(baselinePath), current = fs.readFileSync(currentPath);
    const real = fixture('real baseline copy', baseline);
    ok(run(real, false, quiet).pending === 6, 'real baseline pending');
    ok(fs.readFileSync(real).equals(current), 'baseline transforms exactly to installed runtime');
    ok(!run(real, false, quiet).changed, 'real repeat');
    const installedCopy = fixture('installed runtime copy', current);
    ok(run(installedCopy, true, quiet).pending === 0, 'current fully patched');
    ok(!run(installedCopy, false, quiet).changed, 'current no-op');
    console.log('PASS: baseline copy becomes byte-for-byte identical to installed runtime.');
  } else console.log('SKIP: real bundle fixtures unavailable; pass baseline and patched bundle paths to enable.');
  if (process.platform === 'win32') {
    const good = cmd(`--no-pause --check "${target}"`);
    ok(good.status === 0 && good.stdout.includes('CHECK OK'), `CMD success: ${good.error || good.stderr || good.stdout}`);
    const bad = cmd(`--no-pause --check "${path.join(root, 'missing file.cjs')}"`);
    ok(bad.status === 1, 'CMD must retain failure exit code');
    // Removing Node from PATH exercises the installed Electron fallback.
    if (fs.existsSync('D:/ZCode/ZCode.exe')) {
      const fallback = cmd(`--no-pause --check "${target}"`, {PATH: path.join(process.env.SystemRoot, 'System32')});
      ok(fallback.status === 0 && fallback.stdout.includes('CHECK OK'), `Electron fallback: ${fallback.error || fallback.stderr || fallback.stdout}`);
    }
  }
  console.log(`PASS: ${checks} assertions; no API calls; no installed bundle or config changes.`);
} finally { fs.rmSync(root, {recursive: true, force: true}); }
