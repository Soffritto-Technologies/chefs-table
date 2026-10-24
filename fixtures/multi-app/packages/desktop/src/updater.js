const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function parseVersion(text) {
  return String(text).split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(candidate, current) {
  const next = parseVersion(candidate);
  const now = parseVersion(current);
  for (let i = 0; i < Math.max(next.length, now.length); i++) {
    if ((next[i] ?? 0) !== (now[i] ?? 0)) return (next[i] ?? 0) > (now[i] ?? 0);
  }
  return false;
}

async function latestRelease(fetchJson) {
  const release = await fetchJson('https://updates.example.com/latest.json');
  return { version: release.version, notes: release.notes ?? '' };
}

exports.checkForUpdate = async function checkForUpdate(current, fetchJson) {
  const release = await latestRelease(fetchJson);
  return isNewer(release.version, current) ? release : null;
};

exports.CHECK_EVERY_MS = CHECK_EVERY_MS;
