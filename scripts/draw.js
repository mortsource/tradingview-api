const crypto = require('crypto');

process.loadEnvFile('./.env');

const STORAGE_URL = 'https://charts-storage.tradingview.com/charts-storage';
const SEARCH_URL = 'https://symbol-search.tradingview.com/symbol_search/v3/';
const LAYOUT_ID = process.env.TRADINGVIEW_LAYOUT_ID ?? '';
const JWT = process.env.TRADINGVIEW_JWT ?? '';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://www.tradingview.com',
    'Referer': 'https://www.tradingview.com/',
    'Cookie': process.env.TRADINGVIEW_COOKIE ?? ''
};
const TAG_FIELD = '_mzPositionLevel';
const LINE_TYPES = { horizontal: 'LineToolHorzLine', vertical: 'LineToolVertLine' };

function randomId(length) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
}

async function request(path, init = {}) {
    const url = `${STORAGE_URL}${path}${path.includes('?') ? '&' : '?'}chart_id=_shared&layout_id=${LAYOUT_ID}&jwt=${JWT}`;
    const response = await fetch(url, { ...init, headers: { ...HEADERS, ...init.headers } });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from charts-storage (TRADINGVIEW_JWT may be expired)`);
    return response;
}

async function resolveSymbol(symbol) {
    if (symbol.includes(':')) return symbol;

    const response = await fetch(`${SEARCH_URL}?text=${encodeURIComponent(symbol)}&hl=0&lang=en&domain=production`, { headers: HEADERS });
    const { symbols = [] } = await response.json();
    const match = symbols.find(match => match.symbol === symbol.toUpperCase());
    if (!match) throw new Error(`Symbol '${symbol}' not found on TradingView`);
    return `${match.prefix || match.exchange}:${match.symbol}`;
}

async function putSources(sources) {
    await request(`/layout/${LAYOUT_ID}/sources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources, drawing_groups: {}, clientId: `${LAYOUT_ID}/1/${randomId(16)}` })
    });
}

const COLORS = {
    red: '#FF0000',
    orange: '#FF8000',
    yellow: '#FFFF00',
    green: '#00FF00',
    teal: '#00FFFF',
    blue: '#0000FF',
    purple: '#8000FF',
    pink: '#FF00FF',
    white: '#FFFFFF',
    grey: '#808080',
    gray: '#808080',
    black: '#000000',
};

function wordToColor(word = 'white') {
    if (/^(#|rgb)/i.test(word)) return word;
    return COLORS[word.toLowerCase()] ?? COLORS.white;
}

async function drawLine(type, color, symbol, value) {
    if (!LINE_TYPES[type]) throw new Error(`Unknown line type '${type}' (available: ${Object.keys(LINE_TYPES).join(', ')})`);

    const id = randomId(6);
    const horizontal = type === 'horizontal';
    const time = new Date(horizontal ? Date.now() : value).getTime() / 1000;
    const price = horizontal ? Number(value) : 0;
    if (!Number.isFinite(time) || !Number.isFinite(price)) throw new Error(`Invalid ${horizontal ? 'price' : 'time'} '${value}'`);

    const source = { symbol: await resolveSymbol(symbol), currencyId: null, unitId: null, ownerSource: '_seriesId' };
    await putSources({
        [id]: {
            ...source,
            id,
            state: {
                id,
                type: LINE_TYPES[type],
                state: { symbol: source.symbol, interval: '60', linecolor: wordToColor(color) },
                points: [{ price, time_t: Math.floor(time), offset: 0, interval: '60' }],
                ownerSource: source.ownerSource,
                linkKey: randomId(12),
                sharingMode: 1,
                [TAG_FIELD]: true,
            },
        }
    });
    return id;
}

async function listLines(symbol) {
    const response = await request(`/get/layout/${LAYOUT_ID}/sources?symbol=${encodeURIComponent(await resolveSymbol(symbol))}`);
    const { payload } = await response.json();
    return Object.values(payload?.sources || {})
        .filter(source => source?.state?.[TAG_FIELD])
        .map(({ id, state }) => {
            const type = Object.keys(LINE_TYPES).find(type => LINE_TYPES[type] === state.type);
            const [point] = state.points;
            return { id, type, color: state.state?.linecolor, value: type === 'horizontal' ? point.price : new Date(point.time_t * 1000) };
        });
}

async function deleteLines(symbol, id) {
    const lines = (await listLines(symbol)).filter(line => !id || line.id === id);
    if (lines.length) await putSources(Object.fromEntries(lines.map(line => [line.id, null])));
    return lines.length;
}

module.exports = { drawLine, listLines, deleteLines };
