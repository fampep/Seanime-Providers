const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { spawnSync } = require("child_process");

// ---------- AllAnime hex map ----------
const ALLANIME_HEX_MAP = {
  79: "A", "7a": "B", "7b": "C", "7c": "D", "7d": "E", "7e": "F", "7f": "G",
  70: "H", 71: "I", 72: "J", 73: "K", 74: "L", 75: "M", 76: "N", 77: "O",
  68: "P", 69: "Q", "6a": "R", "6b": "S", "6c": "T", "6d": "U", "6e": "V", "6f": "W",
  60: "X", 61: "Y", 62: "Z", 59: "a", "5a": "b", "5b": "c", "5c": "d", "5d": "e", "5e": "f", "5f": "g",
  50: "h", 51: "i", 52: "j", 53: "k", 54: "l", 55: "m", 56: "n", 57: "o",
  48: "p", 49: "q", "4a": "r", "4b": "s", "4c": "t", "4d": "u", "4e": "v", "4f": "w",
  40: "x", 41: "y", 42: "z", "08": "0", "09": "1", "0a": "2", "0b": "3", "0c": "4",
  "0d": "5", "0e": "6", "0f": "7", "00": "8", "01": "9", 15: "-", 16: ".", 67: "_",
  46: "~", "02": ":", 17: "/", "07": "?", "1b": "#", 63: "[", 65: "]", 78: "@",
  19: "!", "1c": "$", "1e": "&", 10: "(", 11: ")", 12: "*", 13: "+", 14: ",",
  "03": ";", "05": "=", "1d": "%",
};

function decodeAllanimeUrl(encoded) {
  if (encoded.startsWith("--")) encoded = encoded.slice(2);
  let result = "";
  for (let i = 0; i < encoded.length; i += 2) {
    const pair = encoded.slice(i, i + 2);
    result += ALLANIME_HEX_MAP[pair] !== undefined ? ALLANIME_HEX_MAP[pair] : pair;
  }
  return result.replace(/\\u002F/gi, "/").replace(/\\\|/g, "");
}

// ---------- AES-256-CTR decryption for "tobeparsed" ----------
const ALLANIME_KEY = crypto.createHash("sha256").update("Xot36i3lK3:v1").digest();

function decodeTobeparsed(blob) {
  try {
    const buf = Buffer.from(blob, "base64");
    const iv12 = buf.slice(1, 13);
    const iv16 = Buffer.concat([iv12, Buffer.from([0, 0, 0, 2])]);
    const ct = buf.slice(13, buf.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-ctr", ALLANIME_KEY, iv16);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    const sources = [];
    for (const chunk of plain.split(/[{}]/)) {
      const urlMatch = chunk.match(/"sourceUrl"\s*:\s*"(--[^"]+)"/);
      const nameMatch = chunk.match(/"sourceName"\s*:\s*"([^"]+)"/);
      const prioMatch = chunk.match(/"priority"\s*:\s*([0-9.]+)/);
      if (urlMatch) {
        sources.push({
          sourceUrl: urlMatch[1],
          sourceName: nameMatch ? nameMatch[1] : "",
          priority: prioMatch ? parseFloat(prioMatch[1]) : 0,
        });
      }
    }
    return sources;
  } catch {
    return [];
  }
}

function parseEpisodeSourceUrls(body) {
  const tbMatch = body.match(/"tobeparsed"\s*:\s*"([^"]+)"/);
  if (tbMatch) {
    const sources = decodeTobeparsed(tbMatch[1]);
    if (sources.length) return sources;
  }
  try {
    const sourceUrls = JSON.parse(body)?.data?.episode?.sourceUrls;
    return sourceUrls?.length ? sourceUrls : null;
  } catch {
    return null;
  }
}

// ---------- HTTP GET with redirect following ----------
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    function doGet(url) {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
          Referer: "https://allmanga.to",
          Origin: "https://allmanga.to",
          Accept: "*/*",
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).href;
          res.resume();
          doGet(loc);
          return;
        }
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    }
    doGet(urlStr);
  });
}

function followRedirects(urlStr, maxHops = 10) {
  return new Promise((resolve, reject) => {
    let hops = 0;
    function step(url) {
      if (++hops > maxHops) return resolve(url);
      let u;
      try { u = new URL(url); } catch { return reject(new Error("invalid url")); }
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "HEAD",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
          Referer: "https://allmanga.to",
        },
      }, (res) => {
        res.resume();
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location.startsWith("http") ? res.headers.location : new URL(res.headers.location, url).href;
          step(loc);
        } else {
          resolve(url);
        }
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    }
    step(urlStr);
  });
}

