#!/usr/bin/env node
/**
 * qB WebUI 入口固化脚本
 *
 * 作用：在 qBittorrent 工具栏「配置」按钮右侧注入一枚「搜索服务 Discover」入口，
 *       点击后新标签页打开本项目的 /discover 页面。
 *
 * 原理：qB 内置 WebUI 被打包进二进制（Qt QRC，磁盘上无 html/js 可改），
 *       因此改用官方「替代 WebUI」(Alternative WebUI) 机制：
 *         1) 拉取与当前 qB 同版本的官方 WebUI 源码（src/webui/www 下的 private/ public/）
 *         2) 镜像到本地目录（默认 ~/Library/Application Support/qBittorrent/webui-custom）
 *         3) 在 private/index.html 的 preferencesButton 之后注入入口按钮
 *         4) 通过 API 写入 alternative_webui_enabled / alternative_webui_path（改设置即生效，无需重启 qB）
 *         5) 校验：全量路径可服务 + 入口按钮生效，任一步失败自动回退到内置 WebUI
 *
 * 用法：
 *   node ops/qb-webui-entry.mjs                 # 构建/更新镜像并启用（幂等）
 *   node ops/qb-webui-entry.mjs --refresh       # 强制重新下载官方 WebUI 源码
 *   node ops/qb-webui-entry.mjs --no-enable     # 只生成镜像，不改 qB 设置
 *   node ops/qb-webui-entry.mjs --disable       # 还原为内置 WebUI
 *   node ops/qb-webui-entry.mjs --dry-run       # 只打印将要执行的动作
 *
 * 可选参数：
 *   --qb-version <v>      指定 qB 版本（默认从 qB API 读取）
 *   --dest <dir>          镜像目标目录
 *   --discover-url <url>  入口链接（默认 http://127.0.0.1:<PORT>/discover）
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { config } from '../src/config.js';

const REPO = 'qbittorrent/qBittorrent';
const DEFAULT_DEST = join(homedir(), 'Library/Application Support/qBittorrent/webui-custom');
const BUTTON_ID = 'ptDiscoverButton';
const ANCHOR_ID = 'preferencesButton';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const opts = { enable: true, refresh: false, disable: false, dryRun: false, verify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--qb-version') opts.qbVersion = argv[++i];
    else if (a === '--dest') opts.dest = argv[++i];
    else if (a === '--discover-url') opts.discoverUrl = argv[++i];
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--no-enable') opts.enable = false;
    else if (a === '--disable') { opts.disable = true; opts.enable = false; }
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-verify') opts.verify = false;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`未知参数：${a}`); printHelp(); process.exit(2); }
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node ops/qb-webui-entry.mjs [选项]
  --refresh              强制重新下载官方 WebUI 源码
  --no-enable            只生成镜像，不修改 qB 设置
  --disable              还原为 qB 内置 WebUI
  --dry-run              只打印动作，不写盘
  --no-verify            跳过启用后的校验
  --qb-version <v>       指定 qB 版本（默认从 API 读取）
  --dest <dir>           镜像目标目录（默认 ${DEFAULT_DEST}）
  --discover-url <url>   入口链接（默认 http://127.0.0.1:<PORT>/discover）`);
}

// ---------- qB 客户端（最小实现，独立于 src/services/qbittorrent.js） ----------
const { baseUrl } = config.qb;

async function qbLogin() {
  const res = await fetch(`${baseUrl}/api/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: baseUrl,
      Origin: baseUrl,
    },
    body: new URLSearchParams({ username: config.qb.username, password: config.qb.password }),
  });
  const cookie = (res.headers.get('set-cookie') || '').match(/^([^=]+)=([^;]+)/);
  if (!res.ok || !cookie) throw new Error(`qB 登录失败：${res.status}`);
  return `${cookie[1]}=${cookie[2]}`;
}

async function qbGetVersion(cookie) {
  const res = await fetch(`${baseUrl}/api/v2/app/version`, { headers: cookie ? { Cookie: cookie } : {} });
  if (!res.ok) throw new Error(`读取 qB 版本失败：${res.status}`);
  return (await res.text()).trim().replace(/^v/i, '');
}

async function qbSetAltUi(cookie, enabled, path) {
  const res = await fetch(`${baseUrl}/api/v2/app/setPreferences`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      json: JSON.stringify({
        alternative_webui_enabled: enabled,
        alternative_webui_path: enabled ? path : '',
      }),
    }),
  });
  if (!res.ok) throw new Error(`写入 qB 设置失败：${res.status}`);
}

// ---------- 下载并镜像官方 WebUI ----------
function downloadWebuiSource(version, stage) {
  const tag = `release-${version}`;
  const url = `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}`;
  const tarball = join(tmpdir(), `qb-webui-${version}-${Date.now()}.tar.gz`);
  console.log(`下载官方 WebUI 源码：${url}`);
  const res = spawnSync('curl', ['-fsSL', '-o', tarball, url], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error('下载失败，请确认版本号正确且网络可达 GitHub');

  // 成员路径：<tag>/src/webui/www/{private,public}；strip 4 层得到 private/ public/
  const member = `${REPO.split('/')[1]}-${tag}/src/webui/www`;
  console.log(`解包 ${member}`);
  const tar = spawnSync('tar', ['-xzf', tarball, '--strip-components=4', '-C', stage, member], {
    stdio: 'inherit',
  });
  rmSync(tarball, { force: true });
  if (tar.status !== 0 || !existsSync(join(stage, 'private/index.html'))) {
    throw new Error(`解包失败或版本 ${version} 的 WebUI 目录结构不符预期`);
  }
}

function mirrorTo(stage, dest, dryRun) {
  if (dryRun) return;
  for (const sub of ['private', 'public']) {
    const target = join(dest, sub);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(join(stage, sub), target, { recursive: true });
  }
}

// ---------- 注入入口按钮 ----------
function injectButton(indexPath, discoverUrl) {
  const html = readFileSync(indexPath, 'utf8');
  const button =
    `<a id="${BUTTON_ID}" class="divider" title="搜索服务 Discover" target="_blank" rel="noopener" ` +
    `href="${discoverUrl}"><img class="mochaToolButton" title="搜索服务 Discover" ` +
    `src="images/edit-find.svg" alt="搜索服务 Discover" width="24" height="24"></a>`;

  const lines = html.split('\n');
  const existing = lines.findIndex((l) => l.includes(`id="${BUTTON_ID}"`));
  if (existing !== -1) {
    if (lines[existing].trim() === button) return 'unchanged';
    const indent = lines[existing].match(/^\s*/)[0];
    lines[existing] = indent + button;
    writeFileSync(indexPath, lines.join('\n'));
    return 'updated';
  }

  const anchor = lines.findIndex((l) => l.includes(`id="${ANCHOR_ID}"`));
  if (anchor === -1) throw new Error(`未找到 ${ANCHOR_ID}，官方 index.html 结构可能已变更`);
  const indent = lines[anchor].match(/^\s*/)[0];
  lines.splice(anchor + 1, 0, indent + button);
  writeFileSync(indexPath, lines.join('\n'));
  return 'injected';
}

