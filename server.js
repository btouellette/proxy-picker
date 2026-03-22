const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_PATH = path.join(DATA_DIR, 'progress.json');
const CARD_CACHE_PATH = path.join(DATA_DIR, 'card-cache.json');
const CARD_LIST_PATH = path.join(ROOT_DIR, 'MTGOVintageCube.txt');
const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const CARD_CACHE_SCHEMA_VERSION = '2';
const OUTPUT_ROOT = path.resolve(
  process.env.PROXY_PICKER_OUTPUT_DIR || path.join(ROOT_DIR, 'downloads')
);
const PORT = Number(process.env.PORT || 4310);
let activeScryfallPath = '';
let activeInputFingerprint = '';

const STATIC_MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const MULTI_FACE_LAYOUTS = new Set([
  'adventure',
  'art_series',
  'double_faced_token',
  'flip',
  'modal_dfc',
  'reversible_card',
  'split',
  'transform',
]);

const appData = createAppData();

bootstrap()
  .then(() => {
    const server = http.createServer((request, response) => {
      handleRequest(request, response).catch((error) => {
        console.error(error);
        sendJson(response, 500, { error: 'Internal server error' });
      });
    });

    server.listen(PORT, () => {
      console.log(`Proxy Picker running at http://localhost:${PORT}`);
      console.log(`Output directory: ${OUTPUT_ROOT}`);
      console.log(`Card data source: ${activeScryfallPath}`);
    });
  })
  .catch((error) => {
    console.error('Failed to start Proxy Picker');
    console.error(error);
    process.exitCode = 1;
  });

async function bootstrap() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_ROOT, 'related-cards'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_ROOT, 'single-faced'), { recursive: true });
  fs.mkdirSync(path.join(OUTPUT_ROOT, 'double-sided'), { recursive: true });

  activeScryfallPath = await ensureDefaultCardData();
  const queue = loadCardQueue(CARD_LIST_PATH);
  const loadedData = await loadCardData(queue);
  activeScryfallPath = loadedData.filePath;
  activeInputFingerprint = buildInputFingerprint(activeScryfallPath);

  if (!fs.existsSync(STATE_PATH)) {
    writeState(createEmptyState());
  }

  const cards = loadedData.cards;

  if (!Array.isArray(cards)) {
    throw new Error('Scryfall dump must be a JSON array');
  }

  appData.queue = queue;
  appData.cards = cards;
  indexCards(cards);
  appData.state = readState();
}

function createAppData() {
  return {
    cards: [],
    cardsById: new Map(),
    cardsByFaceName: new Map(),
    cardsByName: new Map(),
    cardsByOracleId: new Map(),
    queue: [],
    state: createEmptyState(),
  };
}

function createEmptyState() {
  return {
    currentIndex: 0,
    inputFingerprint: activeInputFingerprint,
    relatedSelections: [],
    selections: [],
    skips: [],
  };
}

function loadCardQueue(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^\s*(\d+)\s*:\s*(.+)$/);
      const name = (match ? match[2] : line).trim();

      return {
        index,
        originalLine: line,
        name,
        normalizedName: normalizeName(name),
      };
    });
}

function indexCards(cards) {
  cards.forEach((card, index) => {
    if (card.lang !== 'en') {
      return;
    }

    if (card.id) {
      appData.cardsById.set(card.id, index);
    }

    for (const topLevelName of collectNormalizedNames(card, ['name', 'flavor_name'])) {
      addToIndex(appData.cardsByName, topLevelName, index);
    }

    if (card.oracle_id) {
      addToIndex(appData.cardsByOracleId, card.oracle_id, index);
    }

    if (Array.isArray(card.card_faces)) {
      for (const face of card.card_faces) {
        for (const faceName of collectNormalizedNames(face, ['name', 'flavor_name'])) {
          addToIndex(appData.cardsByFaceName, faceName, index);
        }
      }
    }
  });
}

function collectNormalizedNames(record, fields) {
  const names = new Set();

  for (const field of fields) {
    const normalizedName = normalizeName(record?.[field] || '');
    if (normalizedName) {
      names.add(normalizedName);
    }
  }

  return names;
}

