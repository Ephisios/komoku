'use strict';

/**
 * Remplit la base avec des postes fictifs et 24 h d'historique, pour voir le
 * tableau de bord avant d'avoir installé le moindre agent.
 *
 *   node scripts/seed.js
 *   DB_PATH=data/demo.db node scripts/seed.js
 *
 * L'écriture se fait directement en base, et non via POST /api/ingest : le
 * serveur horodate à la réception, ce qui tasserait tout l'historique sur
 * l'instant présent et laisserait les courbes plates.
 *
 * Les identifiants fictifs commencent tous par « dead » : `--clean` ne retire
 * que ceux-là, et jamais un vrai poste.
 */

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'komoku.db');
const CLEAN_ONLY = process.argv.includes('--clean');
const GO = 1024 ** 3;
const MO = 1024 ** 2;

const POSTES = [
  {
    id: 'dead000000000001', hostname: 'PC-ACCUEIL', label: 'Poste accueil',
    user: 'SONES\\laura', model: 'Latitude 3540', cpuName: 'Intel Core i5-1335U',
    ram: 8 * GO, ramUsed: 0.71, diskTotal: 256 * GO, diskUsed: 0.62,
    cpu: 24, gpu: 9, vpn: 'WireGuard', laptop: true, battery: 88, ac: true,
    uptimeDays: 3,
  },
  {
    id: 'dead000000000002', hostname: 'PC-COMPTA', label: 'Compta — Marie',
    user: 'SONES\\marie', model: 'OptiPlex 7010', cpuName: 'Intel Core i7-13700',
    ram: 16 * GO, ramUsed: 0.93, diskTotal: 512 * GO, diskUsed: 0.91,
    cpu: 87, gpu: 14, vpn: 'WireGuard', laptop: false,
    uptimeDays: 41, reboot: true,
  },
  {
    id: 'dead000000000003', hostname: 'PC-ATELIER', label: 'Atelier',
    user: 'SONES\\atelier', model: 'ThinkCentre M70q', cpuName: 'Intel Core i3-12100T',
    ram: 8 * GO, ramUsed: 0.46, diskTotal: 256 * GO, diskUsed: 0.971,
    cpu: 11, gpu: 3, vpn: null, laptop: false, firewallOff: true,
    uptimeDays: 9,
  },
  {
    id: 'dead000000000004', hostname: 'PC-COMMERCE', label: 'Commercial — Yanis',
    user: 'SONES\\yanis', model: 'EliteBook 840 G10', cpuName: 'Intel Core Ultra 7 155H',
    ram: 32 * GO, ramUsed: 0.52, diskTotal: 1024 * GO, diskUsed: 0.34,
    cpu: 38, gpu: 61, vpn: 'NordVPN', laptop: true, battery: 17, ac: false,
    uptimeDays: 1,
  },
  {
    id: 'dead000000000005', hostname: 'PC-DIRECTION', label: 'Direction',
    user: 'SONES\\matheo', model: 'Latitude 5550', cpuName: 'Intel Core Ultra 5 125U',
    ram: 16 * GO, ramUsed: 0.63, diskTotal: 512 * GO, diskUsed: 0.22,
    cpu: 15, gpu: 7, vpn: 'WireGuard', laptop: true, battery: 100, ac: true,
    avOff: true, uptimeDays: 6,
  },
  {
    id: 'dead000000000006', hostname: 'PC-STOCK', label: 'Magasin / stock',
    user: 'SONES\\stock', model: 'Latitude 3420', cpuName: 'Intel Core i5-1135G7',
    ram: 8 * GO, ramUsed: 0.4, diskTotal: 256 * GO, diskUsed: 0.55,
    cpu: 9, gpu: 2, vpn: 'WireGuard', laptop: true, battery: 54, ac: true,
    silentHours: 9, uptimeDays: 2,
  },
];

function jitter(base, amp, min = 0, max = 100) {
  return Math.round(Math.max(min, Math.min(max, base + (Math.random() - 0.5) * amp)) * 10) / 10;
}

