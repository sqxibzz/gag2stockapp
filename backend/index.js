require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const API_URL = process.env.API_URL || process.env.STOCK_API_URL || "https://grow-a-garden-2-tracker.onrender.com/api/stock";
const RESTOCK_SECONDS = Number(process.env.RESTOCK_SECONDS || 300);
const POLL_OFFSET_SECONDS = Number(process.env.POLL_OFFSET_SECONDS || 3);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 4);
const RETRY_DELAY_SECONDS = Number(process.env.RETRY_DELAY_SECONDS || 5);
const USER_AGENT = process.env.USER_AGENT || "GrowAGarden2LiveStocksBackend/1.2";
const SEND_EMPTY_RESTOCK = String(process.env.SEND_EMPTY_RESTOCK || "false").toLowerCase() === "true";
const STATE_FILE = path.join(__dirname, "state.json");

const STOCK_CATEGORIES = [
  {
    apiKey: "SeedShop_Normal",
    restockKey: "SeedShop",
    topicPrefix: "seed",
    label: "Seeds",
    singular: "seed"
  },
  {
    apiKey: "GearShop",
    restockKey: "GearShop",
    topicPrefix: "gear",
    label: "Gear",
    singular: "gear"
  }
];

function slugifyName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function nameFromSlug(slug) {
  return String(slug || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function topicForSlug(category, slug) {
  return `${category.topicPrefix}_${String(slug || "").replace(/-/g, "_")}`;
}

function topicForItem(category, item) {
  return topicForSlug(category, item.slug || slugifyName(item.name));
}

function categoryForTopic(topic) {
  return STOCK_CATEGORIES.find(category => topic.startsWith(`${category.topicPrefix}_`)) || STOCK_CATEGORIES[0];
}

function initFirebase() {
  if (admin.apps.length > 0) return;

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (rawJson && rawJson.trim().length > 0) {
    const parsed = JSON.parse(rawJson);
    admin.initializeApp({
      credential: admin.credential.cert(parsed)
    });
    console.log("Firebase initialized with FIREBASE_SERVICE_ACCOUNT_JSON.");
    return;
  }

  const file = process.env.FIREBASE_SERVICE_ACCOUNT || "serviceAccountKey.json";
  const filePath = path.isAbsolute(file) ? file : path.join(__dirname, file);

  if (fs.existsSync(filePath)) {
    const serviceAccount = require(filePath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase initialized with service account file.");
    return;
  }

  throw new Error("Firebase credentials missing. Add FIREBASE_SERVICE_ACCOUNT_JSON in Railway variables or add backend/serviceAccountKey.json locally.");
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      ...state,
      lastWindows: state.lastWindows || {}
    };
  } catch {
    return { lastWindow: 0, lastWindows: {} };
  }
}

function saveState(state) {
  const lastWindows = state.lastWindows || {};
  const lastWindow = Math.max(0, ...Object.values(lastWindows).map(value => Number(value || 0)));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...state, lastWindow, lastWindows }, null, 2));
}

function lastWindowForCategory(state, category) {
  const lastWindows = state.lastWindows || {};
  const categoryWindow = Number(lastWindows[category.restockKey] || 0);

  if (categoryWindow > 0) return categoryWindow;
  if (category.topicPrefix === "seed") return Number(state.lastWindow || 0);
  return 0;
}