function addToIndex(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (request.method === 'GET' && pathname === '/api/state') {
    return sendJson(response, 200, buildStatePayload());
  }

  if (request.method === 'POST' && pathname === '/api/select') {
    const body = await readJsonBody(request);
    return handleSelection(body, response);
  }

  if (request.method === 'POST' && pathname === '/api/skip') {
    const body = await readJsonBody(request);
    return handleSkip(body, response);
  }

  if (request.method === 'GET') {
    return serveStaticAsset(pathname, response);
  }

  return sendJson(response, 404, { error: 'Not found' });
}

function buildStatePayload() {
  const { currentIndex } = appData.state;
  const total = appData.queue.length;

  if (currentIndex >= total) {
    return {
      progress: {
        current: total,
        total,
      },
      status: 'done',
    };
  }

  const queueEntry = appData.queue[currentIndex];
  const matchingCardIndexes = findMatchingCardIndexes(queueEntry);
  const options = buildCardOptions(queueEntry, matchingCardIndexes);
  const relatedOptions = buildRelatedOptions(queueEntry, matchingCardIndexes);
  const hasNameSlash = queueEntry.name.includes('//');

  return {
    progress: {
      current: currentIndex + 1,
      total,
    },
    status: 'ready',
    currentCard: {
      index: queueEntry.index,
      name: queueEntry.name,
      isDoubleSided: hasNameSlash || options.some((option) => option.isDoubleSided),
      previewWarning: buildWarningMessage(),
      options,
      relatedOptions,
    },
  };
}

function buildCardOptions(queueEntry, matchingCardIndexes = findMatchingCardIndexes(queueEntry)) {
  const options = [];

  for (const cardIndex of matchingCardIndexes) {
    const card = appData.cards[cardIndex];
    const option = buildOptionFromCard(queueEntry, card);

    if (!option) {
      continue;
    }

    options.push(option);
  }

  return options.sort(compareOptions);
}

function buildRelatedOptions(queueEntry, matchingCardIndexes = findMatchingCardIndexes(queueEntry)) {
  const relatedOptions = new Map();

  for (const cardIndex of matchingCardIndexes) {
    const card = appData.cards[cardIndex];
    const entries = extractEligibleRelatedEntries(card);

    for (const entry of entries) {
      if (relatedOptions.has(entry.stableKey)) {
        continue;
      }

      const option = buildRelatedOptionFromEntry(queueEntry, entry);
      if (option) {
        relatedOptions.set(entry.stableKey, option);
      }
    }
  }

  return Array.from(relatedOptions.values()).sort(compareRelatedOptions);
}

function extractEligibleRelatedEntries(card) {
  if (!Array.isArray(card.all_parts)) {
    return [];
  }

  return card.all_parts
    .filter((part) => part && part.object === 'related_card')
    .map((part) => {
      const relatedCard = typeof part.id === 'string'
        ? appData.cards[appData.cardsById.get(part.id)]
        : null;
      const relatedName = relatedCard?.name || part.name || '';
      const relatedTypeLine = relatedCard?.type_line || part.type_line || '';
      const stableKey = relatedCard?.oracle_id || relatedCard?.id || `${normalizeName(relatedName)}|${relatedTypeLine}`;

      return {
        part,
        relatedCard,
        relatedName,
        relatedTypeLine,
        stableKey,
      };
    })
    .filter((part) => {
      const normalizedPartName = normalizeName(part.relatedName || '');
      const normalizedCardName = normalizeName(card.name || '');
      const relatedTypeLine = part.relatedTypeLine || '';
      const cardTypeLine = card.type_line || '';

      if (!normalizedPartName) {
        return false;
      }

      if (normalizedPartName === normalizedCardName && relatedTypeLine === cardTypeLine) {
        return false;
      }

      if (
        normalizedPartName === normalizeName(`A-${card.name || ''}`) &&
        relatedTypeLine === cardTypeLine
      ) {
        return false;
      }

      return true;
    });
}

