const { version } = require('./package.json');

module.exports = {
  appId: 'com.qserial.app',
  productName: 'QSerial',
  copyright: `Copyright 婕?${new Date().getFullYear()} QSerial Team`,
  publish: null,

  directories: {
    output: 'release',
    buildResources: 'build',
  },

  files: [
    'packages/main/dist/**/*',
    'packages/renderer/dist/**/*',
    // 内置插件（智能助手、设备特征库等）打进 asar，
    // 插件对 @qserial/shared 的导入经 asar 内 node_modules 解析
    'plugins/**/*',
    'package.json',
    {
      from: 'packages/shared',
      to: 'node_modules/@qserial/shared',
      filter: ['dist/**/*', 'package.json'],
    },
    // 运行时依赖映射（由 scripts/gen-deps-mapping.cjs 自动生成）
    // 重新生成: node scripts/gen-deps-mapping.cjs
    ...require('./electron-builder.config.deps.cjs'),
  ],

  extraResources: [
    {
      from: 'node_modules/ffmpeg-static',
      to: 'ffmpeg-static',
      filter: ['ffmpeg.exe', 'ffmpeg', 'ffmpeg_darwin', 'package.json'],
    },
    {
      from: 'resources',
      to: 'resources',
      filter: ['**/*'],
    },
  ],

  asar: true,
  asarUnpack: [
    'node_modules/node-pty/**/*',
    'node_modules/@serialport/bindings-cpp/**/*',
    'node_modules/ssh2/**/*',
    'node_modules/ffmpeg-static/**/*',
  ],
  npmRebuild: false,

  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
      {
        target: 'portable',
        arch: ['x64'],
      },
    ],
    icon: 'build/icon.ico',
    artifactName: '${productName}-${version}-${arch}-${os}.${ext}',
    signAndEditExecutable: false,
  },

  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['x64', 'arm64'],
      },
    ],
    icon: 'build/icon.icns',
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    artifactName: '${productName}-${version}-${arch}-${os}.${ext}',
  },

  linux: {
    target: ['AppImage', 'deb'],
    icon: 'build/icons',
    category: 'Development',
    maintainer: 'qserial@example.com',
    artifactName: '${productName}-${version}-${arch}-${os}.${ext}',
  },

  nsis: {
    artifactName: '${productName}-${version}-${arch}-${os}.${ext}',
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'QSerial',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },

  portable: {
    artifactName: '${productName}-${version}-${arch}-${os}-portable.${ext}',
  },

  dmg: {
    contents: [
      {
        x: 130,
        y: 220,
      },
      {
        x: 410,
        y: 220,
        type: 'link',
        path: '/Applications',
      },
    ],
  },
};
