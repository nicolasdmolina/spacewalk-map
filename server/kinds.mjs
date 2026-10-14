// What a folder or file is, judged from its name and the names above it.
// Spacewalk never reads file contents, so names are all there is to go on;
// a rule only fires when the name is specific enough to be right.
//
// tone: "reclaim" means deleting it is normally safe and the space comes
// back (the map draws these in red); "review" means it is often large and
// worth a look, but only you can decide; "neutral" is for context.
// whole: everything inside belongs to it and is never judged on its own,
// so a disk image inside an app is part of the app.

export const KINDS = {
  node_modules: {
    label: 'node_modules',
    tone: 'reclaim',
    blurb: 'JavaScript packages for one project. Safe to delete; npm, pnpm, yarn or bun install brings them back.',
  },
  build: {
    label: 'Build output',
    tone: 'reclaim',
    blurb: 'Files a build tool generated. Safe to delete; the next build makes them again.',
  },
  venv: {
    label: 'Python environment',
    tone: 'reclaim',
    blurb: "A Python virtual environment. Safe to delete; recreate it from the project's requirements.",
  },
  xcode: {
    label: 'Xcode build data',
    tone: 'reclaim',
    blurb: 'Derived data and device support files. Safe to delete; Xcode rebuilds what it needs.',
  },
  cache: {
    label: 'Cache',
    tone: 'reclaim',
    blurb: 'Data an app can download or rebuild. Usually safe to delete; the app refills it as needed.',
  },
  temp: {
    label: 'Temporary files',
    tone: 'reclaim',
    blurb: 'Scratch files. Safe to delete when no app is using them; macOS clears many on restart.',
  },
  trash: {
    label: 'Trash',
    tone: 'reclaim',
    blurb: 'Items already in the Trash. Empty the Trash to get this space back.',
  },
  logs: {
    label: 'Logs',
    tone: 'reclaim',
    blurb: 'Log files. Safe to delete unless you are tracking down a problem.',
  },
  installer: {
    label: 'Installer',
    tone: 'reclaim',
    blurb: 'An installer or disk image. Usually safe to delete once the app is installed.',
  },
  worktree: {
    label: 'Extra worktree',
    tone: 'review',
    blurb: 'A second checkout of a git repository, often made by a coding agent. Check for unsaved work first.',
  },
  vm: {
    label: 'Virtual machine',
    tone: 'review',
    whole: true,
    blurb: "A virtual machine or container disk. Remove it with its own tool if you no longer use it.",
  },
  simulator: {
    label: 'Simulators',
    tone: 'review',
    whole: true,
    blurb: 'iOS simulators and their data. xcrun simctl delete unavailable removes the ones Xcode no longer uses.',
  },
  model: {
    label: 'AI models',
    tone: 'review',
    whole: true,
    blurb: "Downloaded model files. Delete the ones you don't use; they can be downloaded again.",
  },
  downloads: {
    label: 'Downloads',
    tone: 'review',
    blurb: 'Your Downloads folder. Old installers and archives tend to pile up here.',
  },
  archive: {
    label: 'Archive',
    tone: 'review',
    blurb: "A compressed archive. Delete it if you've already unpacked what you need.",
  },
  backup: {
    label: 'Device backups',
    tone: 'review',
    whole: true,
    blurb: "iPhone and iPad backups. Manage them in Finder from the device's page.",
  },
  photos: {
    label: 'Photos library',
    tone: 'review',
    whole: true,
    blurb: 'A Photos library. Manage it in the Photos app, never in Finder.',
  },
  app: { label: 'App', tone: 'neutral', whole: true, blurb: 'An application.' },
  git: { label: 'Git history', tone: 'neutral', whole: true, blurb: "A repository's history and objects." },
  media: { label: 'Media', tone: 'neutral', blurb: 'A video, audio or image file.' },
  swap: {
    label: 'Swap',
    tone: 'neutral',
    whole: true,
    blurb: 'Memory macOS moved to disk. It shrinks on its own, and a restart clears it.',
  },
};