function buildRelatedOptionFromEntry(queueEntry, entry) {
  const sourceCard = entry.relatedCard;
  if (!sourceCard) {
    return null;
  }

  const downloadPlan = extractFaceDownloads(sourceCard);
  if (downloadPlan.length === 0) {
    return null;
  }

  const previousSelections = (appData.state.relatedSelections || []).filter(
    (selection) => selection.stableKey === entry.stableKey && selection.queueIndex !== queueEntry.index
  );

  return {
    alreadySelectedBy: previousSelections.map((selection) => selection.cardName),
    artist: sourceCard.artist || 'Unknown Artist',
    collectorNumber: sourceCard.collector_number || '',
    downloadPlan,
    id: sourceCard.id,
    imageUrl: downloadPlan[0].previewUrl,
    isMultiFace: downloadPlan.length > 1,
    label: entry.part.name || sourceCard.name || 'Related Card',
    layout: sourceCard.layout || 'unknown',
    releasedAt: sourceCard.released_at || null,
    setCode: sourceCard.set || 'unknown',
    setName: sourceCard.set_name || 'Unknown Set',
    stableKey: entry.stableKey,
    typeLine: entry.part.type_line || sourceCard.type_line || 'Related Card',
  };
}

function findMatchingCardIndexes(queueEntry) {
  const exactNameMatches = new Set();
  const faceMatches = new Set();
  const normalizedName = queueEntry.normalizedName;

  for (const index of appData.cardsByName.get(normalizedName) || []) {
    exactNameMatches.add(index);
  }

  for (const index of appData.cardsByFaceName.get(normalizedName) || []) {
    faceMatches.add(index);
  }

  if (normalizedName.includes(' // ')) {
    const faceParts = normalizedName.split(' // ');
    const leftIndexes = new Set(appData.cardsByFaceName.get(faceParts[0]) || []);
    const rightIndexes = appData.cardsByFaceName.get(faceParts[1]) || [];

    for (const index of rightIndexes) {
      if (leftIndexes.has(index)) {
        exactNameMatches.add(index);
      }
    }
  }

  const matches = exactNameMatches.size > 0 ? exactNameMatches : faceMatches;
  const oracleIds = new Set();
  for (const index of matches) {
    const oracleId = appData.cards[index]?.oracle_id;
    if (oracleId) {
      oracleIds.add(oracleId);
    }
  }

  for (const oracleId of oracleIds) {
    for (const index of appData.cardsByOracleId.get(oracleId) || []) {
      matches.add(index);
    }
  }

  return Array.from(matches.values()).filter((index) => isPrimaryPrintCandidate(appData.cards[index]));
}

function buildOptionFromCard(queueEntry, card) {
  if (!isPrimaryPrintCandidate(card)) {
    return null;
  }

  const faceDownloads = extractFaceDownloads(card);
  const hasNameSlash = queueEntry.name.includes('//') || (card.name || '').includes('//');
  const isDoubleSided =
    hasNameSlash ||
    MULTI_FACE_LAYOUTS.has(card.layout) ||
    faceDownloads.length > 1;

  if (faceDownloads.length === 0) {
    return null;
  }

  const artists = Array.from(
    new Set(faceDownloads.map((face) => face.artist).filter(Boolean))
  );

  return {
    cardId: card.id,
    collectorNumber: card.collector_number || '',
    finishes: Array.isArray(card.finishes) ? card.finishes : [],
    id: card.id,
    label: `${card.set_name || card.set || 'Unknown Set'} ${card.collector_number || ''}`.trim(),
    artist: artists.join(' / ') || card.artist || 'Unknown Artist',
    downloadPlan: faceDownloads,
    faceCount: faceDownloads.length,
    folderName: isDoubleSided ? 'double-sided' : 'single-faced',
    imageUrls: faceDownloads.map((face) => face.previewUrl),
    imageUrl: faceDownloads[0].previewUrl,
    isDoubleSided,
    layout: card.layout || 'unknown',
    promo: Boolean(card.promo),
    releasedAt: card.released_at || null,
    setCode: card.set || 'unknown',
    setName: card.set_name || 'Unknown Set',
  };
}