function resolveWithYtdlp(youtubeUrl) {
  return new Promise((resolve) => {
    const which = spawnSync(process.platform === "win32" ? "where" : "which", ["yt-dlp"], { encoding: "utf8" });
    if (which.status !== 0) return resolve(null);
    const result = spawnSync("yt-dlp", [
      "--no-playlist",
      "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "-g", youtubeUrl,
    ], { encoding: "utf8", timeout: 30000 });
    if (result.status !== 0 || !result.stdout?.trim()) return resolve(null);
    resolve(result.stdout.trim().split("\n")[0]);
  });
}

// ---------- GraphQL helpers ----------
const SEARCH_GQL = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){edges{_id name availableEpisodes __typename}}}`;
const EPISODE_GQL = `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){episode(showId:$showId translationType:$translationType episodeString:$episodeString){episodeString sourceUrls}}`;
const EPISODE_GQL_HASH = "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec";

function allanimeGQL(variables, query) {
  const body = JSON.stringify({ variables, query });
  return new Promise((resolve, reject) => {
    const u = new URL("https://api.allanime.day/api");
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
        Referer: "https://allmanga.to",
        Origin: "https://allmanga.to",
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(body);
    req.end();
  });
}

async function allanimeGQLEpisode(variables) {
  try {
    const encodedVars = encodeURIComponent(JSON.stringify(variables));
    const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: EPISODE_GQL_HASH } });
    const encodedExt = encodeURIComponent(extensions);
    const getUrl = `https://api.allanime.day/api?variables=${encodedVars}&extensions=${encodedExt}`;
    const getRes = await new Promise((resolve, reject) => {
      const u = new URL(getUrl);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
          Referer: "https://allmanga.to",
          Origin: "https://youtu-chan.com",
        },
      }, (res) => {
        let data = "";
        res.on("data", c => data += c);
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    });
    if (getRes.body && getRes.body.includes("tobeparsed")) return getRes;
  } catch {}
  return allanimeGQL(variables, EPISODE_GQL);
}

// ---------- Source priority and resolution ----------
const PROVIDER_PRIORITY = ["S-mp4", "Luf-Mp4", "Yt-mp4", "Default", "Sl-Hls"];

