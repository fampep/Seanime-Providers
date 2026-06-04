const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

// ------------------------ Helper Functions (identical to server code) ------------------------
const ALLANIME_HEX_MAP = {
    "79": "A", "7a": "B", "7b": "C", "7c": "D", "7d": "E", "7e": "F", "7f": "G",
    "70": "H", "71": "I", "72": "J", "73": "K", "74": "L", "75": "M", "76": "N",
    "77": "O", "68": "P", "69": "Q", "6a": "R", "6b": "S", "6c": "T", "6d": "U",
    "6e": "V", "6f": "W", "60": "X", "61": "Y", "62": "Z", "59": "a", "5a": "b",
    "5b": "c", "5c": "d", "5d": "e", "5e": "f", "5f": "g", "50": "h", "51": "i",
    "52": "j", "53": "k", "54": "l", "55": "m", "56": "n", "57": "o", "48": "p",
    "49": "q", "4a": "r", "4b": "s", "4c": "t", "4d": "u", "4e": "v", "4f": "w",
    "40": "x", "41": "y", "42": "z", "08": "0", "09": "1", "0a": "2", "0b": "3",
    "0c": "4", "0d": "5", "0e": "6", "0f": "7", "00": "8", "01": "9", "15": "-",
    "16": ".", "67": "_", "46": "~", "02": ":", "17": "/", "07": "?", "1b": "#",
    "63": "[", "65": "]", "78": "@", "19": "!", "1c": "$", "1e": "&", "10": "(",
    "11": ")", "12": "*", "13": "+", "14": ",", "03": ";", "05": "=", "1d": "%"
};

function decodeAllanimeUrl(encoded) {
    if (encoded.startsWith("--"))
        encoded = encoded.slice(2);
    let result = "";
    for (let i = 0; i < encoded.length; i += 2) {
        const pair = encoded.slice(i, i + 2);
        result += ALLANIME_HEX_MAP[pair] !== undefined ? ALLANIME_HEX_MAP[pair] : pair;
    }
    return result.replace(/\\u002F/gi, "/").replace(/\\\|/g, "");
}

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
                    priority: prioMatch ? parseFloat(prioMatch[1]) : 0
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
                "Referer": "https://allmanga.to",
                "Origin": "https://allmanga.to"
            }
        }, (res) => {
            let data = "";
            res.on("data", (c) => data += c);
            res.on("end", () => resolve({ status: res.statusCode || 200, body: data }));
        });
        req.on("error", reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body);
        req.end();
    });
}

const EPISODE_GQL_HASH = "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec";
const EPISODE_GQL = `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){episode(showId:$showId translationType:$translationType episodeString:$episodeString){episodeString sourceUrls}}`;

async function allanimeGQLEpisode(variables) {
    try {
        const encodedVars = encodeURIComponent(JSON.stringify(variables));
        const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: EPISODE_GQL_HASH } });
        const encodedExt = encodeURIComponent(extensions);
        const getUrl = `https://api.allanime.day/api?variables=${encodedVars}&extensions=${encodedExt}`;
        const u = new URL(getUrl);
        const getRes = await new Promise((resolve, reject) => {
            const req = https.request({
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
                    "Referer": "https://allmanga.to",
                    "Origin": "https://youtu-chan.com"
                }
            }, (res) => {
                let data = "";
                res.on("data", (c) => data += c);
                res.on("end", () => resolve({ status: res.statusCode || 200, body: data }));
            });
            req.on("error", reject);
            req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
            req.end();
        });
        if (getRes.body && getRes.body.includes("tobeparsed")) return getRes;
    } catch {}
    return allanimeGQL(variables, EPISODE_GQL);
}

async function followRedirects(urlStr, maxHops = 10) {
    let hops = 0, currentUrl = urlStr;
    while (hops < maxHops) {
        const u = new URL(currentUrl);
        const lib = u.protocol === "https:" ? https : http;
        const res = await new Promise((resolve, reject) => {
            const req = lib.request({
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: "HEAD",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
                    "Referer": "https://allmanga.to"
                }
            }, (res) => {
                res.resume();
                resolve({ statusCode: res.statusCode, location: res.headers.location });
            });
            req.on("error", reject);
            req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
            req.end();
        });
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.location) {
            currentUrl = res.location.startsWith("http") ? res.location : new URL(res.location, currentUrl).href;
            hops++;
        } else {
            return currentUrl;
        }
    }
    return currentUrl;
}

async function resolveWithYtdlp(youtubeUrl) {
    const which = spawn(process.platform === "win32" ? "where" : "which", ["yt-dlp"]);
    const whichResult = await new Promise((resolve) => {
        which.on("close", (code) => resolve(code || 0));
        which.on("error", () => resolve(1));
    });
    if (whichResult !== 0) return null;
    const ytProc = spawn("yt-dlp", ["--no-playlist", "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "-g", youtubeUrl]);
    let stdout = "", stderr = "";
    ytProc.stdout.on("data", (d) => stdout += d);
    ytProc.stderr.on("data", (d) => stderr += d);
    await new Promise((resolve) => ytProc.on("close", resolve));
    if (!stdout.trim()) return null;
    return stdout.trim().split("\n")[0];
}

const PROVIDER_PRIORITY = ["S-mp4", "Luf-Mp4", "Yt-mp4", "Default", "Sl-Hls"];

async function trySourceUrls(sourceUrls) {
    const decoded = sourceUrls
        .filter(s => s.sourceUrl?.startsWith("--"))
        .map(s => ({
            sourceName: s.sourceName || "",
            priority: s.priority || 0,
            path: decodeAllanimeUrl(s.sourceUrl).replace("/clock", "/clock.json")
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
                        referer: "https://allmanga.to"
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
                        referer: "https://www.youtube.com"
                    };
                }
                continue;
            }
            const linkRes = await new Promise((resolve, reject) => {
                const u = new URL(fetchUrl);
                const lib = u.protocol === "https:" ? https : http;
                const req = lib.request({
                    hostname: u.hostname,
                    path: u.pathname + u.search,
                    method: "GET",
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0",
                        "Referer": "https://allmanga.to"
                    }
                }, (res) => {
                    let data = "";
                    res.on("data", (c) => data += c);
                    res.on("end", () => resolve({ status: res.statusCode || 200, body: data }));
                });
                req.on("error", reject);
                req.setTimeout(12000, () => { req.destroy(); reject(new Error("timeout")); });
                req.end();
            });
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
                referer: "https://allmanga.to"
            };
        } catch { continue; }
    }
    return null;
}

