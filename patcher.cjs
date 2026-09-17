'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');

// Deliberately exact signatures: a new minifier/build needs manual review.
const patches = [
  {
    id: 'mN fallback: dual providers and forceReasoning', symbol: 'mN',
    before: 'function mN(e,t,r){if(!e)return;let n=k2e(e,r);if(!n?.enabled||n.levels.length===0)return;let o=t?.trim(),i=CIo(e,o,n.levels);if(o&&!i)return;let s=i??_nt(n);return s?{level:s,providerOptions:n.providerOptionsByLevel?.[s]}:void 0}',
    after: 'function mN(e,t,r){if(!e)return;let n=k2e(e,r);if(!n?.enabled||n.levels.length===0)return;let o=t?.trim(),i=CIo(e,o,n.levels);if(o&&!i)return;let s=i??_nt(n),u=s==="off"?"none":s,l=n.providerOptionsByLevel?.[s]??{openaiCompatible:{reasoningEffort:u},openai:{reasoningEffort:u,forceReasoning:!0}};return s?{level:s,providerOptions:l}:void 0}'
  },
  {
    id: 'h2e: dual providers', symbol: 'h2e',
    before: 'function h2e(e){return Object.fromEntries(e.map(t=>[t,{openaiCompatible:{reasoningEffort:t}}]))}',
    after: 'function h2e(e){return Object.fromEntries(e.map(t=>[t,{openaiCompatible:{reasoningEffort:t},openai:{reasoningEffort:t,forceReasoning:!0}}]))}'
  },
  {
    id: 'GPT levels: low medium high xhigh max',
    before: ',JS=[PSo,k7,MSo,OSo],u2e=[G_,IA],l2e=[a2e,s2e],',
    after: ',JS=["low","medium","high","xhigh","max"],u2e=[G_,IA],l2e=[a2e,s2e],'
  },
  {
    id: 'Chat Completions enum: max',
    before: 'user:g.string().optional(),reasoningEffort:g.enum(["none","minimal","low","medium","high","xhigh"]).optional(),maxCompletionTokens:g.number().optional()',
    after: 'user:g.string().optional(),reasoningEffort:g.enum(["none","minimal","low","medium","high","xhigh","max"]).optional(),maxCompletionTokens:g.number().optional()'
  },
  {
    id: 'LSo DeepSeek: dual providers', symbol: 'LSo',
    before: 'function LSo(){let e=lfr();return Object.fromEntries(l2e.map(t=>[t,{...e[t],openaiCompatible:{thinking:{type:G_},reasoningEffort:t}}]))}',
    after: 'function LSo(){let e=lfr();return Object.fromEntries(l2e.map(t=>[t,{...e[t],openaiCompatible:{thinking:{type:G_},reasoningEffort:t},openai:{reasoningEffort:t,forceReasoning:!0}}]))}'
  },
  {
    id: 'sNi off: OpenAI none', symbol: 'sNi',
    before: 'function sNi(e,t){let n={...e.kind==="anthropic"?fee().providerOptionsByLevel:mee().providerOptionsByLevel,[jdn]:e.kind==="anthropic"?{anthropic:{thinking:{type:IA}}}:{openaiCompatible:{thinking:{type:IA}}}};return JMe(t,n)}',
    after: 'function sNi(e,t){let n={...e.kind==="anthropic"?fee().providerOptionsByLevel:mee().providerOptionsByLevel,[jdn]:e.kind==="anthropic"?{anthropic:{thinking:{type:IA}}}:{openaiCompatible:{thinking:{type:IA}},...e.kind==="openai"?{openai:{reasoningEffort:"none",forceReasoning:!0}}:{}}};return JMe(t,n)}'
  }
];
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const count = (source, needle) => source.split(needle).length - 1;
let storageDir = __dirname, settingsCache, logFile, logDisabled = false;
function setStorage(directory) {
  storageDir = directory; settingsCache = undefined; logFile = undefined; logDisabled = false;
}
function redact(text) {
  return String(text).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL REDACTED]');
}
function audit(text) {
  if (logDisabled) return;
  try {
    if (!logFile) {
      const directory = path.join(storageDir, 'logs');
      fs.mkdirSync(directory, {recursive: true});
      logFile = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}.log`);
      durableWrite(logFile, '', 0o600);
    }
    const fd = fs.openSync(logFile, 'a');
    try { fs.writeSync(fd, `${new Date().toISOString()} ${redact(text)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch {
    logDisabled = true;
    console.error('警告：本包日志目录不可写，本次仅在终端报告；操作不会因日志失败而中断。');
  }
}
function output(text) { console.log(text); audit(text); }
function warning(text) { console.error(text); audit(text); }
function settings() {
  if (settingsCache) return settingsCache;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(storageDir, 'settings.json'), 'utf8'));
    if (!data || data.schema !== 1 || (data.selectedTarget !== null && typeof data.selectedTarget !== 'string') ||
        !data.pendingRestart || typeof data.pendingRestart !== 'object' || Array.isArray(data.pendingRestart) ||
        Object.values(data.pendingRestart).some(value => value !== true)) throw Error('invalid settings');
    settingsCache = {schema: 1, selectedTarget: data.selectedTarget, pendingRestart: {...data.pendingRestart}};
  } catch (error) {
    warning(error.code === 'ENOENT' ? '提示：本包 settings.json 尚未生成，使用默认选择。' : '警告：本包 settings.json 无效或不可读，使用默认选择，仍会检查这项补丁所需的代码。');
    settingsCache = {schema: 1, selectedTarget: null, pendingRestart: {}};
  }
  return settingsCache;
}
function saveSettings() {
  const stage = path.join(storageDir, `.settings-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    durableWrite(stage, JSON.stringify(settings(), null, 2), 0o600);
    fs.renameSync(stage, path.join(storageDir, 'settings.json'));
    return true;
  } catch {
    warning('警告：本包设置无法保存，所选安装位置和待重启记录只能保留到本次工具关闭；请手动重启。');
    return false;
  } finally { try { if (fs.existsSync(stage)) fs.unlinkSync(stage); } catch { /* Best-effort local cleanup. */ } }
}
function targetKey(target) {
  const real = fs.realpathSync(normalizeTarget(target));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}
function remember(target) {
  try {
    const file = normalizeTarget(target);
    if (!fs.statSync(file).isFile()) throw Error('not a file');
    settings().selectedTarget = targetKey(file); saveSettings();
  } catch { warning('警告：所选安装文件不存在或无法使用，未保存这个位置。'); }
}
function preferred(targets) {
  const saved = settings().selectedTarget;
  if (!saved) return null;
  const match = targets.find(target => { try { return targetKey(target) === saved; } catch { return false; } });
  if (!match) warning('警告：没有找到上次选择的 ZCode，请重新选择安装位置。');
  return match || null;
}
function markPending(target, pending) {
  const data = settings(), key = targetKey(target);
  if (pending) data.pendingRestart[key] = true;
  else delete data.pendingRestart[key];
  return saveSettings();
}
function isPending(target) { return settings().pendingRestart[targetKey(target)] === true; }
function reportState(target, log) {
  log(isPending(target) ? '运行状态：文件已修改，待重启 ZCode；正在运行的 ZCode 不一定已读取这些修改。' : '运行状态：没有待重启记录；工具不会判断你是否在其他地方重启过，也不能确认 ZCode 已读取修改。');
  log('ZCode 下次加载这个文件时才会读取修改；补丁装好或重启成功，都不能证明服务端支持所选思考等级。');
}
function operation(name, fn) {
  return function (...args) {
    audit(`BEGIN ${name}`);
    const fail = error => { audit(`ERROR ${name}: ${error.message}`); throw error; };
    const done = result => { audit(`END ${name}`); return result; };
    try {
      const result = fn(...args);
      return result && typeof result.then === 'function' ? result.then(done, fail) : done(result);
    } catch (error) { return fail(error); }
  };
}
function inspect(source) {
  return patches.map(p => {
    const before = count(source, p.before), after = count(source, p.after);
    const symbols = p.symbol ? count(source, `function ${p.symbol}(`) : null;
    return {id: p.id, before, after, symbols, applied: after === 1,
      valid: before + after === 1 && (symbols === null || symbols === 1)};
  });
}
function patchState(bytes) {
  const source = bytes.toString('utf8');
  const states = inspect(source);
  if (!Buffer.from(source).equals(bytes) || states.some(s => !s.valid)) return 'unknown';
  const applied = states.filter(s => s.applied).length;
  return applied === 0 ? 'unpatched' : applied === patches.length ? 'full' : 'partial';
}
function transform(source) {
  const states = inspect(source);
  const failures = states.filter(s => !s.valid);
  if (failures.length) {
    throw new Error(`这项补丁所需的代码缺失或重复 (Unsupported)：\n${failures.map(s => `${s.id}（修改前=${s.before}，修改后=${s.after}，函数数=${s.symbols ?? '不适用'}）`).join('\n')}\n六处代码必须全部检查通过：本次未修改 ZCode 文件，也未创建备份或临时文件。需要为此版本调整补丁，不能拿旧版 ZCode 文件覆盖当前文件。`);
  }
  let candidate = source;
  patches.forEach((p, i) => { if (!states[i].applied) candidate = candidate.replace(p.before, p.after); });
  for (const p of patches) {
    if (count(candidate, p.after) !== 1 || count(candidate, p.before) !== 0) throw new Error(`修改后的代码不符合预期：${p.id}`);
  }
  return {candidate, states, pending: states.filter(s => !s.applied).length};
}
function normalizeTarget(value) {
  const resolved = path.resolve(value);
  return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'resources', 'glm', 'zcode.cjs') : resolved;
}
function discoveryRows(rows) {
  const found = new Map();
  for (const row of rows) {
    if (!row || typeof row.target !== 'string') continue;
    const target = normalizeTarget(row.target);
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) continue;
    const key = fs.realpathSync(target);
    found.set(process.platform === 'win32' ? key.toLowerCase() : key, target);
  }
  return [...found.values()];
}
function discover() {
  if (process.platform !== 'win32') return [];
  const result = cp.spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'discover.ps1')], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  if (result.error || result.status !== 0) throw new Error('自动发现失败，请用 --target 指定完整路径。');
  return discoveryRows(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim() || '[]'));
}
function locate(explicit) {
  if (explicit) return normalizeTarget(explicit);
  const targets = discover();
  const saved = preferred(targets);
  if (saved) return saved;
  if (targets.length !== 1) throw new Error(targets.length ? '发现多个安装，请用 --target 明确选择。' : '未找到安装，请用 --target 指定路径。');
  return targets[0];
}
function syntaxCheck(file) {
  const result = cp.spawnSync(process.execPath, ['--check', file], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: 'ignore', windowsHide: true, timeout: 60000
  });
  if (result.error || result.status !== 0) throw new Error('检查修改后的文件能否正常读取时失败 (syntax check failed)。ZCode 原文件未修改，请使用兼容的 Node.js 或 ZCode 自带的 Electron，或请熟悉代码的人检查版本。');
}
function durableWrite(file, data, mode) {
  const fd = fs.openSync(file, 'wx', mode);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function identity(target) {
  const real = fs.realpathSync(target);
  const manifests = [path.resolve(path.dirname(target), '../app/package.json'), path.join(path.dirname(target), 'package.json')];
  const versions = manifests.filter(file => fs.existsSync(file)).map(file => {
    const bytes = fs.readFileSync(file);
    const data = JSON.parse(bytes.toString('utf8'));
    return {file, version: data.version || null, hash: hash(bytes)};
  });
  return {target: process.platform === 'win32' ? real.toLowerCase() : real, versions};
}
function snapshot(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('所选 ZCode 文件必须是实际文件，不能是指向其他文件的链接。');
  return {bytes: fs.readFileSync(target), identity: identity(target), mode: stat.mode};
}
function assertCurrent(target, snap) {
  if (hash(fs.readFileSync(target)) !== hash(snap.bytes) || JSON.stringify(identity(target)) !== JSON.stringify(snap.identity)) {
    throw new Error('检查期间，ZCode 文件或版本信息被其他程序改动，已停止写入。');
  }
}
function fingerprint(bytes) {
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw new Error('文件无法按 UTF-8 编码完整读取。');
  return hash(transform(source).candidate);
}
function backupSnapshot(target, snap, log = output, reason = 'manual') {
  assertCurrent(target, snap);
  const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
  const backup = `${target}.reasoning-${suffix}.bak`;
  let canonical = null;
  try { canonical = fingerprint(snap.bytes); } catch { /* Unknown builds may be backed up, never restored. */ }
  const metadata = {schema: 1, reason, originalState: patchState(snap.bytes), ...snap.identity, created: new Date().toISOString(), originalHash: hash(snap.bytes), currentHash: hash(snap.bytes), patchedHash: canonical};
  durableWrite(backup, snap.bytes, snap.mode);
  durableWrite(`${backup}.json`, JSON.stringify(metadata, null, 2), snap.mode);
  if (hash(fs.readFileSync(backup)) !== metadata.originalHash) throw new Error('备份校验失败。');
  assertCurrent(target, snap);
  log(`备份位置：${backup}`);
  return backup;
}
function backupOnly(target, log = output) {
  return backupSnapshot(target, snapshot(target), log);
}
function validateBackup(target, backup, snap = snapshot(target)) {
  backup = path.resolve(backup);
  const prefix = `${path.basename(target)}.reasoning-`;
  if (path.dirname(backup) !== path.dirname(path.resolve(target)) || !path.basename(backup).startsWith(prefix) || !backup.endsWith('.bak')) throw new Error('不能使用外部备份：请选择与 ZCode 文件放在同一目录、由本工具命名的备份。');
  for (const file of [backup, `${backup}.json`]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('备份或配套的校验记录不是实际文件，不能恢复。');
  }
  const meta = JSON.parse(fs.readFileSync(`${backup}.json`, 'utf8'));
  const bytes = fs.readFileSync(backup);
  if (meta.schema !== 1 || meta.target !== snap.identity.target || JSON.stringify(meta.versions) !== JSON.stringify(snap.identity.versions)) throw new Error('这份备份不能用于当前版本：备份对应的安装位置或版本不同。');
  if (hash(bytes) !== meta.originalHash || meta.currentHash !== meta.originalHash || !meta.patchedHash || fingerprint(bytes) !== meta.patchedHash || fingerprint(snap.bytes) !== meta.patchedHash) throw new Error('这份备份不能用于当前版本：备份内容或当前代码与校验记录不一致，不能跨版本恢复，也不能覆盖补丁以外的代码改动。');
  return {bytes, meta};
}
function listBackups(target) {
  const snap = snapshot(target);
  return fs.readdirSync(path.dirname(target)).filter(name => name.startsWith(`${path.basename(target)}.reasoning-`) && name.endsWith('.bak'))
    .sort().map(name => {
      const file = path.join(path.dirname(target), name);
      const entry = {file, created: 'unknown', reason: 'unknown', originalState: 'unknown', compatible: false, diagnosis: ''};
      try {
        if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('备份不是普通文件');
        entry.created = fs.statSync(file).mtime.toISOString();
        entry.originalState = patchState(fs.readFileSync(file));
        const validated = validateBackup(target, file, snap);
        entry.created = validated.meta.created || entry.created;
        entry.reason = ['manual', 'preapply', 'prerestore'].includes(validated.meta.reason) ? validated.meta.reason : 'unknown';
        entry.compatible = true;
      } catch (error) { entry.diagnosis = error.message; }
      // Metadata is display-only here; recovery always repeats all guards.
      try {
        const metaFile = `${file}.json`;
        if (fs.lstatSync(metaFile).isSymbolicLink()) throw Error('link');
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (typeof meta.created === 'string' && !Number.isNaN(Date.parse(meta.created))) entry.created = meta.created;
        if (['manual', 'preapply', 'prerestore'].includes(meta.reason)) entry.reason = meta.reason;
      } catch { /* Historical backup metadata may be absent. */ }
      return entry;
    });
}
function describeBackup(entry) {
  return `${entry.file}\n   时间=${entry.created === 'unknown' ? '未知' : entry.created} 备份时机=${({manual: '手动备份', preapply: '打补丁前', prerestore: '恢复前', unknown: '未知'})[entry.reason]} 备份内容=${({unpatched: '未装补丁', partial: '装了部分补丁', full: '已装全部补丁', unknown: '无法判断'})[entry.originalState]} ${entry.compatible ? '可以恢复' : `这份备份不能用于当前版本，原因：${entry.diagnosis}`}`;
}
function restore(target, backup, yes, log = output) {
  if (!yes) throw new Error('恢复需要明确确认：非交互命令必须加 --yes。');
  const snap = snapshot(target);
  log('[1/5] 检查备份是否属于这个 ZCode，版本和完整代码是否对应');
  const selected = validateBackup(target, backup, snap);
  if (selected.bytes.equals(snap.bytes)) { log('恢复无需写入：当前内容与备份相同。'); reportState(target, log); return {changed: false}; }
  const stage = path.join(path.dirname(target), `.zcode-restore-${crypto.randomBytes(12).toString('hex')}.cjs`);
  try {
    log('[2/5] 在同一目录准备恢复文件，检查文件能否正常读取');
    durableWrite(stage, selected.bytes, snap.mode);
    syntaxCheck(stage);
    log('[3/5] 保存恢复前的当前文件');
    const safetyBackup = backupSnapshot(target, snap, log, 'prerestore');
    log('[4/5] 再次检查备份和文件有没有被其他程序改动，通过后整份替换');
    validateBackup(target, backup, snap);
    assertCurrent(target, snap);
    fs.renameSync(stage, target);
    markPending(target, true);
    if (hash(fs.readFileSync(target)) !== selected.meta.originalHash) throw new Error('恢复后校验失败，安全备份已保留。');
    log('[5/5] 已恢复文件，所选备份和恢复前的备份都已保留；需要重启 ZCode 才能读取修改。恢复不等于卸载，备份里有补丁就仍会保留。');
    reportState(target, log);
    return {changed: true, backup: safetyBackup};
  } finally { if (fs.existsSync(stage)) fs.unlinkSync(stage); }
}
function run(target, check, log = output) {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('所选 ZCode 文件必须是实际文件，不能是指向其他文件的链接。');
  const original = fs.readFileSync(target);
  const source = original.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(original)) throw new Error('所选 ZCode 文件无法按 UTF-8 编码完整读取，未进行修改。');
  const beforeHash = hash(original);
  const snap = {bytes: original, identity: identity(target), mode: stat.mode};
  log(`当前选择的 ZCode：${target}`);
  log(`版本：${snap.identity.versions.map(v => v.version || '未知').join(', ') || '未知（没有版本记录）'}；文件校验值 SHA-256=${beforeHash}`);
  log('[安全 1/4] 检查是否为实际文件、能否完整读取，以及六处对应代码是否各出现一次');
  const result = transform(source);
  const labels = ['缺省思考配置与双提供商', '等级映射与双提供商', 'GPT 五档等级', 'Chat Completions 的 max 枚举', 'DeepSeek 双提供商配置', '关闭思考映射为 none'];
  result.states.forEach((s, i) => log(`[补丁 ${i + 1}/6] ${s.applied ? '已安装' : '待安装'}：${labels[i]}`));
  let tempDir, stage, backup;
  try {
    const suffix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
    // Check-only/idempotent runs never create files in the installation directory.
    if (check || !result.pending) {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-reasoning-check-'));
      stage = path.join(tempDir, 'candidate.cjs');
    } else {
      stage = path.join(path.dirname(target), `.zcode-reasoning-${suffix}.candidate.cjs`);
    }
    log('[安全 2/4] 检查修改后的文件能否正常读取，以及原文件有没有被其他程序改动');
    durableWrite(stage, result.candidate, stat.mode);
    syntaxCheck(stage);
    assertCurrent(target, snap);
    if (check || !result.pending) {
      log(check ? `CHECK OK：检查通过，6/6 处对应代码符合要求，${result.pending} 处待安装。不修改 ZCode 文件，也不创建备份。` : '全部已安装：6/6；文件读取检查通过，不重复写入或备份。');
      reportState(target, log);
      return {pending: result.pending, changed: false, beforeHash};
    }
    log('[安全 3/4] 保存原文件备份和配套校验记录，检查备份是否完整');
    backup = backupSnapshot(target, snap, log, 'preapply');
    assertCurrent(target, snap);
    // Same-directory rename is the only installation operation. Never unlink or truncate target.
    fs.renameSync(stage, target);
    markPending(target, true);
    stage = undefined;
    if (hash(fs.readFileSync(target)) !== hash(result.candidate)) throw new Error(`安装后校验失败，备份保留在 ${backup}，需要人工检查。`);
    log(`[安全 4/4] 已整份替换文件，并确认保存的内容正确，安装 ${result.pending} 处，共 6/6 处。`);
    log(`备份位置：${backup}`);
    log('补丁已写入文件，需要手动重启。未停止、重载或重启任何进程。');
    reportState(target, log);
    return {pending: result.pending, changed: true, beforeHash, backup};
  } catch (error) {
    if (backup) log(`备份已保留（不会自动恢复）：${backup}`);
    throw error;
  } finally {
    if (stage && fs.existsSync(stage)) fs.unlinkSync(stage);
    if (tempDir) fs.rmSync(tempDir, {recursive: true, force: true});
  }
}
function restartExecutable(target) {
  const bundle = fs.realpathSync(normalizeTarget(target));
  const root = path.resolve(path.dirname(bundle), '../..');
  if (path.relative(root, bundle).replace(/\\/g, '/').toLowerCase() !== 'resources/glm/zcode.cjs') {
    throw new Error('重启仅支持安装目录内的 resources/glm/zcode.cjs。');
  }
  const executable = path.join(root, 'ZCode.exe');
  if (!fs.statSync(executable).isFile()) throw new Error('所选安装没有有效的 ZCode.exe。');
  return fs.realpathSync(executable);
}
function executeRestart(executable) {
  if (process.platform !== 'win32') throw new Error('重启仅支持 Windows。');
  const result = cp.spawnSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'restart.ps1'),
      '-Executable', executable, '-ToolProcessId', String(process.pid)],
    {encoding: 'utf8', windowsHide: true, timeout: 45000});
  if (result.error || result.status !== 0) {
    throw new Error(`重启未完成；不会强制关闭或重试。请检查保存提示；若工具在 ZCode 内运行，请改用外部 CMD。\n${result.error?.message || result.stderr.trim()}`);
  }
  const outcome = result.stdout.trim();
  if (!['started', 'restarted'].includes(outcome)) throw new Error('无法确认重启结果，未自动重试。');
  return outcome;
}
async function requestRestart(target, ask, log = output, execute = executeRestart) {
  const executable = restartExecutable(target);
  const confirmation = await ask(`将关闭并重新启动所选 ZCode：${executable}\n请先保存所有工作；当前会话将中断。仅正常关闭，超时不强制结束。\n输入 YES 确认（其他输入取消）：`);
  if (confirmation !== 'YES') { log('已取消重启，未关闭或启动任何应用。'); return; }
  log('正在请求正常关闭并等待退出，请处理 ZCode 的保存提示……');
  const outcome = execute(executable);
  if (!['started', 'restarted'].includes(outcome)) throw new Error('无法确认新的 ZCode 窗口已启动，保留待重启记录。');
  const persisted = markPending(target, false);
  log(outcome === 'started' ? '已确认当前选择的 ZCode 启动了新窗口。' : '已确认当前选择的 ZCode 原来的程序已退出，并启动了新窗口。');
  log(persisted ? '已清除待重启记录；窗口启动成功不证明服务端已接受思考等级。' : '本次已清除待重启记录，但保存失败，下次可能仍提示待重启；窗口启动成功不证明服务端已接受思考等级。');
}
async function menu(explicit) {
  const rl = require('node:readline').createInterface({input: process.stdin, crlfDelay: Infinity});
  const lines = rl[Symbol.asyncIterator]();
  const ask = async text => { process.stdout.write(text); const line = await lines.next(); return line.done ? null : line.value.trim(); };
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const terminal = interactive && process.env.TERM !== 'dumb';
  const color = terminal && process.env.NO_COLOR === undefined;
  const accent = text => color ? `\x1b[36m${text}\x1b[0m` : text;
  const clear = () => { if (terminal) process.stdout.write('\x1b[2J\x1b[H'); };
  const choices = [
    ['1', '看看补丁装好了没', '检查六处对应代码和修改后的文件能否正常读取，不修改 ZCode 文件'],
    ['2', '先备份一下', '保存当前 ZCode 文件和校验记录，不打补丁；已有补丁也会一起备份'],
    ['3', '开始打补丁', '检查通过后先备份，再安装六处补丁，不自动重启 ZCode'],
    ['4', '用备份恢复', '恢复到备份时的内容，不等于卸载补丁；输入 YES 确认'],
    ['5', '换一个 ZCode 安装位置', '选择要修改的 ZCode 安装位置，不会更换模型或供应商'],
    ['6', '重启 ZCode', '请先保存工作；确认后关闭并重新启动所选安装的 ZCode'],
    ['0', '退出', '退出补丁工具，不关闭 ZCode']
  ];
  let target = explicit ? normalizeTarget(explicit) : null;
  function heading(title) {
    console.log(`\n${accent(title)}\n当前选择的 ZCode：${target || '未选择'}\n`);
  }
  async function choose(usePreference = false) {
    let found = [];
    try { found = discover(); } catch (error) { warning(error.message); }
    if (usePreference) { const saved = preferred(found); if (saved) return saved; }
    if (found.length === 1) return found[0];
    found.forEach((file, i) => console.log(`${i + 1}. ${file}`));
    const answer = await ask(found.length ? '选择安装编号，或输入完整路径（空行取消）：' : '未找到安装，请输入安装目录或 zcode.cjs 完整路径（空行取消）：');
    if (!answer) return null;
    return found[Number(answer) - 1] || normalizeTarget(answer.replace(/^"|"$/g, ''));
  }
  try {
    if (!target) target = await choose(true);
    if (target) remember(target);
    while (true) {
      heading('ZCode 思考等级补丁');
      for (const [key, title, description] of choices) {
        console.log(`  ${accent(`${key}. ${title}`)}\n     ${description}\n`);
      }
      const answer = await ask('请选择 [0-6]：');
      if (answer === null || answer === '0') return;
      const choice = choices.find(([key]) => key === answer);
      clear();
      heading(choice ? choice[1] : '选择无效');
      try {
        if (!choice) console.log('无效选项。请输入 0 到 6。');
        else if (answer === '5') {
          const selected = await choose();
          if (selected) { target = selected; remember(target); console.log(`已选择 ZCode 安装位置：${target}`); }
          else console.log('已取消更换安装位置，保留当前选择。');
        } else if (!target) console.log('请先选择 ZCode 安装位置：返回菜单后选择 5。');
        else if (answer === '6') await requestRestart(target, ask);
        else if (answer === '1') run(target, true);
        else if (answer === '2') {
          backupOnly(target);
          console.log('备份完成，ZCode 文件未修改；备份保存的是当前内容，不保证是未装补丁的版本。');
        } else if (answer === '3') run(target, false);
        else if (answer === '4') {
          const files = listBackups(target);
          if (!files.length) console.log('没有找到这个 ZCode 的备份文件。');
          else {
            output('恢复会回到所选备份保存时的内容，不等于卸载补丁：备份里有全部或部分补丁，恢复后也会保留。');
            files.forEach((entry, i) => output(`${i + 1}. ${describeBackup(entry)}`));
            const selected = await ask('选择恢复编号（空行取消）：');
            const entry = files[Number(selected) - 1];
            if (!entry) console.log(selected ? '无效备份编号，未执行恢复。' : '已取消恢复。');
            else if (!entry.compatible) output(`这份备份不能用于当前版本，未执行恢复。原因：${entry.diagnosis}`);
            else if (await ask(`将恢复 ${entry.file}\n输入 YES 确认：`) === 'YES') restore(target, entry.file, true);
            else console.log('已取消恢复。');
          }
        }
      } catch (error) { warning(`错误：${error.message}`); }
      if (interactive && await ask('\n按 Enter 返回菜单：') === null) return;
      clear();
    }
  } finally { rl.close(); }
}
async function main(args) {
  let command, target, backup, yes = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--check', '--backup', '--apply', '--restore', '--list-backups'].includes(arg)) {
      if (command) throw new Error('每次只能指定一个操作。');
      command = arg;
      if (arg === '--restore') { backup = args[++i]; if (!backup || backup.startsWith('--')) throw new Error('--restore 需要备份路径。'); }
    } else if (arg === '--target') {
      if (target) throw new Error('安装位置重复指定，请只提供一个。');
      target = args[++i]; if (!target || target.startsWith('--')) throw new Error('--target 需要路径。');
    } else if (arg === '--yes') yes = true;
    else if (arg === '--no-pause') continue;
    else if (arg === '--help') {
      console.log('用法：run-patch.cmd [--check | --backup | --apply | --list-backups | --restore 备份 --yes] [--target 安装目录或文件] [--no-pause]\n不指定操作时显示中文菜单；旧式位置参数路径仍然有效。'); return;
    } else if (arg.startsWith('--') || target) throw new Error(`未知或重复参数：${arg}`);
    else target = arg;
  }
  if (!command) return menu(target);
  target = locate(target);
  remember(target);
  if (command === '--check' || command === '--apply') return run(target, command === '--check');
  if (command === '--backup') return backupOnly(target);
  if (command === '--restore') return restore(target, backup, yes);
  const files = listBackups(target);
  output(files.length ? files.map(describeBackup).join('\n') : '没有找到这个 ZCode 的备份文件。');
}
// Wrap public operations without capturing arbitrary console output or process data.
const rawRun = run;
run = operation('check/apply', function (target, check, log = output) {
  audit(check ? 'ACTION check' : 'ACTION apply');
  return rawRun(target, check, text => { if (log !== output) audit(text); log(text); });
});
const rawRestore = restore;
restore = operation('restore', function (target, backup, yes, log = output) {
  return rawRestore(target, backup, yes, text => { if (log !== output) audit(text); log(text); });
});
const rawBackup = backupOnly;
backupOnly = operation('backup', function (target, log = output) {
  return rawBackup(target, text => { if (log !== output) audit(text); log(text); });
});
requestRestart = operation('restart', requestRestart);
listBackups = operation('list-backups', listBackups);
main = operation('session', main);
module.exports = {setStorage, settings, remember, preferred, isPending, audit, redact, patchState, restartExecutable, requestRestart, patches, transform, run, hash, main, discover, discoveryRows, backupOnly, restore, listBackups};
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => { warning(`错误：${error.message}`); process.exitCode = 1; });
}