const BUILD_DIRS = new Set([
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.angular', '.expo', '.docusaurus', '.vercel',
  '.wrangler', '.output', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
  '.gradle', '.dart_tool', '.cxx', '.eggs', 'cmake-build-debug', 'cmake-build-release',
]);
const CACHE_DIRS = new Set([
  '.cache', 'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'DawnCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Cache_Data', 'CacheStorage', 'ScriptCache', '_cacache', '.pnpm-store',
  'node-compile-cache', 'go-build', '.npm', 'component_crx_cache', 'extensions_crx_cache',
]);
const VM_DIRS = new Set(['.colima', '.lima', '.orbstack', 'VirtualBox VMs', 'Parallels', '.vagrant.d']);
const INSTALLER_EXT = new Set(['dmg', 'pkg', 'mpkg', 'ipsw', 'xip']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst']);
const DISK_EXT = new Set(['iso', 'img', 'raw', 'qcow2', 'vmdk', 'vdi', 'sparseimage']);
const MODEL_EXT = new Set(['gguf', 'safetensors', 'ckpt', 'onnx', 'mlmodel']);
const MEDIA_EXT = new Set([
  'mov', 'mp4', 'm4v', 'mkv', 'avi', 'webm', 'wav', 'aif', 'aiff', 'flac', 'mp3', 'm4a', 'heic', 'jpg', 'jpeg',
  'png', 'tif', 'tiff', 'psd', 'dng', 'cr2', 'nef', 'arw',
]);

function ext(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// up: the node's own name, then its parent's, grandparent's and great-
// grandparent's (shorter near the scan root). depth: steps below the scan
// root. sibling(name) and child(name) answer whether the parent, or the
// node itself, holds a folder of that name.
export function classify(isDir, up, depth, sibling, child) {
  const [name, parent = '', gp = '', ggp = ''] = up;
  if (!isDir) {
    const e = ext(name);
    if (INSTALLER_EXT.has(e)) return 'installer';
    if (e === 'log') return 'logs';
    if (ARCHIVE_EXT.has(e)) return 'archive';
    if (DISK_EXT.has(e) || name === 'Docker.raw') return 'vm';
    if (MODEL_EXT.has(e)) return 'model';
    if (MEDIA_EXT.has(e)) return 'media';
    if (/^swapfile\d+$/.test(name) || name === 'sleepimage') return 'swap';
    return null;
  }
  // A project's packages. One under lib is a global install (npm itself
  // lives there), and one inside a package belongs to that package.
  if (name === 'node_modules')
    return parent === 'lib' || gp === 'node_modules' || ggp === 'node_modules' ? null : 'node_modules';
  if (name === '.git') return 'git';
  if (name.endsWith('.app')) return 'app';
  if (name.endsWith('.photoslibrary')) return 'photos';
  if (name === 'worktrees' && (parent === '.claude' || parent === '.codex')) return 'worktree';
  if (/^worktree-[0-9a-f]{6,}$/.test(name)) return 'worktree';
  if (name === 'DerivedData' || name.endsWith(' DeviceSupport')) return parent === 'Xcode' ? 'xcode' : 'build';
  if (name === 'CoreSimulator' && parent === 'Developer') return 'simulator';
  if (BUILD_DIRS.has(name)) return 'build';
  if ((name === 'dist' || name === 'build' || name === 'out') && sibling('node_modules')) return 'build';
  if (name === 'target' && (child('debug') || child('release'))) return 'build';
  if ((name === '.venv' || name === 'venv') && child('lib')) return 'venv';
  if (name === 'huggingface' || (name === 'models' && (parent === '.ollama' || parent === '.lmstudio'))) return 'model';
  if (name.startsWith('models--')) return 'model'; // one model in a Hugging Face style cache
  if (name === 'Caches' && parent === 'Library') return 'cache';
  if (CACHE_DIRS.has(name)) return 'cache';
  if (name === 'cache' && (parent === 'berry' || parent === 'install' || parent === 'uv' || parent === 'pip')) return 'cache';
  if (name === 'mod' && parent === 'pkg' && gp === 'go') return 'cache';
  if (name === 'registry' && parent === '.cargo') return 'cache';
  if (name === 'repository' && parent === '.m2') return 'cache';
  if (name === 'tmp' && parent === 'private' && depth === 2) return 'temp';
  // Per-user temporary and cache folders: /private/var/folders/xx/<id>/T and C.
  if ((name === 'T' || name === 'C') && gp.length === 2 && ggp === 'folders') return name === 'T' ? 'temp' : 'cache';
  if (name === '.Trash' || name === '.Trashes') return 'trash';
  if ((name === 'Logs' && parent === 'Library') || name === 'DiagnosticReports') return 'logs';
  if (VM_DIRS.has(name) || (name === 'avd' && parent === '.android')) return 'vm';
  if (name === 'Backup' && parent === 'MobileSync') return 'backup';
  if (name === 'Downloads' && gp === 'Users') return 'downloads';
  return null;
}