function extractFaceDownloads(card) {
  const downloads = [];
  const shouldPreferFaceImages =
    MULTI_FACE_LAYOUTS.has(card.layout) &&
    Array.isArray(card.card_faces) &&
    card.card_faces.some((face) => face.image_uris);

  if (shouldPreferFaceImages) {
    return extractCardFaceDownloads(card);
  }

  if (card.image_uris) {
    const previewUrl = choosePreviewUrl(card.image_uris);
    const downloadUrl = chooseDownloadUrl(card.image_uris);

    if (previewUrl && downloadUrl) {
      downloads.push({
        artist: card.artist || null,
        downloadUrl,
        faceName: card.name || null,
        previewUrl,
        saveStem: sanitizeSegment(card.name || 'card'),
      });
    }
  }

  if (downloads.length > 0) {
    return downloads;
  }

  if (!Array.isArray(card.card_faces)) {
    return downloads;
  }

  return extractCardFaceDownloads(card);
}

function extractCardFaceDownloads(card) {
  const downloads = [];

  card.card_faces.forEach((face, index) => {
    if (!face.image_uris) {
      return;
    }

    const previewUrl = choosePreviewUrl(face.image_uris);
    const downloadUrl = chooseDownloadUrl(face.image_uris);

    if (!previewUrl || !downloadUrl) {
      return;
    }

    downloads.push({
      artist: face.artist || card.artist || null,
      downloadUrl,
      faceName: face.name || `face-${index + 1}`,
      previewUrl,
      saveStem: sanitizeSegment(face.name || `face-${index + 1}`),
    });
  });

  return downloads;
}

function choosePreviewUrl(imageUris) {
  return imageUris.png || null;
}

function chooseDownloadUrl(imageUris) {
  return imageUris.png || null;
}

function compareOptions(left, right) {
  return (
    (right.releasedAt || '').localeCompare(left.releasedAt || '') ||
    left.setCode.localeCompare(right.setCode) ||
    left.collectorNumber.localeCompare(right.collectorNumber) ||
    left.setName.localeCompare(right.setName) ||
    left.id.localeCompare(right.id)
  );
}

function compareRelatedOptions(left, right) {
  return (
    left.label.localeCompare(right.label) ||
    left.typeLine.localeCompare(right.typeLine) ||
    left.id.localeCompare(right.id)
  );
}

async function handleSelection(body, response) {
  const current = getCurrentQueueEntry();
  if (!current) {
    return sendJson(response, 409, { error: 'Queue already complete' });
  }

  if (!body || body.cardName !== current.name || typeof body.optionId !== 'string') {
    return sendJson(response, 400, { error: 'Invalid selection payload' });
  }

  const matchingCardIndexes = findMatchingCardIndexes(current);
  const selectedOption = buildCardOptions(current, matchingCardIndexes).find((option) => option.id === body.optionId);
  if (!selectedOption) {
    return sendJson(response, 404, { error: 'Print option not found for current card' });
  }

  const requestedRelatedIds = Array.isArray(body.relatedIds)
    ? body.relatedIds.filter((value) => typeof value === 'string')
    : [];
  const availableRelatedOptions = buildRelatedOptions(current, matchingCardIndexes);
  const relatedOptionsToSave = availableRelatedOptions.filter((option) => requestedRelatedIds.includes(option.id));
  const savedFiles = [];
  const savedRelatedFiles = [];
  const relatedSelectionRecords = [];

  try {
    savedFiles.push(...await downloadSelection(current, selectedOption));

    for (const relatedOption of relatedOptionsToSave) {
      const relatedSavedFiles = await downloadRelatedSelection(current, relatedOption);
      savedRelatedFiles.push(...relatedSavedFiles);
      relatedSelectionRecords.push({
        cardName: current.name,
        chosenAt: new Date().toISOString(),
        label: relatedOption.label,
        queueIndex: current.index,
        relatedId: relatedOption.id,
        savedFiles: relatedSavedFiles,
        stableKey: relatedOption.stableKey,
        typeLine: relatedOption.typeLine,
      });
    }

    appData.state.relatedSelections.push(...relatedSelectionRecords);
    appData.state.selections.push({
      cardName: current.name,
      chosenAt: new Date().toISOString(),
      folderName: selectedOption.folderName,
      optionId: selectedOption.id,
      queueIndex: current.index,
      savedFiles,
      setName: selectedOption.setName,
    });
    appData.state.currentIndex += 1;
    persistState();
  } catch (error) {
    cleanupSavedPaths(savedRelatedFiles);
    cleanupSavedPaths(savedFiles);
    throw error;
  }

  return sendJson(response, 200, {
    next: buildStatePayload(),
    savedRelatedFiles,
    savedFiles,
    status: 'ok',
  });
}

