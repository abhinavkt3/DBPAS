import fs from "node:fs";
import path from "node:path";

import { buildQrSvgDataUrl } from "./qr-code.mjs";
import {
  ADMIN_ROLE,
  GPS_RADIUS_THRESHOLD_METERS,
  ROLE_CONFIG,
  STAKEHOLDER_ROLES,
  accountRoleLabel,
  buildWalletIdentity,
  clone,
  computeMinTransitSeconds,
  computeNonce,
  createPasswordHash,
  distanceMeters,
  formatGps,
  gpsKey,
  hashString,
  normalizeGps,
  normalizePassword,
  normalizeUsername,
  ordinalLabel,
  nowIso,
  publicNonce,
  publicToken,
  randomHex,
  randomId,
  roleLabel,
  slugify,
  stageForRole,
  verifyPassword
} from "./utils.mjs";

const STORE_VERSION = 3;
const BOOTSTRAP_ADMIN = {
  username: "admin",
  password: "admin123",
  displayName: "DBPAS System Admin",
  email: "admin@dbpas.local"
};

const NONCE_EVENT_TYPES = new Set([
  "REGISTER_PRODUCT",
  "HANDOFF_PRODUCT",
  "UPDATE_NONCE",
  "TRANSFER_OWNERSHIP"
]);

const ACCOUNT_STATUS = new Set(["ACTIVE", "INACTIVE"]);

export class DBPASService {
  constructor({ dbFile, secret }) {
    this.dbFile = dbFile;
    this.secret = secret;
    this.qrCache = new Map();
    this.ensureStore();
  }

  ensureStore() {
    if (!fs.existsSync(this.dbFile)) {
      fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
      this.writeState(this.buildInitialState());
      return;
    }

    try {
      const state = this.readState();
      if (!Array.isArray(state.accounts)) {
        this.writeState(this.buildInitialState());
        return;
      }

      this.writeState(this.migrateState(state));
    } catch {
      this.writeState(this.buildInitialState());
    }
  }

  readState() {
    return JSON.parse(fs.readFileSync(this.dbFile, "utf8"));
  }