function setLastWindowForCategory(state, category, window) {
  state.lastWindows = state.lastWindows || {};
  state.lastWindows[category.restockKey] = Number(window || 0);
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchStock() {
  const response = await fetch(API_URL, {
    headers: { "user-agent": USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Stock API returned ${response.status}`);
  }

  return await response.json();
}

async function fetchStockWithRetries() {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchStock();
    } catch (error) {
      lastError = error;
      console.warn(`Stock fetch failed attempt ${attempt}/${RETRY_ATTEMPTS}:`, error.message);

      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_DELAY_SECONDS * 1000);
      }
    }
  }

  throw lastError || new Error("Stock fetch failed.");
}

function categoryWindow(data, category) {
  const restock = data?.restockTimes?.[category.restockKey] || {};
  const last = Number(restock.last || 0);
  const next = Number(restock.next || 0);

  if (last > 0) return last;
  if (next > RESTOCK_SECONDS) return next - RESTOCK_SECONDS;

  const updatedAt = Number(data?.updatedAt || 0);
  if (updatedAt > 1000000000000) return Math.floor(updatedAt / 1000);
  if (updatedAt > 0) return updatedAt;

  return Math.floor(Date.now() / 1000);
}

function shopItems(data, category) {
  const items = data?.shops?.[category.apiKey];

  if (!Array.isArray(items)) return [];

  return items
    .filter(item => item && item.name)
    .map(item => ({
      name: String(item.name),
      slug: slugifyName(item.name),
      rarity: item.rarity || "Unknown",
      price: item.price || "",
      stock: Number(item.stock || 0),
      image: item.image || null
    }));
}

function notificationMessage(category, item, window, test = false) {
  const qty = Number(item.stock || 0);
  const priceText = item.price && !/^NO STOCK$/i.test(item.price) ? ` for ${item.price}` : "";
  const title = test ? `Test ${item.name} alert` : `${item.name} is in stock`;
  const body = test
    ? `Firebase topic notifications are working for ${item.name}.`
    : qty > 0
      ? `${item.name} ${category.singular} stock is x${qty}${priceText}.`
      : `${item.name} is showing as in stock.`;

  const data = {
    title,
    body,
    category: category.topicPrefix,
    slug: item.slug,
    item: item.name,
    qty: String(qty),
    price: item.price || "",
    window: String(window),
    click_action: "OPEN_STOCK"
  };

  if (category.topicPrefix === "seed") {
    data.seed = item.name;
  }

  if (category.topicPrefix === "gear") {
    data.gear = item.name;
  }

  return {
    notification: {
      title,
      body
    },
    android: {
      priority: "high",
      notification: {
        channelId: "seed_stock_alerts",
        sound: "default",
        tag: `${category.topicPrefix}-${item.slug}-${window}`,
        defaultSound: true,
        defaultVibrateTimings: true
      }
    },
    data
  };
}

async function sendStockNotification(category, item, window) {
  const topic = topicForItem(category, item);

  const message = {
    topic,
    ...notificationMessage(category, item, window, false)
  };

  const id = await admin.messaging().send(message);
  console.log(`Sent ${item.name} ${category.singular} to topic ${topic}: ${id}`);
}

async function sendTopicTest(topicArg) {
  initFirebase();

  const topic = String(topicArg || "").trim();

  if (!topic) {
    throw new Error("Usage: npm run test:topic seed_tulip OR npm run test:topic gear_common_watering_can");
  }

  const category = categoryForTopic(topic);
  const slug = topic.startsWith(`${category.topicPrefix}_`)
    ? topic.substring(`${category.topicPrefix}_`.length)
    : slugifyName(topic);
  const item = {
    name: nameFromSlug(slug),
    slug,
    rarity: "Test",
    price: "",
    stock: 1
  };

  const id = await admin.messaging().send({
    topic: topic.startsWith(`${category.topicPrefix}_`) ? topic : topicForSlug(category, slug),
    ...notificationMessage(category, item, Date.now(), true)
  });

  console.log(`Test topic notification sent: ${id}`);
}

async function sendTokenTest(token) {
  initFirebase();

  const cleanToken = String(token || "").trim();

  if (!cleanToken) {
    throw new Error("Usage: npm run test:token YOUR_FCM_TOKEN");
  }

  const category = STOCK_CATEGORIES[0];
  const item = {
    name: "Tulip",
    slug: "tulip",
    rarity: "Test",
    price: "",
    stock: 1
  };

  const id = await admin.messaging().send({
    token: cleanToken,
    ...notificationMessage(category, item, Date.now(), true)
  });

  console.log(`Test token notification sent: ${id}`);
}

async function checkOnce({ force = false } = {}) {
  initFirebase();

  const state = loadState();
  const data = await fetchStockWithRetries();
  let stateChanged = false;

  for (const category of STOCK_CATEGORIES) {
    const window = categoryWindow(data, category);
    const lastWindow = lastWindowForCategory(state, category);

    if (!force && window <= lastWindow) {
      console.log(`${category.label} window ${window} already handled. Last handled: ${lastWindow}`);
      continue;
    }

    const inStock = shopItems(data, category).filter(item => item.stock > 0);

    if (inStock.length === 0) {
      console.log(`${category.label} window ${window}: no items in stock.`);

      if (SEND_EMPTY_RESTOCK || force) {
        setLastWindowForCategory(state, category, window);
        stateChanged = true;
      }

      continue;
    }

    console.log(`${category.label} window ${window}: ${inStock.map(item => item.name).join(", ")} in stock.`);

    for (const item of inStock) {
      await sendStockNotification(category, item, window);
    }

    setLastWindowForCategory(state, category, window);
    stateChanged = true;
  }

  if (stateChanged) {
    saveState(state);
  }
}

function msUntilNextPoll() {
  const restockMs = RESTOCK_SECONDS * 1000;
  const offsetMs = POLL_OFFSET_SECONDS * 1000;
  const now = Date.now();
  const nextWindow = Math.floor(now / restockMs) * restockMs + restockMs + offsetMs;
  return Math.max(1000, nextWindow - now);
}

function schedule() {
  const wait = msUntilNextPoll();

  console.log(`Next stock check in ${Math.round(wait / 1000)}s.`);

  setTimeout(async () => {
    try {
      await checkOnce();
    } catch (error) {
      console.error("Stock check failed:", error);
    }

    schedule();
  }, wait);
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--test-topic") {
    return sendTopicTest(args[1]);
  }

  if (args[0] === "--test-token") {
    return sendTokenTest(args[1]);
  }

  if (args.includes("--once")) {
    return checkOnce({ force: args.includes("--force") });
  }

  initFirebase();
  schedule();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