async function downloadSelection(queueEntry, option) {
  const safeCardName = sanitizeSegment(queueEntry.name);
  const basePrefix = `${String(queueEntry.index + 1).padStart(3, '0')}-${safeCardName}`;

  if (option.isDoubleSided) {
    const cardFolder = path.join(OUTPUT_ROOT, 'double-sided', basePrefix);
    const tempFolder = `${cardFolder}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tempFolder, { force: true, recursive: true });
    fs.mkdirSync(tempFolder, { recursive: true });
    const savedFiles = [];

    try {
      for (const [index, face] of option.downloadPlan.entries()) {
        const fileName = `${String(index + 1).padStart(2, '0')}-${face.saveStem}${extensionFromUrl(face.downloadUrl)}`;
        const tempPath = path.join(tempFolder, fileName);
        await downloadToFile(face.downloadUrl, tempPath);
        savedFiles.push(path.join(cardFolder, fileName));
      }

      fs.rmSync(cardFolder, { force: true, recursive: true });
      fs.renameSync(tempFolder, cardFolder);
      return savedFiles;
    } catch (error) {
      fs.rmSync(tempFolder, { force: true, recursive: true });
      throw error;
    }
  }

  const folder = path.join(OUTPUT_ROOT, 'single-faced');
  const onlyFace = option.downloadPlan[0];
  const fileName = `${basePrefix}--${sanitizeSegment(option.setCode)}-${sanitizeSegment(option.collectorNumber)}${extensionFromUrl(onlyFace.downloadUrl)}`;
  const targetPath = path.join(folder, fileName);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await downloadToFile(onlyFace.downloadUrl, tempPath);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  return [targetPath];
}

async function downloadRelatedSelection(queueEntry, option) {
  const safeCardName = sanitizeSegment(queueEntry.name);
  const safeRelatedName = sanitizeSegment(option.label);
  const basePrefix = `${String(queueEntry.index + 1).padStart(3, '0')}-${safeCardName}--${safeRelatedName}`;

  if (option.downloadPlan.length > 1) {
    const relatedFolder = path.join(OUTPUT_ROOT, 'related-cards', basePrefix);
    const tempFolder = `${relatedFolder}.tmp-${process.pid}-${Date.now()}`;
    fs.rmSync(tempFolder, { force: true, recursive: true });
    fs.mkdirSync(tempFolder, { recursive: true });
    const savedFiles = [];

    try {
      for (const [index, face] of option.downloadPlan.entries()) {
        const fileName = `${String(index + 1).padStart(2, '0')}-${face.saveStem}${extensionFromUrl(face.downloadUrl)}`;
        const tempPath = path.join(tempFolder, fileName);
        await downloadToFile(face.downloadUrl, tempPath);
        savedFiles.push(path.join(relatedFolder, fileName));
      }

      fs.rmSync(relatedFolder, { force: true, recursive: true });
      fs.renameSync(tempFolder, relatedFolder);
      return savedFiles;
    } catch (error) {
      fs.rmSync(tempFolder, { force: true, recursive: true });
      throw error;
    }
  }

  const onlyFace = option.downloadPlan[0];
  const fileName = `${basePrefix}--${sanitizeSegment(option.setCode)}-${sanitizeSegment(option.collectorNumber)}${extensionFromUrl(onlyFace.downloadUrl)}`;
  const targetPath = path.join(OUTPUT_ROOT, 'related-cards', fileName);
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await downloadToFile(onlyFace.downloadUrl, tempPath);
    fs.renameSync(tempPath, targetPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  return [targetPath];
}

async function handleSkip(body, response) {
  const current = getCurrentQueueEntry();
  if (!current) {
    return sendJson(response, 409, { error: 'Queue already complete' });
  }

  if (!body || body.cardName !== current.name) {
    return sendJson(response, 400, { error: 'Invalid skip payload' });
  }

  appData.state.skips.push({
    cardName: current.name,
    queueIndex: current.index,
    skippedAt: new Date().toISOString(),
  });
  appData.state.currentIndex += 1;
  persistState();

  return sendJson(response, 200, {
    next: buildStatePayload(),
    status: 'ok',
  });
}

function getCurrentQueueEntry() {
  return appData.queue[appData.state.currentIndex] || null;
}

async function downloadToFile(url, targetPath) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'ProxyPicker/1.0',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download image: ${url}`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));
}

