// 打包成 dist/ACORN Widget-darwin-<arch>/ACORN Widget.app
//   npm run package           只打包
//   npm run package:install   打包并安装到 /Applications（会先退出正在运行的旧版本）
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const NAME = 'ACORN Widget';

const [outDir] = await packager({
  dir: '.',
  name: NAME,
  platform: 'darwin',
  arch: process.arch,
  icon: 'assets/icon.icns',
  out: 'dist',
  overwrite: true,
  asar: true,
  appBundleId: 'local.acorn-widget',
  appCategoryType: 'public.app-category.education',
  // Only runtime source/assets are packaged; never imports, screenshots, logs or build tools.
  ignore: (file) => file !== '' && !/^\/(src|assets|node_modules)(\/|$)/.test(file) && !/^\/(package\.json|package-lock\.json)$/.test(file),
});
const built = `${outDir}/${NAME}.app`;

// 本机自用的 ad-hoc 签名：Apple Silicon 要求可执行文件有签名，登录项也要求签名完整
execFileSync('codesign', ['--force', '--deep', '--sign', '-', built], { stdio: 'inherit' });
console.log(`built     → ${built}`);

if (process.argv.includes('--install')) {
  const target = `/Applications/${NAME}.app`;
  execFileSync('osascript', ['-e', `if application "${NAME}" is running then tell application "${NAME}" to quit`]);
  rmSync(target, { recursive: true, force: true });
  execFileSync('ditto', [built, target]);
  console.log(`installed → ${target}`);
}
