// Only LoongArch lacks the native modules shipped by the pinned upstream release.
module.exports.portableBackend = process.platform === 'linux'
  && (process.arch === 'loong64' || process.arch === 'loongarch64');