function cleanupSavedPaths(paths) {
  for (const savedPath of paths) {
    if (!savedPath || !fs.existsSync(savedPath)) {
      continue;
    }

    const stat = fs.statSync(savedPath);
    if (stat.isDirectory()) {
      fs.rmSync(savedPath, { force: true, recursive: true });
      continue;
    }

    fs.rmSync(savedPath, { force: true });

    let parentDir = path.dirname(savedPath);
    while (parentDir.startsWith(OUTPUT_ROOT) && parentDir !== OUTPUT_ROOT) {
      if (fs.existsSync(parentDir) && fs.readdirSync(parentDir).length === 0) {
        fs.rmdirSync(parentDir);
        parentDir = path.dirname(parentDir);
        continue;
      }

      break;
    }
  }
}

function persistState() {
  writeState(appData.state);
}

function readState() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const hasNoProgress =
    !Number.isInteger(state.currentIndex) || state.currentIndex === 0 &&
    (!Array.isArray(state.selections) || state.selections.length === 0) &&
    (!Array.isArray(state.skips) || state.skips.length === 0);
  const inputFingerprint = typeof state.inputFingerprint === 'string' && state.inputFingerprint
    ? state.inputFingerprint
    : hasNoProgress
      ? activeInputFingerprint
      : '';

  return {
    currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : 0,
    inputFingerprint,
    relatedSelections: Array.isArray(state.relatedSelections) ? state.relatedSelections : [],
    selections: Array.isArray(state.selections) ? state.selections : [],
    skips: Array.isArray(state.skips) ? state.skips : [],
  };
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function normalizeName(value) {
  return value
    .normalize('NFKC')
    .replace(/\s*\/\/\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildInputFingerprint(dataPath) {
  const listStats = fs.statSync(CARD_LIST_PATH);
  const jsonStats = fs.statSync(dataPath);

  return [
    `${CARD_LIST_PATH}:${listStats.size}:${listStats.mtimeMs}`,
    `${dataPath}:${jsonStats.size}:${jsonStats.mtimeMs}`,
  ].join('|');
}

function buildCardCacheFingerprint(dataPath) {
  return `${CARD_CACHE_SCHEMA_VERSION}|${buildInputFingerprint(dataPath)}`;
}

function buildWarningMessage() {
  return appData.state.inputFingerprint !== activeInputFingerprint
    ? 'Input files changed since the last saved progress. Reset progress if this queue looks wrong.'
    : null;
}

function discoverCardDataPaths() {
  const fileNames = fs.readdirSync(ROOT_DIR);
  return fileNames
    .filter((fileName) => /^default-cards-.*\.json$/.test(fileName))
    .sort()
    .reverse()
    .map((fileName) => path.join(ROOT_DIR, fileName));
}

async function ensureDefaultCardData() {
  for (const existingPath of discoverCardDataPaths()) {
    if (isReadableJsonArrayFile(existingPath)) {
      return existingPath;
    }

    console.warn(`Ignoring unreadable bulk file: ${existingPath}`);
  }

  console.log('No default-cards bulk file found. Downloading the latest copy from Scryfall...');
  const bulkResponse = await fetch(BULK_DATA_URL, {
    headers: {
      'User-Agent': 'ProxyPicker/1.0',
    },
  });

  if (!bulkResponse.ok) {
    throw new Error(`Failed to fetch Scryfall bulk data index: ${bulkResponse.status}`);
  }

  const bulkPayload = await bulkResponse.json();
  const defaultCardsEntry = Array.isArray(bulkPayload.data)
    ? bulkPayload.data.find((entry) => entry.type === 'default_cards')
    : null;

  if (!defaultCardsEntry || typeof defaultCardsEntry.download_uri !== 'string') {
    throw new Error('Scryfall bulk data index did not include a default_cards download URI.');
  }

  const targetFileName = path.basename(new URL(defaultCardsEntry.download_uri).pathname);
  const finalPath = path.join(ROOT_DIR, targetFileName);
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    await downloadToFile(defaultCardsEntry.download_uri, tempPath);
    fs.renameSync(tempPath, finalPath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }

  console.log(`Downloaded Scryfall bulk data to ${finalPath}`);
  return finalPath;
}

function isReadableJsonArrayFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 2) {
      return false;
    }

    const fileHandle = fs.openSync(filePath, 'r');
    try {
      const startBuffer = Buffer.alloc(256);
      const endBuffer = Buffer.alloc(256);
      fs.readSync(fileHandle, startBuffer, 0, startBuffer.length, 0);
      fs.readSync(fileHandle, endBuffer, 0, endBuffer.length, Math.max(0, stat.size - endBuffer.length));
      const startText = startBuffer.toString('utf8').trimStart();
      const endText = endBuffer.toString('utf8').trimEnd();
      return startText.startsWith('[') && endText.endsWith(']');
    } finally {
      fs.closeSync(fileHandle);
    }
  } catch (_error) {
    return false;
  }
}