  writeState(state) {
    fs.writeFileSync(this.dbFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  mutate(mutator) {
    const state = this.readState();
    const result = mutator(state);
    state.updatedAt = nowIso();
    this.writeState(state);
    return result;
  }

  migrateState(rawState) {
    const state = clone(rawState);
    const timestamp = nowIso();
    state.version = STORE_VERSION;
    state.createdAt = state.createdAt ?? timestamp;
    state.updatedAt = state.updatedAt ?? timestamp;
    state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
    state.products = Array.isArray(state.products) ? state.products : [];
    state.history = Array.isArray(state.history) ? state.history : [];
    state.privateData = Array.isArray(state.privateData) ? state.privateData : [];
    state.sessions = Array.isArray(state.sessions) ? state.sessions : [];

    for (const account of state.accounts) {
      account.identity = buildWalletIdentity(account);
      account.status = account.status ?? "ACTIVE";
      account.updatedAt = account.updatedAt ?? account.createdAt ?? timestamp;
    }

    const resolveLegacyOrdinal = (account) => {
      if (account.role !== "consumer") {
        return null;
      }

      if (Number.isInteger(account.postSaleOrdinal) && account.postSaleOrdinal > 0) {
        return account.postSaleOrdinal;
      }

      const creator = state.accounts.find((candidate) => candidate.id === account.createdByAccountId);
      if (!creator) {
        return 1;
      }

      if (creator.role === "retailer" || creator.role === ADMIN_ROLE) {
        return 1;
      }

      if (creator.role === "consumer") {
        return (resolveLegacyOrdinal(creator) ?? 1) + 1;
      }

      return 1;
    };

    for (const account of state.accounts) {
      if (account.role === "consumer") {
        account.postSaleOrdinal = resolveLegacyOrdinal(account);
      } else {
        account.postSaleOrdinal = null;
      }
    }

    for (const product of state.products) {
      const owner = state.accounts.find((account) => account.id === product.ownerAccountId);
      const history = state.history.filter((entry) => entry.productId === product.id);
      const latestNonceEntry = history
        .filter((entry) => this.isNonceEvent(entry))
        .at(-1);
      const latestPrivateData = latestNonceEntry
        ? state.privateData.find((record) => record.txId === latestNonceEntry.id) ?? null
        : null;
      const category = product.metadata?.category ?? "General Goods";

      const minTransitSeconds =
        latestNonceEntry?.publicData?.minTransitSeconds ??
        product.minTransitSeconds ??
        (latestPrivateData
          ? computeMinTransitSeconds({
              gpsCurrent: latestPrivateData.gpsCurrent,
              gpsDestination: latestPrivateData.gpsDestination,
              category
            })
          : 0);

      product.ownerIdentity = owner?.identity ?? product.ownerIdentity ?? null;
      product.transferCount =
        product.transferCount ??
        history.filter(
          (entry) =>
            entry.fromOwnerAccountId &&
            entry.toOwnerAccountId &&
            entry.fromOwnerAccountId !== entry.toOwnerAccountId
        ).length;
      product.minTransitSeconds = minTransitSeconds;
      product.gpsDestHash = product.gpsDestHash ?? latestNonceEntry?.publicData?.gpsDestHash ?? null;
      product.status = product.status ?? stageForRole(owner?.role);
      product.updatedAt = product.updatedAt ?? latestNonceEntry?.timestamp ?? product.createdAt ?? timestamp;
      product.checkpointIndex =
        product.checkpointIndex ??
        Math.max(
          0,
          history.filter((entry) => this.isNonceEvent(entry)).length - 1
        );
      product.consumed = Boolean(product.consumed);
      product.currentDestinationAccountId =
        product.currentDestinationAccountId ?? latestNonceEntry?.publicData?.destinationAccountId ?? null;
    }

    for (const entry of state.history) {
      if (this.isNonceEvent(entry)) {
        const privateData = state.privateData.find((record) => record.txId === entry.id) ?? null;
        if (entry.publicData && entry.publicData.minTransitSeconds === undefined && privateData) {
          const product = state.products.find((candidate) => candidate.id === entry.productId);
          entry.publicData.minTransitSeconds = computeMinTransitSeconds({
            gpsCurrent: privateData.gpsCurrent,
            gpsDestination: privateData.gpsDestination,
            category: product?.metadata?.category ?? "General Goods"
          });
        }
      }
    }

    return state;
  }

  getPublicBootstrap() {
    const state = this.readState();
    const fresh = this.isFreshInstance(state);
    return {
      system: this.buildSystemSummary(),
      stats: {
        accounts: state.accounts.length,
        activeAccounts: state.accounts.filter((account) => account.status === "ACTIVE").length,
        products: state.products.length,
        historyEvents: state.history.length
      },
      auth: {
        setupHint: fresh
          ? {
              username: BOOTSTRAP_ADMIN.username,
              password: BOOTSTRAP_ADMIN.password
            }
          : null
      }
    };
  }

  login(input) {
    return this.mutate((state) => {
      const username = normalizeUsername(input.username);
      const password = String(input.password ?? "");
      const account = state.accounts.find((candidate) => candidate.username === username);

      if (!account) {
        throw this.httpError(401, "Invalid username or password.");
      }

      if (account.status !== "ACTIVE") {
        throw this.httpError(403, "This account is inactive. Contact your administrator.");
      }

      if (!verifyPassword(password, account.passwordSalt, account.passwordHash)) {
        throw this.httpError(401, "Invalid username or password.");
      }

      const token = randomHex(24);
      const timestamp = nowIso();
      state.sessions = state.sessions.filter((session) => session.accountId !== account.id);
      state.sessions.push({
        token,
        accountId: account.id,
        createdAt: timestamp,
        lastSeenAt: timestamp
      });

      return {
        token,
        dashboard: this.buildDashboardPayload(state, account)
      };
    });
  }

  logout(token) {
    return this.mutate((state) => {
      const index = state.sessions.findIndex((session) => session.token === token);
      if (index >= 0) {
        state.sessions.splice(index, 1);
      }

      return { ok: true };
    });
  }

  getDashboard(token) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      return this.buildDashboardPayload(state, actor);
    });
  }

  getProductDetails(token, productId) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      const product = this.getProductOrThrow(state, productId);
      this.assertCanViewProduct(state, actor, product);

      return {
        product: this.serializeProduct(product, state, actor),
        history: this.getHistoryForProduct(state, productId)
          .filter((entry) => this.canViewHistory(state, actor, entry))
          .map((entry) => this.serializeHistoryEntry(entry, state)),
        audit: this.buildVerificationReport(state, product, {
          viewer: actor,
          token: product.token,
          mode: "audit"
        })
      };
    });
  }

  createAccount(token, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);

      const role = String(input.role ?? "").trim().toLowerCase();
      const creationOptions = this.getAccountCreationOptions(actor);
      const option = creationOptions.find((candidate) => candidate.role === role);
      if (!option || !STAKEHOLDER_ROLES.includes(role)) {
        throw this.httpError(403, "You can only create the next stakeholder role in your chain.");
      }

      const username = normalizeUsername(input.username);
      if (state.accounts.some((account) => account.username === username)) {
        throw this.httpError(409, `Username ${username} already exists.`);
      }

      const displayName = String(input.displayName ?? "").trim();
      if (!displayName) {
        throw this.httpError(400, "Display name is required.");
      }

      const postSaleOrdinal = this.resolvePostSaleOrdinal(actor, role, input.postSaleOrdinal);

      const account = this.buildAccountRecord({
        username,
        password: input.password,
        displayName,
        email: String(input.email ?? "").trim() || null,
        role,
        postSaleOrdinal,
        registeredGps: normalizeGps(input.registeredGps),
        createdByAccountId: actor.id
      });

      state.accounts.push(account);

      const historyEntry = this.appendHistory(state, {
        type: "CREATE_ACCOUNT",
        timestamp: nowIso(),
        productId: null,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: null,
        toOwnerAccountId: account.id,
        status: "COMMITTED",
        publicData: {
          role: account.role,
          roleLabel: accountRoleLabel(account),
          username: account.username,
          postSaleOrdinal: account.postSaleOrdinal ?? null,
          registeredGpsHash: hashString(gpsKey(account.registeredGps))
        }
      });

      return {
        account: this.serializeAccount(account),
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  updateAccountStatus(token, accountId, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      this.assertRole(actor, [ADMIN_ROLE]);

      const target = this.getAccountOrThrow(state, accountId);
      const status = String(input.status ?? "").toUpperCase();
      if (!ACCOUNT_STATUS.has(status)) {
        throw this.httpError(400, "Status must be ACTIVE or INACTIVE.");
      }

      if (target.id === actor.id) {
        throw this.httpError(400, "You cannot change the status of the account you are using.");
      }

      target.status = status;
      target.updatedAt = nowIso();

      if (status === "INACTIVE") {
        state.sessions = state.sessions.filter((session) => session.accountId !== target.id);
      }

      const historyEntry = this.appendHistory(state, {
        type: "UPDATE_ACCOUNT_STATUS",
        timestamp: nowIso(),
        productId: null,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: null,
        toOwnerAccountId: target.id,
        status: "COMMITTED",
        publicData: {
          accountStatus: target.status
        }
      });

      return {
        account: this.serializeAccount(target),
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  registerProduct(token, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      this.assertRole(actor, ["manufacturer"]);

      const destination = this.getAccountOrThrow(state, input.destinationAccountId);
      this.assertActiveAccount(destination);
      if (destination.role !== "distributor") {
        throw this.httpError(400, "Initial destination must be a distributor account.");
      }

      const productId =
        String(input.productId ?? "").trim() ||
        `${slugify(input.productName || "product")}-${randomHex(3)}`;
      if (state.products.some((product) => product.id === productId)) {
        throw this.httpError(409, `Product ${productId} already exists.`);
      }

      const timestamp = nowIso();
      const gpsFactory = input.gpsFactory ? normalizeGps(input.gpsFactory) : clone(actor.registeredGps);
      const gpsDestination = input.destinationGps
        ? normalizeGps(input.destinationGps)
        : clone(destination.registeredGps);
      const minTransitSeconds = computeMinTransitSeconds({
        gpsCurrent: gpsFactory,
        gpsDestination,
        category: input.category
      });
      const currentNonce = computeNonce({
        pid: productId,
        gpsCurrent: gpsFactory,
        gpsDestination,
        previousNonce: "",
        timestamp,
        minTransitSeconds,
        secret: this.secret
      });

      const asset = {
        id: productId,
        token: randomHex(10),
        metadata: {
          productName: String(input.productName ?? "").trim() || "Unnamed Product",
          batchNumber: String(input.batchNumber ?? "").trim() || `BATCH-${randomHex(2)}`,
          manufacturingDate:
            String(input.manufacturingDate ?? "").trim() ||
            new Date().toISOString().slice(0, 10),
          manufacturerAccountId: actor.id,
          description: String(input.description ?? "").trim() || "",
          category: String(input.category ?? "").trim() || "General Goods",
          initialDestinationAccountId: destination.id
        },
        currentNonce,
        consumed: false,
        ownerAccountId: actor.id,
        ownerIdentity: actor.identity,
        gpsDestHash: hashString(gpsKey(gpsDestination)),
        minTransitSeconds,
        checkpointIndex: 0,
        transferCount: 0,
        status: "REGISTERED",
        registeredRetailerAccountId: null,
        currentDestinationAccountId: destination.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        initialNonceHash: hashString(currentNonce)
      };

      state.products.push(asset);

      const historyEntry = this.appendHistory(state, {
        type: "REGISTER_PRODUCT",
        timestamp,
        productId: asset.id,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: null,
        toOwnerAccountId: actor.id,
        status: "COMMITTED",
        publicData: {
          nonceBefore: "",
          nonceAfter: currentNonce,
          gpsDestHash: asset.gpsDestHash,
          minTransitSeconds,
          checkpointIndex: 0,
          destinationAccountId: destination.id,
          metadataSummary: {
            productName: asset.metadata.productName,
            batchNumber: asset.metadata.batchNumber,
            category: asset.metadata.category
          }
        }
      });

      this.appendPrivateData(state, {
        txId: historyEntry.id,
        productId: asset.id,
        visibleTo: [actor.id, destination.id],
        gpsCurrent: gpsFactory,
        gpsDestination
      });

      return {
        product: this.serializeProduct(asset, state, actor),
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  handoffProduct(token, productId, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      const product = this.getProductOrThrow(state, productId);
      this.assertOwner(product, actor);
      this.assertRole(actor, ["manufacturer", "distributor"]);

      const receiver = this.getAccountOrThrow(state, input.receiverAccountId);
      const destination = this.getAccountOrThrow(state, input.destinationAccountId);
      this.assertActiveAccount(receiver);
      this.assertActiveAccount(destination);

      if (receiver.id === actor.id) {
        throw this.httpError(400, "Sender and receiver must be different accounts.");
      }

      if (actor.role === "manufacturer") {
        if (receiver.role !== "distributor") {
          throw this.httpError(400, "Manufacturers can only hand off to distributors.");
        }
        if (destination.role !== "retailer") {
          throw this.httpError(400, "The next destination after a distributor must be a retailer.");
        }
      }

      if (actor.role === "distributor") {
        if (receiver.role !== "retailer") {
          throw this.httpError(400, "Distributors can only hand off to retailers.");
        }
        if (destination.role !== "retailer") {
          throw this.httpError(400, "Retail delivery must target a retailer location.");
        }
      }

      const gpsNow = input.gpsNow ? normalizeGps(input.gpsNow) : clone(actor.registeredGps);
      const gpsDestination = input.destinationGps
        ? normalizeGps(input.destinationGps)
        : clone(destination.registeredGps);
      const timestamp = nowIso();
      const previousNonce = product.currentNonce;
      const minTransitSeconds = computeMinTransitSeconds({
        gpsCurrent: gpsNow,
        gpsDestination,
        category: product.metadata.category
      });
      const nextNonce = computeNonce({
        pid: product.id,
        gpsCurrent: gpsNow,
        gpsDestination,
        previousNonce,
        timestamp,
        minTransitSeconds,
        secret: this.secret
      });

      const previousOwnerAccountId = product.ownerAccountId;
      product.currentNonce = nextNonce;
      product.minTransitSeconds = minTransitSeconds;
      product.consumed = false;
      product.ownerAccountId = receiver.id;
      product.ownerIdentity = receiver.identity;
      product.gpsDestHash = hashString(gpsKey(gpsDestination));
      product.checkpointIndex += 1;
      product.transferCount += 1;
      product.status = stageForRole(receiver.role);
      product.currentDestinationAccountId = destination.id;
      product.updatedAt = timestamp;
      if (receiver.role === "retailer") {
        product.registeredRetailerAccountId = receiver.id;
      }

      const historyEntry = this.appendHistory(state, {
        type: "HANDOFF_PRODUCT",
        timestamp,
        productId: product.id,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: previousOwnerAccountId,
        toOwnerAccountId: receiver.id,
        status: "COMMITTED",
        publicData: {
          nonceBefore: previousNonce,
          nonceAfter: nextNonce,
          gpsDestHash: product.gpsDestHash,
          minTransitSeconds,
          checkpointIndex: product.checkpointIndex,
          destinationAccountId: destination.id
        }
      });

      this.appendPrivateData(state, {
        txId: historyEntry.id,
        productId: product.id,
        visibleTo: [actor.id, receiver.id],
        gpsCurrent: gpsNow,
        gpsDestination
      });

      return {
        product: this.serializeProduct(product, state, actor),
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  updateNonce(token, productId, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      this.getProductOrThrow(state, productId);
      this.assertRole(actor, ["retailer", "consumer"]);

      throw this.httpError(
        410,
        "The revised DBPAS model uses atomic checkpoints. Transfer ownership to commit the next nonce."
      );
    });
  }

  transferOwnership(token, productId, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      const product = this.getProductOrThrow(state, productId);
      this.assertOwner(product, actor);
      this.assertRole(actor, ["retailer", "consumer"]);

      const receiver = this.getAccountOrThrow(state, input.receiverAccountId);
      this.assertActiveAccount(receiver);

      if (actor.role === "retailer" && receiver.role !== "consumer") {
        throw this.httpError(400, "Retailers can only transfer ownership to first-owner accounts.");
      }

      if (actor.role === "retailer" && receiver.postSaleOrdinal !== 1) {
        throw this.httpError(400, "Retailers can only transfer to accounts labeled as 1st Owner.");
      }

      if (actor.role === "consumer" && receiver.role !== "consumer") {
        throw this.httpError(400, "Owners can only transfer ownership to downstream owner accounts.");
      }

      if (
        actor.role === "consumer" &&
        receiver.postSaleOrdinal !== (actor.postSaleOrdinal ?? 1) + 1
      ) {
        throw this.httpError(
          400,
          `This ownership hop requires a ${ordinalLabel((actor.postSaleOrdinal ?? 1) + 1)} Owner account.`
        );
      }

      if (receiver.id === actor.id) {
        throw this.httpError(400, "Sender and receiver must be different accounts.");
      }

      const gpsNow = input.gpsNow ? normalizeGps(input.gpsNow) : clone(actor.registeredGps);
      const gpsDestination = input.destinationGps
        ? normalizeGps(input.destinationGps)
        : clone(receiver.registeredGps);
      const timestamp = nowIso();
      const previousOwnerAccountId = product.ownerAccountId;
      const previousNonce = product.currentNonce;
      const minTransitSeconds = computeMinTransitSeconds({
        gpsCurrent: gpsNow,
        gpsDestination,
        category: product.metadata.category
      });
      const nextNonce = computeNonce({
        pid: product.id,
        gpsCurrent: gpsNow,
        gpsDestination,
        previousNonce,
        timestamp,
        minTransitSeconds,
        secret: this.secret
      });

      product.currentNonce = nextNonce;
      product.gpsDestHash = hashString(gpsKey(gpsDestination));
      product.minTransitSeconds = minTransitSeconds;
      product.consumed = false;
      product.ownerAccountId = receiver.id;
      product.ownerIdentity = receiver.identity;
      product.currentDestinationAccountId = receiver.id;
      product.checkpointIndex += 1;
      product.transferCount += 1;
      product.updatedAt = timestamp;
      product.status = stageForRole(receiver.role);

      const historyEntry = this.appendHistory(state, {
        type: "TRANSFER_OWNERSHIP",
        timestamp,
        productId: product.id,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: previousOwnerAccountId,
        toOwnerAccountId: receiver.id,
        status: "COMMITTED",
        publicData: {
          nonceBefore: previousNonce,
          nonceAfter: nextNonce,
          gpsDestHash: product.gpsDestHash,
          gpsEventHash: hashString(gpsKey(gpsNow)),
          minTransitSeconds,
          checkpointIndex: product.checkpointIndex,
          destinationAccountId: receiver.id
        }
      });

      this.appendPrivateData(state, {
        txId: historyEntry.id,
        productId: product.id,
        visibleTo: [actor.id, receiver.id],
        gpsCurrent: gpsNow,
        gpsDestination
      });

      return {
        product: this.serializeProduct(product, state, actor),
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  verifyProduct(token, productId, input) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      const product = this.getProductOrThrow(state, productId);
      this.assertCanViewProduct(state, actor, product);

      const scanLocation = input.scanLocation
        ? normalizeGps(input.scanLocation)
        : clone(actor.registeredGps);
      const report = this.buildVerificationReport(state, product, {
        viewer: actor,
        token: input.token,
        scanLocation,
        submittedAt: nowIso(),
        mode: "sale-check"
      });

      let historyType = "VERIFY_PRODUCT";
      let status = report.status;

      if (product.consumed) {
        historyType = "CLONE_ALERT";
        status = "CLONE_ALERT";
      } else if (status === "AUTHENTIC") {
        product.consumed = true;
        product.updatedAt = nowIso();
      }

      const historyEntry = this.appendHistory(state, {
        type: historyType,
        timestamp: nowIso(),
        productId: product.id,
        actorAccountId: actor.id,
        actorIdentity: actor.identity,
        fromOwnerAccountId: product.ownerAccountId,
        toOwnerAccountId: product.ownerAccountId,
        status,
        publicData: {
          tokenHash: hashString(String(input.token ?? "")),
          gpsScanHash: hashString(gpsKey(scanLocation))
        }
      });

      return {
        report,
        historyEntry: this.serializeHistoryEntry(historyEntry, state),
        product: this.serializeProduct(product, state, actor),
        dashboard: this.buildDashboardPayload(state, actor)
      };
    });
  }

  auditProduct(token, productId, scanLocation) {
    return this.mutate((state) => {
      const actor = this.getActorForTokenOrThrow(state, token);
      this.touchSession(state, token);
      const product = this.getProductOrThrow(state, productId);
      this.assertCanViewProduct(state, actor, product);

      return this.buildVerificationReport(state, product, {
        viewer: actor,
        token: product.token,
        scanLocation,
        mode: "audit"
      });
    });
  }

  buildSystemSummary() {
    return {
      name: "DBPAS",
      paperTitle:
        "DBPAS: A Geo-Nonce Authenticated, Atomically-Consistent Blockchain Framework for End-to-End Anti-Counterfeit Detection Across Pre- and Post-Supply-Chain Lifecycles",
      runtime: "Local Fabric-style simulation",
      qrFormat: "https://dbpas.io/verify?pid=<PID>&t=<Token>",
      organizations: [
        "GovernanceOrg",
        "ManufacturerOrg",
        "DistributorOrg",
        "RetailerOrg",
        "ConsumerOrg"
      ]
    };
  }

  buildDashboardPayload(state, actor) {
    const accounts = this.getVisibleAccounts(state, actor).map((account) =>
      this.serializeAccount(account)
    );
    const directory = this.getDirectoryAccounts(state).map((account) =>
      this.serializeAccount(account)
    );
    const products = this.getVisibleProducts(state, actor).map((product) =>
      this.serializeProduct(product, state, actor)
    );
    const visibleHistory = this.getVisibleHistory(state, actor);

    return {
      system: this.buildSystemSummary(),
      currentUser: this.serializeAccount(actor),
      panel: this.buildRolePanel(actor.role),
      stats: {
        accounts: actor.role === ADMIN_ROLE ? state.accounts.length : directory.length,
        activeAccounts: state.accounts.filter((account) => account.status === "ACTIVE").length,
        products: products.length,
        ownedProducts: products.filter((product) => product.ownerAccountId === actor.id).length,
        historyEvents: visibleHistory.length,
        createdStakeholders: state.accounts.filter((account) => account.createdByAccountId === actor.id).length
      },
      stakeholderCreation: {
        canCreate: this.getAccountCreationOptions(actor).length > 0,
        options: this.getAccountCreationOptions(actor)
      },
      accounts,
      directory,
      products,
      recentHistory: visibleHistory
        .slice(-16)
        .reverse()
        .map((entry) => this.serializeHistoryEntry(entry, state))
      };
  }

  getAccountCreationOptions(actor) {
    if (actor.role === ADMIN_ROLE) {
      return [
        { role: "manufacturer", roleLabel: roleLabel("manufacturer"), postSaleOrdinal: null },
        { role: "distributor", roleLabel: roleLabel("distributor"), postSaleOrdinal: null },
        { role: "retailer", roleLabel: roleLabel("retailer"), postSaleOrdinal: null },
        { role: "consumer", roleLabel: `${ordinalLabel(1)} Owner`, postSaleOrdinal: 1 }
      ];
    }

    if (actor.role === "manufacturer") {
      return [{ role: "distributor", roleLabel: roleLabel("distributor"), postSaleOrdinal: null }];
    }

    if (actor.role === "distributor") {
      return [{ role: "retailer", roleLabel: roleLabel("retailer"), postSaleOrdinal: null }];
    }

    if (actor.role === "retailer") {
      return [{ role: "consumer", roleLabel: `${ordinalLabel(1)} Owner`, postSaleOrdinal: 1 }];
    }

    if (actor.role === "consumer") {
      const nextOrdinal = (actor.postSaleOrdinal ?? 1) + 1;
      return [{ role: "consumer", roleLabel: `${ordinalLabel(nextOrdinal)} Owner`, postSaleOrdinal: nextOrdinal }];
    }

    return [];
  }

  resolvePostSaleOrdinal(actor, role, requestedOrdinal) {
    if (role !== "consumer") {
      return null;
    }

    if (actor.role === ADMIN_ROLE) {
      const parsed = Number(requestedOrdinal ?? 1);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw this.httpError(400, "Owner tier must be a positive whole number.");
      }
      return parsed;
    }

    if (actor.role === "retailer") {
      return 1;
    }

    if (actor.role === "consumer") {
      return (actor.postSaleOrdinal ?? 1) + 1;
    }

    return null;
  }

  buildVerificationReport(state, product, options = {}) {
    const currentOwner = this.getAccountOrThrow(state, product.ownerAccountId);
    const viewer = options.viewer ?? null;
    const retailer = product.registeredRetailerAccountId
      ? this.getAccountOrThrow(state, product.registeredRetailerAccountId)
      : null;
    const nonceHistory = this.getNonceHistory(state, product.id);
    const chainValidation = this.validateNonceHistory(nonceHistory, product.id, product.currentNonce);
    const latestCheckpoint = nonceHistory.at(-1) ?? null;
    const latestPrivateData = latestCheckpoint?.privateData ?? null;
    const scanLocation = options.scanLocation ? normalizeGps(options.scanLocation) : null;
    const submittedAt = options.submittedAt ?? nowIso();
    const tokenMatches = options.token ? options.token === product.token : true;
    const scanDistance =
      latestPrivateData && scanLocation
        ? distanceMeters(scanLocation, latestPrivateData.gpsDestination)
        : null;
    const geofenceMatches =
      scanDistance === null ? false : scanDistance <= GPS_RADIUS_THRESHOLD_METERS;
    const minTransitSeconds =
      latestCheckpoint?.publicData?.minTransitSeconds ?? product.minTransitSeconds ?? 0;
    const validAfter =
      latestCheckpoint && Number.isFinite(Date.parse(latestCheckpoint.timestamp))
        ? new Date(Date.parse(latestCheckpoint.timestamp) + minTransitSeconds * 1000).toISOString()
        : null;
    const timeBoundSatisfied =
      validAfter === null ? false : Date.parse(submittedAt) >= Date.parse(validAfter);
    const ownerMatchesViewer = viewer ? currentOwner.id === viewer.id : false;
    const checkpointPrivacyReady = Boolean(product.gpsDestHash && latestPrivateData?.gpsDestination);
    const provenanceHops =
      typeof product.transferCount === "number" ? product.transferCount : chainValidation.chainLength - 1;

    const checks =
      options.mode === "audit"
        ? [
            {
              label: "Token resolves the immutable product identity",
              ok: tokenMatches,
              detail: tokenMatches
                ? "QR token matches the on-ledger token pointer."
                : "Submitted token does not resolve to the current ledger pointer."
            },
            {
              label: "Nonce history forms an unbroken HMAC chain",
              ok: chainValidation.ok,
              detail: chainValidation.ok
                ? `Validated ${chainValidation.chainLength} nonce checkpoints against the revised GNQR equation.`
                : chainValidation.reason
            },
            {
              label: "Current nonce matches the latest committed checkpoint",
              ok: chainValidation.currentMatchesAsset,
              detail: chainValidation.currentMatchesAsset
                ? "World-state nonce equals the last nonce in history."
                : "World-state nonce diverges from the history trail."
            },
            {
              label: "GPS destination privacy and time-bound metadata are committed",
              ok: checkpointPrivacyReady,
              detail: checkpointPrivacyReady
                ? `Shared ledger stores ${publicNonce(product.gpsDestHash)} with a ${minTransitSeconds}s minimum transit bound.`
                : "The latest checkpoint is missing either its destination hash or private GPS payload."
            },
            {
              label: "Continuous provenance remains intact",
              ok: Boolean(currentOwner.id),
              detail: `Current owner is ${currentOwner.displayName} (${roleLabel(currentOwner.role)}) after ${provenanceHops} ownership hops.`
            }
          ]
        : [
            {
              label: "Token resolves the immutable product identity",
              ok: tokenMatches,
              detail: tokenMatches
                ? "QR token matches the on-ledger token pointer."
                : "Submitted token does not resolve to the current ledger pointer."
            },
            {
              label: "Nonce history forms an unbroken HMAC chain",
              ok: chainValidation.ok,
              detail: chainValidation.ok
                ? `Validated ${chainValidation.chainLength} nonce checkpoints against the revised GNQR equation.`
                : chainValidation.reason
            },
            {
              label: "Current nonce matches the latest committed checkpoint",
              ok: chainValidation.currentMatchesAsset,
              detail: chainValidation.currentMatchesAsset
                ? "World-state nonce equals the last nonce in history."
                : "World-state nonce diverges from the history trail."
            },
            {
              label: "GPS destination and time-bound window both match the scan",
              ok: geofenceMatches && timeBoundSatisfied,
              detail:
                !latestPrivateData
                  ? "The latest checkpoint is missing private GPS data."
                  : !scanLocation
                    ? "A scan location is required to evaluate the destination geofence."
                    : !geofenceMatches
                      ? `Scan is ${Math.round(scanDistance)} m from the expected destination checkpoint.`
                      : !timeBoundSatisfied
                        ? `Scan arrived before the minimum transit window closed at ${validAfter}.`
                        : `Scan is ${Math.round(scanDistance)} m from destination and after ${validAfter}.`
            },
            {
              label: "NFT ownership matches the scanning stakeholder identity",
              ok: ownerMatchesViewer,
              detail: ownerMatchesViewer
                ? `Current owner is ${currentOwner.displayName} under ${currentOwner.mspId}.`
                : viewer
                  ? `Current owner is ${currentOwner.displayName}, not ${viewer.displayName}.`
                  : `Current owner is ${currentOwner.displayName}.`
            }
          ];

    const status = product.consumed
      ? "CLONE_ALERT"
      : checks.every((check) => check.ok)
        ? "AUTHENTIC"
        : "TAMPERED";

    return {
      status,
      mode: options.mode ?? "audit",
      consumed: product.consumed,
      checks,
      retailer: retailer ? this.serializeAccount(retailer) : null,
      currentOwner: this.serializeAccount(currentOwner),
      chainLength: chainValidation.chainLength,
      provenanceHops,
      minTransitSeconds,
      validAfter,
      destinationHashPreview: product.gpsDestHash ? publicNonce(product.gpsDestHash) : null,
      qrPayload: this.buildDynamicQrPayload(product, state),
      manufacturerQrPayload: this.buildManufacturerQrPayload(product),
      localVerifyPath: this.buildLocalVerifyPath(product),
      scanLocation,
      scanDistanceMeters: scanDistance === null ? null : Number(scanDistance.toFixed(2))
    };
  }

  buildInitialState() {
    const timestamp = nowIso();
    const admin = this.buildAccountRecord({
      username: BOOTSTRAP_ADMIN.username,
      password: BOOTSTRAP_ADMIN.password,
      displayName: BOOTSTRAP_ADMIN.displayName,
      email: BOOTSTRAP_ADMIN.email,
      role: ADMIN_ROLE,
      registeredGps: { lat: 28.6139, lon: 77.209 }
    });

    return {
      version: STORE_VERSION,
      createdAt: timestamp,
      updatedAt: timestamp,
      accounts: [admin],
      products: [],
      history: [],
      privateData: [],
      sessions: []
    };
  }

  buildAccountRecord(input) {
    const role = String(input.role ?? "").trim().toLowerCase();
    if (!ROLE_CONFIG[role]) {
      throw this.httpError(400, "Unsupported account role.");
    }

    const displayName = String(input.displayName ?? "").trim();
    if (!displayName) {
      throw this.httpError(400, "Display name is required.");
    }

    const username = normalizeUsername(input.username);
    const { hash, salt } = createPasswordHash(normalizePassword(input.password));
    const registeredGps = normalizeGps(input.registeredGps);
    const createdAt = nowIso();

    const account = {
      id: `${role}-${slugify(displayName) || "user"}-${randomHex(2)}`,
      username,
      displayName,
      email: input.email || null,
      role,
      org: ROLE_CONFIG[role].org,
      mspId: ROLE_CONFIG[role].mspId,
      postSaleOrdinal:
        role === "consumer" && Number.isInteger(Number(input.postSaleOrdinal))
          ? Number(input.postSaleOrdinal)
          : null,
      registeredGps,
      status: "ACTIVE",
      passwordSalt: salt,
      passwordHash: hash,
      createdByAccountId: input.createdByAccountId ?? null,
      createdAt,
      updatedAt: createdAt
    };

    account.identity = buildWalletIdentity(account);
    return account;
  }

  buildRolePanel(role) {
    const panels = {
      admin: {
        key: "admin",
        title: "Admin Control Panel",
        description: "Create and manage stakeholder accounts, supervise products, and monitor the full DBPAS supply chain."
      },
      manufacturer: {
        key: "manufacturer",
        title: "Manufacturer Panel",
        description: "Register products, mint GNQR identities, and commit atomic distributor handoffs."
      },
      distributor: {
        key: "distributor",
        title: "Distributor Panel",
        description: "Receive authenticated assets and commit atomic retailer-bound checkpoints."
      },
      retailer: {
        key: "retailer",
        title: "Retailer Panel",
        description: "Audit inventory, create 1st Owner accounts, and complete atomic sale checkpoints."
      },
      consumer: {
        key: "consumer",
        title: "Owner Panel",
        description: "Verify owned assets, create the next downstream owner, and continue provenance with atomic transfers."
      }
    };

    return panels[role] ?? panels.consumer;
  }

  isFreshInstance(state) {
    return (
      state.accounts.length === 1 &&
      state.accounts[0].username === BOOTSTRAP_ADMIN.username &&
      state.products.length === 0
    );
  }

  getActorForTokenOrThrow(state, token) {
    if (!token) {
      throw this.httpError(401, "Please sign in to continue.");
    }

    const session = state.sessions.find((candidate) => candidate.token === token);
    if (!session) {
      throw this.httpError(401, "Your session has expired. Please sign in again.");
    }

    const actor = this.getAccountOrThrow(state, session.accountId);
    this.assertActiveAccount(actor);
    return actor;
  }

  touchSession(state, token) {
    const session = state.sessions.find((candidate) => candidate.token === token);
    if (session) {
      session.lastSeenAt = nowIso();
    }
  }

  getAccountOrThrow(state, accountId) {
    const account = state.accounts.find((candidate) => candidate.id === accountId);
    if (!account) {
      throw this.httpError(404, `Account ${accountId} was not found.`);
    }
    return account;
  }

  getProductOrThrow(state, productId) {
    const product = state.products.find((candidate) => candidate.id === productId);
    if (!product) {
      throw this.httpError(404, `Product ${productId} was not found.`);
    }
    return product;
  }

  getVisibleAccounts(state, actor) {
    const accounts =
      actor.role === ADMIN_ROLE
        ? state.accounts
        : state.accounts.filter(
            (account) => account.id === actor.id || account.createdByAccountId === actor.id
          );
    return accounts.slice().sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getDirectoryAccounts(state) {
    return state.accounts
      .filter((account) => account.role !== ADMIN_ROLE)
      .slice()
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  getVisibleProducts(state, actor) {
    return state.products
      .filter((product) => this.canViewProduct(state, actor, product))
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getVisibleHistory(state, actor) {
    return state.history.filter((entry) => this.canViewHistory(state, actor, entry));
  }

  getHistoryForProduct(state, productId) {
    return state.history.filter((entry) => entry.productId === productId);
  }

  getNonceHistory(state, productId) {
    return this.getHistoryForProduct(state, productId)
      .filter((entry) => this.isNonceEvent(entry))
      .map((entry) => ({
        ...entry,
        privateData: state.privateData.find((record) => record.txId === entry.id) ?? null
      }));
  }

  isNonceEvent(entry) {
    if (!NONCE_EVENT_TYPES.has(entry.type)) {
      return false;
    }

    if (entry.type === "TRANSFER_OWNERSHIP") {
      return entry.publicData?.nonceBefore !== undefined;
    }

    return true;
  }

  validateNonceHistory(historyEntries, productId, currentNonce) {
    let previousNonce = "";
    for (const entry of historyEntries) {
      if (!entry.privateData) {
        return {
          ok: false,
          reason: `Private checkpoint data is missing for ${entry.id}.`,
          chainLength: historyEntries.length,
          currentMatchesAsset: false,
          lastNonce: previousNonce
        };
      }

      const expected = computeNonce({
        pid: productId,
        gpsCurrent: entry.privateData.gpsCurrent,
        gpsDestination: entry.privateData.gpsDestination,
        previousNonce,
        timestamp: entry.timestamp,
        minTransitSeconds: entry.publicData.minTransitSeconds ?? 0,
        secret: this.secret
      });

      if (expected !== entry.publicData.nonceAfter) {
        return {
          ok: false,
          reason: `Checkpoint ${entry.id} failed HMAC validation.`,
          chainLength: historyEntries.length,
          currentMatchesAsset: false,
          lastNonce: previousNonce
        };
      }

      previousNonce = entry.publicData.nonceAfter;
    }

    return {
      ok: true,
      reason: "Nonce chain validated successfully.",
      chainLength: historyEntries.length,
      lastNonce: previousNonce,
      currentMatchesAsset: previousNonce === currentNonce
    };
  }

  canViewProduct(state, actor, product) {
    if (actor.role === ADMIN_ROLE) {
      return true;
    }

    if (product.ownerAccountId === actor.id) {
      return true;
    }

    if (product.metadata.manufacturerAccountId === actor.id) {
      return true;
    }

    if (product.registeredRetailerAccountId === actor.id) {
      return true;
    }

    return state.history.some((entry) => {
      if (entry.productId !== product.id) {
        return false;
      }

      return (
        entry.actorAccountId === actor.id ||
        entry.fromOwnerAccountId === actor.id ||
        entry.toOwnerAccountId === actor.id
      );
    });
  }

  canViewHistory(state, actor, entry) {
    if (actor.role === ADMIN_ROLE) {
      return true;
    }

    if (!entry.productId) {
      return entry.actorAccountId === actor.id || entry.toOwnerAccountId === actor.id;
    }

    const product = state.products.find((candidate) => candidate.id === entry.productId);
    return product ? this.canViewProduct(state, actor, product) : false;
  }

  assertCanViewProduct(state, actor, product) {
    if (!this.canViewProduct(state, actor, product)) {
      throw this.httpError(403, "You do not have permission to view this product.");
    }
  }

  assertActiveAccount(account) {
    if (account.status !== "ACTIVE") {
      throw this.httpError(403, `${account.displayName} is inactive.`);
    }
  }

  assertOwner(product, actor) {
    if (product.ownerAccountId !== actor.id) {
      throw this.httpError(403, `${actor.displayName} is not the current owner of ${product.id}.`);
    }
  }

  assertRole(account, roles) {
    if (!roles.includes(account.role)) {
      throw this.httpError(
        403,
        `${account.displayName} must have one of these roles: ${roles.join(", ")}.`
      );
    }
  }

  appendHistory(state, entry) {
    const historyEntry = {
      id: randomId("tx"),
      timestamp: entry.timestamp ?? nowIso(),
      ...entry
    };
    state.history.push(historyEntry);
    return historyEntry;
  }

  appendPrivateData(state, entry) {
    state.privateData.push({
      ...entry,
      gpsCurrent: clone(entry.gpsCurrent),
      gpsDestination: clone(entry.gpsDestination)
    });
  }

  serializeAccount(account) {
    return {
      id: account.id,
      username: account.username,
      displayName: account.displayName,
      email: account.email,
      role: account.role,
      roleLabel: accountRoleLabel(account),
      org: account.org,
      mspId: account.mspId,
      identity: account.identity,
      postSaleOrdinal: account.postSaleOrdinal ?? null,
      registeredGps: clone(account.registeredGps),
      status: account.status,
      createdByAccountId: account.createdByAccountId ?? null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt
    };
  }

  serializeProduct(product, state, viewer = null) {
    const owner = this.getAccountOrThrow(state, product.ownerAccountId);
    const manufacturer = this.getAccountOrThrow(state, product.metadata.manufacturerAccountId);
    const retailer = product.registeredRetailerAccountId
      ? this.getAccountOrThrow(state, product.registeredRetailerAccountId)
      : null;
    const manufacturerQrPayload = this.buildManufacturerQrPayload(product);
    const dynamicQrPayload = this.buildDynamicQrPayload(product, state);

    return {
      id: product.id,
      token: product.token,
      tokenPreview: publicToken(product.token),
      metadata: clone(product.metadata),
      currentNonce: product.currentNonce,
      currentNoncePreview: publicNonce(product.currentNonce),
      consumed: product.consumed,
      ownerAccountId: product.ownerAccountId,
      ownerDisplayName: owner.displayName,
      ownerRole: owner.role,
      ownerRoleLabel: accountRoleLabel(owner),
      ownerIdentity: product.ownerIdentity,
      manufacturerDisplayName: manufacturer.displayName,
      status: product.status,
      checkpointIndex: product.checkpointIndex,
      transferCount: product.transferCount ?? 0,
      minTransitSeconds: product.minTransitSeconds ?? 0,
      gpsDestHashPreview: product.gpsDestHash ? publicNonce(product.gpsDestHash) : null,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      qrPayload: dynamicQrPayload,
      manufacturerQrPayload,
      qrImageDataUrl: this.buildQrImageDataUrl(product),
      qrDownloadName: `${product.id}-qr.svg`,
      localVerifyPath: this.buildLocalVerifyPath(product),
      registeredRetailer: retailer ? this.serializeAccount(retailer) : null,
      historyCount: this.getHistoryForProduct(state, product.id).length,
      actions: viewer
        ? {
            canHandoff:
              viewer.id === product.ownerAccountId &&
              ["manufacturer", "distributor"].includes(viewer.role),
            canTransfer:
              viewer.id === product.ownerAccountId &&
              ["retailer", "consumer"].includes(viewer.role),
            canVerify: viewer.id === product.ownerAccountId
          }
        : null
    };
  }

  serializeHistoryEntry(entry, state) {
    const actor = state.accounts.find((account) => account.id === entry.actorAccountId) ?? null;
    const fromOwner = entry.fromOwnerAccountId
      ? state.accounts.find((account) => account.id === entry.fromOwnerAccountId) ?? null
      : null;
    const toOwner = entry.toOwnerAccountId
      ? state.accounts.find((account) => account.id === entry.toOwnerAccountId) ?? null
      : null;

    return {
      id: entry.id,
      timestamp: entry.timestamp,
      type: entry.type,
      productId: entry.productId,
      actorAccountId: entry.actorAccountId,
      actorDisplayName: actor?.displayName ?? entry.actorAccountId,
      actorRole: actor?.role ?? null,
      status: entry.status,
      fromOwnerDisplayName: fromOwner?.displayName ?? null,
      toOwnerDisplayName: toOwner?.displayName ?? null,
      publicData: clone(entry.publicData)
    };
  }

  buildManufacturerQrPayload(product) {
    return `https://dbpas.io/verify?pid=${encodeURIComponent(product.id)}&t=${encodeURIComponent(product.token)}`;
  }

  buildDynamicQrPayload(product, state) {
    const latestCheckpoint = this.getNonceHistory(state, product.id).at(-1) ?? null;
    const privateData = latestCheckpoint?.privateData ?? null;
    const payload = {
      schema: "dbpas-gnqr-v2",
      pid: product.id,
      token: product.token,
      checkpoint: product.checkpointIndex ?? 0,
      status: product.status,
      nonce: product.currentNonce,
      ownerAccountId: product.ownerAccountId,
      currentLocation: privateData?.gpsCurrent ?? null,
      destinationLocation: privateData?.gpsDestination ?? null,
      destinationHash: product.gpsDestHash ?? null,
      minTransitSeconds:
        latestCheckpoint?.publicData?.minTransitSeconds ?? product.minTransitSeconds ?? 0,
      updatedAt: latestCheckpoint?.timestamp ?? product.updatedAt ?? product.createdAt
    };

    return JSON.stringify(payload);
  }

  buildLocalVerifyPath(product) {
    return `/verify?pid=${encodeURIComponent(product.id)}&t=${encodeURIComponent(product.token)}`;
  }

  buildQrImageDataUrl(product) {
    const payload = this.buildManufacturerQrPayload(product);
    if (this.qrCache.has(payload)) {
      return this.qrCache.get(payload);
    }

    const dataUrl = buildQrSvgDataUrl(payload);
    this.qrCache.set(payload, dataUrl);
    return dataUrl;
  }

  httpError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }
}