async function trySourceUrls(sourceUrls) {
  const decoded = sourceUrls
    .filter(s => s.sourceUrl?.startsWith("--"))
    .map(s => ({
      sourceName: s.sourceName || "",
      priority: s.priority || 0,
      path: decodeAllanimeUrl(s.sourceUrl).replace("/clock", "/clock.json"),
    }))
    .sort((a, b) => {
      const ai = PROVIDER_PRIORITY.indexOf(a.sourceName);
      const bi = PROVIDER_PRIORITY.indexOf(b.sourceName);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

  for (const src of decoded) {
    let fetchUrl = src.path;
    if (fetchUrl.startsWith("//")) fetchUrl = "https:" + fetchUrl;
    else if (fetchUrl.startsWith("/")) fetchUrl = "https://allanime.day" + fetchUrl;
    else if (!fetchUrl.startsWith("http")) fetchUrl = "https://allanime.day/" + fetchUrl;

    try {
      if (fetchUrl.includes("fast4speed.rsvp") || src.sourceName === "Yt-mp4") {
        const finalUrl = await followRedirects(fetchUrl).catch(() => null);
        if (!finalUrl) continue;
        let isGoogleVideoHost = false;
        try {
          const host = new URL(finalUrl).hostname.toLowerCase();
          isGoogleVideoHost = host === "googlevideo.com" || host.endsWith(".googlevideo.com");
        } catch {}
        if (/\.(mp4|webm|mkv|m3u8)(\?|$)/i.test(finalUrl) || isGoogleVideoHost ||
            (!finalUrl.includes("youtube.com/watch") && !finalUrl.includes("youtu.be/"))) {
          return {
            ok: true,
            url: finalUrl,
            resolution: "?",
            sourceName: src.sourceName,
            isDirectMp4: !finalUrl.includes(".m3u8"),
            referer: "https://allmanga.to",
          };
        }
        const ytStream = await resolveWithYtdlp(finalUrl).catch(() => null);
        if (ytStream) {
          return {
            ok: true,
            url: ytStream,
            resolution: "?",
            sourceName: src.sourceName,
            isDirectMp4: true,
            referer: "https://www.youtube.com",
          };
        }
        continue;
      }

      const linkRes = await httpsGet(fetchUrl);
      if (linkRes.status !== 200 || !linkRes.body) continue;
      let linkJson;
      try { linkJson = JSON.parse(linkRes.body); } catch { continue; }
      const links = linkJson?.links;
      if (!links?.length) continue;
      const allLinks = links.filter(l => l.link);
      const mp4Links = allLinks.filter(l => !l.link.includes(".m3u8") && !l.link.includes("master."));
      const best = (mp4Links.length ? mp4Links : allLinks).sort((a, b) => (parseInt(b.resolutionStr) || 0) - (parseInt(a.resolutionStr) || 0))[0];
      if (!best) continue;
      return {
        ok: true,
        url: best.link,
        resolution: best.resolutionStr || "?",
        sourceName: src.sourceName,
        isDirectMp4: !best.link.includes(".m3u8"),
        referer: "https://allmanga.to",
      };
    } catch { continue; }
  }
  return null;
}

// ---------- AniList season title resolution ----------
function anilistSeasonTitle(baseTitle, seasonNumber) {
  return new Promise((resolve) => {
    const query = `query($search:String){Media(search:$search,type:ANIME,sort:SEARCH_MATCH){title{english romaji}episodes relations{edges{relationType node{type format title{english romaji}episodes startDate{year}seasonYear}}}}}`;
    const body = JSON.stringify({ query, variables: { search: baseTitle } });
    const opts = {
      hostname: "graphql.anilist.co",
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const fallback = { title: baseTitle, romaji: null, episodes: null, nextTitle: null, nextRomaji: null };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const media = json?.data?.Media;
          if (!media) return resolve(fallback);
          const s1Romaji = media.title?.romaji || null;
          const s1Episodes = media.episodes || null;
          const sequels = (media.relations?.edges || [])
            .filter(e => e.relationType === "SEQUEL" && e.node.type === "ANIME" && (e.node.format === "TV" || e.node.format === "TV_SHORT"))
            .sort((a, b) => (a.node.startDate?.year || a.node.seasonYear || 9999) - (b.node.startDate?.year || b.node.seasonYear || 9999));
          const getTitle = node => node.title?.english || node.title?.romaji || null;
          const getRomaji = node => node.title?.romaji || null;
          if (seasonNumber <= 1) {
            const next = sequels[0]?.node ?? null;
            return resolve({
              title: media.title?.english || baseTitle,
              romaji: s1Romaji,
              episodes: s1Episodes,
              nextTitle: next ? getTitle(next) : null,
              nextRomaji: next ? getRomaji(next) : null,
            });
          }
          const target = sequels[seasonNumber - 2];
          if (!target) return resolve({ ...fallback, romaji: s1Romaji });
          const nextNode = sequels[seasonNumber - 1]?.node ?? null;
          resolve({
            title: getTitle(target.node) || baseTitle,
            romaji: getRomaji(target.node) || s1Romaji,
            episodes: target.node.episodes || null,
            nextTitle: nextNode ? getTitle(nextNode) : null,
            nextRomaji: nextNode ? getRomaji(nextNode) : null,
          });
        } catch { resolve(fallback); }
      });
    });
    req.on("error", () => resolve(fallback));
    req.setTimeout(8000, () => { req.destroy(); resolve(fallback); });
    req.write(body);
    req.end();
  });
}

// ---------- Hardcoded show IDs & split seasons ----------
const HARDCODED_SHOW_IDS = {
  "jojo's bizarre adventure": [
    "MeX4czvkwKGo3zdDp", // S1
    "zyqDjR8te4z6taKyk", // S2
    "GTAQH8Z9K6WbAdXsS", // S3
    "JS9PzKiPanesGRvs5", // S4
    "b6xFsr7MDSMcJArB9", // S5
    "pwduJkjBLytqiWCvM", // S6
  ],
};

const SPLIT_SEASONS = {
  "spy x family": {
    1: [
      { from: 1, showId: null, offset: 0 },
      { from: 13, showId: "H8Aey6QXE7HSqwvW3", offset: 12 },
    ],
  },
};

