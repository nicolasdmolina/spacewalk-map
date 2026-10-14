// The startup disk as macOS reports it, and the two ways of writing a path
// on it. diskutil gives the APFS container that holds the startup volume:
// its size, free space and volumes. Firmlinks join the read-only system
// volume to the Data volume, so /Users/alex and
// /System/Volumes/Data/Users/alex are the same folder.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: 16 << 20, timeout: 15000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

async function diskutil(...args) {
  const xml = await run('/usr/sbin/diskutil', [...args, '-plist']);
  return JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], xml));
}

// Volumes that only help the Mac start up or recover. A container holding
// nothing else is part of the Mac itself, not another disk.
const SUPPORT_ROLES = new Set(['Preboot', 'Recovery', 'Update', 'xART', 'Hardware']);

export async function readDisk() {
  const xml = await run('/usr/sbin/diskutil', ['info', '-plist', '/']);
  const ref = (await run('/usr/bin/plutil', ['-extract', 'APFSContainerReference', 'raw', '-o', '-', '-'], xml)).trim();
  const { Containers } = await diskutil('apfs', 'list');
  const boot = Containers.find((c) => c.ContainerReference === ref);
  if (!boot) throw new Error(`diskutil did not list the startup container ${ref}`);
  const volumes = boot.Volumes.map((v) => ({
    dev: v.DeviceIdentifier,
    name: v.Name,
    role: v.Roles?.[0] ?? null,
    used: v.CapacityInUse,
  }));
  const used = volumes.reduce((sum, v) => sum + v.used, 0);
  const others = Containers.filter(
    (c) => c !== boot && c.Volumes.some((v) => !v.Roles?.length || !SUPPORT_ROLES.has(v.Roles[0])),
  ).map((c) => ({
    name: c.Volumes.reduce((a, b) => (b.CapacityInUse > a.CapacityInUse ? b : a)).Name,
    size: c.CapacityCeiling,
    free: c.CapacityFree,
  }));
  return {
    at: Date.now(),
    container: ref,
    name: volumes.find((v) => v.role === 'System')?.name ?? 'Startup disk',
    size: boot.CapacityCeiling,
    free: boot.CapacityFree,
    overhead: Math.max(0, boot.CapacityCeiling - used - boot.CapacityFree),
    volumes,
    others,
  };
}

const DATA = '/System/Volumes/Data';

// Each line of /usr/share/firmlinks is a path on the system volume, a tab,
// and the same folder's path relative to the Data volume.
export function loadFirmlinks(file = '/usr/share/firmlinks') {
  let pairs = [];
  try {
    pairs = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.split('\t'))
      .filter(([sys, rel]) => sys?.startsWith('/') && rel)
      .map(([sys, rel]) => ({ sys, data: `${DATA}/${rel}` }));
  } catch {
    // Without the list every path keeps its Data volume spelling.
  }
  const longest = (key) => [...pairs].sort((a, b) => b[key].length - a[key].length);
  const byData = longest('data');
  const bySys = longest('sys');
  const under = (path, base) => path === base || path.startsWith(base + '/');
  return {
    // /System/Volumes/Data/Users/alex becomes /Users/alex
    display(raw) {
      const p = byData.find((f) => under(raw, f.data));
      return p ? p.sys + raw.slice(p.data.length) : raw;
    },
    // and back
    raw(path) {
      if (under(path, DATA)) return path;
      const p = bySys.find((f) => under(path, f.sys));
      return p ? p.data + path.slice(p.sys.length) : path;
    },
  };
}
