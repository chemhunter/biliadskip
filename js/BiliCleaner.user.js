// ==UserScript==
// @name         BiliCleaner
// @namespace    https://greasyfork.org/scripts/511437/
// @description  隐藏B站动态瀑布流中的广告、评论区广告、充电内容以及美化首页；v2.6.3变更：精简代码，增加评论区ip属地显示
// @version      2.7.0
// @author       chemhunter
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @match        *://live.bilibili.com/*
// @match        *://message.bilibili.com/*
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @license      GPL-3.0 License
// @run-at       document-start
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/511437/BiliCleaner.user.js
// @updateURL https://update.greasyfork.org/scripts/511437/BiliCleaner.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // --- 全局变量 ---
    let keywordRegex, keywordRegexGlobal, userSettings, biliAdWordsConfig, whiteList, messageDiv;
    let commentAppObserver, dynamicPanelObserver, panelCardObserver, setupIntervalId;
    let lastPathname = '';
    let hiddenAdCount = 0;
    let lastActiveUpName = null;
    let setMainWidth = false;
    let liveGiftObserver = null;
    const FORCE_GIT_CONFIG = false;

    // --- 1. 定义默认配置与用户设置 ---
    const defaultSettings = {
        global: {
            label: "🖥️ 全局与首页_屏蔽项",
            enable: true,
            sub: {
                swipe: { label: "首页大屏轮播", enable: true },
                feed: { label: "首页推广动态卡片", enable: true },
                nav: { label: "导航栏广告/会员入口", enable: true },
                sidebar: { label: "侧边栏：热搜、公告等", enable: true },
            }
        },
        dynamic: {
            label: "⚡ 动态瀑布流_屏蔽项",
            enable: true,
            sub: {
                goods: { label: "商品推广", enable: true },
                charge: { label: "充电专属", enable: true },
                reverse: { label: "预约动态", enable: true },
                widen: { label: "动态页面宽屏美化", enable: true },
                popup: { label: "导航栏悬浮”动态“窗", enable: true }
            }
        },
        comment: {
            label: "📺 视频评论区_屏蔽项",
            enable: true,
            sub: {
                adBlock: { label: "评论区置顶广告", enable: true },
                banner: { label: "评论区上方活动横幅", enable: true },
                ipShow: { label: "➕评论区显示IP属地", enable: false } // 新增项
            }
        },
        live: {
            label: "🎥 直播间_屏蔽项",
            enable: true,
            sub: {
                rank: { label: "上方榜单精简", enable: true },
                giftTip: { label: "聊天栏礼物播报", enable: true },
                giftBar: { label: "下方礼物栏隐藏", enable: true },
                recommend: { label: "下方直播推荐隐藏", enable: true }
            }
        }
    };

    function synchronizeSettings(defaults, stored) {
        if (!stored || typeof stored !== 'object') {
            return JSON.parse(JSON.stringify(defaults));
        }
        const result = {};
        for (let key in defaults) {
            const defaultCategory = defaults[key];
            const storedCategory = stored[key];
            result[key] = {
                label: defaultCategory.label,
                enable: storedCategory && typeof storedCategory.enable === 'boolean' ? storedCategory.enable : defaultCategory.enable,
                sub: {}
            };
            if (defaultCategory.sub) {
                for (let subKey in defaultCategory.sub) {
                    const defaultSub = defaultCategory.sub[subKey];
                    const storedSub = storedCategory && storedCategory.sub ? storedCategory.sub[subKey] : null;
                    result[key].sub[subKey] = {
                        label: defaultSub.label,
                        enable: storedSub && typeof storedSub.enable === 'boolean' ? storedSub.enable : defaultSub.enable
                    };
                }
            }
        }
        return result;
    }

    // 存储接口
    const storage = {
        get(key, defaultValue = null) {
            try {
                const value = GM_getValue(key, null);
                if (value === null) return defaultValue;
                if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                    try { return JSON.parse(value); } catch(e) { return value; }
                }
                return value;
            } catch(e) {
                const local = localStorage.getItem(key);
                return local ? JSON.parse(local) : defaultValue;
            }
        },
        set(key, value) {
            try {
                GM_setValue(key, JSON.stringify(value));
            } catch(e) {
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
    };

    function migrateFromLocalStorage() {
        if (localStorage.getItem('biliCleanerConfigMigrated')) return;
        const keysConfig = {
            'biliCleanerSettings': { type: 'object', strategy: 'overwrite_if_empty', targetKey: 'biliCleanerSettings'},
            'biliUpWhiteList': { type: 'array', strategy: 'union', targetKey: 'biliUpWhiteList' },
            'localConfig': { type: 'object', strategy: 'keep_newest', targetKey: 'localConfig' }
        };
        for (const [oldKey, config] of Object.entries(keysConfig)) {
            const raw = localStorage.getItem(oldKey);
            if (raw === null) continue;
            let localValue;
            try { localValue = JSON.parse(raw); } catch(e) { continue; }
            const targetKey = config.targetKey;
            const existing = storage.get(targetKey, null);
            let merged;
            if (existing === null) {
                merged = localValue;
            } else {
                switch (config.strategy) {
                    case 'union':
                        if (Array.isArray(existing) && Array.isArray(localValue))
                            merged = [...new Set([...existing, ...localValue])];
                        else merged = existing;
                        break;
                    case 'keep_newest':
                        if (typeof existing === 'object' && typeof localValue === 'object') {
                            const existingTime = existing.time || 0;
                            const localTime = localValue.time || 0;
                            merged = localTime > existingTime ? localValue : existing;
                        } else merged = existing;
                        break;
                    default: merged = existing;
                }
            }
            storage.set(targetKey, merged);
            console.log(`[BiliCleaner] ✅ 已迁移 localStorage.${oldKey} -> GM.${targetKey}`);
        }
        localStorage.setItem('biliCleanerConfigMigrated', true);
    }

    userSettings = synchronizeSettings(defaultSettings, storage.get('biliCleanerSettings', {}));
    function saveSettings() { storage.set('biliCleanerSettings', userSettings); }

    const defaultConfig = {
        keywordStr: `淘宝|京东|天猫|美团|外卖|补贴|密令|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价`,
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduodilo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com'],
        time: 0
    };

    async function fetchConfigFromGit(timeoutMs = 1500) {
        let lastError = null;
        const gitMirror = [
            'https://cdn.jsdelivr.net/gh/chemhunter/biliadskip@main/biliadwordslinks.json',
            'https://raw.githubusercontent.com/chemhunter/biliadskip/main/biliadwordslinks.json',
        ];
        for (const source of gitMirror) {
            const url = `${source}?t=${Date.now()}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                const configData = JSON.parse(text);
                log(`✅ 从git镜像: ${source} 获取到广告基础配置`);
                return configData;
            } catch (error) {
                clearTimeout(timeoutId);
                lastError = error;
                continue;
            }
        }
        throw new Error(`所有镜像源均无法访问: ${lastError?.message || '未知错误'}`);
    }

    async function getConfigWithFallback(maxRetries = 2) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fetchConfigFromGit();
            } catch (error) {
                console.error(`尝试 ${attempt} 失败:`, error.message);
                if (attempt >= maxRetries) return null;
                await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
        }
        return null;
    }

    async function getAdWordsConfig() {
        try {
            const localConfig = storage.get('localConfig', null);
            const lastUpdateTime = localConfig && localConfig.time || 0;
            if (FORCE_GIT_CONFIG || Date.now() - lastUpdateTime >= 24 * 3600 * 1000) {
                const res = await getConfigWithFallback();
                if (res) {
                    biliAdWordsConfig = {
                        ...res,
                        keywordStr: Object.values(res.keywordStr).join('|'),
                        time: Date.now()
                    };
                    storage.set('localConfig', biliAdWordsConfig);
                } else {
                    biliAdWordsConfig = localConfig ? { ...localConfig } : defaultConfig;
                }
            } else {
                biliAdWordsConfig = localConfig ? { ...localConfig } : defaultConfig;
            }
        } catch (error) {
            console.error("获取广告词配置失败:", error);
            biliAdWordsConfig = defaultConfig;
        }
        keywordRegex = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'i');
        keywordRegexGlobal = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'gi');
    }

    function log(...args) { console.log('[BiliCleaner] ', ...args); }
    function hideItem(element) { if (element && element.style.display !== 'none') element.style.display = 'none'; }
    function showMessage(msg) {
        if (!messageDiv) return;
        messageDiv.textContent = msg;
        messageDiv.style.display = 'block';
        setTimeout(() => { messageDiv.style.display = 'none'; }, 3000);
    }

    function hideUnwantedElements() {
        const rules = {
            nav: ['li.v-popover-wrap.left-loc-entry', 'ul.left-entry > li.v-popover-wrap:last-child', 'ul.right-entry > .vip-wrap', ".bili-dyn-version-control__reminding"],
            sidebar: [".video-page-game-card-small", '.video-page-special-card-small', '.slide-ad-exp', '.video-card-ad-small', 'bili-dyn-home--member .right', 'aside.right > section > .bili-dyn-banner', '.bili-dyn-search-trendings'],
            commentBanner: ['.ad-report.strip-ad', '.activity-m-v1', '.reply-notice', '.w-100.over-hidden.p-relative.flip-view'],
            liveGiftBar: ['gift-control-vm', '.gift-control-section', '.gift-menu-root'],
            liveGiftTip: ['.live-room-app .app-body .aside-area .chat-history-panel .chat-history-list .chat-items .gift-item', '.border-box.convention-msg.chat-item'],
            liveRecommend: ['.room-info-ctnr'],
            liveRank: ['rank-list-ctnr-box .tab-content.ts-dot-2'],
        };
        const { hostname, pathname } = location;
        const isVideoPage = pathname.startsWith('/video/');
        const isDynamicPage = hostname === 't.bilibili.com' || pathname.startsWith('/opus/');
        const isLivePage = hostname === 'live.bilibili.com' || pathname.startsWith('/live/');

        let selectorsToApply = [];
        if (userSettings.global.enable) {
            if (userSettings.global.sub.nav.enable) selectorsToApply.push(...rules.nav);
            if (userSettings.global.sub.sidebar.enable && (isVideoPage || isDynamicPage)) selectorsToApply.push(...rules.sidebar);
        }
        if (userSettings.comment.enable && userSettings.comment.sub.banner.enable) selectorsToApply.push(...rules.commentBanner);
        if (isLivePage && userSettings.live.enable) {
            initLiveCleaner();
            if (userSettings.live.sub.giftBar.enable) selectorsToApply.push(...rules.liveGiftBar);
            if (userSettings.live.sub.giftTip.enable) selectorsToApply.push(...rules.liveGiftTip);
            if (userSettings.live.sub.recommend.enable) selectorsToApply.push(...rules.liveRecommend);
            if (userSettings.live.sub.rank.enable) {
                selectorsToApply.push(...rules.liveRank);
                const parentElement = document.getElementById('rank-list-vm');
                const childElement = document.getElementById('rank-list-ctnr-box');
                if (parentElement && childElement) {
                    let height = parseFloat(window.getComputedStyle(childElement).height);
                    height = !parentElement.dataset.heightModified ? height/3 - 1 : height;
                    parentElement.style.height = `${height}px`;
                    childElement.style.height = `${height}px`;
                    parentElement.dataset.heightModified = 'true';
                }
            }
        }
        for (const selector of selectorsToApply) {
            const element = document.querySelector(selector);
            if (element) hideItem(element);
        }
    }

    function initLiveCleaner() {
        if (userSettings.live.sub.giftTip.enable) observeLiveGiftTips();
    }
    function stopLiveCleaner() { if (liveGiftObserver) { liveGiftObserver.disconnect(); liveGiftObserver = null; } }
    function observeLiveGiftTips() {
        if (liveGiftObserver) return;
        const container = document.querySelector('.live-room-app .app-body .aside-area .chat-items');
        if (!container) return;
        container.querySelectorAll('.chat-item.gift-item').forEach(hideItem);
        liveGiftObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1 && node.classList && node.classList.contains('gift-item')) hideItem(node);
                });
            }
        });
        liveGiftObserver.observe(container, { childList: true });
    }

    function checkCommentTopAdsOld() {
        const commentAds = document.querySelectorAll('.dynamic-card-comment .comment-list.has-limit .list-item.reply-wrap.is-top');
        let found = false;
        commentAds.forEach(comment => {
            const links = comment.querySelectorAll('a');
            links.forEach(link => {
                const href = link.getAttribute('href');
                if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                    hideItem(comment);
                    found = true;
                }
            });
        });
        return found;
    }

    function checkCommentsForAds() {
        if (!userSettings.comment.enable || !userSettings.comment.sub.adBlock.enable) return false;
        const dynCommentOldVersion = document.querySelector('.dynamic-card-comment');
        if (dynCommentOldVersion) return checkCommentTopAdsOld();

        const commentsContainer = document.querySelector('#commentapp > bili-comments') || document.querySelector('.bili-dyn-comment > bili-comments');
        if (commentsContainer && commentsContainer.shadowRoot) {
            const headerElement = commentsContainer.shadowRoot.querySelector("#header > bili-comments-header-renderer");
            if (headerElement && headerElement.shadowRoot) {
                const noticeElement = headerElement.shadowRoot.querySelector("#notice > bili-comments-notice");
                if (noticeElement && noticeElement.shadowRoot) {
                    const closeElement = noticeElement.shadowRoot.querySelector("#close");
                    if (closeElement) closeElement.click();
                }
            }
            const thread = commentsContainer.shadowRoot.querySelector('bili-comment-thread-renderer');
            if (thread && window.getComputedStyle(thread).display !== 'none' && thread.shadowRoot) {
                const commentRenderer = thread.shadowRoot.querySelector('#comment');
                if (commentRenderer && commentRenderer.shadowRoot) {
                    const richText = commentRenderer.shadowRoot.querySelector('#content > bili-rich-text');
                    if (richText && richText.shadowRoot) {
                        const contentsElement = richText.shadowRoot.querySelector('#contents');
                        if (contentsElement) {
                            let foundAd = false;
                            const links = contentsElement.querySelectorAll('a');
                            links.forEach(link => {
                                const href = link.getAttribute('href');
                                if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) foundAd = true;
                            });
                            if (!foundAd) {
                                const commentText = contentsElement.textContent.trim();
                                const matches = commentText.matchAll(keywordRegexGlobal);
                                let matchedCount = 0;
                                for (const match of matches) {
                                    if (!['评论','评论区','产品'].includes(match[0])) matchedCount++;
                                    if (matchedCount >= 2) break;
                                }
                                if (matchedCount >= 2) foundAd = true;
                            }
                            if (foundAd) {
                                hideItem(thread);
                                hiddenAdCount++;
                                const isVideoPage = window.location.pathname.startsWith('/video/');
                                if (isVideoPage && window.MyObserver) window.MyObserver.disconnect();
                                showMessage(`隐藏广告 x ${hiddenAdCount}`);
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }

    function processFeedCards() {
        document.querySelectorAll('span.bili-video-card__stats--text').forEach(span => {
            if (span.textContent.trim() === '广告') {
                const targetCard = span.closest('.bili-feed-card') || span.closest('.feed-card');
                if (targetCard) hideItem(targetCard);
            }
        });
        document.querySelectorAll('.feed-card').forEach(card => {
            if (!card.querySelector('.bili-video-card__wrap')) hideItem(card);
        });
    }

    function logCurrentActiveUp() {
        if (window.location.hostname !== 't.bilibili.com') {
            if (lastActiveUpName !== null) lastActiveUpName = null;
            return;
        }
        const upListContainer = document.querySelector('.bili-dyn-up-list__window');
        if (!upListContainer) return;
        const activeUpElement = document.querySelector('.bili-dyn-up-list__item.active .bili-dyn-up-list__item__name');
        let currentActiveUpName = activeUpElement ? activeUpElement.textContent.trim() : null;
        if (!currentActiveUpName && document.querySelector('.bili-dyn-up-list__item.active .bili-dyn-up-list__item__face.all')) {
            currentActiveUpName = '全部动态';
        }
        if (currentActiveUpName && currentActiveUpName !== lastActiveUpName) {
            const inWhiteList = whiteList.includes(currentActiveUpName) ? " (白名单)" : '';
            console.log(`[BiliCleaner] UP: %c${currentActiveUpName}${inWhiteList}`, 'background: #009688; color: #fff; padding: 2px 5px; border-radius: 2px;');
            lastActiveUpName = currentActiveUpName;
        } else if (!currentActiveUpName && lastActiveUpName !== null) {
            lastActiveUpName = null;
        }
    }

    function getMatchedAdKeywords(text) {
        const notAd = ['评论', '评论区', '产品'];
        const matches = text.matchAll(keywordRegexGlobal);
        const keywordSet = new Set();
        for (const match of matches) {
            const word = match[0];
            if (!notAd.includes(word)) keywordSet.add(word);
        }
        return Array.from(keywordSet);
    }

    function checkForContentToHide() {
        let hiddenChargeCount = 0;
        hiddenAdCount = 0;
        const hostname = window.location.hostname;
        const pathname = window.location.pathname;

        hideUnwantedElements();

        if (hostname === 'www.bilibili.com' && !pathname.startsWith('/video/')) {
            if (userSettings.global.enable) {
                if (userSettings.global.sub.feed.enable) {
                    processFeedCards();
                    document.querySelectorAll('.floor-single-card').forEach(card => hideItem(card));
                }
                if (userSettings.global.sub.swipe.enable) hideItem(document.querySelector('.recommended-swipe'));
            }
        } else if (['t.bilibili.com', 'space.bilibili.com'].includes(hostname)) {
            if (hostname === 't.bilibili.com') {
                logCurrentActiveUp();
                if (userSettings.dynamic.enable && userSettings.dynamic.sub.widen.enable) {
                    if (!setMainWidth) {
                        const dynMain = document.querySelector('.bili-dyn-home--member > main');
                        if (dynMain) {
                            dynMain.style.width = (parseInt(getComputedStyle(dynMain).width, 10) + 260) + 'px';
                            setMainWidth = true;
                        }
                    }
                    const contentDiv = document.querySelector("#app > div.content");
                    if (contentDiv && contentDiv.style.width !== '900px') contentDiv.style.width = '900px';
                }
            }
            checkCommentsForAds();

            if (userSettings.dynamic.enable) {
                const items = document.querySelectorAll('.bili-dyn-list__item');
                items.forEach(item => {
                    if (window.getComputedStyle(item).display === 'none') return;
                    const titleElement = item.querySelector('.bili-dyn-title');
                    if (titleElement && whiteList.includes(titleElement.textContent.trim())) return;

                    function isAdItem(item) { return item.querySelector('.bili-dyn-card-goods, .dyn-goods, bili-dyn-card-goods, dyn-goods'); }
                    function isChargeItem(item) {
                        if (item.querySelector('.dyn-blocked-mask, .bili-dyn-upower-common, .bili-dyn-upower-lottery, .dyn-icon-badge__renderimg.bili-dyn-item__iconbadge, .bili-dyn-card-common')) return true;
                        const badge = item.querySelector('.bili-dyn-card-video__badge');
                        if (badge && /专属|抢先看/.test(badge.textContent)) return true;
                        const lotteryTitle = item.querySelector('.dyn-upower-lottery__title');
                        if (lotteryTitle && lotteryTitle.textContent.includes('专属')) return true;
                        return false;
                    }

                    if (userSettings.dynamic.sub.goods.enable) {
                        if (isAdItem(item)) { hideItem(item); hiddenAdCount++; return; }
                        const disabled = item.querySelector('.uncheck.disabled');
                        if (disabled) { hideItem(item); return; }
                    }
                    if (userSettings.dynamic.sub.charge.enable && isChargeItem(item)) {
                        hideItem(item);
                        hiddenChargeCount++;
                        return;
                    }

                    if (userSettings.dynamic.sub.goods.enable) {
                        const bili_dyn_content = item.querySelector('.bili-dyn-content');
                        if (bili_dyn_content) {
                            let richtext = bili_dyn_content.querySelector('.bili-rich-text .bili-rich-text__content')?.textContent?.trim();
                            if (!richtext) richtext = bili_dyn_content.querySelector('.dyn-card-opus')?.textContent?.trim();
                            if (richtext) {
                                if (item.innerText && item.innerText.includes('抽奖')) return;
                                const matchedKeywords = getMatchedAdKeywords(richtext);
                                if (matchedKeywords.length >= 2) {
                                    hideItem(item);
                                    hiddenAdCount++;
                                    return;
                                }
                            }
                        }
                        const spans = item.querySelectorAll('span');
                        spans.forEach(span => {
                            const dataUrl = span.getAttribute('data-url');
                            if (dataUrl && biliAdWordsConfig.biliAdLinks.some(blocked => dataUrl.includes(blocked))) {
                                hideItem(item);
                                hiddenAdCount++;
                            } else if (span.textContent.includes('专属')) {
                                hideItem(item);
                                hiddenChargeCount++;
                            }
                        });
                    }
                });
            }
        } else if (pathname.startsWith('/video/BV')) {
            if (userSettings.comment.enable) {
                if (!checkCommentsForAds()) setTimeout(() => checkCommentsForAds(), 2000);
            }
        }

        let message = '';
        if (hiddenChargeCount > 0) message += `隐藏充电 x ${hiddenChargeCount} `;
        if (hiddenAdCount > 0) message += `隐藏广告 x ${hiddenAdCount} `;
        if (message) showMessage(message.trim());
        else logCurrentActiveUp();
    }

    function initObserver() {
        const mainObserver = new MutationObserver(debounce(checkForContentToHide, 300));
        mainObserver.observe(document.body, { childList: true, subtree: true });
        return mainObserver;
    }

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function restartMainObserver() {
        if (window.MyObserver) window.MyObserver.disconnect();
        window.MyObserver = initObserver();
    }

    function initCommentAppObserver() {
        const commentApp = document.querySelector('#commentapp');
        if (commentApp) {
            commentAppObserver = new MutationObserver(restartMainObserver);
            commentAppObserver.observe(commentApp, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        }
    }

    async function whiteListMenu() {
        function addToWhiteList(upId) {
            if (!whiteList.includes(upId)) {
                whiteList.push(upId);
                storage.set('biliUpWhiteList', whiteList);
                updateWhiteListDisplay();
            } else alert(`${upId} 已在白名单中`);
            syncConfigToPage();
        }
        function removeFromWhiteList(upId) {
            const index = whiteList.indexOf(upId);
            if (index !== -1) {
                whiteList.splice(index, 1);
                storage.set('biliUpWhiteList', whiteList);
                updateWhiteListDisplay();
            } else alert(`${upId} 不在白名单中`);
            syncConfigToPage();
        }
        function updateWhiteListDisplay() {
            const listDisplay = document.getElementById('whiteListDisplay');
            if (listDisplay) listDisplay.textContent = whiteList.join(', ') || '白名单为空';
            const currentUserRow = document.getElementById('bili-current-up-display');
            const upInfo = getUpInfo();
            if (currentUserRow) {
                if (upInfo && upInfo.name) currentUserRow.innerHTML = `当前页面UP主: <b style="color: #00a1d6;">${upInfo.name}</b>`;
                else currentUserRow.innerHTML = '';
            }
            const currentUpBtn = document.getElementById('bili-add-current-up-btn');
            if (currentUpBtn) {
                const upInfo = getUpInfo();
                if (upInfo && upInfo.name) {
                    currentUpBtn.style.display = '';
                    if (whiteList.includes(upInfo.name)) {
                        currentUpBtn.textContent = `移除当前UP`;
                        currentUpBtn.style.backgroundColor = '#e74c3c';
                    } else {
                        currentUpBtn.textContent = `添加当前UP`;
                        currentUpBtn.style.backgroundColor = '#2eac31';
                    }
                } else currentUpBtn.style.display = 'none';
            }
        }
        function getUpInfo() {
            const isSpacePage = window.location.href.match(/space.bilibili.com\/(\d+)/);
            const isVideoPage = window.location.href.includes('/video/BV');
            const container = isSpacePage ? document.querySelector('.upinfo__main') : document.querySelector('.up-panel-container');
            if (isVideoPage) {
                const singleUp = container?.querySelector('.up-detail .up-detail-top .up-name');
                if (singleUp) {
                    const clone = singleUp.cloneNode(true);
                    clone.querySelectorAll('span').forEach(span => span.remove());
                    const name = clone.textContent.trim();
                    const href = singleUp.getAttribute('href');
                    const idMatch = href?.match(/space\.bilibili\.com\/(\d+)/);
                    const id = idMatch ? idMatch[1] : null;
                    return { name, id };
                } else {
                    const allMemberCards = container?.querySelectorAll('.membersinfo-upcard');
                    const firstUpCard = allMemberCards?.[0];
                    if (firstUpCard) {
                        const nameElement = firstUpCard.querySelector('.staff-name');
                        const name = nameElement ? nameElement.textContent.trim() : null;
                        const idElement = firstUpCard.querySelector('a[href*="space.bilibili.com"]');
                        const href = idElement ? idElement.getAttribute('href') : null;
                        const id = href ? href.match(/\/\/space\.bilibili\.com\/(\d+)/)?.[1] : null;
                        return { name, id };
                    }
                }
            }
            return null;
        }

        const UpWhiteListContainer = document.createElement('div');
        UpWhiteListContainer.id = 'UpWhiteListContainer';
        Object.assign(UpWhiteListContainer.style, {
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            width: '500px', padding: '20px', background: '#fff', border: '1px solid #ccc',
            borderRadius: '10px', zIndex: '10000', fontSize: '16px', boxShadow: '0 4px 8px rgba(0,0,0,0.2)'
        });
        const Title = document.createElement('h3');
        Title.textContent = '手动管理白名单（跳过检测）';
        Title.style.cssText = 'text-align: center; margin-bottom: 20px; font-weight: bold; cursor: move;';
        UpWhiteListContainer.appendChild(Title);

        const toggleUpRow = document.createElement('div');
        toggleUpRow.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px; gap: 10px;';
        const toggleUpLabel = document.createElement('label');
        toggleUpLabel.textContent = '添加/移除UP主:';
        const handleToggle = () => {
            const upName = toggleUpInput.value.trim();
            if (!upName) return;
            if (whiteList.includes(upName)) removeFromWhiteList(upName);
            else addToWhiteList(upName);
            toggleUpInput.value = '';
        };
        const toggleUpInput = document.createElement('input');
        toggleUpInput.type = 'text';
        toggleUpInput.placeholder = '输入UP主昵称';
        toggleUpInput.style.cssText = 'flex-grow: 1; min-width: 200px; border: 1px solid #ccc;';
        toggleUpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleToggle(); });
        const toggleButton = createButton('执行', handleToggle);
        toggleUpRow.append(toggleUpLabel, toggleUpInput, toggleButton);
        UpWhiteListContainer.appendChild(toggleUpRow);

        const listDiv = document.createElement('div');
        listDiv.id = 'whiteListDisplay';
        Object.assign(listDiv.style, {
            textAlign: 'left', color: '#30b688', margin: '20px 0', padding: '5px',
            border: '1px dashed #ccc', borderRadius: '5px', fontSize: '14px',
            wordBreak: 'break-word', maxHeight: '150px', overflowY: 'auto'
        });
        listDiv.textContent = whiteList.join(', ') || '白名单为空';
        UpWhiteListContainer.appendChild(listDiv);

        const upInfo = getUpInfo();
        if (upInfo && upInfo.name) {
            const currentUserRow = document.createElement('div');
            currentUserRow.id = 'bili-current-up-display';
            currentUserRow.style.cssText = 'text-align: center; font-size: 16px; color: #555; margin: 5px 0; padding: 5px;';
            UpWhiteListContainer.appendChild(currentUserRow);
        }

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; margin: 10px 0; gap: 10px';
        function createButton(text, onClick) {
            const button = document.createElement('button');
            button.textContent = text;
            button.style.cssText = 'padding: 3px 3px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 14px;';
            if (onClick) button.onclick = onClick;
            return button;
        }
        const finishButton = createButton('关闭界面', () => { document.body.removeChild(UpWhiteListContainer); });
        if (upInfo && upInfo.name) {
            const toggleCurrentUpButton = document.createElement('button');
            toggleCurrentUpButton.id = 'bili-add-current-up-btn';
            toggleCurrentUpButton.style.cssText = 'color: white; padding: 4px 5px; margin: 0 5px; border: none; border-radius: 4px;';
            toggleCurrentUpButton.addEventListener('click', () => {
                const name = upInfo.name;
                if (whiteList.includes(name)) removeFromWhiteList(name);
                else addToWhiteList(name);
            });
            buttonContainer.appendChild(toggleCurrentUpButton);
        }
        buttonContainer.appendChild(finishButton);
        UpWhiteListContainer.appendChild(buttonContainer);
        document.body.appendChild(UpWhiteListContainer);
        updateWhiteListDisplay();
    }

    function prepareForWork() {
        migrateFromLocalStorage();
        whiteList = storage.get('biliUpWhiteList', []);
        GM_registerMenuCommand("⚙️ 功能开关", openSettingsMenu);
        GM_registerMenuCommand("🛡️ UP白名单", whiteListMenu);
        messageDiv = document.createElement('div');
        Object.assign(messageDiv.style, {
            position: 'fixed', top: '10px', right: '10px', padding: '10px',
            backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', borderRadius: '5px',
            zIndex: '9999', display: 'none'
        });
        if (document.body) document.body.appendChild(messageDiv);
        else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(messageDiv));
        lastPathname = window.location.pathname;
        syncConfigToPage();
    }

    function openSettingsMenu() {
        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 10000;';
        const container = document.createElement('div');
        container.id = 'BiliCleanerSettings';
        container.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 500px; padding: 20px; background: #fff; border-radius: 10px; z-index: 10001; font-size: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); max-height: 80vh; overflow-y: auto;';
        const title = document.createElement('h3');
        title.textContent = 'BiliCleaner 功能开关';
        title.style.cssText = 'text-align: center; margin-bottom: 15px; font-weight: bold; border-bottom: 1px solid #eee; padding-bottom: 10px;';
        container.appendChild(title);
        const content = document.createElement('div');
        for (const [key, group] of Object.entries(userSettings)) {
            const groupDiv = document.createElement('div');
            groupDiv.style.cssText = "margin-bottom: 10px; padding: 10px; background: #f9f9f9; border-radius: 6px;";
            const header = document.createElement('div');
            header.style.cssText = "display: flex; align-items: center; font-weight: bold; margin-bottom: 5px;";
            const groupCb = document.createElement('input');
            groupCb.type = 'checkbox';
            groupCb.checked = group.enable;
            groupCb.style.marginRight = '8px';
            const groupLabel = document.createElement('span');
            groupLabel.textContent = group.label;
            header.appendChild(groupCb);
            header.appendChild(groupLabel);
            groupDiv.appendChild(header);
            const subContainer = document.createElement('div');
            subContainer.style.cssText = `margin-left: 24px; display: ${group.enable ? 'block' : 'none'};`;
            groupCb.onchange = (e) => {
                group.enable = e.target.checked;
                subContainer.style.display = group.enable ? 'block' : 'none';
                saveSettings();
            };
            for (const [subKey, subItem] of Object.entries(group.sub)) {
                const subRow = document.createElement('div');
                subRow.style.margin = "5px 0";
                const subCb = document.createElement('input');
                subCb.type = 'checkbox';
                subCb.checked = subItem.enable;
                subCb.style.marginRight = '8px';
                const subLabel = document.createElement('label');
                subLabel.textContent = subItem.label;
                subLabel.style.cursor = 'pointer';
                subLabel.onclick = () => subCb.click();
                subCb.onchange = (e) => {
                    subItem.enable = e.target.checked;
                    saveSettings();
                };
                subRow.appendChild(subCb);
                subRow.appendChild(subLabel);
                subContainer.appendChild(subRow);
            }
            groupDiv.appendChild(subContainer);
            content.appendChild(groupDiv);
        }
        container.appendChild(content);
        const closeBtn = document.createElement('button');
        closeBtn.textContent = "保存并生效";
        closeBtn.style.cssText = "display: block; width: 100%; padding: 10px; background: #00a1d6; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 15px;";
        const closeAction = () => {
            saveSettings();
            document.body.removeChild(backdrop);
            document.body.removeChild(container);
            showMessage("设置已保存");
            reinitializeAllObservers();
            syncConfigToPage();
        };
        closeBtn.onclick = closeAction;
        backdrop.onclick = closeAction;
        container.appendChild(closeBtn);
        document.body.appendChild(backdrop);
        document.body.appendChild(container);
    }

    function reinitializeAllObservers() {
        if (window.MyObserver) window.MyObserver.disconnect();
        if (commentAppObserver) commentAppObserver.disconnect();
        if (dynamicPanelObserver) dynamicPanelObserver.disconnect();
        stopLiveCleaner();
        window.MyObserver = initObserver();
        initCommentAppObserver();
        checkForContentToHide();
    }

    function setupNavigationObserver() {
        const observer = new MutationObserver(() => {
            const currentPath = window.location.pathname.replace(/\/$/, '');
            const lastPath = lastPathname.replace(/\/$/, '');
            if (!lastPathname || currentPath !== lastPath) {
                if (lastPathname) log(`检测到页面导航: ${lastPathname} -> ${window.location.pathname}`);
                lastPathname = window.location.pathname;
                debounce(reinitializeAllObservers, 1500)();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('✅ 主导航观察器已启动');
    }

    function syncConfigToPage() {
        const config = {
            settings: userSettings,
            whiteList: whiteList,
            keywords: biliAdWordsConfig?.keywordStr || null
        };
        const script = document.createElement('script');
        script.textContent = `window.__biliCleanerConfig = ${JSON.stringify(config)};`;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }

    // 注入网络拦截器（精简版，依赖同步配置）
    function injectBiliInterceptor() {
        const interceptorLogic = `
(function() {
    if (window.__biliInterceptorInjected) return;
    window.__biliInterceptorInjected = true;
    const originalFetch = window.fetch;
    console.log('[BiliCleaner] 🚀 网络拦截器已加载');

    const targetReplyUrl = '/x/v2/reply/wbi/main';
    const targetSubReplyUrl = '/x/v2/reply/reply';
    const targetDynUrl = '/x/polymer/web-dynamic/v1/feed/all';
    const targetNavUrl = '/x/polymer/web-dynamic/v1/feed/nav';
    const targetSpaceUrl = '/x/polymer/web-dynamic/v1/feed/space';

    let runtimeSettings = null;
    let runtimeWhiteList = [];
    let runtimeRegex = null;

    function refreshRuntimeConfig() {
        const pageConfig = window.__biliCleanerConfig || {};
        const rawSettings = pageConfig.settings;
        const rawWhiteList = pageConfig.whiteList;
        const keywordPattern = pageConfig.keywords;

        if (rawSettings && typeof rawSettings === 'object') {
            runtimeSettings = JSON.parse(JSON.stringify(rawSettings));
            runtimeSettings.dynamic = runtimeSettings.dynamic || { enable: true, sub: {} };
            runtimeSettings.dynamic.sub = runtimeSettings.dynamic.sub || {};
            runtimeSettings.comment = runtimeSettings.comment || { enable: true, sub: {} };
            runtimeSettings.comment.sub = runtimeSettings.comment.sub || {};
        } else {
            runtimeSettings = {
                dynamic: { enable: true, sub: { goods: { enable: true }, charge: { enable: true }, reverse: { enable: true } } },
                comment: { enable: true, sub: { adBlock: { enable: true }, ipShow: { enable: true } } },
            };
        }
        runtimeWhiteList = Array.isArray(rawWhiteList) ? rawWhiteList : [];
        if (keywordPattern && typeof keywordPattern === 'string') {
            const cleaned = keywordPattern.replace(/\s+/g, '');
            runtimeRegex = new RegExp(cleaned, 'gi');
        } else {
            const DEFAULT_KEYWORD_STR = '淘宝|京东|天猫|美团|外卖|补贴|密令|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价';
            runtimeRegex = new RegExp(DEFAULT_KEYWORD_STR.replace(/\s+/g, ''), 'gi');
        }
    }

    refreshRuntimeConfig();

    function extractAllTextFromItem(item) {
        const textParts = [];
        const modules = item.modules || {};
        const dynamic = modules.module_dynamic || {};
        if (dynamic.desc?.text) textParts.push(dynamic.desc.text);
        if (dynamic.desc?.rich_text_nodes) {
            dynamic.desc.rich_text_nodes.forEach(node => { if (node.text) textParts.push(node.text); });
        }
        const major = dynamic.major || {};
        if (major.opus) {
            if (major.opus.title) textParts.push(major.opus.title);
            if (major.opus.summary?.text) textParts.push(major.opus.summary.text);
            if (major.opus.summary?.rich_text_nodes) {
                major.opus.summary.rich_text_nodes.forEach(node => { if (node.text) textParts.push(node.text); });
            }
        }
        if (major.archive) {
            if (major.archive.title) textParts.push(major.archive.title);
            if (major.archive.desc) textParts.push(major.archive.desc);
        }
        if (major.article) {
            if (major.article.title) textParts.push(major.article.title);
            if (major.article.summary) textParts.push(major.article.summary);
        }
        const additional = dynamic.additional;
        if (additional?.goods?.items) {
            additional.goods.items.forEach(good => {
                if (good.name) textParts.push(good.name);
                if (good.brief) textParts.push(good.brief);
            });
        }
        if (item.orig) {
            const origText = extractAllTextFromItem(item.orig);
            if (origText) textParts.push(origText);
        }
        const rawText = textParts.filter(t => t && typeof t === 'string').join(';');
        return rawText.replace(/\\[[^\\[\\]]+\\]/g, '');
    }

    function getMatchedAdKeywords(text) {
        if (!runtimeRegex) return [];
        const notAd = ['评论', '评论区', '产品'];
        const matches = text.matchAll(runtimeRegex);
        const keywordSet = new Set();
        for (const match of matches) {
            const word = match[0];
            if (!notAd.includes(word)) keywordSet.add(word);
        }
        return Array.from(keywordSet);
    }

    function hasLotteryNode(dynamicObj) {
        if (!dynamicObj) return false;
        try {
            const summary = dynamicObj.modules?.module_dynamic?.major?.opus?.summary;
            if (summary && Array.isArray(summary.rich_text_nodes)) {
                return summary.rich_text_nodes.some(node => node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY');
            }
        } catch(e) {}
        return false;
    }

    function isLotteryDynamic(item) {
        if (hasLotteryNode(item)) return true;
        if (item.orig && hasLotteryNode(item.orig)) return true;
        return false;
    }

    function filterDynamic(json, settings, whiteList, regex) {
        if (!json?.data?.items || !settings?.dynamic?.enable) return json;
        const originalCount = json.data.items.length;
        const enableGoods = !(settings.dynamic.sub.goods?.enable === false);
        const enableCharge = !(settings.dynamic.sub.charge?.enable === false);
        const enableReverse = !(settings.dynamic.sub.reverse?.enable === false);

        json.data.items = json.data.items.filter(item => {
            const authorName = item.modules?.module_author?.name || '未知用户';
            if (authorName && whiteList?.includes(authorName)) return true;
            const jump_url = 'https:' + (item.basic?.jump_url || item.modules?.module_dynamic?.major?.archive?.jump_url || item.orig?.basic?.jump_url || '//t.bilibili.com/'+ item.id_str);
            if (isLotteryDynamic(item)) {
                console.log('[BiliCleaner] 🎁 动态放行-抽奖', authorName, '\\n', jump_url);
                return true;
            }
            const dyn = item.modules?.module_dynamic;
            const addType = dyn?.additional?.type;
            if (enableGoods && addType === "ADDITIONAL_TYPE_GOODS") {
                console.log('[BiliCleaner] 🚫 网络拦截-商品推广', authorName, '\\n', jump_url);
                return false;
            }
            if (enableReverse && addType === "ADDITIONAL_TYPE_RESERVE") {
                console.log('[BiliCleaner] 🚫 网络拦截-预约动态', authorName, '\\n', jump_url);
                return false;
            }
            if (enableCharge && (item.type === 'DYNAMIC_TYPE_COMMON_SQUARE' ||
                dyn?.major?.type === "MAJOR_TYPE_BLOCKED" ||
                item.basic?.is_only_fans ||
                dyn?.major?.archive?.badge?.text === "充电专属")) {
                const title = dyn?.major?.archive?.title || '';
                console.log('[BiliCleaner] 🚫 网络拦截-充电专属:', authorName, title, '\\n', jump_url);
                return false;
            }
            if (enableGoods && regex) {
                const allText = extractAllTextFromItem(item);
                if (allText) {
                    const matches = getMatchedAdKeywords(allText);
                    if (matches && matches.length >= 2) {
                        console.log('[BiliCleaner] 🚫 网络拦截-关键词命中:', authorName, '->', allText.slice(0, 100)+ '...   \\n', jump_url, '\\n关键词：', matches);
                        return false;
                    }
                }
            }
            return true;
        });
        const blockedCount = originalCount - json.data.items.length;
        if (blockedCount > 0) console.log('[BiliCleaner] 🧹 动态流已净化: 移除 ' + blockedCount + ' 条广告');
        return json;
    }

    function filterReply(json, settings, whiteList, keywordRegex) {
        if (!json?.data || !settings?.comment?.sub?.adBlock?.enable) return json;
        const checkAd = (r, source) => {
            if (!r?.content) return false;
            const u = r.member?.uname || '未知用户';
            if (whiteList.includes(u)) return false;
            if (r.content.jump_url && Object.keys(r.content.jump_url).length > 0) {
                console.log('[BiliCleaner] 🚫 网络拦截-置顶带货(' + source + '):', u);
                return true;
            }
            if (keywordRegex && r.content.message?.match(keywordRegex)) {
                const matches = r.content.message.match(keywordRegex);
                const isReal = matches.some(m => !['评论','评论区','产品'].includes(m));
                if (isReal) {
                    console.log('[BiliCleaner] 🚫 网络拦截-置顶关键词(' + source + '):', u);
                    return true;
                }
            }
            return false;
        };
        if (json.data.top?.upper && checkAd(json.data.top.upper, 'upper')) json.data.top.upper = null;
        if (Array.isArray(json.data.top_replies)) {
            json.data.top_replies = json.data.top_replies.filter(r => !checkAd(r, 'top_replies'));
        }
        return json;
    }

    // 递归处理评论数据，注入 IP 属地
    function processReplyIp(data, isSubCommentAPI = false) {
        if (!data?.data) return data;
        let commentsToProcess = [];
        if (isSubCommentAPI) {
            commentsToProcess = [].concat(data.data.root || [], data.data.replies || []);
        } else {
            commentsToProcess = [].concat(data.data.top_replies || [], data.data.replies || []);
        }
        for (let i = 0; i < commentsToProcess.length; i++) {
            const comment = commentsToProcess[i];
            const isSub = isSubCommentAPI || (comment.root > 0);
            injectIpToComment(comment, isSub);
            if (!isSubCommentAPI && comment.replies && comment.replies.length > 0) {
                for (let j = 0; j < comment.replies.length; j++) {
                    injectIpToComment(comment.replies[j], true);
                }
            }
        }
        return data;
    }

    function injectIpToComment(comment, isSubReply = false) {
        if (!comment || !comment.reply_control || !comment.member || !comment.member.uname) return;
        const locationRaw = comment.reply_control.location;
        if (locationRaw && typeof locationRaw === 'string') {
            const ipLocation = locationRaw.replace(/IP属地：/ig, "").trim();
            if (ipLocation) {
                comment.member.uname += ' <' + ipLocation + '>';
            }
        }
    }

    function filterNav(json, settings, whiteList, keywordRegex) {
        let items = json?.data?.items ?? json?.items;
        if (!items) return json;
        const goodsEnabled = settings?.dynamic?.sub?.goods?.enable !== false;
        const popupEnabled = settings?.dynamic?.sub?.popup?.enable !== false;
        if (!goodsEnabled || !popupEnabled) return json;
        const originalCount = json.data.items.length;
        json.data.items = json.data.items.filter(item => {
            const authorName = item.author?.name;
            if (authorName && whiteList.includes(authorName)) return true;
            if (item.type === 64) {
                console.log('[BiliCleaner] 🚫 网络拦截-导航动态广告:', authorName, '->', item.title);
                return false;
            }
            return true;
        });
        const blockedCount = originalCount - json.data.items.length;
        if (blockedCount > 0 && json.data.items.length === 0) {
            json.data.has_more = false;
            json.data.offset = null;
        }
        return json;
    }

    window.fetch = async function(...args) {
        const url = (typeof args[0] === 'string') ? args[0] : args[0].url;
        const isReplyAdd = url.includes('/x/v2/reply/add');
        const isReplyApi = url.includes(targetReplyUrl) || url.includes(targetSubReplyUrl);
        const isMainListApi = url.includes(targetDynUrl) || url.includes(targetSpaceUrl) || url.includes(targetNavUrl);

        if (isMainListApi || isReplyApi) refreshRuntimeConfig();

        if (isReplyAdd && args[1] && args[1].method === 'POST') {
            try {
                let bodyData = args[1].body;
                if (typeof bodyData === 'string') {
                    const params = new URLSearchParams(bodyData);
                    let message = params.get('message');
                    if (message && / <[^>]+>/.test(message)) {
                        message = message.replace(/ <[^>]+>/g, '');
                        params.set('message', message);
                        args[1].body = params.toString();
                    }
                }
            } catch(e) { console.error('[BiliCleaner] 清理回复消息失败', e); }
        }

        const response = await originalFetch.apply(this, args);

        if (isMainListApi) {
            try {
                const clone = response.clone();
                let json = await clone.json();
                if (url.includes(targetDynUrl) || url.includes(targetSpaceUrl)) {
                    json = filterDynamic(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                } else if (url.includes(targetNavUrl)) {
                    json = filterNav(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                }
                return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: response.headers });
            } catch(e) { return response; }
        }
        else if (isReplyApi) {
            try {
                const clone = response.clone();
                let json = await clone.json();
                // 评论区广告过滤
                if (runtimeSettings.comment?.sub?.adBlock?.enable) {
                    json = filterReply(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                }
                // IP属地显示（新增）
                if (runtimeSettings.comment?.sub?.ipShow?.enable) {
                    json = processReplyIp(json, url.includes(targetSubReplyUrl));
                }
                return new Response(JSON.stringify(json), { status: response.status, statusText: response.statusText, headers: response.headers });
            } catch(e) { return response; }
        }

        return response;
    };

})();
`;
        const script = document.createElement('script');
        script.textContent = interceptorLogic;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }

    async function initApp() {
        await getAdWordsConfig();
        prepareForWork();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                reinitializeAllObservers();
                setupNavigationObserver();
            });
        } else {
            reinitializeAllObservers();
            setupNavigationObserver();
        }
    }

    injectBiliInterceptor();
    initApp().catch(console.error);
})();
