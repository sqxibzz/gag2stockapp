require("dotenv").config();

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const API_URL = process.env.API_URL || "https://gag.gg/api/seed-restock";
const RESTOCK_SECONDS = Number(process.env.RESTOCK_SECONDS || 300);
const POLL_OFFSET_SECONDS = Number(process.env.POLL_OFFSET_SECONDS || 3);
const RETRY_ATTEMPTS = Number(process.env.RETRY_ATTEMPTS || 4);
const RETRY_DELAY_SECONDS = Number(process.env.RETRY_DELAY_SECONDS || 5);
const USER_AGENT = process.env.USER_AGENT || "GrowAGarden2LiveStocksBackend/1.1";
const SEND_EMPTY_RESTOCK = String(process.env.SEND_EMPTY_RESTOCK || "false").toLowerCase() === "true";
const STATE_FILE = path.join(__dirname, "state.json");

const SEEDS = [
  { slug: "tulip", name: "Tulip", emoji: "🌷", rarity: "Uncommon" },
  { slug: "tomato", name: "Tomato", emoji: "🍅", rarity: "Uncommon" },
  { slug: "apple", name: "Apple", emoji: "🍎", rarity: "Uncommon" },
  { slug: "bamboo", name: "Bamboo", emoji: "🎍", rarity: "Rare" },
  { slug: "corn", name: "Corn", emoji: "🌽", rarity: "Rare" },
  { slug: "cactus", name: "Cactus", emoji: "🌵", rarity: "Rare" },
  { slug: "pineapple", name: "Pineapple", emoji: "🍍", rarity: "Rare" },
  { slug: "mushroom", name: "Mushroom", emoji: "🍄", rarity: "Epic" },
  { slug: "green-bean", name: "Green Bean", emoji: "🫘", rarity: "Epic" },
  { slug: "banana", name: "Banana", emoji: "🍌", rarity: "Epic" },
  { slug: "grape", name: "Grape", emoji: "🍇", rarity: "Epic" },
  { slug: "coconut", name: "Coconut", emoji: "🥥", rarity: "Epic" },
  { slug: "mango", name: "Mango", emoji: "🥭", rarity: "Epic" },
  { slug: "dragon-fruit", name: "Dragon Fruit", emoji: "🐉", rarity: "Legendary" },
  { slug: "acorn", name: "Acorn", emoji: "🌰", rarity: "Legendary" },
  { slug: "cherry", name: "Cherry", emoji: "🍒", rarity: "Legendary" },
  { slug: "sunflower", name: "Sunflower", emoji: "🌻", rarity: "Legendary" },
  { slug: "venus-fly-trap", name: "Venus Fly Trap", emoji: "🪰", rarity: "Mythic" },
  { slug: "pomegranate", name: "Pomegranate", emoji: "🔴", rarity: "Mythic" },
  { slug: "poison-apple", name: "Poison Apple", emoji: "☠️", rarity: "Mythic" },
  { slug: "moon-bloom", name: "Moon Bloom", emoji: "🌙", rarity: "Super" },
  { slug: "dragons-breath", name: "Dragon's Breath", emoji: "🔥", rarity: "Super" }
];

function topicForSlug(slug) {
  return "seed_" + slug.replace(/-/g, "_");
}

function initFirebase() {
  if (admin.apps.length > 0) return;

  const file = process.env.FIREBASE_SERVICE_ACCOUNT || "serviceAccountKey.json";
  const filePath = path.isAbsolute(file) ? file : path.join(__dirname, file);

  if (fs.existsSync(filePath)) {
    const serviceAccount = require(filePath);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("Firebase initialized with service account file.");
    return;
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  console.log("Firebase initialized with application default credentials.");
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastWindow: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
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

function mapSeed(apiSeed) {
  const seed = SEEDS.find(item => item.name.toLowerCase() === String(apiSeed.name || "").toLowerCase());
  return seed ? { ...seed, ...apiSeed } : null;
}

function notificationMessage(seed, window, test = false) {
  const qty = Number(seed.lastQty || 0);
  const title = test ? `${seed.emoji} Test ${seed.name} alert` : `${seed.emoji} ${seed.name} is in stock`;
  const body = test
    ? `If you received this, Firebase topic notifications are working for ${seed.name}.`
    : qty > 0
      ? `${seed.name} dropped with stock ×${qty}. Hop in before the next restock.`
      : `${seed.name} is showing as in stock.`;

  return {
    notification: { title, body },
    android: {
      priority: "high",
      notification: {
        channelId: "seed_stock_alerts",
        sound: "default",
        tag: `seed-${seed.slug}-${window}`,
        defaultSound: true,
        defaultVibrateTimings: true
      }
    },
    data: {
      title,
      body,
      slug: seed.slug,
      seed: seed.name,
      qty: String(qty),
      window: String(window),
      click_action: "OPEN_STOCK"
    }
  };
}

async function sendSeedNotification(seed, window) {
  const topic = topicForSlug(seed.slug);
  const message = {
    topic,
    ...notificationMessage(seed, window, false)
  };

  const id = await admin.messaging().send(message);
  console.log(`Sent ${seed.name} to topic ${topic}: ${id}`);
}

async function sendTopicTest(topicArg) {
  initFirebase();
  const topic = String(topicArg || "").trim();
  if (!topic) throw new Error("Usage: npm run test:topic seed_tulip");
  const slug = topic.startsWith("seed_") ? topic.substring("seed_".length).replace(/_/g, "-") : topic.replace(/_/g, "-");
  const seed = SEEDS.find(item => item.slug === slug) || SEEDS[0];
  const id = await admin.messaging().send({
    topic: topic.startsWith("seed_") ? topic : topicForSlug(seed.slug),
    ...notificationMessage(seed, Date.now(), true)
  });
  console.log(`Test topic notification sent: ${id}`);
}

async function sendTokenTest(token) {
  initFirebase();
  const cleanToken = String(token || "").trim();
  if (!cleanToken) throw new Error("Usage: npm run test:token YOUR_FCM_TOKEN");
  const seed = SEEDS[0];
  const id = await admin.messaging().send({
    token: cleanToken,
    ...notificationMessage(seed, Date.now(), true)
  });
  console.log(`Test token notification sent: ${id}`);
}

async function checkOnce({ force = false } = {}) {
  initFirebase();
  const state = loadState();
  const data = await fetchStockWithRetries();
  const window = Number(data.window || 0);

  if (!window) {
    throw new Error("API response did not include a valid window.");
  }

  if (!force && window <= Number(state.lastWindow || 0)) {
    console.log(`Window ${window} already handled. Last handled: ${state.lastWindow}`);
    return;
  }

  const inStock = Array.isArray(data.seeds)
    ? data.seeds.filter(seed => seed && seed.inStockNow === true).map(mapSeed).filter(Boolean)
    : [];

  if (inStock.length === 0) {
    console.log(`Window ${window}: no seeds in stock.`);
    if (SEND_EMPTY_RESTOCK || force) {
      state.lastWindow = window;
      saveState(state);
    }
    return;
  }

  console.log(`Window ${window}: ${inStock.map(seed => seed.name).join(", ")} in stock.`);

  for (const seed of inStock) {
    await sendSeedNotification(seed, window);
  }

  state.lastWindow = window;
  saveState(state);
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
  if (args[0] === "--test-topic") return sendTopicTest(args[1]);
  if (args[0] === "--test-token") return sendTokenTest(args[1]);
  if (args.includes("--once")) return checkOnce({ force: args.includes("--force") });

  initFirebase();
  schedule();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