function buildPayload(p, at, metrics = {}) {
  const ramPct = metrics.ram ?? jitter(p.ramUsed * 100, 8);
  const used = Math.round(p.ram * (ramPct / 100));
  const diskUsed = Math.round(p.diskTotal * p.diskUsed);
  const index = POSTES.indexOf(p);

  return {
    machineId: p.id,
    hostname: p.hostname,
    label: p.label,
    agentVersion: '1.1.0',
    collectedAt: new Date(at).toISOString(),
    system: {
      manufacturer: 'Dell Inc.', model: p.model, domain: 'sones.int',
      osName: 'Microsoft Windows 11 Professionnel', osVersion: '10.0.26200',
      osBuild: '26200', osArch: '64 bits', osDisplayVersion: '25H2',
      serial: `SN${p.id.slice(-6).toUpperCase()}`, isLaptop: Boolean(p.laptop),
      loggedUser: p.user,
      lastBoot: new Date(at - p.uptimeDays * 86400000).toISOString(),
      uptimeSeconds: Math.round(p.uptimeDays * 86400),
    },
    cpu: {
      name: p.cpuName, cores: 8, threads: 12, maxClockMhz: 2600,
      loadPercent: metrics.cpu ?? jitter(p.cpu, 20),
    },
    memory: {
      totalBytes: p.ram, freeBytes: p.ram - used, usedBytes: used,
      usedPercent: ramPct, swapUsedPercent: jitter(ramPct + 6, 10),
    },
    gpu: {
      adapters: [{
        name: 'Intel(R) Graphics', driverVersion: '32.0.101.8724',
        vramBytes: 2 * GO, resolution: '1920x1080',
      }],
      loadPercent: metrics.gpu ?? jitter(p.gpu, 24),
      vramUsedBytes: null,
    },
    disk: {
      volumes: [{
        drive: 'C:', label: '', fileSystem: 'NTFS',
        totalBytes: p.diskTotal, freeBytes: p.diskTotal - diskUsed,
        usedBytes: diskUsed, usedPercent: Math.round(p.diskUsed * 1000) / 10,
      }],
      physical: [{
        name: 'SK hynix BC911 512GB', mediaType: 'SSD',
        healthStatus: p.diskSick ? 'Warning' : 'Healthy', sizeBytes: p.diskTotal,
      }],
    },
    network: {
      interfaces: [{
        alias: 'Ethernet', description: 'Intel(R) Ethernet Connection I219-LM',
        ipv4: [`192.168.0.${10 + index}`], gateway: ['192.168.0.254'],
        dns: ['192.168.0.1', '8.8.8.8'], dhcp: true,
        mac: `54:BF:64:00:00:0${index + 1}`, linkSpeed: '1 Gbps', status: 'Up',
      }],
      publicIp: '185.86.91.154',
      wifiSsid: p.laptop ? 'SONES-WIFI' : null,
      gateway: '192.168.0.254',
    },
    vpn: p.vpn
      ? {
          connected: true, name: p.vpn, kind: 'adapter',
          details: [{ source: 'adapter', name: p.vpn, status: 'Up', ip: '10.5.0.2' }],
        }
      : { connected: false, name: null, kind: null, details: [] },
    battery: p.laptop
      ? { percent: p.battery ?? 90, onAc: p.ac !== false, statusRaw: p.ac === false ? 1 : 2 }
      : null,
    rebootPending: Boolean(p.reboot),
    security: {
      antivirus: [{
        name: 'Windows Defender', realTime: !p.avOff, upToDate: !p.avStale, stateRaw: 266240,
      }],
      defender: {
        antivirusEnabled: !p.avOff, realTimeProtection: !p.avOff,
        signatureAgeDays: p.avStale ? 12 : 1, lastQuickScanAgeDays: 2, tamperProtection: true,
      },
      firewall: [
        { name: 'Domain', enabled: true },
        { name: 'Private', enabled: !p.firewallOff },
        { name: 'Public', enabled: true },
      ],
      bitlocker: [{ mount: 'C:', protection: 'On', percent: 100 }],
      lastUpdate: { id: 'KB5129195', date: '2026-09-20T22:00:00.000Z' },
      vpnProfiles: [],
    },
    topProcesses: [
      { name: 'chrome', ramBytes: 740 * MO, cpuTime: 1420.5 },
      { name: 'OUTLOOK', ramBytes: 410 * MO, cpuTime: 302.1 },
      { name: 'Teams', ramBytes: 388 * MO, cpuTime: 517.8 },
      { name: 'explorer', ramBytes: 142 * MO, cpuTime: 88.4 },
    ],
    collectMs: 4200,
  };
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY, hostname TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS samples (
    machine_id TEXT NOT NULL, ts INTEGER NOT NULL,
    cpu REAL, ram REAL, gpu REAL, disk REAL, vpn INTEGER);
  CREATE INDEX IF NOT EXISTS idx_samples_machine_ts ON samples (machine_id, ts);
`);

const ids = POSTES.map((p) => p.id);
const holes = ids.map(() => '?').join(',');
db.prepare(`DELETE FROM samples WHERE machine_id IN (${holes})`).run(...ids);
db.prepare(`DELETE FROM machines WHERE id IN (${holes})`).run(...ids);

if (CLEAN_ONLY) {
  console.log(`${POSTES.length} postes fictifs retirés de ${DB_PATH}.`);
  db.close();
  process.exit(0);
}

const insertMachine = db.prepare(`
  INSERT INTO machines (id, hostname, label, first_seen, last_seen, payload)
  VALUES (?, ?, ?, ?, ?, ?)`);
const insertSample = db.prepare(`
  INSERT INTO samples (machine_id, ts, cpu, ram, gpu, disk, vpn) VALUES (?, ?, ?, ?, ?, ?, ?)`);

const STEP_MIN = 6;
const now = Date.now();

// Une seule transaction : 14 000 insertions une par une prendraient des minutes.
db.exec('BEGIN');
try {
  for (const p of POSTES) {
    // Un poste « muet » arrête de remonter il y a quelques heures : il doit
    // apparaître hors ligne, avec un historique qui s'interrompt.
    const stopAt = now - (p.silentHours || 0) * 3600000;
    let last = null;
    let lastTs = null;

    for (let t = now - 24 * 3600000; t <= stopAt; t += STEP_MIN * 60000) {
      const hour = new Date(t).getHours();
      const workday = hour >= 8 && hour <= 19 ? 1 : 0.22;
      const payload = buildPayload(p, t, {
        cpu: jitter(p.cpu * workday, 22),
        ram: jitter(p.ramUsed * 100 * (0.72 + 0.28 * workday), 7),
        gpu: jitter(p.gpu * workday, 18),
      });
      insertSample.run(
        p.id, t,
        payload.cpu.loadPercent, payload.memory.usedPercent, payload.gpu.loadPercent,
        payload.disk.volumes[0].usedPercent, payload.vpn.connected ? 1 : 0
      );
      last = payload;
      lastTs = t;
    }

    insertMachine.run(
      p.id, p.hostname, p.label, now - 24 * 3600000, lastTs, JSON.stringify(last)
    );
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

db.close();

console.log(`${POSTES.length} postes fictifs écrits dans ${DB_PATH}, avec 24 h d'historique.`);
console.log('Démarre le serveur puis ouvre le tableau de bord.');
console.log('Pour les retirer : node scripts/seed.js --clean');
