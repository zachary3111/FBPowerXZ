import { Actor, log, Dataset } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import dayjs from 'dayjs';
import { sleep, pickCounts, parseReactionsBreakdown, shouldBlockRequest, toEpoch, isBlocked } from './utils.js';

Configuration.set({ purgeOnStart: true });
await Actor.init();

try {
  const input = (await Actor.getInput()) || {};

  // ---- Cookies: support cookies_json and decode %-encoded values ----
  let cookies = Array.isArray(input.cookies) ? input.cookies : [];
  if (!cookies.length && typeof input.cookies_json === 'string' && input.cookies_json.trim()) {
    try {
      const parsed = JSON.parse(input.cookies_json);
      if (Array.isArray(parsed)) cookies = parsed;
    } catch (e) {
      log.warning('Failed to parse cookies_json; ignoring. ' + String(e));
    }
  }

  const query = String(input.query || '').trim();
  if (!query) throw new Error('`query` is required');

  const maxResults = Math.min(Math.max(Number(input.maxResults || 100), 1), 5000);
  const recentOnly = Boolean(input.recent_posts);
  const startEpoch = toEpoch(input.start_date);
  const endEpoch = toEpoch(input.end_date);

  const proxyConfiguration = input.proxy
    ? await Actor.createProxyConfiguration(input.proxy)
    : await Actor.createProxyConfiguration();

  const sessionOpts = input.session || {};

  const base = new URL('https://m.facebook.com/search/posts/');
  base.searchParams.set('q', query);
  const startUrl = base.toString();

  const seen = new Set();
  let total = 0;

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
      maxPoolSize: Math.min(Math.max(Number(sessionOpts.maxPoolSize ?? 20), 1), 200),
      persistStateKey: sessionOpts.persistState === false ? undefined : 'SESSION_POOL_STATE',
    },
    launchContext: {
      launchOptions: { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      contextOptions: {
        ignoreHTTPSErrors: true,
        userAgent:
          'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36',
        locale: 'en-US',
        viewport: { width: 390, height: 844 },
      },
    },
    preNavigationHooks: [
      async ({ page, session }) => {
        await page.route('**/*', (route) => {
          if (shouldBlockRequest(route.request())) return route.abort();
          route.continue();
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        if (session && cookies.length && !session.get('cookiesSet')) {
          try {
            const decodeIfEncoded = (v) =>
              /%[0-9A-Fa-f]{2}/.test(String(v)) ? decodeURIComponent(String(v)) : String(v);

            const normalized = cookies.map((c) => ({
              name: String(c.name),
              value: decodeIfEncoded(c.value),
              domain:
                c.domain && typeof c.domain === 'string'
                  ? c.domain.startsWith('.') ? c.domain : c.domain
                  : '.facebook.com',
              path: c.path || '/',
              expires: typeof c.expires === 'number' ? c.expires : -1,
              httpOnly: Boolean(c.httpOnly),
              secure: c.secure !== false,
              sameSite: c.sameSite || 'Lax',
            }));

            await page.context().addCookies(normalized);
            session.set('cookiesSet', true);
          } catch (e) {
            log.warning('Failed to set cookies', { e: String(e) });
          }
        }
      },
    ],
    requestHandlerTimeoutSecs: 1200,
    requestHandler: async ({ page, session }) => {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      await sleep(1500); // small settle time helps avoid early blockers

      const html0 = await page.content();
      if (isBlocked(html0)) {
        log.warning('Blocked HTML snippet: ' + html0.slice(0, 400).replace(/\s+/g, ' ').trim());
        log.warning('Blocked page detected; retiring session');
        if (session && (sessionOpts.retireOnBlocked ?? true)) session.retire();
        return;
      }

      while (total < maxResults) {
        const batch = await page.evaluate(() => {
          const abs = (href) => {
            try {
              return new URL(href, location.origin).href;
            } catch {
              return null;
            }
          };
          const items = [];
          for (const art of document.querySelectorAll('article')) {
            const postLink = art.querySelector(
              'a[href*="story.php"], a[href*="/posts/"], a[href*="/permalink/"], a[href*="/reel/"], a[href*="/videos/"]',
            );
            const url = postLink ? abs(postLink.getAttribute('href')) : null;

            const authorA = art.querySelector('header a[href^="/"]');
            const authorName = authorA?.textContent?.trim() || null;
            const authorUrl = authorA ? abs(authorA.getAttribute('href')) : null;
            const profilePic = art.querySelector('image, img')?.getAttribute('src') || null;

            let message = '';
            const messageEl = art.querySelector('[data-ad-preview="message"], div[dir="auto"] p, div[dir="auto"] span');
            if (messageEl) message = messageEl.innerText?.trim() || '';

            const timeEl = art.querySelector('abbr[data-utime], time');
            const timestamp = timeEl?.getAttribute('data-utime') ? Number(timeEl.getAttribute('data-utime')) : null;

            const raw = art.innerText || '';
            const firstImg = art.querySelector('img');
            const image = firstImg
              ? { uri: firstImg.src, height: Number(firstImg.height) || null, width: Number(firstImg.width) || null, id: null }
              : null;

            const videoA = art.querySelector('a[href*="/reel/"], a[href*="/videos/"]');
            const video = videoA ? abs(videoA.getAttribute('href')) : null;
            const video_thumbnail = firstImg?.src || null;

            let post_id = null;
            if (url) {
              const m = url.match(/(?:story\.php.*[?&]story_fbid=|posts\/|permalink\/|reel\/|videos\/)(\d{6,})/);
              if (m) post_id = m[1];
            }

            let author_id = null;
            if (authorUrl) {
              const mid = authorUrl.match(/profile\.php\?id=(\d+)/) || authorUrl.match(/facebook\.com\/(\d{6,})/);
              if (mid) author_id = mid[1];
            }

            items.push({
              url,
              post_id,
              message,
              timestamp,
              raw,
              image,
              video,
              video_thumbnail,
              author: { id: author_id, name: authorName, url: authorUrl, profile_picture_url: profilePic },
            });
          }
          return items;
        });

        for (const it of batch) {
          if (!it.url) continue;
          if (seen.has(it.url)) continue;

          const ts = it.timestamp || null;

          if (recentOnly && !startEpoch && !endEpoch) {
            const cutoff = dayjs().subtract(30, 'day').unix();
            if (ts && ts < cutoff) continue;
          }
          if (startEpoch && ts && ts < startEpoch) continue;
          if (endEpoch && ts && ts > endEpoch + 86399) continue;

          const { reactions, comments, shares } = pickCounts(it.raw);
          const reactionsObj = it.raw
            ? { like: 0, love: 0, haha: 0, wow: 0, sad: 0, angry: 0, care: 0, ...parseReactionsBreakdown(it.raw) }
            : null;

          const out = {
            post_id: it.post_id || null,
            type: 'post',
            url: it.url,
            message: it.message || null,
            timestamp: ts || null,
            comments_count: comments ?? null,
            reactions_count: reactions ?? null,
            reshare_count: shares ?? null,
            reactions: reactionsObj,
            author: it.author,
            image: it.image,
            video: it.video,
            album_preview: null,
            video_files: null,
            video_thumbnail: it.video_thumbnail || null,
            external_url: null,
            attached_event: null,
            attached_post: null,
            attached_post_url: null,
            text_format_metadata: null,
            scrapedAt: new Date().toISOString(),
          };

          if (!out.post_id && it.url) {
            const m = it.url.match(/(?:story\.php.*[?&]story_fbid=|posts\/|permalink\/|reel\/|videos\/)(\d{6,})/);
            if (m) out.post_id = m[1];
          }

          await Dataset.pushData(out);
          seen.add(it.url);
          total++;
          if (total >= maxResults) break;
        }

        if (total >= maxResults) break;

        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await sleep(900 + Math.random() * 600);

        const more = await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('a, button')).find((e) =>
            /see more|more results|show more|next/i.test(e.textContent || ''),
          );
          if (el) {
            el.click();
            return true;
          }
          return false;
        });

        if (more) await sleep(1200 + Math.random() * 800);

        const newCount = await page.evaluate(() => document.querySelectorAll('article').length);
        if (newCount < seen.size / 2) break;
      }

      log.info(`Collected ${total} posts.`);
    },
  });

  await crawler.run([{ url: startUrl }]);

  await Actor.pushData({
    _summary: {
      query,
      total,
      maxResults,
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      recent_posts: recentOnly,
    },
  });

  log.info('Done.');
} catch (err) {
  log.exception(err, 'Run failed');
  throw err;
} finally {
  await Actor.exit();
}