async function loadCardData(queue) {
  const cache = readCardCache();
  const cacheFingerprint = buildCardCacheFingerprint(activeScryfallPath);

  if (cache && cache.inputFingerprint === cacheFingerprint && Array.isArray(cache.cards)) {
    return {
      cards: cache.cards,
      filePath: activeScryfallPath,
    };
  }

  console.log('Building queue-specific card cache from bulk data...');
  const cards = await buildCardCacheFromBulk(activeScryfallPath, queue);
  writeCardCache({
    cards,
    inputFingerprint: cacheFingerprint,
  });

  return {
    cards,
    filePath: activeScryfallPath,
  };
}

function readCardCache() {
  if (!fs.existsSync(CARD_CACHE_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(CARD_CACHE_PATH, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeCardCache(cache) {
  fs.writeFileSync(CARD_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function buildCardCacheFromBulk(filePath, queue) {
  const queueNameSet = new Set(queue.map((entry) => entry.normalizedName));
  const directOracleIds = new Set();

  await streamBulkCards(filePath, (card) => {
    if (!isRelevantLanguage(card)) {
      return;
    }

    if (!matchesQueueEntry(card, queueNameSet)) {
      return;
    }

    if (typeof card.oracle_id === 'string' && card.oracle_id) {
      directOracleIds.add(card.oracle_id);
    }
  });

  const relatedIds = new Set();
  const includedCards = new Map();

  await streamBulkCards(filePath, (card) => {
    if (!isRelevantLanguage(card)) {
      return;
    }

    if (!directOracleIds.has(card.oracle_id)) {
      return;
    }

    const projectedCard = projectCardRecord(card);
    includedCards.set(projectedCard.id, projectedCard);

    for (const part of card.all_parts || []) {
      if (part && typeof part.id === 'string') {
        relatedIds.add(part.id);
      }
    }
  });

  await streamBulkCards(filePath, (card) => {
    if (!isRelevantLanguage(card)) {
      return;
    }

    if (!relatedIds.has(card.id)) {
      return;
    }

    const projectedCard = projectCardRecord(card);
    includedCards.set(projectedCard.id, projectedCard);
  });

  return Array.from(includedCards.values());
}

async function streamBulkCards(filePath, onCard) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let startedArray = false;
  let finishedArray = false;
  let inString = false;
  let isEscaped = false;
  let depth = 0;
  let buffer = '';

  for await (const chunk of stream) {
    for (const character of chunk) {
      if (!startedArray) {
        if (character === '[') {
          startedArray = true;
        }
        continue;
      }

      if (depth === 0) {
        if (character === ']') {
          finishedArray = true;
          continue;
        }

        if (finishedArray) {
          if (/\S/.test(character)) {
            throw new Error(`Unexpected trailing content in bulk file: ${filePath}`);
          }
          continue;
        }

        if (character === '{') {
          depth = 1;
          buffer = '{';
          inString = false;
          isEscaped = false;
          finishedArray = false;
        }
        continue;
      }

      buffer += character;

      if (inString) {
        if (isEscaped) {
          isEscaped = false;
        } else if (character === '\\') {
          isEscaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
        continue;
      }

      if (character === '{') {
        depth += 1;
        continue;
      }

      if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          onCard(JSON.parse(buffer));
          buffer = '';
        }
      }
    }
  }

  if (!startedArray) {
    throw new Error(`Bulk file is missing a top-level array: ${filePath}`);
  }

  if (depth !== 0 || buffer.trim()) {
    throw new Error(`Bulk file ended before a card object was fully parsed: ${filePath}`);
  }

  if (!finishedArray) {
    throw new Error(`Bulk file ended before the top-level array was closed: ${filePath}`);
  }
}

function isRelevantLanguage(card) {
  return card && (card.lang === 'en' || !card.lang);
}

function isPrimaryPrintCandidate(card) {
  if (!card) {
    return false;
  }

  if (card.layout === 'art_series' || card.layout === 'token') {
    return false;
  }

  return !String(card.type_line || '').startsWith('Token ');
}

function matchesQueueEntry(card, queueNameSet) {
  if (!isPrimaryPrintCandidate(card)) {
    return false;
  }

  for (const cardName of collectNormalizedNames(card, ['name', 'flavor_name'])) {
    if (queueNameSet.has(cardName)) {
      return true;
    }
  }

  if (!Array.isArray(card.card_faces)) {
    return false;
  }

  const faceNames = card.card_faces
    .flatMap((face) => Array.from(collectNormalizedNames(face, ['name', 'flavor_name'])));

  if (faceNames.some((name) => queueNameSet.has(name))) {
    return true;
  }

  if (faceNames.length > 1 && queueNameSet.has(faceNames.join(' // '))) {
    return true;
  }

  return false;
}

function projectCardRecord(card) {
  return {
    all_parts: Array.isArray(card.all_parts)
      ? card.all_parts.map((part) => ({
        component: part.component,
        id: part.id,
        name: part.name,
        object: part.object,
        type_line: part.type_line,
        uri: part.uri,
      }))
      : undefined,
    artist: card.artist,
    card_faces: Array.isArray(card.card_faces)
      ? card.card_faces.map((face) => ({
        artist: face.artist,
        flavor_name: face.flavor_name,
        image_uris: face.image_uris,
        name: face.name,
      }))
      : undefined,
    collector_number: card.collector_number,
    finishes: card.finishes,
    flavor_name: card.flavor_name,
    id: card.id,
    image_uris: card.image_uris,
    lang: card.lang,
    layout: card.layout,
    name: card.name,
    oracle_id: card.oracle_id,
    promo: card.promo,
    released_at: card.released_at,
    set: card.set,
    set_name: card.set_name,
    type_line: card.type_line,
  };
}

function sanitizeSegment(value) {
  return value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'item';
}

function extensionFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const extension = path.extname(parsedUrl.pathname);
    return extension || '.jpg';
  } catch (_error) {
    return '.jpg';
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on('data', (chunk) => {
      chunks.push(chunk);
    });

    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8').trim();
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(error);
      }
    });

    request.on('error', reject);
  });
}

function serveStaticAsset(pathname, response) {
  const filePath = pathname === '/'
    ? path.join(PUBLIC_DIR, 'index.html')
    : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(PUBLIC_DIR)) {
    return sendText(response, 403, 'Forbidden');
  }

  if (!fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).isDirectory()) {
    return sendText(response, 404, 'Not found');
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': STATIC_MIME_TYPES[extension] || 'application/octet-stream',
  });
  fs.createReadStream(normalizedPath).pipe(response);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendText(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(payload);
}