// ------------------------ AllMangaProvider (identical to server version) ------------------------
class AllMangaProvider {
    constructor() {
        this.name = "AllManga";
        this.baseApi = "https://api.allmanga.to/api";
        this.referer = "https://allmanga.to";
    }

    async gqlRequest(query, variables) {
        const fetch = require("node-fetch");
        const res = await fetch(this.baseApi, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Referer": this.referer,
                "Origin": "https://allmanga.to"
            },
            body: JSON.stringify({ query, variables })
        });
        if (!res.ok) throw new Error("GQL request failed");
        return res.json();
    }

    async search(query, dub = false) {
        const translationType = dub ? "dub" : "sub";
        const gqlQuery = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){
            shows(search:$search limit:$limit page:$page translationType:$translationType countryOrigin:$countryOrigin){
                edges{_id name availableEpisodes}
            }
        }`;
        const vars = {
            search: { allowAdult: true, allowUnknown: false, query: query.toLowerCase() },
            limit: 40, page: 1, translationType, countryOrigin: "ALL"
        };
        const data = await this.gqlRequest(gqlQuery, vars);
        const edges = data?.data?.shows?.edges || [];
        return edges.map(edge => ({
            title: edge.name,
            url: edge._id,
            hasSub: translationType === "sub",
            hasDub: translationType === "dub"
        }));
    }

    async findEpisodes(seriesUrl) {
        const showId = seriesUrl;
        let totalEp = 999;
        try {
            const gqlQuery = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType $countryOrigin:VaildCountryOriginEnumType){
                shows(search:$search limit:$limit page:$page translationType:"sub" countryOrigin:$countryOrigin){
                    edges{_id name availableEpisodes}
                }
            }`;
            const vars = {
                search: { allowAdult: true, allowUnknown: false, query: "" },
                limit: 100, page: 1, translationType: "sub", countryOrigin: "ALL"
            };
            const data = await this.gqlRequest(gqlQuery, vars);
            const found = data?.data?.shows?.edges?.find(e => e._id === showId);
            if (found && found.availableEpisodes) totalEp = parseInt(found.availableEpisodes) || 999;
        } catch {}
        const episodes = [];
        for (let i = 1; i <= totalEp; i++) {
            episodes.push({
                dataIds: JSON.stringify({ showId, episodeNumber: i }),
                number: i,
                title: `Episode ${i}`
            });
        }
        return episodes;
    }

    async findAvailableServers(dataIds, audio) {
        const { showId, episodeNumber } = JSON.parse(dataIds);
        const translationType = audio === "dub" ? "dub" : "sub";
        const episodeQuery = `query($showId:String! $translationType:VaildTranslationTypeEnumType $episodeString:String!){
            episode(showId:$showId translationType:$translationType episodeString:$episodeString){
                episodeString sourceUrls
            }
        }`;
        const vars = { showId, translationType, episodeString: episodeNumber.toString() };
        const data = await this.gqlRequest(episodeQuery, vars);
        const sourceUrls = data?.data?.episode?.sourceUrls || [];
        const servers = sourceUrls
            .filter(s => s.sourceUrl?.startsWith("--"))
            .map(s => ({
                id: JSON.stringify({ showId, episodeNumber, audio, source: s }),
                name: `${s.sourceName || "Unknown"} (${audio.toUpperCase()})`
            }));
        servers.push({
            id: JSON.stringify({ showId, episodeNumber, audio, auto: true }),
            name: `Auto (Best) (${audio.toUpperCase()})`
        });
        return servers;
    }

    async extractStreamFromLinkId(linkId) {
        const { showId, episodeNumber, audio, source, auto } = JSON.parse(linkId);
        if (auto) {
            const translationType = audio === "dub" ? "dub" : "sub";
            const vars = { showId, translationType, episodeString: episodeNumber.toString() };
            const data = await this.gqlRequest(`query($showId:String! $translationType:VaildTranslationTypeEnumType $episodeString:String!){
                episode(showId:$showId translationType:$translationType episodeString:$episodeString){ sourceUrls }
            }`, vars);
            const sourceUrls = data?.data?.episode?.sourceUrls || [];
            for (const src of sourceUrls) {
                try {
                    const result = await trySourceUrls([src]);
                    if (result && result.ok) {
                        return {
                            headers: { Referer: result.referer, Origin: new URL(result.referer).origin },
                            file: result.url,
                            tracks: []
                        };
                    }
                } catch {}
            }
            throw new Error("No working source");
        } else if (source) {
            const result = await trySourceUrls([source]);
            if (!result || !result.ok) throw new Error("Source not playable");
            return {
                headers: { Referer: result.referer, Origin: new URL(result.referer).origin },
                file: result.url,
                tracks: []
            };
        }
        throw new Error("Invalid linkId");
    }
}

// Export the provider class as required by Seanime
module.exports = { Provider: AllMangaProvider };