function sanitizeTitle(t) {
  return t.replace(/[''`´]/g, "").replace(/[:!.]/g, "").replace(/\s+/g, " ").trim();
}

// ---------- Helper to resolve episode from known showId ----------
async function resolveEpisodeFromId(showId, epStr, dubSub) {
  const candidates = [epStr];
  if (!epStr.includes(".")) candidates.push(epStr + ".0");
  let sourceUrls = null;
  for (const attempt of candidates) {
    const epRes = await allanimeGQLEpisode({ showId, translationType: dubSub, episodeString: attempt });
    if (!epRes.body) continue;
    const urls = parseEpisodeSourceUrls(epRes.body);
    if (urls?.length) { sourceUrls = urls; break; }
  }
  if (!sourceUrls) return null;
  return trySourceUrls(sourceUrls);
}

// ---------- SEANIME PROVIDER CLASS ----------
class Provider {
  getSettings() {
    return { episodeServers: ["Auto"], supportsDub: true };
  }

  async search(queryObj) {
    const query = queryObj.query;
    const dub = queryObj.opts?.dub === true;
    const translationType = dub ? "dub" : "sub";
    const vars = {
      search: { allowAdult: true, allowUnknown: false, query: query.toLowerCase() },
      limit: 40,
      page: 1,
      translationType,
      countryOrigin: "ALL",
    };
    const res = await allanimeGQL(vars, SEARCH_GQL);
    if (!res.body) return [];
    let edges;
    try { edges = JSON.parse(res.body)?.data?.shows?.edges; } catch { return []; }
    if (!edges) return [];
    return edges.map(edge => ({
      id: edge._id,
      title: edge.name,
      url: edge._id, // store id as url
      subOrDub: translationType,
    }));
  }

  async findEpisodes(seriesUrl, dub) {
    const showId = seriesUrl;
    const translationType = dub ? "dub" : "sub";
    // Try to get episode count via availableEpisodesDetail
    const detailGql = `query($showId:String!){ show(_id:$showId){ availableEpisodesDetail } }`;
    const detailRes = await allanimeGQL({ showId }, detailGql);
    let eps = [];
    try {
      const detail = JSON.parse(detailRes.body)?.data?.show?.availableEpisodesDetail;
      if (detail) {
        eps = translationType === "dub" ? (detail.dub || []) : (detail.sub || []);
      }
    } catch {}
    if (!eps.length) {
      // fallback to episode count from search
      const searchRes = await allanimeGQL({ search: { allowAdult: true, allowUnknown: false, query: "" }, limit: 100, page: 1, translationType: "sub", countryOrigin: "ALL" }, SEARCH_GQL);
      let edges;
      try { edges = JSON.parse(searchRes.body)?.data?.shows?.edges; } catch { edges = null; }
      const found = edges?.find(e => e._id === showId);
      const total = found?.availableEpisodes ? parseInt(found.availableEpisodes) : 999;
      for (let i = 1; i <= total; i++) eps.push(i.toString());
    }
    return eps.map(ep => ({
      id: JSON.stringify({ showId, episodeNumber: ep, translationType }),
      title: `Episode ${ep}`,
      number: parseFloat(ep),
      url: `https://allmanga.to/anime/${showId}/episodes/${ep}`,
    }));
  }

  async findEpisodeServer(episode, server) {
    const { showId, episodeNumber, translationType } = JSON.parse(episode.id);
    const epStr = episodeNumber.toString();
    const candidates = [epStr];
    if (!epStr.includes(".")) candidates.push(epStr + ".0");
    let sourceUrls = null;
    for (const attempt of candidates) {
      const epRes = await allanimeGQLEpisode({ showId, translationType, episodeString: attempt });
      if (!epRes.body) continue;
      const urls = parseEpisodeSourceUrls(epRes.body);
      if (urls?.length) { sourceUrls = urls; break; }
    }
    if (!sourceUrls) throw new Error("No sourceUrls found");
    const result = await trySourceUrls(sourceUrls);
    if (!result || !result.ok) throw new Error("No playable link");
    return {
      server,
      videoSources: [{ url: result.url, quality: result.resolution, type: result.isDirectMp4 ? "mp4" : "m3u8", subtitles: [] }],
      headers: { Referer: result.referer, Origin: new URL(result.referer).origin },
    };
  }
}

module.exports = { Provider };