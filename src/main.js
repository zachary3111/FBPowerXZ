import { Actor, log, Dataset } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import dayjs from 'dayjs';
import { sleep, pickCounts, parseReactionsBreakdown, toEpoch } from './utils.js';

Configuration.set({ purgeOnStart: true });
await Actor.init();

try {
  const input = (await Actor.getInput()) || {};

  // ---- UA and helpers ----
  const MOBILE_UA =
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36';

  const decodeIfEncoded = (v) =>
    /%[0-9A-Fa-f]{2}/.test(String(v)) ? decodeURIComponent(String(v)) : String(v);

  // Cookie normalizers: Playwright requires exact shapes/values
  const normalizeSameSite = (v) => {
    const s = (v ?? 'Lax').toString().trim().toLowerCase();
    if (s === 'strict') return 'Strict';
    if (s === 'lax') return 'Lax';
    if (s === 'none') return 'None';
    return 'Lax';
  };
  const normalizeExpires = (e) => {
    // Must be a positive UNIX seconds timestamp or undefined
    const n = Number(e);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  // Accepts a raw `Cookie:` header string; split on semicolons.
  const parseCookieHeader = (header) => {
    if (typeof header !== 'string') return [];
    return header
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        if (idx < 1) return null;
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        return {
          name,
          value: decodeIfEncoded(value),
          path: '/',
          httpOnly: /^(xs|fr|datr|sb)$/i.test(name),
          secure: true,
          sameSite: 'Lax',
        };
      })
      .filter(Boolean);
  };

  // ---- Cookies: array, cookies_json array, or raw header string ----
  let cookies = Array.isArray(input.cookies) ? input.cookies : [];
  if (!cookies.length) {
    if (Array.isArray(input.cookies_json)) {
      cookies = input.cookies_json;
    } else if (typeof input.cookies_json === 'string' && input.cookies_json.trim()) {
      try {
        const parsed = JSON.parse(input.cookies_json);
        cookies = Array.isArray(parsed) ? parsed : parseCookieHeader(input.cookies_json);
      } catch {
        cookies = parseCookieHeader(input.cookies_json);
      }
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

  const searchTop = new URL('https://m.facebook.com/search/top/');
  searchTop.searchParams.set('q', query);
  const searchPosts = new URL('https://m.facebook.com/search/posts/');
  searchPosts.searchParams.set('q', query);

  const seen = new Set();
  let total = 0;

  const cookieSessions = new Set();

  const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    useSessionPool: true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
      maxPoolSize: Math.min(Math.max(Number(sessionOpts.maxPoolSize ?? 20), 1), 200),
      persistStateKey: sessionOpts.persistState === false ? undefined : 'SESSION_POOL_STATE',
    },

    // Crawlee v3: use launch args for UA + TLS ignore
    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--ignore-certificate-errors',
          `--user-agent=${MOBILE_UA}`,
          '--lang=en-US',
        ],
      },
    },

    preNavigationHooks: [
      async ({ page, session }) => {
        // Tiny stealth shim
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
          Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });

        // Safe router: never block FB first-party; drop common trackers only.
        await page.route('**/*', (route) => {
          try {
            const u = new URL(route.request().url());
            const host = u.hostname || '';
            const isFB = /(?:^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|akamaihd\.net)$/i.test(host);
            const isTracker = /(doubleclick|googlesyndication|google-analytics|googletagmanager|hotjar|mixpanel|optimizely|bing|yandex|adservice|adsystem)\./i.test(host);
            if (!isFB && isTracker) return route.abort();
          } catch {}
          route.continue();
        });

        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewportSize({ width: 390, height: 844 });

        // Set cookies (scope by URL to bind to m.facebook.com)
        const key = (session && session.id) ? session.id : 'global';
        if (cookies.length && !cookieSessions.has(key)) {
          try {
            const normalized = cookies
              .map((c) => {
                const name = String(c.name ?? '').trim();
                const value = decodeIfEncoded(c.value ?? '');
                if (!name || !value) return null;

                const sameSite = normalizeSameSite(c.sameSite);
                const secure = sameSite === 'None' ? true : c.secure !== false;

                return {
                  name,
                  value,
                  url: 'https://m.facebook.com', // scope cookie to m.facebook.com
                  path: c.path || '/',
                  sameSite,
                  secure,
                  httpOnly: Boolean(c.httpOnly),
                  expires: normalizeExpires(c.expires),
                };
              })
              .filter(Boolean);

            await page.context().addCookies(normalized);
            cookieSessions.add(key);
            log.info(`Set ${normalized.length} cookies: ${normalized.map((c) => c.name).join(', ')}`);

            // Sanity check: which cookies are visible to m.facebook.com?
            const visible = await page.context().cookies(['https://m.facebook.com']);
            const names = new Set(visible.map((k) => k.name));
            for (const req of ['c_user', 'xs', 'datr']) {
              if (!names.has(req)) log.warning(`Cookie visibility: "${req}" is NOT present for m.facebook.com`);
            }

            // Heuristic: warn if xs *looks* expired (3rd segment sometimes carries an epoch)
            const xs = visible.find((k) => k.name.toLowerCase() === 'xs');
            if (xs && typeof xs.value === 'string') {
              const parts = xs.value.split(':');
              const maybeTs = Number(parts[2]);
              const now = Math.floor(Date.now() / 1000);
              if (Number.isFinite(maybeTs) && maybeTs > 0 && maybeTs < now) {
                log.warning(`Cookie sanity: xs appears expired (epoch ${maybeTs}). Please refresh cookies.`);
              }
            } else if (!xs) {
              log.warning('Cookie sanity: no xs cookie found — login will fail.');
            }
          } catch (e) {
            log.warning('Failed to set cookies after normalization', { e: String(e) });
          }
        }
      },
    ],

    requestHandlerTimeoutSecs: 1200,
    requestHandler: async ({ page, session }) => {
      // ---------- STRICT AUTH CHECK ----------
      await page.goto('https://m.facebook.com/home.php', { waitUntil: 'domcontentloaded' });
      await sleep(1200);

      // Fail auth if redirected to login/checkpoint
      const finalHomeUrl = page.url();
      if (/\/login\.php|\/checkpoint\//i.test(finalHomeUrl)) {
        log.warning(`AUTH_FAIL: redirected to ${finalHomeUrl}`);
        if (session && (sessionOpts.retireOnBlocked ?? true)) session.retire();
        return;
      }

      const auth = await page.evaluate(() => {
        const hasVisibleLoginForm = !!document.querySelector('form[action*="/login"][method="post"] input[name="email"], #login_form input[name="email"]');
        const hasCheckpoint = !!document.querySelector('form[action*="checkpoint"], a[href*="checkpoint/"]');
        const hasMenu = !!document.querySelector('a[href="/menu/"], a[href*="logout.php"]');
        const hasFeed = !!document.querySelector('[role="feed"], [data-sigil*="m-feed-stream"]');
        const hasComposer = !!document.querySelector('[role="textbox"], textarea, [data-sigil*="composer"]');
        return { hasVisibleLoginForm, hasCheckpoint, hasMenu, hasFeed, hasComposer, title: document.title || '' };
      });

      if (auth.hasVisibleLoginForm || auth.hasCheckpoint || (!auth.hasMenu && !auth.hasFeed && !auth.hasComposer)) {
        const html0 = await page.content();
        log.warning('AUTH_FAIL: Looks like not logged in. Snippet: ' + html0.slice(0, 400).replace(/\s+/g, ' ').trim());
        if (session && (sessionOpts.retireOnBlocked ?? true)) session.retire();
        return;
      }
      log.info(`Authenticated view OK: title="${auth.title || 'n/a'}"`);

      // ---------- SEARCH: open "Top" then switch to "Posts" ----------
      await page.goto(searchTop.toString(), { waitUntil: 'domcontentloaded' });
      await sleep(1000);

      const postsTab = await page.$('a[href*="/search/posts/"]');
      if (postsTab) {
        await postsTab.click();
        await page.waitForLoadState('domcontentloaded');
      } else {
        await page.goto(searchPosts.toString(), { waitUntil: 'domcontentloaded' });
      }

      // Wait for either results or a visible login form
      try {
        await Promise.race([
          page.waitForSelector('article, [role="article"]', { timeout: 8000 }),
          page.waitForSelector('form[action*="/login"][method="post"] input[name="email"], #login_form input[name="email"], form[action*="checkpoint"]', { timeout: 8000 }),
        ]);
      } catch {}
      await sleep(800);

      // Decide block only if visible login/checkpoint AND no articles rendered
      const state = await page.evaluate(() => {
        const articles = document.querySelectorAll('article, [role="article"]').length;
        const hasVisibleLoginForm = !!document.querySelector('form[action*="/login"][method="post"] input[name="email"], #login_form input[name="email"]');
        const hasCheckpoint = !!document.querySelector('form[action*="checkpoint"], a[href*="checkpoint/"]');
        return { articles, hasVisibleLoginForm, hasCheckpoint, title: document.title || '' };
      });

      if ((state.hasVisibleLoginForm || state.hasCheckpoint) && state.articles === 0) {
        const html0 = await page.content();
        log.warning('Blocked HTML snippet: ' + html0.slice(0, 400).replace(/\s+/g, ' ').trim());
        log.warning('Blocked page detected; retiring session');
        if (session && (sessionOpts.retireOnBlocked ?? true)) session.retire();
        return;
      }

      log.info(`Search page ready: title="${state.title}", articles=${state.articles}`);

      // Primer scroll for lazy content
      await page.evaluate(() => window.scrollBy(0, 600));
      await sleep(600);

      // ---------- Main scrape loop ----------
      while (total < maxResults) {
        const batch = await page.evaluate(() => {
          const abs = (href) => { try { return new URL(href, location.origin).href; } catch { return null; } };
          const items = [];
          for (const art of document.querySelectorAll('article, [role="article"]')) {
            const postLink = art.querySelector(
              'a[href*="story.php"], a[href*="/posts/"], a[href*="/permalink/"], a[href*="/reel/"], a[href*="/videos/"]'
            );
            const url = postLink ? abs(postLink.getAttribute('href')) : null;

            const authorA = art.querySelector('header a[href^="/"], a[role="link"][href^="/"]');
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
            const image = firstImg ? { uri: firstImg.src, height: Number(firstImg.height)||null, width: Number(firstImg.width)||null, id: null } : null;

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

        // Load more
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
        await sleep(900 + Math.random() * 600);

        const more = await page.evaluate(() => {
          const el = Array.from(document.querySelectorAll('a, button')).find((e) =>
            /see more|more results|show more|next/i.test(e.textContent || '')
          );
          if (el) {
            el.click();
            return true;
          }
          return false;
        });
        if (more) await sleep(1200 + Math.random() * 800);

        const newCount = await page.evaluate(
          () => document.querySelectorAll('article, [role="article"]').length
        );
        if (newCount < seen.size / 2) break;
      }

      log.info(`Collected ${total} posts.`);
    },
  });

  await crawler.run([{ url: searchTop.toString() }]);

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