// ---------- 校验 ----------
function collectFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

async function verify(dest, cookie) {
  const files = collectFiles(dest).map((f) => relative(dest, f));
  // URL 路径 = 去掉 private/ | public/ 前缀（qB 会先试 private 再试 public）
  const urls = ['/', ...new Set(files.map((f) => `/${f.replace(/^(private|public)\//, '')}`))];

  let failed = 0;
  for (const u of urls) {
    const res = await fetch(`${baseUrl}${u}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    if (res.status !== 200) {
      failed += 1;
      console.error(`  ✗ ${u} -> ${res.status}`);
    }
  }

  const home = await (await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } })).text();
  const hasButton = home.includes(`id="${BUTTON_ID}"`);

  const closure = staticClosure(dest, files);

  console.log(`  路径探测：${urls.length} 条，失败 ${failed} 条`);
  console.log(`  入口按钮：${hasButton ? '已生效' : '未生效'}`);
  console.log(`  静态引用闭包：${closure.missing.length === 0 ? '完整' : `缺失 ${closure.missing.length} 项`}`);
  if (closure.missing.length) for (const m of closure.missing.slice(0, 10)) console.error(`  ✗ ${m}`);

  return failed === 0 && hasButton && closure.missing.length === 0;
}

function staticClosure(dest, files) {
  const pool = new Set(files);
  const re = /["'`]((?:scripts|css|images|views)\/[A-Za-z0-9_\-./]+\.(?:js|css|svg|png|html))["'`]/g;
  const missing = new Set();
  for (const f of files.filter((p) => /\.(js|css|html)$/.test(p))) {
    const src = readFileSync(join(dest, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const ref = m[1];
      const inPrivate = pool.has(`private/${ref}`);
      const inPublic = pool.has(`public/${ref}`);
      if (!inPrivate && !inPublic) missing.add(ref);
    }
  }
  return { missing: [...missing] };
}

// ---------- 主流程 ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dest = opts.dest || DEFAULT_DEST;
  const discoverUrl =
    opts.discoverUrl || `http://127.0.0.1:${config.server.port || 3000}/discover`;

  const cookie = await qbLogin();

  if (opts.disable) {
    console.log('还原为内置 WebUI …');
    if (!opts.dryRun) await qbSetAltUi(cookie, false);
    console.log('完成。');
    return;
  }

  const version = opts.qbVersion || (await qbGetVersion(cookie));
  console.log(`qB 版本：${version}`);
  console.log(`镜像目录：${dest}`);
  console.log(`入口链接：${discoverUrl}`);

  const indexPath = join(dest, 'private/index.html');
  const needDownload = opts.refresh || !existsSync(indexPath);

  if (needDownload) {
    const stage = mkdtempSync(join(tmpdir(), 'qb-webui-'));
    try {
      if (opts.dryRun) console.log('[dry-run] 将下载并解包官方 WebUI 源码');
      else downloadWebuiSource(version, stage);
      mirrorTo(stage, dest, opts.dryRun);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  } else {
    console.log('镜像已存在，跳过下载（--refresh 可强制重建）');
  }

  if (!opts.dryRun) {
    const action = injectButton(indexPath, discoverUrl);
    console.log(`入口按钮：${action}`);
  }

  if (opts.enable) {
    if (opts.dryRun) console.log('[dry-run] 将启用替代 WebUI');
    else {
      await qbSetAltUi(cookie, true, dest);
      console.log('已启用替代 WebUI');
    }
  }

  if (opts.enable && opts.verify && !opts.dryRun) {
    console.log('校验中 …');
    const ok = await verify(dest, cookie);
    if (!ok) {
      console.error('校验未通过，自动回退到内置 WebUI');
      await qbSetAltUi(cookie, false);
      process.exit(1);
    }
    console.log('校验通过。');
  }

  console.log('\n完成。回退方法：qB 设置 → Web UI → 取消勾选「使用替代 WebUI」。');
}

main().catch(async (err) => {
  console.error(String(err?.stack || err));
  process.exit(1);
});
