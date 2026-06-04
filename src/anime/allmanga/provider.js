const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");

class Provider {
  constructor() {
    this.base = "https://allanime.day";
    this.apiHost = "https://api.allanime.day";
    this.referer = "https://allanime.to/";
    this.agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
  }

  getSettings() {
    return {
      episodeServers: ["wixmp"],
      supportsDub: true,
    };
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------
  async search(query) {
    const translationType = query.opts?.dub ? "dub" : "sub";
    const gql = `query($search:SearchInput $limit:Int $page:Int $translationType:VaildTranslationTypeEnumType){
      shows(search:$search limit:$limit page:$page translationType:$translationType){
        edges{_id name availableEpisodes}
      }
    }`;
    const data = await this._gql(gql, {
      search: { query: query.query, allowAdult: false, allowUnknown: false },
      limit: 20,
      page: 1,
      translationType,
    });

    return (data?.data?.shows?.edges || []).map((s) => ({
      id: `${s._id}|||${translationType}`,
      title: s.name,
      url: `${this.base}/anime/${s._id}`,
      subOrDub: translationType,
    }));
  }

  async findEpisodes(id) {
    const [showId, lang] = id.split("|||");
    const language = lang === "dub" ? "dub" : "sub";
    const gql = `query($showId:String!){show(_id:$showId){_id availableEpisodesDetail}}`;
    const data = await this._gql(gql, { showId });
    const detail = data?.data?.show?.availableEpisodesDetail;
    const eps = language === "dub" ? (detail?.dub || []) : (detail?.sub || []);

    return eps.map((e) => ({
      id: `${showId}|||${language}|||${e}`,
      title: `Episode ${e}`,
      number: parseFloat(e),
      url: `${this.base}/anime/${showId}/episodes/${e}`,
    })).sort((a, b) => a.number - b.number);
  }

  async findEpisodeServer(episode, server) {
    const parts = episode.id.split("|||");
    if (parts.length !== 3) throw new Error("Invalid episode ID format");
    const [showId, translationType, episodeString] = parts;

    // 1) Get raw source URLs from AllAnime
    const sourceUrls = await this._fetchSourceUrls(showId, translationType, episodeString);
    if (!sourceUrls || sourceUrls.length === 0) throw new Error("No sources found");

    // 2) Select preferred source (matching the requested server name)
    const selected = this._selectSource(sourceUrls, server);
    if (!selected) throw new Error(`No source found for server: ${server}`);

    // 3) Resolve the selected source to video URLs
    return await this._resolveSource(selected, server);
  }

  // ------------------------------------------------------------------------
  // Private helpers – AllAnime GraphQL & source handling
  // ------------------------------------------------------------------------
  async _gql(query, variables) {
    const res = await fetch(`${this.apiHost}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Referer": this.referer,
        "User-Agent": this.agent,
      },
      body: JSON.stringify({ variables, query }),
    });
    if (!res.ok) throw new Error(`GQL request failed: ${res.status}`);
    return res.json();
  }

  // Use persisted‑query GET endpoint for episode sources (better compatibility)
  async _episodeGQL(variables) {
    const EPISODE_GQL_HASH = "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec";
    const EPISODE_GQL = `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){
      episode(showId:$showId translationType:$translationType episodeString:$episodeString){
        episodeString sourceUrls
      }
    }`;
    const encodedVars = encodeURIComponent(JSON.stringify(variables));
    const extensions = JSON.stringify({ persistedQuery: { version: 1, sha256Hash: EPISODE_GQL_HASH } });
    const encodedExt = encodeURIComponent(extensions);
    const url = `https://api.allanime.day/api?variables=${encodedVars}&extensions=${encodedExt}`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": this.agent,
        "Referer": "https://allmanga.to",
        "Origin": "https://youtu-chan.com",
      },
    });
    if (!res.ok) throw new Error(`Episode GQL failed: ${res.status}`);
    return res.json();
  }

  async _fetchSourceUrls(showId, translationType, episodeString) {
    // Try GET persisted query first
    try {
      const data = await this._episodeGQL({ showId, translationType, episodeString });
      const urls = this._parseSourceUrls(data);
      if (urls && urls.length) return urls;
    } catch (e) {
      // fallback to POST
    }
    // Fallback to POST GQL
    const gql = `query($showId:String! $translationType:VaildTranslationTypeEnumType! $episodeString:String!){
      episode(showId:$showId translationType:$translationType episodeString:$episodeString){sourceUrls}
    }`;
    const data = await this._gql(gql, { showId, translationType, episodeString });
    return this._parseSourceUrls(data);
  }

  _parseSourceUrls(gqlResponse) {
    // Direct sourceUrls array
    const direct = gqlResponse?.data?.episode?.sourceUrls;
    if (direct && direct.length) return direct;

    // Handle "tobeparsed" field (encrypted blob)
    const bodyStr = JSON.stringify(gqlResponse);
    const tbMatch = bodyStr.match(/"tobeparsed"\s*:\s*"([^"]+)"/);
    if (tbMatch) {
      const decoded = this._decodeTobeparsed(tbMatch[1]);
      if (decoded.length) return decoded;
    }
    return null;
  }

  _decodeTobeparsed(blob) {
    try {
      const ALLANIME_KEY = crypto.createHash("sha256").update("Xot36i3lK3:v1").digest();
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

  _selectSource(sources, requestedServer) {
    const priorityMap = {
      "wixmp": 1,
      "S-mp4": 2,
      "Luf-Mp4": 3,
      "Yt-mp4": 4,
      "Default": 5,
      "Sl-Hls": 6,
    };
    const targetKey = requestedServer.toLowerCase();
    const idx = priorityMap[targetKey] || 99;
    // find source with matching name, otherwise fallback to priority order
    const exact = sources.find(s => s.sourceName?.toLowerCase() === targetKey);
    if (exact) return exact;
    const ordered = [...sources].sort((a, b) => {
      const pa = priorityMap[a.sourceName?.toLowerCase()] ?? 99;
      const pb = priorityMap[b.sourceName?.toLowerCase()] ?? 99;
      return pa - pb;
    });
    return ordered[0] || null;
  }

  // ------------------------------------------------------------------------
  // Source resolution (clock.json fetch + quality sorting)
  // ------------------------------------------------------------------------
  async _resolveSource(source, serverName) {
    let rawUrl = source.sourceUrl || "";
    if (rawUrl.startsWith("--")) {
      rawUrl = this._decodeUrl(rawUrl.slice(2));
    }
    // Build absolute clock.json URL
    let clockUrl;
    if (rawUrl.startsWith("http")) {
      clockUrl = rawUrl;
    } else {
      const path = rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`;
      clockUrl = `https://allanime.day${path}`;
    }
    // Replace /clock with /clock.json if needed
    clockUrl = clockUrl.replace(/\/clock$/, "/clock.json");

    try {
      const res = await fetch(clockUrl, {
        headers: {
          "Referer": this.referer,
          "User-Agent": this.agent,
        },
      });
      if (!res.ok) throw new Error(`Clock API returned ${res.status}`);
      const json = await res.json();
      if (!json.links || !Array.isArray(json.links)) {
        throw new Error("Response missing 'links' array");
      }
      const videoSources = json.links
        .filter(l => l.link)
        .map((link) => ({
          url: link.link,
          quality: link.resolutionStr || "auto",
          type: link.link.includes(".m3u8") ? "m3u8" : "mp4",
          subtitles: [],
        }))
        .sort((a, b) => {
          const qa = parseInt(a.quality) || 0;
          const qb = parseInt(b.quality) || 0;
          return qb - qa;
        });
      return { server: serverName, videoSources, headers: {} };
    } catch (err) {
      console.error(`[AllAnime] Resolution Error for ${source.sourceName}: ${err.message}`);
      return { server: serverName, videoSources: [], headers: {} };
    }
  }

  _decodeUrl(encoded) {
    const map = {
      "79":"A","7a":"B","7b":"C","7c":"D","7d":"E","7e":"F","7f":"G","70":"H",
      "71":"I","72":"J","73":"K","74":"L","75":"M","76":"N","77":"O","68":"P",
      "69":"Q","6a":"R","6b":"S","6c":"T","6d":"U","6e":"V","6f":"W","60":"X",
      "61":"Y","62":"Z","59":"a","5a":"b","5b":"c","5c":"d","5d":"e","5e":"f",
      "5f":"g","50":"h","51":"i","52":"j","53":"k","54":"l","55":"m","56":"n",
      "57":"o","48":"p","49":"q","4a":"r","4b":"s","4c":"t","4d":"u","4e":"v",
      "4f":"w","40":"x","41":"y","42":"z","08":"0","09":"1","0a":"2","0b":"3",
      "0c":"4","0d":"5","0e":"6","0f":"7","00":"8","01":"9","15":"-","16":".",
      "67":"_","46":"~","02":":","17":"/","07":"?","1b":"#","63":"[","65":"]",
      "78":"@","19":"!","1c":"$","1e":"&","10":"(","11":")","12":"*","13":"+",
      "14":",","03":";","05":"=","1d":"%",
    };
    let out = "";
    for (let i = 0; i < encoded.length; i += 2) {
      const byte = encoded.substring(i, i + 2);
      out += map[byte] !== undefined ? map[byte] : "";
    }
    out = out.replace(/\/clock/g, "/clock.json");
    return out;
  }
}

module.exports = { Provider };