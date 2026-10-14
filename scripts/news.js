const fs = require('fs');
const path = require('path');
const { setTimeout: sleep } = require('timers/promises');
const { DatabaseSync } = require('node:sqlite');
const { EventSource } = require('eventsource');
const { REST, Routes } = require('discord.js');

process.loadEnvFile('./.env');

const SCREENS_URL = 'https://news-mediator.tradingview.com/news-flow/v2/screens?streaming=true';
const NEWS_URL = 'https://news-mediator.tradingview.com/news-flow/v2/news';
const STORY_URL = 'https://news-mediator.tradingview.com/public/news/v1/story';
const STREAM_URL = 'https://notifications.tradingview.com/news/channel';
const HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Origin': 'https://www.tradingview.com/',
    'Referer': 'https://www.tradingview.com/',
    'Cookie': process.env.TRADINGVIEW_COOKIE ?? ''
};
const FILTER_ORDER = ['corp_activity', 'economic_category', 'lang', 'market', 'market_country', 'priority', 'sector', 'provider', 'symbol', 'watchlist'];
const DB_PATH = path.join(__dirname, './tradingview.db');
const MAX_DESCRIPTION_LENGTH = 500;
const RECONNECT_DELAY_MS = 60 * 1000;
const URGENT_EMOJI = ':fire:';
const FLASH_EMOJI = ':zap:';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('CREATE TABLE IF NOT EXISTS news (story_id TEXT PRIMARY KEY, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)');
const markSeen = db.prepare('INSERT OR IGNORE INTO news (story_id) VALUES (?)');

const discord = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function get(url) {
    const response = await fetch(url, { headers: HEADERS });
    if (response.status === 403) throw new Error(`403 Forbidden from ${url} (TRADINGVIEW_COOKIE may be expired)`);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
    return response.json();
}

function renderNode(node) {
    if (typeof node === 'string') return node;

    const inner = (node.children || []).map(renderNode).join('') || node.params?.text || '';
    switch (node.type) {
        case 'symbol':
            return node.params?.symbol
                ? `[${inner || node.params.symbol}](https://www.tradingview.com/symbols/${node.params.symbol.replace(':', '-')}/)`
                : inner;
        case 'url':
        case 'link': {
            const url = node.params?.url || node.url;
            const text = node.params?.linkText || inner;
            return url && text ? `[${text}](${url})` : text;
        }
        case 'strong':
        case 'b':
            return `**${inner}**`;
        case 'em':
        case 'i':
            return `*${inner}*`;
        case 'br':
        case 'linebreak':
            return '\n';
        default:
            return inner;
    }
}

function renderDescription(story) {
    const blocks = [];
    for (const node of story.ast_description?.children || []) {
        if (node.type === 'p') blocks.push(renderNode(node).trim());
        else if (node.type === 'quote') blocks.push(`> ${renderNode(node).trim()}`);
        else if (node.type === 'list') blocks.push(...(node.children || []).map(item => `• ${renderNode(item).trim()}`));
    }

    const text = blocks.filter(block => block.replace(/^[>•]\s*/, '')).join('\n\n');
    if (text.length > MAX_DESCRIPTION_LENGTH) return `${text.slice(0, MAX_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
    return text || story.short_description?.trim() || 'No description available';
}

function sessionColor() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay();
    const minutes = et.getHours() * 60 + et.getMinutes();
    const weekday = day >= 1 && day <= 5;

    if ((day <= 4 && minutes >= 20 * 60) || (weekday && minutes < 4 * 60)) return 0xEE33FF; // Vivid Magenta
    if (weekday && minutes < 9 * 60 + 30) return 0x39FF14; // Bright Neon Green
    if (weekday && minutes < 16 * 60) return 0x66FF77; // Bright Light Green
    if (weekday && minutes < 20 * 60) return 0x9966FF; // Vivid Blue-Purple
    return 0xE0E0E0; // Very Light Grey
}

function buildEmbed(story) {
    const title = [story.urgency === 1 && URGENT_EMOJI, story.is_flash && FLASH_EMOJI, story.title?.trim() || 'No title available'];
    return {
        author: { name: 'TradingView', url: 'https://tradingview.com' },
        color: sessionColor(),
        url: story.story_path ? `https://tradingview.com${story.story_path}` : (story.link || 'https://tradingview.com/news'),
        title: title.filter(Boolean).join(' ').slice(0, 256),
        description: renderDescription(story),
        footer: { text: story.provider?.name || 'Unknown Source' },
        timestamp: new Date(Number.isFinite(story.published) ? story.published * 1000 : Date.now()).toISOString(),
    };
}

async function handleStory(storyId, channelId) {
    if (!storyId || !markSeen.run(storyId).changes) return;

    await sleep(500);
    const story = await get(`${STORY_URL}?id=${encodeURIComponent(storyId)}&lang=en&user_prostatus=non_pro`);
    const embed = buildEmbed(story);

    await discord.post(Routes.channelMessages(channelId), { body: { embeds: [embed] } });
    if (story.urgency < 2 && process.env.DISCORD_MAIN_CHANNEL_ID) {
        await discord.post(Routes.channelMessages(process.env.DISCORD_MAIN_CHANNEL_ID), {
            body: { embeds: [embed] }
        });
    }
}

async function NewsFlow(flowName) {
    try {
        const channelId = process.env.DISCORD_NEWS_CHANNEL_ID;
        if (!channelId) throw new Error(`No Discord channel configured for '${flowName}'`);

        const screens = await get(SCREENS_URL);
        const flow = screens.items?.find(item => item.title === flowName);
        if (!flow) throw new Error(`Flow '${flowName}' not found (available: ${screens.items?.map(item => item.title).join(', ')})`);
        if (flow.invalid) throw new Error(`Flow '${flowName}' is invalid on TradingView: ${flow.invalid_reason}`);

        const filters = flow.filters
            .filter(filter => filter.values?.length)
            .sort((a, b) => FILTER_ORDER.indexOf(a.id) - FILTER_ORDER.indexOf(b.id))
            .map(filter => `filter=${filter.id}%3A${encodeURIComponent([...filter.values].sort().join(','))}`);
        const news = await get(`${NEWS_URL}?${filters.join('&')}&client=screener&streaming=true&user_prostatus=non_pro`);
        if (!news.streaming?.channel) throw new Error(`No streaming channel returned for '${flowName}'`);

        const stream = new EventSource(`${STREAM_URL}/${news.streaming.channel}`, {
            fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, ...HEADERS } })
        });

        stream.onopen = () => console.log(`[LOG] [NEWS] Streaming '${flowName}' on channel ${news.streaming.channel}`);

        stream.onmessage = async (event) => {
            try {
                let data = JSON.parse(event.data);
                if (typeof data === 'string') data = JSON.parse(data);
                await handleStory(data.news?.story_id ?? data.news?.id, channelId);
            } catch (error) {
                console.error(`[ERROR] [NEWS] Failed to handle '${flowName}' event:`, error);
            }
        };

        stream.onerror = (error) => {
            if (stream.readyState !== EventSource.CLOSED) return;
            console.error(`[ERROR] [NEWS] Stream '${flowName}' closed (${error.message || error.code || 'unknown'}), restarting in ${RECONNECT_DELAY_MS / 1000}s`);
            setTimeout(() => NewsFlow(flowName), RECONNECT_DELAY_MS);
        };
    } catch (error) {
        console.error(`[ERROR] [NEWS] Could not start '${flowName}':`, error.message);
    }
}

module.exports = { NewsFlow };
