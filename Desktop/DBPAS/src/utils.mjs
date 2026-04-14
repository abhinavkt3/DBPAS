import crypto from "node:crypto";

export const GPS_RADIUS_THRESHOLD_METERS = 500;
export const DEFAULT_MAX_VELOCITY_MPS = 16.67;
export const ADMIN_ROLE = "admin";
export const STAKEHOLDER_ROLES = [
  "manufacturer",
  "distributor",
  "retailer",
  "consumer"
];

export const ROLE_CONFIG = {
  admin: {
    label: "Admin",
    org: "GovernanceOrg",
    mspId: "GovernanceMSP",
    stage: "SYSTEM"
  },
  manufacturer: {
    label: "Manufacturer",
    org: "ManufacturerOrg",
    mspId: "ManufacturerOrgMSP",
    stage: "REGISTERED"
  },
  distributor: {
    label: "Distributor",
    org: "DistributorOrg",
    mspId: "DistributorOrgMSP",
    stage: "IN_TRANSIT"
  },
  retailer: {
    label: "Retailer",
    org: "RetailerOrg",
    mspId: "RetailerOrgMSP",
    stage: "RETAIL_READY"
  },
  consumer: {
    label: "Owner",
    org: "ConsumerOrg",
    mspId: "ConsumerOrgMSP",
    stage: "OWNED"
  }
};

export function nowIso() {
  return new Date().toISOString();
}

export function hashString(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function randomHex(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomId(prefix) {
  return `${prefix}-${crypto.randomUUID().split("-")[0]}`;
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function normalizeUsername(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "");

  if (!normalized) {
    throw new Error("Username is required.");
  }

  if (normalized.length < 3) {
    throw new Error("Username must be at least 3 characters long.");
  }

  return normalized;
}

export function normalizePassword(value) {
  const normalized = String(value ?? "");
  if (normalized.length < 6) {
    throw new Error("Password must be at least 6 characters long.");
  }
  return normalized;
}

export function createPasswordHash(password, salt = randomHex(16)) {
  const normalized = normalizePassword(password);
  const hash = crypto.scryptSync(normalized, salt, 64).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const normalized = String(password ?? "");
  const hash = crypto.scryptSync(normalized, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

export function normalizeGps(gps) {
  if (!gps || gps.lat === undefined || gps.lon === undefined) {
    throw new Error("GPS coordinates must include lat and lon.");
  }

  const lat = Number(gps.lat);
  const lon = Number(gps.lon);

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error("GPS coordinates must be valid numbers.");
  }

  return {
    lat: Number(lat.toFixed(6)),
    lon: Number(lon.toFixed(6))
  };
}

export function gpsKey(gps) {
  const normalized = normalizeGps(gps);
  return `${normalized.lat.toFixed(6)},${normalized.lon.toFixed(6)}`;
}

export function maxVelocityMetersPerSecond(category) {
  const normalized = String(category ?? "")
    .trim()
    .toLowerCase();

  if (normalized.includes("pharma")) {
    return 13.89;
  }

  if (normalized.includes("food")) {
    return 11.11;
  }

  if (normalized.includes("luxury")) {
    return 22.22;
  }

  if (normalized.includes("electronics")) {
    return 19.44;
  }

  return DEFAULT_MAX_VELOCITY_MPS;
}

export function computeMinTransitSeconds({ gpsCurrent, gpsDestination, category }) {
  const meters = distanceMeters(gpsCurrent, gpsDestination);
  const velocity = maxVelocityMetersPerSecond(category);
  if (!Number.isFinite(meters) || !Number.isFinite(velocity) || velocity <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(meters / velocity));
}

export function computeNonce({
  pid,
  gpsCurrent,
  gpsDestination,
  previousNonce = "",
  timestamp,
  minTransitSeconds = 0,
  secret
}) {
  const message = [
    String(pid),
    gpsKey(gpsCurrent),
    gpsKey(gpsDestination),
    String(previousNonce),
    String(timestamp),
    String(Math.max(0, Number(minTransitSeconds) || 0))
  ].join("|");

  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function distanceMeters(a, b) {
  const start = normalizeGps(a);
  const end = normalizeGps(b);
  const toRadians = (degrees) => (degrees * Math.PI) / 180;

  const earthRadiusMeters = 6371000;
  const dLat = toRadians(end.lat - start.lat);
  const dLon = toRadians(end.lon - start.lon);
  const lat1 = toRadians(start.lat);
  const lat2 = toRadians(end.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);

  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function formatGps(gps) {
  const normalized = normalizeGps(gps);
  return `${normalized.lat.toFixed(6)}, ${normalized.lon.toFixed(6)}`;
}

export function buildWalletIdentity(account) {
  return `x509::/CN=${account.id}/O=${account.org}::${account.mspId}`;
}

export function roleLabel(role) {
  return ROLE_CONFIG[role]?.label ?? role;
}

export function ordinalLabel(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return "";
  }

  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${number}th`;
  }

  switch (number % 10) {
    case 1:
      return `${number}st`;
    case 2:
      return `${number}nd`;
    case 3:
      return `${number}rd`;
    default:
      return `${number}th`;
  }
}

export function accountRoleLabel(account) {
  if (account?.role === "consumer" && Number.isInteger(account?.postSaleOrdinal)) {
    return `${ordinalLabel(account.postSaleOrdinal)} Owner`;
  }

  return roleLabel(account?.role);
}

export function stageForRole(role) {
  return ROLE_CONFIG[role]?.stage ?? "REGISTERED";
}

export function publicNonce(nonce) {
  if (!nonce) {
    return "";
  }

  return `${nonce.slice(0, 12)}...${nonce.slice(-8)}`;
}

export function publicToken(token) {
  if (!token) {
    return "";
  }

  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function clone(value) {
  return structuredClone(value);
}
